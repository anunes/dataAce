use std::time::Instant;
use tokio_postgres::{Client, NoTls, Row};

use super::types::*;

pub struct PostgresConn {
    pub client: Client,
    pub current_db: String,
}

impl PostgresConn {
    pub async fn new(
        host: &str,
        port: u16,
        user: &str,
        pass: &str,
        db: &str,
    ) -> Result<Self, String> {
        let dbname = if db.is_empty() { "postgres" } else { db };
        let config = format!(
            "host={} port={} user={} password={} dbname={}",
            host, port, user, pass, dbname
        );
        let (client, connection) = tokio_postgres::connect(&config, NoTls)
            .await
            .map_err(|e| e.to_string())?;
        tokio::spawn(async move {
            let _ = connection.await;
        });
        Ok(Self {
            client,
            current_db: dbname.to_string(),
        })
    }

    pub async fn list_databases(&self) -> Result<Vec<String>, String> {
        let rows = self
            .client
            .query(
                "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname",
                &[],
            )
            .await
            .map_err(|e| e.to_string())?;
        Ok(rows.iter().map(|r| r.get::<_, String>(0)).collect())
    }

    pub async fn list_tables(&self, _database: Option<&str>) -> Result<Vec<TableInfo>, String> {
        let rows = self
            .client
            .query(
                "SELECT table_name, table_type FROM information_schema.tables \
                 WHERE table_schema = 'public' ORDER BY table_name",
                &[],
            )
            .await
            .map_err(|e| e.to_string())?;
        Ok(rows
            .iter()
            .map(|r| TableInfo {
                name: r.get(0),
                table_type: if r.get::<_, String>(1) == "VIEW" {
                    "view".to_string()
                } else {
                    "table".to_string()
                },
            })
            .collect())
    }

    /// Run a statement that cannot be inside a transaction block (e.g. CREATE/DROP DATABASE).
    /// Uses simple_query so PostgreSQL never wraps it in an implicit transaction.
    pub async fn simple_execute(&self, sql: &str) -> Result<QueryResult, String> {
        let start = Instant::now();
        self.client
            .simple_query(sql)
            .await
            .map_err(|e| e.to_string())?;
        Ok(QueryResult {
            affected_rows: 0,
            execution_time_ms: start.elapsed().as_secs_f64() * 1000.0,
            ..QueryResult::empty()
        })
    }

    pub async fn execute(&self, sql: &str, database: Option<&str>) -> Result<QueryResult, String> {
        let start = Instant::now();

        if let Some(db) = database {
            let set_sql = format!("SET search_path TO \"{}\"", db.replace('"', "\"\""));
            if let Err(e) = self.client.execute(set_sql.as_str(), &[]).await {
                return Ok(QueryResult::from_error(e.to_string()));
            }
        }

        let upper = sql.trim().to_uppercase();
        let is_query = upper.starts_with("SELECT")
            || upper.starts_with("WITH")
            || upper.starts_with("SHOW")
            || upper.starts_with("EXPLAIN")
            || upper.starts_with("TABLE");

        if is_query {
            // Prepare first so we always get column metadata even for empty result sets.
            let stmt = match self.client.prepare(sql).await {
                Ok(s) => s,
                Err(e) => return Ok(QueryResult::from_error(e.to_string())),
            };
            let columns: Vec<ColumnDef> = stmt
                .columns()
                .iter()
                .map(|c| ColumnDef {
                    name: c.name().to_string(),
                    col_type: c.type_().name().to_string(),
                    nullable: true,
                    is_primary_key: false,
                    default_value: None,
                })
                .collect();
            match self.client.query(&stmt, &[]).await {
                Ok(rows) => {
                    let ncols = columns.len();
                    let result_rows = rows
                        .iter()
                        .map(|row| (0..ncols).map(|i| pg_value_to_string(row, i)).collect())
                        .collect();
                    Ok(QueryResult {
                        columns,
                        rows: result_rows,
                        affected_rows: 0,
                        last_insert_id: 0,
                        execution_time_ms: start.elapsed().as_secs_f64() * 1000.0,
                        error: None,
                    })
                }
                Err(e) => Ok(QueryResult::from_error(e.to_string())),
            }
        } else {
            match self.client.execute(sql, &[]).await {
                Ok(affected) => Ok(QueryResult {
                    affected_rows: affected,
                    execution_time_ms: start.elapsed().as_secs_f64() * 1000.0,
                    ..QueryResult::empty()
                }),
                Err(e) => Ok(QueryResult::from_error(e.to_string())),
            }
        }
    }

    pub async fn table_columns(
        &self,
        table: &str,
        _database: Option<&str>,
    ) -> Result<Vec<ColumnInfo>, String> {
        let sql = "
            SELECT c.column_name, c.data_type, c.is_nullable, c.column_default,
                   CASE WHEN pk.column_name IS NOT NULL THEN 'PRI' ELSE '' END as key_type,
                   CASE WHEN c.column_default LIKE 'nextval%' THEN 'auto_increment' ELSE '' END as extra
            FROM information_schema.columns c
            LEFT JOIN (
                SELECT ku.column_name
                FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage ku
                  ON tc.constraint_name = ku.constraint_name
                  AND tc.table_schema = ku.table_schema
                WHERE tc.constraint_type = 'PRIMARY KEY'
                  AND tc.table_name = $1
                  AND tc.table_schema = 'public'
            ) pk ON c.column_name = pk.column_name
            WHERE c.table_name = $1 AND c.table_schema = 'public'
            ORDER BY c.ordinal_position";
        let rows = self
            .client
            .query(sql, &[&table])
            .await
            .map_err(|e| e.to_string())?;
        Ok(rows
            .iter()
            .map(|r| ColumnInfo {
                name: r.get(0),
                col_type: r.get(1),
                nullable: r.get::<_, String>(2) == "YES",
                default_value: r.get(3),
                key_type: r.get(4),
                extra: r.get(5),
                charset: String::new(),
                collation: String::new(),
                comment: String::new(),
            })
            .collect())
    }

    pub async fn get_create_table_sql(&self, table: &str, _database: Option<&str>) -> Result<String, String> {
        // `database` here is the PG database name (from pg_database), not a schema name.
        // Tables live in the "public" schema by default.
        let schema = "public";
        let sql = format!(
            "SELECT column_name, data_type, character_maximum_length, is_nullable, column_default \
             FROM information_schema.columns \
             WHERE table_schema = '{}' AND table_name = '{}' \
             ORDER BY ordinal_position",
            schema.replace('\'', "''"),
            table.replace('\'', "''")
        );
        let rows = self.client.query(&sql, &[]).await.map_err(|e| e.to_string())?;
        if rows.is_empty() {
            return Err(format!("Table {} not found in schema {}", table, schema));
        }
        let col_defs: Vec<String> = rows.iter().map(|row| {
            let col_name: String = row.get(0);
            let data_type: String = row.get(1);
            let char_max_len: Option<i32> = row.get(2);
            let is_nullable: String = row.get(3);
            let col_default: Option<String> = row.get(4);
            let type_str = match char_max_len {
                Some(len) => format!("{}({})", data_type, len),
                None => data_type,
            };
            let mut def = format!("  \"{}\" {}", col_name, type_str);
            if let Some(default) = col_default {
                def.push_str(&format!(" DEFAULT {}", default));
            }
            if is_nullable == "NO" {
                def.push_str(" NOT NULL");
            }
            def
        }).collect();
        Ok(format!(
            "CREATE TABLE \"{}\".\"{}\" (\n{}\n)",
            schema, table, col_defs.join(",\n")
        ))
    }

    pub async fn table_indexes(
        &self,
        table: &str,
        _database: Option<&str>,
    ) -> Result<Vec<IndexInfo>, String> {
        let sql = "
            SELECT i.relname, ix.indisunique,
                   array_agg(a.attname ORDER BY array_position(ix.indkey, a.attnum)),
                   am.amname
            FROM pg_class t
            JOIN pg_index ix ON t.oid = ix.indrelid
            JOIN pg_class i ON i.oid = ix.indexrelid
            JOIN pg_am am ON i.relam = am.oid
            JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
            WHERE t.relname = $1 AND t.relkind = 'r'
            GROUP BY i.relname, ix.indisunique, am.amname";
        let rows = self
            .client
            .query(sql, &[&table])
            .await
            .map_err(|e| e.to_string())?;
        Ok(rows
            .iter()
            .map(|r| {
                let cols: Vec<String> = r.get(2);
                IndexInfo {
                    name: r.get(0),
                    unique: r.get(1),
                    columns: cols,
                    index_type: r.get::<_, String>(3).to_uppercase(),
                }
            })
            .collect())
    }

    pub async fn table_foreign_keys(&self, table: &str, _database: Option<&str>) -> Result<Vec<ForeignKeyInfo>, String> {
        let sql = "SELECT tc.constraint_name, kcu.column_name, ccu.table_name, ccu.column_name \
             FROM information_schema.table_constraints tc \
             JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema \
             JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name=tc.constraint_name AND ccu.table_schema=tc.table_schema \
             WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_name=$1 AND tc.table_schema='public' \
             ORDER BY tc.constraint_name, kcu.ordinal_position";
        let rows = self.client.query(sql, &[&table]).await.map_err(|e| e.to_string())?;
        Ok(rows.iter().map(|r| ForeignKeyInfo {
            constraint_name: r.get(0),
            column_name: r.get(1),
            referenced_table: r.get(2),
            referenced_column: r.get(3),
        }).collect())
    }

    pub async fn table_triggers(&self, table: &str, _database: Option<&str>) -> Result<Vec<TriggerInfo>, String> {
        let sql = "SELECT trigger_name, event_manipulation, action_timing, action_statement \
             FROM information_schema.triggers \
             WHERE event_object_table=$1 AND trigger_schema='public' ORDER BY trigger_name";
        let rows = self.client.query(sql, &[&table]).await.map_err(|e| e.to_string())?;
        Ok(rows.iter().map(|r| TriggerInfo {
            name: r.get(0),
            event: r.get(1),
            timing: r.get(2),
            statement: r.get(3),
        }).collect())
    }

    pub async fn table_info(&self, table: &str, _database: Option<&str>) -> Result<TableInfoData, String> {
        let count_sql = format!("SELECT COUNT(*) FROM \"{}\"", table.replace('"', "\"\""));
        let count: i64 = self.client.query_one(&count_sql, &[]).await
            .map(|r| r.get::<_, i64>(0)).unwrap_or(0);
        let size_sql = "SELECT pg_size_pretty(pg_total_relation_size($1::regclass))";
        let size = self.client.query_one(size_sql, &[&format!("\"{}\"", table)]).await
            .map(|r| r.get::<_, String>(0)).unwrap_or_else(|_| "N/A".to_string());
        Ok(TableInfoData {
            row_count: count.to_string(),
            size,
            data_size: "N/A".into(),
            index_size: "N/A".into(),
            auto_increment: None,
            engine: "PostgreSQL".into(),
            collation: "N/A".into(),
            created: "N/A".into(),
            comment: String::new(),
        })
    }
}

fn pg_value_to_string(row: &Row, idx: usize) -> Option<String> {
    use tokio_postgres::types::Type;
    let col = &row.columns()[idx];
    match *col.type_() {
        Type::BOOL => row.get::<_, Option<bool>>(idx).map(|v| v.to_string()),
        Type::INT2 => row.get::<_, Option<i16>>(idx).map(|v| v.to_string()),
        Type::INT4 => row.get::<_, Option<i32>>(idx).map(|v| v.to_string()),
        Type::INT8 => row.get::<_, Option<i64>>(idx).map(|v| v.to_string()),
        Type::FLOAT4 => row.get::<_, Option<f32>>(idx).map(|v| v.to_string()),
        Type::FLOAT8 => row.get::<_, Option<f64>>(idx).map(|v| v.to_string()),
        _ => row.get::<_, Option<String>>(idx),
    }
}
