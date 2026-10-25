use rusqlite::types::ValueRef;
use rusqlite::Connection;
use std::time::Instant;

use super::types::*;

pub struct SqliteConn {
    pub conn: Connection,
    pub path: String,
}

impl SqliteConn {
    pub fn new(path: &str) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
            .map_err(|e| e.to_string())?;
        Ok(Self {
            conn,
            path: path.to_string(),
        })
    }

    pub fn list_databases(&self) -> Result<Vec<String>, String> {
        let name = if self.path == ":memory:" {
            "memory".to_string()
        } else {
            std::path::Path::new(&self.path)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("main")
                .to_string()
        };
        Ok(vec![name])
    }

    pub fn list_tables(&self, _database: Option<&str>) -> Result<Vec<TableInfo>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY name",
            )
            .map_err(|e| e.to_string())?;
        let tables = stmt
            .query_map([], |row| {
                Ok(TableInfo {
                    name: row.get(0)?,
                    table_type: row.get(1)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(tables)
    }

    pub fn execute(&self, sql: &str, _database: Option<&str>) -> Result<QueryResult, String> {
        let start = Instant::now();
        let statements = split_statements(sql);
        let mut last_result = QueryResult::empty();

        for stmt_sql in &statements {
            let trimmed = stmt_sql.trim();
            if trimmed.is_empty() {
                continue;
            }

            let mut stmt = match self.conn.prepare(trimmed) {
                Err(e) => return Ok(QueryResult::from_error(e.to_string())),
                Ok(s) => s,
            };

            let col_count = stmt.column_count();
            let columns: Vec<ColumnDef> = (0..col_count)
                .map(|i| ColumnDef {
                    name: stmt.column_name(i).unwrap_or("?").to_string(),
                    col_type: String::new(),
                    nullable: true,
                    is_primary_key: false,
                    default_value: None,
                })
                .collect();

            let mut rows: Vec<Vec<Option<String>>> = vec![];

            let mut row_iter = match stmt.query([]) {
                Err(e) => return Ok(QueryResult::from_error(e.to_string())),
                Ok(r) => r,
            };

            loop {
                match row_iter.next() {
                    Err(e) => return Ok(QueryResult::from_error(e.to_string())),
                    Ok(None) => break,
                    Ok(Some(row)) => {
                        let values: Vec<Option<String>> = (0..col_count)
                            .map(|i| {
                                match row.get_ref(i).unwrap_or(ValueRef::Null) {
                                    ValueRef::Null => None,
                                    ValueRef::Integer(n) => Some(n.to_string()),
                                    ValueRef::Real(f) => Some(f.to_string()),
                                    ValueRef::Text(t) => {
                                        Some(String::from_utf8_lossy(t).to_string())
                                    }
                                    ValueRef::Blob(b) => {
                                        Some(format!("<BLOB {} bytes>", b.len()))
                                    }
                                }
                            })
                            .collect();
                        rows.push(values);
                    }
                }
            }

            last_result = QueryResult {
                columns,
                rows,
                affected_rows: self.conn.changes() as u64,
                last_insert_id: self.conn.last_insert_rowid() as u64,
                execution_time_ms: start.elapsed().as_secs_f64() * 1000.0,
                error: None,
            };
        }

        Ok(last_result)
    }

    pub fn table_columns(
        &self,
        table: &str,
        _database: Option<&str>,
    ) -> Result<Vec<ColumnInfo>, String> {
        let sql = format!(
            "PRAGMA table_info(\"{}\")",
            table.replace('"', "\"\"")
        );
        let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let cols = stmt
            .query_map([], |row| {
                let notnull: i32 = row.get(3)?;
                let pk: i32 = row.get(5)?;
                Ok(ColumnInfo {
                    name: row.get(1)?,
                    col_type: row.get::<_, String>(2).unwrap_or_default(),
                    nullable: notnull == 0,
                    key_type: if pk > 0 {
                        "PRI".to_string()
                    } else {
                        "".to_string()
                    },
                    default_value: row.get(4)?,
                    extra: "".to_string(),
                    charset: String::new(),
                    collation: String::new(),
                    comment: String::new(),
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(cols)
    }

    pub fn get_create_table_sql(&self, table: &str, _database: Option<&str>) -> Result<String, String> {
        self.conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name=?1",
                [table],
                |row| row.get::<_, String>(0),
            )
            .map_err(|e| e.to_string())
    }

    pub fn table_indexes(
        &self,
        table: &str,
        _database: Option<&str>,
    ) -> Result<Vec<IndexInfo>, String> {
        let sql = format!(
            "PRAGMA index_list(\"{}\")",
            table.replace('"', "\"\"")
        );
        let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let index_list: Vec<(String, bool)> = stmt
            .query_map([], |row| {
                let unique: i32 = row.get(2)?;
                Ok((row.get::<_, String>(1)?, unique != 0))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        let mut indexes = vec![];
        for (name, unique) in index_list {
            let info_sql = format!(
                "PRAGMA index_info(\"{}\")",
                name.replace('"', "\"\"")
            );
            let mut info_stmt = self.conn.prepare(&info_sql).map_err(|e| e.to_string())?;
            let cols: Vec<String> = info_stmt
                .query_map([], |row| row.get::<_, String>(2))
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();
            indexes.push(IndexInfo {
                name,
                columns: cols,
                unique,
                index_type: "BTREE".to_string(),
            });
        }
        Ok(indexes)
    }

    pub fn table_foreign_keys(&self, table: &str, _database: Option<&str>) -> Result<Vec<ForeignKeyInfo>, String> {
        let sql = format!("PRAGMA foreign_key_list(\"{}\")", table.replace('"', "\"\""));
        let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let fks = stmt.query_map([], |row| {
            Ok(ForeignKeyInfo {
                constraint_name: format!("fk_{}", row.get::<_, i64>(0).unwrap_or(0)),
                column_name: row.get::<_, String>(3).unwrap_or_default(),
                referenced_table: row.get::<_, String>(2).unwrap_or_default(),
                referenced_column: row.get::<_, String>(4).unwrap_or_default(),
            })
        }).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
        Ok(fks)
    }

    pub fn table_triggers(&self, table: &str, _database: Option<&str>) -> Result<Vec<TriggerInfo>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?1 ORDER BY name"
        ).map_err(|e| e.to_string())?;
        let triggers = stmt.query_map([table], |row| {
            Ok(TriggerInfo {
                name: row.get::<_, String>(0).unwrap_or_default(),
                event: String::new(),
                timing: String::new(),
                statement: row.get::<_, String>(1).unwrap_or_default(),
            })
        }).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
        Ok(triggers)
    }

    pub fn table_info(&self, table: &str, _database: Option<&str>) -> Result<TableInfoData, String> {
        let count_sql = format!("SELECT COUNT(*) FROM \"{}\"", table.replace('"', "\"\""));
        let count: i64 = self.conn.query_row(&count_sql, [], |r| r.get(0)).unwrap_or(0);
        Ok(TableInfoData {
            row_count: count.to_string(),
            size: "N/A (file-based)".into(),
            data_size: "N/A".into(),
            index_size: "N/A".into(),
            auto_increment: None,
            engine: "SQLite".into(),
            collation: "N/A".into(),
            created: "N/A".into(),
            comment: String::new(),
        })
    }
}

fn split_statements(sql: &str) -> Vec<String> {
    let mut stmts = vec![];
    let mut current = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut in_backtick = false;

    for ch in sql.chars() {
        match ch {
            '\'' if !in_double && !in_backtick => {
                in_single = !in_single;
                current.push(ch);
            }
            '"' if !in_single && !in_backtick => {
                in_double = !in_double;
                current.push(ch);
            }
            '`' if !in_single && !in_double => {
                in_backtick = !in_backtick;
                current.push(ch);
            }
            ';' if !in_single && !in_double && !in_backtick => {
                current.push(';');
                let s = current.trim().to_string();
                if !s.is_empty() {
                    stmts.push(s);
                }
                current = String::new();
            }
            _ => {
                current.push(ch);
            }
        }
    }
    let s = current.trim().to_string();
    if !s.is_empty() {
        stmts.push(s);
    }
    stmts
}
