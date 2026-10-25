use super::types::*;

pub struct OracleConn {
    #[cfg(feature = "oracle-support")]
    conn: oracle::Connection,
    pub connection_string: String,
}

impl OracleConn {
    pub async fn new(
        host: &str,
        port: u16,
        service: &str,
        user: &str,
        pass: &str,
    ) -> Result<Self, String> {
        #[cfg(feature = "oracle-support")]
        {
            let conn_str = format!("//{}:{}/{}", host, port, service);
            let conn = oracle::Connection::connect(user, pass, &conn_str)
                .map_err(|e| e.to_string())?;
            Ok(Self {
                conn,
                connection_string: conn_str,
            })
        }
        #[cfg(not(feature = "oracle-support"))]
        {
            let _ = (host, port, service, user, pass);
            Err(
                "Oracle support requires Oracle Instant Client. \
                 See https://oracle.github.io/odpi/doc/installation.html \
                 and rebuild with --features oracle-support"
                    .to_string(),
            )
        }
    }

    pub async fn list_databases(&self) -> Result<Vec<String>, String> {
        #[cfg(feature = "oracle-support")]
        {
            let rows = self
                .conn
                .query("SELECT username FROM all_users ORDER BY username", &[])
                .map_err(|e| e.to_string())?;
            let mut names = vec![];
            for row_result in rows {
                let row = row_result.map_err(|e| e.to_string())?;
                names.push(row.get::<_, String>(0).unwrap_or_default());
            }
            Ok(names)
        }
        #[cfg(not(feature = "oracle-support"))]
        Err("Oracle not supported".to_string())
    }

    pub async fn list_tables(&self, database: Option<&str>) -> Result<Vec<TableInfo>, String> {
        #[cfg(feature = "oracle-support")]
        {
            let sql = match database {
                Some(owner) if !owner.eq_ignore_ascii_case("USER") => format!(
                    "SELECT table_name, 'TABLE' FROM all_tables WHERE owner='{}' \
                     UNION SELECT view_name, 'VIEW' FROM all_views WHERE owner='{}' ORDER BY 1",
                    owner.to_uppercase().replace('\'', "''"),
                    owner.to_uppercase().replace('\'', "''")
                ),
                _ => "SELECT table_name, 'TABLE' FROM user_tables \
                      UNION SELECT view_name, 'VIEW' FROM user_views ORDER BY 1"
                    .to_string(),
            };
            let rows = self.conn.query(&sql, &[]).map_err(|e| e.to_string())?;
            let mut tables = vec![];
            for row_result in rows {
                let row = row_result.map_err(|e| e.to_string())?;
                tables.push(TableInfo {
                    name: row.get::<_, String>(0).unwrap_or_default(),
                    table_type: if row.get::<_, String>(1).unwrap_or_default() == "VIEW" {
                        "view".to_string()
                    } else {
                        "table".to_string()
                    },
                });
            }
            Ok(tables)
        }
        #[cfg(not(feature = "oracle-support"))]
        {
            let _ = database;
            Err("Oracle not supported".to_string())
        }
    }

    pub async fn execute(&self, sql: &str, _database: Option<&str>) -> Result<QueryResult, String> {
        #[cfg(feature = "oracle-support")]
        {
            use std::time::Instant;
            let start = Instant::now();
            // Try as SELECT first
            match self.conn.query(sql, &[]) {
                Ok(rows) => {
                    let col_info = rows.column_info().to_vec();
                    let columns: Vec<ColumnDef> = col_info
                        .iter()
                        .map(|c| ColumnDef {
                            name: c.name().to_string(),
                            col_type: format!("{:?}", c.oracle_type()),
                            nullable: c.nullable(),
                            is_primary_key: false,
                            default_value: None,
                        })
                        .collect();
                    let ncols = columns.len();
                    let mut result_rows = vec![];
                    for row_result in rows {
                        let row = row_result.map_err(|e| e.to_string())?;
                        let values: Vec<Option<String>> = (0..ncols)
                            .map(|i| row.get::<_, Option<String>>(i).unwrap_or(None))
                            .collect();
                        result_rows.push(values);
                    }
                    Ok(QueryResult {
                        columns,
                        rows: result_rows,
                        affected_rows: 0,
                        last_insert_id: 0,
                        execution_time_ms: start.elapsed().as_secs_f64() * 1000.0,
                        error: None,
                    })
                }
                Err(_) => {
                    match self.conn.execute(sql, &[]) {
                        Ok(stmt) => {
                            let affected = stmt.row_count().unwrap_or(0);
                            self.conn.commit().map_err(|e| e.to_string())?;
                            Ok(QueryResult {
                                affected_rows: affected as u64,
                                execution_time_ms: start.elapsed().as_secs_f64() * 1000.0,
                                ..QueryResult::empty()
                            })
                        }
                        Err(e) => Ok(QueryResult::from_error(e.to_string())),
                    }
                }
            }
        }
        #[cfg(not(feature = "oracle-support"))]
        {
            let _ = sql;
            Err("Oracle not supported".to_string())
        }
    }

    pub async fn table_columns(
        &self,
        table: &str,
        _database: Option<&str>,
    ) -> Result<Vec<ColumnInfo>, String> {
        #[cfg(feature = "oracle-support")]
        {
            let sql = format!(
                "SELECT column_name, data_type, nullable, data_default \
                 FROM user_tab_columns WHERE table_name='{}' ORDER BY column_id",
                table.to_uppercase().replace('\'', "''")
            );
            let rows = self.conn.query(&sql, &[]).map_err(|e| e.to_string())?;
            let mut cols = vec![];
            for row_result in rows {
                let row = row_result.map_err(|e| e.to_string())?;
                cols.push(ColumnInfo {
                    name: row.get::<_, String>(0).unwrap_or_default(),
                    col_type: row.get::<_, String>(1).unwrap_or_default(),
                    nullable: row.get::<_, String>(2).unwrap_or_default() == "Y",
                    key_type: String::new(),
                    default_value: row.get::<_, Option<String>>(3).unwrap_or(None),
                    extra: String::new(),
                    charset: String::new(),
                    collation: String::new(),
                    comment: String::new(),
                });
            }
            Ok(cols)
        }
        #[cfg(not(feature = "oracle-support"))]
        {
            let _ = (table, _database);
            Err("Oracle not supported".to_string())
        }
    }

    pub async fn get_create_table_sql(&self, table: &str, database: Option<&str>) -> Result<String, String> {
        #[cfg(feature = "oracle-support")]
        {
            let schema = database.unwrap_or("");
            let sql = if schema.is_empty() {
                format!(
                    "SELECT DBMS_METADATA.GET_DDL('TABLE', '{}') FROM DUAL",
                    table.to_uppercase().replace('\'', "''")
                )
            } else {
                format!(
                    "SELECT DBMS_METADATA.GET_DDL('TABLE', '{}', '{}') FROM DUAL",
                    table.to_uppercase().replace('\'', "''"),
                    schema.to_uppercase().replace('\'', "''")
                )
            };
            let result = self.execute(&sql).await?;
            if let Some(row) = result.rows.first() {
                if let Some(Some(ddl)) = row.first() {
                    return Ok(ddl.clone());
                }
            }
            Err(format!("Could not get DDL for table {}", table))
        }
        #[cfg(not(feature = "oracle-support"))]
        {
            let _ = (table, database);
            Err("Oracle not supported".to_string())
        }
    }

    pub async fn table_foreign_keys(&self, _table: &str, _database: Option<&str>) -> Result<Vec<ForeignKeyInfo>, String> {
        Ok(vec![])
    }

    pub async fn table_triggers(&self, _table: &str, _database: Option<&str>) -> Result<Vec<TriggerInfo>, String> {
        Ok(vec![])
    }

    pub async fn table_info(&self, _table: &str, _database: Option<&str>) -> Result<TableInfoData, String> {
        Ok(TableInfoData {
            row_count: "N/A".into(), size: "N/A".into(), data_size: "N/A".into(),
            index_size: "N/A".into(), auto_increment: None, engine: "Oracle".into(),
            collation: "N/A".into(), created: "N/A".into(), comment: String::new(),
        })
    }

    pub async fn table_indexes(
        &self,
        table: &str,
        _database: Option<&str>,
    ) -> Result<Vec<IndexInfo>, String> {
        #[cfg(feature = "oracle-support")]
        {
            let sql = format!(
                "SELECT i.index_name, i.uniqueness, ic.column_name, i.index_type \
                 FROM user_indexes i \
                 JOIN user_ind_columns ic ON i.index_name = ic.index_name \
                 WHERE i.table_name='{}' ORDER BY i.index_name, ic.column_position",
                table.to_uppercase().replace('\'', "''")
            );
            let rows = self.conn.query(&sql, &[]).map_err(|e| e.to_string())?;
            let mut map: std::collections::HashMap<String, IndexInfo> =
                std::collections::HashMap::new();
            for row_result in rows {
                let row = row_result.map_err(|e| e.to_string())?;
                let name: String = row.get(0).unwrap_or_default();
                let unique: String = row.get(1).unwrap_or_default();
                let col: String = row.get(2).unwrap_or_default();
                let idx_type: String = row.get(3).unwrap_or_default();
                let entry = map.entry(name.clone()).or_insert(IndexInfo {
                    name: name.clone(),
                    columns: vec![],
                    unique: unique == "UNIQUE",
                    index_type: idx_type,
                });
                entry.columns.push(col);
            }
            Ok(map.into_values().collect())
        }
        #[cfg(not(feature = "oracle-support"))]
        {
            let _ = (table, _database);
            Err("Oracle not supported".to_string())
        }
    }
}
