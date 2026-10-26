use mysql_async::consts::ColumnFlags;
use mysql_async::prelude::*;
use mysql_async::{Opts, OptsBuilder, Pool, Row, SslOpts, Value};
use std::collections::HashMap;
use std::time::Instant;

use super::types::*;

pub struct MysqlConn {
    pool: Pool,
    pub current_db: Option<String>,
}

fn value_to_string(v: Value) -> String {
    match v {
        Value::NULL => String::new(),
        Value::Bytes(b) => String::from_utf8_lossy(&b).to_string(),
        Value::Int(n) => n.to_string(),
        Value::UInt(n) => n.to_string(),
        Value::Float(f) => f.to_string(),
        Value::Double(f) => f.to_string(),
        Value::Date(y, mo, d, h, mi, s, _us) => {
            format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", y, mo, d, h, mi, s)
        }
        Value::Time(neg, days, h, mi, s, _us) => {
            let total_h = days * 24 + h as u32;
            format!("{}{}:{:02}:{:02}", if neg { "-" } else { "" }, total_h, mi, s)
        }
    }
}

impl MysqlConn {
    pub async fn new(
        host: &str,
        port: u16,
        user: &str,
        pass: &str,
        db: Option<&str>,
        require_ssl: bool,
    ) -> Result<Self, String> {
        let mut builder = OptsBuilder::default()
            .ip_or_hostname(host)
            .tcp_port(port)
            .user(Some(user.to_string()))
            .pass(Some(pass.to_string()));
        if let Some(d) = db {
            builder = builder.db_name(Some(d.to_string()));
        }
        if require_ssl {
            builder = builder.ssl_opts(SslOpts::default());
        }
        let opts = Opts::from(builder);
        let pool = Pool::new(opts);
        // Test the connection
        let conn = pool.get_conn().await.map_err(|e| e.to_string())?;
        conn.disconnect().await.map_err(|e| e.to_string())?;
        Ok(Self {
            pool,
            current_db: db.map(|s| s.to_string()),
        })
    }

    pub async fn list_databases(&self) -> Result<Vec<String>, String> {
        let mut conn = self.pool.get_conn().await.map_err(|e| e.to_string())?;
        conn.query("SHOW DATABASES")
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn list_tables(&self, database: Option<&str>) -> Result<Vec<TableInfo>, String> {
        let db = database
            .or(self.current_db.as_deref())
            .unwrap_or("information_schema");
        let sql = format!(
            "SHOW FULL TABLES FROM `{}`",
            db.replace('`', "``")
        );
        let mut conn = self.pool.get_conn().await.map_err(|e| e.to_string())?;
        let rows: Vec<Row> = conn.query(sql).await.map_err(|e| e.to_string())?;
        let tables = rows
            .into_iter()
            .map(|mut row| {
                let name: String = row.take(0).unwrap_or_default();
                let t: String = row.take(1).unwrap_or_default();
                TableInfo {
                    name,
                    table_type: if t == "VIEW" {
                        "view".to_string()
                    } else {
                        "table".to_string()
                    },
                }
            })
            .collect();
        Ok(tables)
    }

    pub async fn execute(&self, sql: &str, database: Option<&str>) -> Result<QueryResult, String> {
        let start = Instant::now();
        let mut conn = self.pool.get_conn().await.map_err(|e| e.to_string())?;

        if let Some(db) = database.or(self.current_db.as_deref()) {
            let use_sql = format!("USE `{}`", db.replace('`', "``"));
            if let Err(e) = conn.query_drop(use_sql).await {
                return Ok(QueryResult::from_error(e.to_string()));
            }
        }

        let mut qr = match conn.query_iter(sql).await {
            Err(e) => return Ok(QueryResult::from_error(e.to_string())),
            Ok(r) => r,
        };

        // Capture column metadata before consuming the result
        let columns: Vec<ColumnDef> = qr
            .columns_ref()
            .iter()
            .map(|c| ColumnDef {
                name: c.name_str().to_string(),
                col_type: format!("{:?}", c.column_type()),
                nullable: !c.flags().contains(ColumnFlags::NOT_NULL_FLAG),
                is_primary_key: c.flags().contains(ColumnFlags::PRI_KEY_FLAG),
                default_value: None,
            })
            .collect();

        let ncols = columns.len();
        let mut all_rows: Vec<Vec<Option<String>>> = vec![];

        // Collect raw rows
        let raw: Vec<Row> = qr.collect().await.map_err(|e| e.to_string())?;

        for mut row in raw {
            let values = (0..ncols)
                .map(|i| match row.take::<Value, usize>(i) {
                    Some(Value::NULL) | None => None,
                    Some(v) => Some(value_to_string(v)),
                })
                .collect();
            all_rows.push(values);
        }

        Ok(QueryResult {
            columns,
            rows: all_rows,
            affected_rows: qr.affected_rows(),
            last_insert_id: qr.last_insert_id().unwrap_or(0),
            execution_time_ms: start.elapsed().as_secs_f64() * 1000.0,
            error: None,
        })
    }

    pub async fn table_columns(
        &self,
        table: &str,
        database: Option<&str>,
    ) -> Result<Vec<ColumnInfo>, String> {
        let db = database
            .or(self.current_db.as_deref())
            .unwrap_or("information_schema");
        let sql = format!(
            "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, \
             COLUMN_DEFAULT, EXTRA, IFNULL(CHARACTER_SET_NAME,''), \
             IFNULL(COLLATION_NAME,''), IFNULL(COLUMN_COMMENT,'') \
             FROM information_schema.COLUMNS \
             WHERE TABLE_SCHEMA='{}' AND TABLE_NAME='{}' \
             ORDER BY ORDINAL_POSITION",
            db.replace('\'', "\\'"),
            table.replace('\'', "\\'")
        );
        let mut conn = self.pool.get_conn().await.map_err(|e| e.to_string())?;
        let rows: Vec<Row> = conn.query(sql).await.map_err(|e| e.to_string())?;
        let cols = rows
            .into_iter()
            .map(|mut row| {
                let null_str: Option<String> = row.take(2);
                ColumnInfo {
                    name:          row.take::<Option<String>, _>(0).flatten().unwrap_or_default(),
                    col_type:      row.take::<Option<String>, _>(1).flatten().unwrap_or_default(),
                    nullable:      null_str.as_deref() == Some("YES"),
                    key_type:      row.take::<Option<String>, _>(3).flatten().unwrap_or_default(),
                    default_value: row.take::<Option<String>, _>(4).flatten(),
                    extra:         row.take::<Option<String>, _>(5).flatten().unwrap_or_default(),
                    charset:       row.take::<Option<String>, _>(6).flatten().unwrap_or_default(),
                    collation:     row.take::<Option<String>, _>(7).flatten().unwrap_or_default(),
                    comment:       row.take::<Option<String>, _>(8).flatten().unwrap_or_default(),
                }
            })
            .collect();
        Ok(cols)
    }

    pub async fn get_create_table_sql(&self, table: &str, database: Option<&str>) -> Result<String, String> {
        let db = database.or(self.current_db.as_deref()).unwrap_or("");
        let sql = if db.is_empty() {
            format!("SHOW CREATE TABLE `{}`", table.replace('`', "``"))
        } else {
            format!("SHOW CREATE TABLE `{}`.`{}`", db.replace('`', "``"), table.replace('`', "``"))
        };
        let mut conn = self.pool.get_conn().await.map_err(|e| e.to_string())?;
        let rows: Vec<Row> = conn.query(sql).await.map_err(|e| e.to_string())?;
        if let Some(mut row) = rows.into_iter().next() {
            let ddl: String = row.take::<Option<String>, _>(1).flatten().unwrap_or_default();
            Ok(ddl)
        } else {
            Err(format!("Table {} not found", table))
        }
    }

    pub async fn table_indexes(
        &self,
        table: &str,
        database: Option<&str>,
    ) -> Result<Vec<IndexInfo>, String> {
        let db = database
            .or(self.current_db.as_deref())
            .unwrap_or("information_schema");
        let sql = format!(
            "SHOW INDEX FROM `{}`.`{}`",
            db.replace('`', "``"),
            table.replace('`', "``")
        );
        let mut conn = self.pool.get_conn().await.map_err(|e| e.to_string())?;
        let rows: Vec<Row> = conn.query(sql).await.map_err(|e| e.to_string())?;

        // SHOW INDEX: 0=Table 1=Non_unique 2=Key_name 3=Seq 4=Column_name 5=Collation(nullable)
        //             6=Cardinality 7=Sub_part(nullable) 8=Packed(nullable) 9=Null 10=Index_type
        //             11=Comment 12=Index_comment 13=Visible 14=Expression(nullable, MySQL 8+)
        let mut index_map: HashMap<String, IndexInfo> = HashMap::new();
        for mut row in rows {
            let non_unique: Option<i64> = row.take(1);
            let name: String = row.take::<Option<String>, _>(2).flatten().unwrap_or_default();
            let col: String = row.take::<Option<String>, _>(4).flatten().unwrap_or_default();
            let idx_type: String = row.take::<Option<String>, _>(10).flatten().unwrap_or_else(|| "BTREE".to_string());
            let non_unique = non_unique.unwrap_or(1);

            let entry = index_map.entry(name.clone()).or_insert(IndexInfo {
                name: name.clone(),
                columns: vec![],
                unique: non_unique == 0,
                index_type: idx_type,
            });
            entry.columns.push(col);
        }

        Ok(index_map.into_values().collect())
    }

    pub async fn table_foreign_keys(&self, table: &str, database: Option<&str>) -> Result<Vec<ForeignKeyInfo>, String> {
        let db = database.or(self.current_db.as_deref()).unwrap_or("information_schema");
        let sql = format!(
            "SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME \
             FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE \
             WHERE TABLE_NAME='{}' AND TABLE_SCHEMA='{}' AND REFERENCED_TABLE_NAME IS NOT NULL \
             ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION",
            table.replace('\'', "\\'"), db.replace('\'', "\\'")
        );
        let mut conn = self.pool.get_conn().await.map_err(|e| e.to_string())?;
        let rows: Vec<Row> = conn.query(sql).await.map_err(|e| e.to_string())?;
        Ok(rows.into_iter().map(|mut r| ForeignKeyInfo {
            constraint_name: r.take::<Option<String>, _>(0).flatten().unwrap_or_default(),
            column_name: r.take::<Option<String>, _>(1).flatten().unwrap_or_default(),
            referenced_table: r.take::<Option<String>, _>(2).flatten().unwrap_or_default(),
            referenced_column: r.take::<Option<String>, _>(3).flatten().unwrap_or_default(),
        }).collect())
    }

    pub async fn table_triggers(&self, table: &str, database: Option<&str>) -> Result<Vec<TriggerInfo>, String> {
        let db = database.or(self.current_db.as_deref()).unwrap_or("information_schema");
        let sql = format!(
            "SELECT TRIGGER_NAME, EVENT_MANIPULATION, ACTION_TIMING, ACTION_STATEMENT \
             FROM INFORMATION_SCHEMA.TRIGGERS \
             WHERE EVENT_OBJECT_TABLE='{}' AND TRIGGER_SCHEMA='{}' ORDER BY TRIGGER_NAME",
            table.replace('\'', "\\'"), db.replace('\'', "\\'")
        );
        let mut conn = self.pool.get_conn().await.map_err(|e| e.to_string())?;
        let rows: Vec<Row> = conn.query(sql).await.map_err(|e| e.to_string())?;
        Ok(rows.into_iter().map(|mut r| TriggerInfo {
            name: r.take::<Option<String>, _>(0).flatten().unwrap_or_default(),
            event: r.take::<Option<String>, _>(1).flatten().unwrap_or_default(),
            timing: r.take::<Option<String>, _>(2).flatten().unwrap_or_default(),
            statement: r.take::<Option<String>, _>(3).flatten().unwrap_or_default(),
        }).collect())
    }

    pub async fn table_info(&self, table: &str, database: Option<&str>) -> Result<TableInfoData, String> {
        let db = database.or(self.current_db.as_deref()).unwrap_or("information_schema");
        let sql = format!(
            "SELECT TABLE_ROWS, \
             ROUND((DATA_LENGTH+INDEX_LENGTH)/1024/1024,2), \
             ENGINE, TABLE_COLLATION, \
             DATE_FORMAT(CREATE_TIME,'%Y-%m-%d %H:%i:%s'), \
             TABLE_COMMENT, AUTO_INCREMENT, \
             ROUND(DATA_LENGTH/1024/1024,2), \
             ROUND(INDEX_LENGTH/1024/1024,2) \
             FROM information_schema.TABLES WHERE TABLE_NAME='{}' AND TABLE_SCHEMA='{}'",
            table.replace('\'', "\\'"), db.replace('\'', "\\'")
        );
        let mut conn = self.pool.get_conn().await.map_err(|e| e.to_string())?;
        let rows: Vec<Row> = conn.query(sql).await.map_err(|e| e.to_string())?;
        if let Some(mut r) = rows.into_iter().next() {
            let row_count = r.take::<Option<String>, _>(0).flatten().unwrap_or_else(|| "~0".to_string());
            let size = format!("{} MB", r.take::<Option<String>, _>(1).flatten().unwrap_or_else(|| "0".to_string()));
            let engine = r.take::<Option<String>, _>(2).flatten().unwrap_or_default();
            let collation = r.take::<Option<String>, _>(3).flatten().unwrap_or_default();
            let created = r.take::<Option<String>, _>(4).flatten().unwrap_or_default();
            let comment = r.take::<Option<String>, _>(5).flatten().unwrap_or_default();
            let auto_increment = r.take::<Option<String>, _>(6).flatten();
            let data_size = format!("{} MB", r.take::<Option<String>, _>(7).flatten().unwrap_or_else(|| "0".to_string()));
            let index_size = format!("{} MB", r.take::<Option<String>, _>(8).flatten().unwrap_or_else(|| "0".to_string()));
            Ok(TableInfoData { row_count, size, data_size, index_size, engine, collation, created, comment, auto_increment })
        } else {
            Ok(TableInfoData {
                row_count: "0".into(), size: "N/A".into(), data_size: "N/A".into(),
                index_size: "N/A".into(), engine: "N/A".into(), collation: "N/A".into(),
                created: "N/A".into(), comment: String::new(), auto_increment: None,
            })
        }
    }

    // ── User management ──────────────────────────────────────────────────────

    pub async fn list_users(&self) -> Result<Vec<super::types::MysqlUser>, String> {
        let mut conn = self.pool.get_conn().await.map_err(|e| e.to_string())?;
        let rows: Vec<Row> = conn
            .query("SELECT User, Host FROM mysql.user ORDER BY User, Host")
            .await
            .map_err(|e| e.to_string())?;
        Ok(rows
            .into_iter()
            .map(|mut row| super::types::MysqlUser {
                username: row.take::<String, _>(0).unwrap_or_default(),
                host: row.take::<String, _>(1).unwrap_or_default(),
            })
            .collect())
    }

    pub async fn create_user(&self, username: &str, host: &str, password: &str) -> Result<(), String> {
        let mut conn = self.pool.get_conn().await.map_err(|e| e.to_string())?;
        let sql = format!(
            "CREATE USER '{}'@'{}' IDENTIFIED BY '{}'",
            username.replace('\'', "\\'"),
            host.replace('\'', "\\'"),
            password.replace('\'', "\\'")
        );
        conn.query_drop(sql).await.map_err(|e| e.to_string())
    }

    pub async fn drop_user(&self, username: &str, host: &str) -> Result<(), String> {
        let mut conn = self.pool.get_conn().await.map_err(|e| e.to_string())?;
        let sql = format!(
            "DROP USER '{}'@'{}'",
            username.replace('\'', "\\'"),
            host.replace('\'', "\\'")
        );
        conn.query_drop(sql).await.map_err(|e| e.to_string())
    }

    pub async fn set_password(&self, username: &str, host: &str, password: &str) -> Result<(), String> {
        let mut conn = self.pool.get_conn().await.map_err(|e| e.to_string())?;
        let sql = format!(
            "ALTER USER '{}'@'{}' IDENTIFIED BY '{}'",
            username.replace('\'', "\\'"),
            host.replace('\'', "\\'"),
            password.replace('\'', "\\'")
        );
        conn.query_drop(sql).await.map_err(|e| e.to_string())
    }

    pub async fn get_global_privs(&self, username: &str, host: &str) -> Result<Vec<String>, String> {
        let mut conn = self.pool.get_conn().await.map_err(|e| e.to_string())?;
        let grantee = format!("'{}'@'{}'", username.replace('\'', "\\'"), host.replace('\'', "\\'"));
        let rows: Vec<Row> = conn
            .exec(
                "SELECT PRIVILEGE_TYPE FROM information_schema.USER_PRIVILEGES WHERE GRANTEE = ?",
                (grantee,),
            )
            .await
            .map_err(|e| e.to_string())?;
        Ok(rows
            .into_iter()
            .map(|mut r| r.take::<String, _>(0).unwrap_or_default())
            .collect())
    }

    pub async fn set_global_privs(&self, username: &str, host: &str, privs: Vec<String>) -> Result<(), String> {
        let mut conn = self.pool.get_conn().await.map_err(|e| e.to_string())?;
        let user_host = format!(
            "'{}'@'{}'",
            username.replace('\'', "\\'"),
            host.replace('\'', "\\'")
        );
        // Revoke all first
        let revoke = format!("REVOKE ALL PRIVILEGES, GRANT OPTION FROM {}", user_host);
        conn.query_drop(&revoke).await.map_err(|e| e.to_string())?;

        if !privs.is_empty() {
            // Separate GRANT OPTION from other privs
            let has_grant_option = privs.iter().any(|p| p.eq_ignore_ascii_case("GRANT OPTION"));
            let other_privs: Vec<&str> = privs
                .iter()
                .filter(|p| !p.eq_ignore_ascii_case("GRANT OPTION"))
                .map(|p| p.as_str())
                .collect();

            if !other_privs.is_empty() {
                let priv_list = other_privs.join(", ");
                let grant = if has_grant_option {
                    format!("GRANT {} ON *.* TO {} WITH GRANT OPTION", priv_list, user_host)
                } else {
                    format!("GRANT {} ON *.* TO {}", priv_list, user_host)
                };
                conn.query_drop(&grant).await.map_err(|e| e.to_string())?;
            } else if has_grant_option {
                let grant = format!("GRANT USAGE ON *.* TO {} WITH GRANT OPTION", user_host);
                conn.query_drop(&grant).await.map_err(|e| e.to_string())?;
            }
        }

        conn.query_drop("FLUSH PRIVILEGES").await.map_err(|e| e.to_string())
    }

    pub async fn get_schema_privs_for_user(&self, username: &str, host: &str) -> Result<Vec<super::types::MysqlSchemaPriv>, String> {
        let mut conn = self.pool.get_conn().await.map_err(|e| e.to_string())?;
        let grantee = format!("'{}'@'{}'", username.replace('\'', "\\'"), host.replace('\'', "\\'"));
        let rows: Vec<Row> = conn
            .exec(
                "SELECT TABLE_SCHEMA, PRIVILEGE_TYPE FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE = ? ORDER BY TABLE_SCHEMA, PRIVILEGE_TYPE",
                (grantee,),
            )
            .await
            .map_err(|e| e.to_string())?;
        Ok(rows
            .into_iter()
            .map(|mut r| super::types::MysqlSchemaPriv {
                schema: r.take::<String, _>(0).unwrap_or_default(),
                privilege_type: r.take::<String, _>(1).unwrap_or_default(),
            })
            .collect())
    }

    pub async fn set_schema_privs(&self, username: &str, host: &str, schema: &str, privs: Vec<String>) -> Result<(), String> {
        let mut conn = self.pool.get_conn().await.map_err(|e| e.to_string())?;
        let user_host = format!(
            "'{}'@'{}'",
            username.replace('\'', "\\'"),
            host.replace('\'', "\\'")
        );
        let schema_q = format!("`{}`", schema.replace('`', "``"));
        let revoke = format!("REVOKE ALL PRIVILEGES ON {}.* FROM {}", schema_q, user_host);
        conn.query_drop(&revoke).await.map_err(|e| e.to_string())?;

        if !privs.is_empty() {
            let has_grant_option = privs.iter().any(|p| p.eq_ignore_ascii_case("GRANT OPTION"));
            let other_privs: Vec<&str> = privs
                .iter()
                .filter(|p| !p.eq_ignore_ascii_case("GRANT OPTION"))
                .map(|p| p.as_str())
                .collect();
            if !other_privs.is_empty() {
                let priv_list = other_privs.join(", ");
                let grant = if has_grant_option {
                    format!("GRANT {} ON {}.* TO {} WITH GRANT OPTION", priv_list, schema_q, user_host)
                } else {
                    format!("GRANT {} ON {}.* TO {}", priv_list, schema_q, user_host)
                };
                conn.query_drop(&grant).await.map_err(|e| e.to_string())?;
            }
        }

        conn.query_drop("FLUSH PRIVILEGES").await.map_err(|e| e.to_string())
    }

    pub async fn get_resource_limits(&self, username: &str, host: &str) -> Result<super::types::MysqlResourceLimits, String> {
        let mut conn = self.pool.get_conn().await.map_err(|e| e.to_string())?;
        let rows: Vec<Row> = conn
            .exec(
                "SELECT max_updates, max_connections, max_questions FROM mysql.user WHERE User = ? AND Host = ?",
                (username, host),
            )
            .await
            .map_err(|e| e.to_string())?;
        if let Some(mut r) = rows.into_iter().next() {
            Ok(super::types::MysqlResourceLimits {
                max_updates: r.take::<u64, _>(0).unwrap_or(0),
                max_connections: r.take::<u64, _>(1).unwrap_or(0),
                max_questions: r.take::<u64, _>(2).unwrap_or(0),
            })
        } else {
            Ok(super::types::MysqlResourceLimits { max_updates: 0, max_connections: 0, max_questions: 0 })
        }
    }

    pub async fn set_resource_limits(&self, username: &str, host: &str, max_updates: u64, max_connections: u64, max_questions: u64) -> Result<(), String> {
        let mut conn = self.pool.get_conn().await.map_err(|e| e.to_string())?;
        let sql = format!(
            "ALTER USER '{}'@'{}' WITH MAX_UPDATES_PER_HOUR {} MAX_CONNECTIONS_PER_HOUR {} MAX_QUERIES_PER_HOUR {}",
            username.replace('\'', "\\'"),
            host.replace('\'', "\\'"),
            max_updates,
            max_connections,
            max_questions
        );
        conn.query_drop(&sql).await.map_err(|e| e.to_string())?;
        conn.query_drop("FLUSH PRIVILEGES").await.map_err(|e| e.to_string())
    }
}
