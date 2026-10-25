use std::collections::HashMap;
use std::time::Instant;
use tiberius::{AuthMethod, Client, Config, Query, Row};
use tokio::net::TcpStream;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

use super::types::*;

pub struct MssqlConn {
    client: Client<Compat<TcpStream>>,
    pub current_db: String,
}

impl MssqlConn {
    pub async fn new(
        host: &str,
        port: u16,
        user: &str,
        pass: &str,
        db: &str,
    ) -> Result<Self, String> {
        let mut config = Config::new();
        config.host(host);
        config.port(port);
        config.authentication(AuthMethod::sql_server(user, pass));
        config.trust_cert(); // For dev — avoids cert validation issues
        if !db.is_empty() {
            config.database(db);
        }

        let tcp = TcpStream::connect(config.get_addr())
            .await
            .map_err(|e| e.to_string())?;
        tcp.set_nodelay(true).map_err(|e| e.to_string())?;
        let client = Client::connect(config, tcp.compat_write())
            .await
            .map_err(|e| e.to_string())?;

        Ok(Self {
            client,
            current_db: db.to_string(),
        })
    }

    pub async fn list_databases(&mut self) -> Result<Vec<String>, String> {
        let rows = Query::new("SELECT name FROM sys.databases ORDER BY name")
            .query(&mut self.client)
            .await
            .map_err(|e| e.to_string())?
            .into_results()
            .await
            .map_err(|e| e.to_string())?;

        Ok(rows
            .into_iter()
            .next()
            .unwrap_or_default()
            .iter()
            .filter_map(|r| r.get::<&str, _>(0).map(|s| s.to_string()))
            .collect())
    }

    pub async fn list_tables(&mut self, _database: Option<&str>) -> Result<Vec<TableInfo>, String> {
        let rows = Query::new(
            "SELECT name, type_desc FROM sys.objects \
             WHERE type IN ('U', 'V') ORDER BY name",
        )
        .query(&mut self.client)
        .await
        .map_err(|e| e.to_string())?
        .into_results()
        .await
        .map_err(|e| e.to_string())?;

        Ok(rows
            .into_iter()
            .next()
            .unwrap_or_default()
            .iter()
            .map(|r| {
                let name = r.get::<&str, _>(0).unwrap_or("").to_string();
                let type_desc = r.get::<&str, _>(1).unwrap_or("").to_string();
                TableInfo {
                    name,
                    table_type: if type_desc == "USER_TABLE" {
                        "table".to_string()
                    } else {
                        "view".to_string()
                    },
                }
            })
            .collect())
    }

    pub async fn execute(&mut self, sql: &str, database: Option<&str>) -> Result<QueryResult, String> {
        if let Some(db) = database {
            let use_sql = format!("USE [{}]", db.replace(']', ""));
            if let Err(e) = Query::new(&use_sql).execute(&mut self.client).await {
                return Ok(QueryResult::from_error(e.to_string()));
            }
        }
        let start = Instant::now();
        let upper = sql.trim().to_ascii_uppercase();
        let first_word = upper.split_whitespace().next().unwrap_or("");

        if matches!(first_word, "SELECT" | "WITH" | "SHOW" | "EXPLAIN") {
            match Query::new(sql).query(&mut self.client).await {
                Err(e) => Ok(QueryResult::from_error(e.to_string())),
                Ok(stream) => {
                    let results = stream
                        .into_results()
                        .await
                        .map_err(|e| e.to_string())?;
                    let rows_data = results.into_iter().next().unwrap_or_default();

                    let columns: Vec<ColumnDef> = if let Some(first_row) = rows_data.first() {
                        first_row
                            .columns()
                            .iter()
                            .map(|c| ColumnDef {
                                name: c.name().to_string(),
                                col_type: format!("{:?}", c.column_type()),
                                nullable: true,
                                is_primary_key: false,
                                default_value: None,
                            })
                            .collect()
                    } else {
                        vec![]
                    };

                    let ncols = columns.len();
                    let all_rows = rows_data
                        .iter()
                        .map(|row| (0..ncols).map(|i| row_value_to_string(row, i)).collect())
                        .collect();

                    Ok(QueryResult {
                        columns,
                        rows: all_rows,
                        affected_rows: 0,
                        last_insert_id: 0,
                        execution_time_ms: start.elapsed().as_secs_f64() * 1000.0,
                        error: None,
                    })
                }
            }
        } else {
            match self.client.execute(sql, &[]).await {
                Err(e) => Ok(QueryResult::from_error(e.to_string())),
                Ok(exec_result) => {
                    let affected = exec_result.rows_affected().iter().sum::<u64>();
                    Ok(QueryResult {
                        affected_rows: affected,
                        execution_time_ms: start.elapsed().as_secs_f64() * 1000.0,
                        ..QueryResult::empty()
                    })
                }
            }
        }
    }

    pub async fn table_columns(
        &mut self,
        table: &str,
        _database: Option<&str>,
    ) -> Result<Vec<ColumnInfo>, String> {
        let sql = format!(
            "SELECT c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE, c.COLUMN_DEFAULT,
                    CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 'PRI' ELSE '' END as key_type,
                    '' as extra
             FROM INFORMATION_SCHEMA.COLUMNS c
             LEFT JOIN (
                 SELECT ku.COLUMN_NAME
                 FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
                 JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
                   ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
                 WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
                   AND tc.TABLE_NAME = '{}'
                   AND tc.TABLE_SCHEMA = 'dbo'
             ) pk ON c.COLUMN_NAME = pk.COLUMN_NAME
             WHERE c.TABLE_NAME = '{}' AND c.TABLE_SCHEMA = 'dbo'
             ORDER BY c.ORDINAL_POSITION",
            table.replace('\'', "''"),
            table.replace('\'', "''")
        );

        let rows = Query::new(&sql)
            .query(&mut self.client)
            .await
            .map_err(|e| e.to_string())?
            .into_results()
            .await
            .map_err(|e| e.to_string())?;

        Ok(rows
            .into_iter()
            .next()
            .unwrap_or_default()
            .iter()
            .map(|r| ColumnInfo {
                name: r.get::<&str, _>(0).unwrap_or("").to_string(),
                col_type: r.get::<&str, _>(1).unwrap_or("").to_string(),
                nullable: r.get::<&str, _>(2).unwrap_or("YES") == "YES",
                default_value: r.get::<&str, _>(3).map(|s| s.to_string()),
                key_type: r.get::<&str, _>(4).unwrap_or("").to_string(),
                extra: r.get::<&str, _>(5).unwrap_or("").to_string(),
                charset: String::new(),
                collation: String::new(),
                comment: String::new(),
            })
            .collect())
    }

    pub async fn table_indexes(
        &mut self,
        table: &str,
        _database: Option<&str>,
    ) -> Result<Vec<IndexInfo>, String> {
        let sql = format!(
            "SELECT i.name, i.is_unique, c.name AS col_name, i.type_desc
             FROM sys.indexes i
             JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
             JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
             WHERE i.object_id = OBJECT_ID('{}')
               AND i.name IS NOT NULL
             ORDER BY i.name, ic.key_ordinal",
            table.replace('\'', "''")
        );

        let rows = Query::new(&sql)
            .query(&mut self.client)
            .await
            .map_err(|e| e.to_string())?
            .into_results()
            .await
            .map_err(|e| e.to_string())?;

        let mut index_map: HashMap<String, IndexInfo> = HashMap::new();
        for row in rows.into_iter().next().unwrap_or_default() {
            let name = row.get::<&str, _>(0).unwrap_or("").to_string();
            let unique: bool = row.get::<bool, _>(1).unwrap_or(false);
            let col = row.get::<&str, _>(2).unwrap_or("").to_string();
            let idx_type = row.get::<&str, _>(3).unwrap_or("BTREE").to_string();

            index_map
                .entry(name.clone())
                .or_insert(IndexInfo {
                    name,
                    columns: vec![],
                    unique,
                    index_type: idx_type,
                })
                .columns
                .push(col);
        }

        Ok(index_map.into_values().collect())
    }

    pub async fn get_create_table_sql(
        &mut self,
        table: &str,
        _database: Option<&str>,
    ) -> Result<String, String> {
        let sql = format!(
            "SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE, COLUMN_DEFAULT
             FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_NAME = '{}' AND TABLE_SCHEMA = 'dbo'
             ORDER BY ORDINAL_POSITION",
            table.replace('\'', "''")
        );

        let rows = Query::new(&sql)
            .query(&mut self.client)
            .await
            .map_err(|e| e.to_string())?
            .into_results()
            .await
            .map_err(|e| e.to_string())?;

        let rows_data = rows.into_iter().next().unwrap_or_default();
        if rows_data.is_empty() {
            return Err(format!("Table {} not found", table));
        }

        let col_defs: Vec<String> = rows_data
            .iter()
            .map(|row| {
                let col_name = row.get::<&str, _>(0).unwrap_or("").to_string();
                let data_type = row.get::<&str, _>(1).unwrap_or("").to_string();
                let char_max_len: Option<i32> = row.get(2);
                let is_nullable = row.get::<&str, _>(3).unwrap_or("YES");
                let col_default: Option<&str> = row.get(4);

                let type_str = match char_max_len {
                    Some(len) => format!("{}({})", data_type, len),
                    None => data_type,
                };
                let mut def = format!("  [{}] {}", col_name, type_str);
                if let Some(default) = col_default {
                    def.push_str(&format!(" DEFAULT {}", default));
                }
                if is_nullable == "NO" {
                    def.push_str(" NOT NULL");
                }
                def
            })
            .collect();

        Ok(format!(
            "CREATE TABLE [dbo].[{}] (\n{}\n)",
            table,
            col_defs.join(",\n")
        ))
    }

    pub async fn create_database(&mut self, name: &str) -> Result<QueryResult, String> {
        let safe_name = name.replace(']', "");
        let sql = format!("CREATE DATABASE [{}]", safe_name);
        self.execute(&sql, None).await
    }

    pub async fn table_foreign_keys(&mut self, table: &str, _database: Option<&str>) -> Result<Vec<ForeignKeyInfo>, String> {
        let sql = format!(
            "SELECT KCU1.CONSTRAINT_NAME, KCU1.COLUMN_NAME, KCU2.TABLE_NAME, KCU2.COLUMN_NAME \
             FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS RC \
             JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE KCU1 ON RC.CONSTRAINT_NAME=KCU1.CONSTRAINT_NAME \
             JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE KCU2 ON RC.UNIQUE_CONSTRAINT_NAME=KCU2.CONSTRAINT_NAME \
             WHERE KCU1.TABLE_NAME='{}' AND KCU1.TABLE_SCHEMA='dbo' \
             ORDER BY KCU1.CONSTRAINT_NAME, KCU1.ORDINAL_POSITION",
            table.replace('\'', "''")
        );
        let results = tiberius::Query::new(&sql).query(&mut self.client).await
            .map_err(|e| e.to_string())?.into_results().await.map_err(|e| e.to_string())?;
        Ok(results.into_iter().next().unwrap_or_default().into_iter().map(|r| ForeignKeyInfo {
            constraint_name: r.get::<&str, _>(0).unwrap_or_default().to_string(),
            column_name: r.get::<&str, _>(1).unwrap_or_default().to_string(),
            referenced_table: r.get::<&str, _>(2).unwrap_or_default().to_string(),
            referenced_column: r.get::<&str, _>(3).unwrap_or_default().to_string(),
        }).collect())
    }

    pub async fn table_triggers(&mut self, table: &str, _database: Option<&str>) -> Result<Vec<TriggerInfo>, String> {
        let sql = format!(
            "SELECT o.name, \
               CASE WHEN OBJECTPROPERTY(o.object_id,'ExecIsInsertTrigger')=1 THEN 'INSERT' \
                    WHEN OBJECTPROPERTY(o.object_id,'ExecIsUpdateTrigger')=1 THEN 'UPDATE' \
                    ELSE 'DELETE' END, \
               CASE WHEN OBJECTPROPERTY(o.object_id,'ExecIsAfterTrigger')=1 THEN 'AFTER' ELSE 'INSTEAD OF' END, \
               OBJECT_DEFINITION(o.object_id) \
             FROM sys.objects o WHERE o.type='TR' AND o.parent_object_id=OBJECT_ID('{}') ORDER BY o.name",
            table.replace('\'', "''")
        );
        let results = tiberius::Query::new(&sql).query(&mut self.client).await
            .map_err(|e| e.to_string())?.into_results().await.map_err(|e| e.to_string())?;
        Ok(results.into_iter().next().unwrap_or_default().into_iter().map(|r| TriggerInfo {
            name: r.get::<&str, _>(0).unwrap_or_default().to_string(),
            event: r.get::<&str, _>(1).unwrap_or_default().to_string(),
            timing: r.get::<&str, _>(2).unwrap_or_default().to_string(),
            statement: r.get::<&str, _>(3).unwrap_or_default().to_string(),
        }).collect())
    }

    pub async fn table_info(&mut self, table: &str, _database: Option<&str>) -> Result<TableInfoData, String> {
        let sql = format!(
            "SELECT CAST(SUM(p.rows) AS VARCHAR(20)) FROM sys.tables t \
             JOIN sys.partitions p ON t.object_id=p.object_id \
             WHERE t.name='{}' AND SCHEMA_NAME(t.schema_id)='dbo' AND p.index_id<2",
            table.replace('\'', "''")
        );
        let results = tiberius::Query::new(&sql).query(&mut self.client).await
            .map_err(|e| e.to_string())?.into_results().await.map_err(|e| e.to_string())?;
        let row_count = results.into_iter().next().unwrap_or_default().into_iter().next()
            .and_then(|r| r.get::<&str, _>(0).map(|s| s.to_string()))
            .unwrap_or_else(|| "0".to_string());
        Ok(TableInfoData {
            row_count,
            size: "N/A".into(),
            data_size: "N/A".into(),
            index_size: "N/A".into(),
            auto_increment: None,
            engine: "SQL Server".into(),
            collation: "N/A".into(),
            created: "N/A".into(),
            comment: String::new(),
        })
    }
}

fn row_value_to_string(row: &Row, idx: usize) -> Option<String> {
    if let Ok(Some(v)) = row.try_get::<&str, _>(idx) {
        return Some(v.to_string());
    }
    if let Ok(Some(v)) = row.try_get::<i64, _>(idx) {
        return Some(v.to_string());
    }
    if let Ok(Some(v)) = row.try_get::<i32, _>(idx) {
        return Some(v.to_string());
    }
    if let Ok(Some(v)) = row.try_get::<i16, _>(idx) {
        return Some(v.to_string());
    }
    if let Ok(Some(v)) = row.try_get::<f64, _>(idx) {
        return Some(v.to_string());
    }
    if let Ok(Some(v)) = row.try_get::<f32, _>(idx) {
        return Some(v.to_string());
    }
    if let Ok(Some(v)) = row.try_get::<bool, _>(idx) {
        return Some(v.to_string());
    }
    if let Ok(Some(v)) = row.try_get::<u8, _>(idx) {
        return Some(v.to_string());
    }
    None
}
