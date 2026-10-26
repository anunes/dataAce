use std::sync::Arc;
use tauri::State;
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(serde::Serialize, Clone)]
pub struct ServerStatus {
    pub name: String,
    pub available: bool,
}

mod db;
use db::mssql::MssqlConn;
use db::mysql::MysqlConn;
use db::oracle::OracleConn;
use db::postgres::PostgresConn;
use db::sqlite::SqliteConn;
use db::types::*;
use db::{ConnectionMap, DbConnection, TunnelMap};

pub struct AppState {
    pub connections: ConnectionMap,
    pub tunnels: TunnelMap,
}

// ── Connect commands ────────────────────────────────────────────────────────

#[tauri::command]
async fn connect_sqlite(state: State<'_, AppState>, path: String) -> Result<String, String> {
    let conn = SqliteConn::new(&path)?;
    let id = Uuid::new_v4().to_string();
    state
        .connections
        .lock()
        .await
        .insert(id.clone(), DbConnection::Sqlite(Arc::new(Mutex::new(conn))));
    Ok(id)
}

#[tauri::command]
async fn connect_mysql(
    state: State<'_, AppState>,
    host: String,
    port: u16,
    username: String,
    password: String,
    database: String,
    // SSH tunnel fields (empty = no tunnel)
    ssh_host: String,
    ssh_port: u16,
    ssh_user: String,
    ssh_password: String,
    require_ssl: bool,
    skip_ssl_verify: bool,
) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    let (actual_host, actual_port) = if !ssh_host.is_empty() {
        let tunnel = db::ssh::create_ssh_tunnel(
            ssh_host,
            if ssh_port == 0 { 22 } else { ssh_port },
            ssh_user,
            ssh_password,
            host.clone(),
            port,
        )
        .await?;
        let lp = tunnel.local_port;
        state.tunnels.lock().await.insert(id.clone(), tunnel);
        ("127.0.0.1".to_string(), lp)
    } else {
        (host, port)
    };

    let db = if database.is_empty() { None } else { Some(database.as_str()) };
    let conn = MysqlConn::new(&actual_host, actual_port, &username, &password, db, require_ssl, skip_ssl_verify).await?;
    state
        .connections
        .lock()
        .await
        .insert(id.clone(), DbConnection::Mysql(Arc::new(Mutex::new(conn))));
    Ok(id)
}

#[tauri::command]
async fn connect_postgres(
    state: State<'_, AppState>,
    host: String,
    port: u16,
    username: String,
    password: String,
    database: String,
    // SSH tunnel fields (empty = no tunnel)
    ssh_host: String,
    ssh_port: u16,
    ssh_user: String,
    ssh_password: String,
) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    let (actual_host, actual_port) = if !ssh_host.is_empty() {
        let tunnel = db::ssh::create_ssh_tunnel(
            ssh_host,
            if ssh_port == 0 { 22 } else { ssh_port },
            ssh_user,
            ssh_password,
            host.clone(),
            port,
        )
        .await?;
        let lp = tunnel.local_port;
        state.tunnels.lock().await.insert(id.clone(), tunnel);
        ("127.0.0.1".to_string(), lp)
    } else {
        (host, port)
    };

    let conn = PostgresConn::new(&actual_host, actual_port, &username, &password, &database).await?;
    state
        .connections
        .lock()
        .await
        .insert(id.clone(), DbConnection::Postgres(Arc::new(Mutex::new(conn))));
    Ok(id)
}

#[tauri::command]
async fn connect_oracle(
    state: State<'_, AppState>,
    host: String,
    port: u16,
    service: String,
    username: String,
    password: String,
) -> Result<String, String> {
    let conn = OracleConn::new(&host, port, &service, &username, &password).await?;
    let id = Uuid::new_v4().to_string();
    state
        .connections
        .lock()
        .await
        .insert(id.clone(), DbConnection::Oracle(Arc::new(Mutex::new(conn))));
    Ok(id)
}

#[tauri::command]
async fn connect_mssql(
    state: State<'_, AppState>,
    host: String,
    port: u16,
    username: String,
    password: String,
    database: String,
) -> Result<String, String> {
    let conn = MssqlConn::new(&host, port, &username, &password, &database).await?;
    let id = Uuid::new_v4().to_string();
    state
        .connections
        .lock()
        .await
        .insert(id.clone(), DbConnection::Mssql(Arc::new(Mutex::new(conn))));
    Ok(id)
}

#[tauri::command]
async fn disconnect(state: State<'_, AppState>, conn_id: String) -> Result<(), String> {
    state.connections.lock().await.remove(&conn_id);
    state.tunnels.lock().await.remove(&conn_id);
    Ok(())
}

// ── Schema commands ─────────────────────────────────────────────────────────

#[tauri::command]
async fn list_databases(state: State<'_, AppState>, conn_id: String) -> Result<Vec<String>, String> {
    let map = state.connections.lock().await;
    match map.get(&conn_id).ok_or("Connection not found")? {
        DbConnection::Sqlite(c) => c.lock().await.list_databases(),
        DbConnection::Mysql(c) => c.lock().await.list_databases().await,
        DbConnection::Postgres(c) => c.lock().await.list_databases().await,
        DbConnection::Oracle(c) => c.lock().await.list_databases().await,
        DbConnection::Mssql(c) => c.lock().await.list_databases().await,
    }
}

#[tauri::command]
async fn list_tables(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
) -> Result<Vec<TableInfo>, String> {
    let db = if database.is_empty() { None } else { Some(database.as_str()) };
    let map = state.connections.lock().await;
    match map.get(&conn_id).ok_or("Connection not found")? {
        DbConnection::Sqlite(c) => c.lock().await.list_tables(db),
        DbConnection::Mysql(c) => c.lock().await.list_tables(db).await,
        DbConnection::Postgres(c) => c.lock().await.list_tables(db).await,
        DbConnection::Oracle(c) => c.lock().await.list_tables(db).await,
        DbConnection::Mssql(c) => c.lock().await.list_tables(db).await,
    }
}

#[tauri::command]
async fn execute_query(
    state: State<'_, AppState>,
    conn_id: String,
    sql: String,
    database: Option<String>,
) -> Result<QueryResult, String> {
    let db = database.as_deref();
    let map = state.connections.lock().await;
    match map.get(&conn_id).ok_or("Connection not found")? {
        DbConnection::Sqlite(c) => c.lock().await.execute(&sql, db),
        DbConnection::Mysql(c) => c.lock().await.execute(&sql, db).await,
        DbConnection::Postgres(c) => c.lock().await.execute(&sql, db).await,
        DbConnection::Oracle(c) => c.lock().await.execute(&sql, db).await,
        DbConnection::Mssql(c) => c.lock().await.execute(&sql, db).await,
    }
}

#[tauri::command]
async fn table_columns(
    state: State<'_, AppState>,
    conn_id: String,
    table: String,
    database: String,
) -> Result<Vec<ColumnInfo>, String> {
    let db = if database.is_empty() { None } else { Some(database.as_str()) };
    let map = state.connections.lock().await;
    match map.get(&conn_id).ok_or("Connection not found")? {
        DbConnection::Sqlite(c) => c.lock().await.table_columns(&table, db),
        DbConnection::Mysql(c) => c.lock().await.table_columns(&table, db).await,
        DbConnection::Postgres(c) => c.lock().await.table_columns(&table, db).await,
        DbConnection::Oracle(c) => c.lock().await.table_columns(&table, db).await,
        DbConnection::Mssql(c) => c.lock().await.table_columns(&table, db).await,
    }
}

#[tauri::command]
async fn table_indexes(
    state: State<'_, AppState>,
    conn_id: String,
    table: String,
    database: String,
) -> Result<Vec<IndexInfo>, String> {
    let db = if database.is_empty() { None } else { Some(database.as_str()) };
    let map = state.connections.lock().await;
    match map.get(&conn_id).ok_or("Connection not found")? {
        DbConnection::Sqlite(c) => c.lock().await.table_indexes(&table, db),
        DbConnection::Mysql(c) => c.lock().await.table_indexes(&table, db).await,
        DbConnection::Postgres(c) => c.lock().await.table_indexes(&table, db).await,
        DbConnection::Oracle(c) => c.lock().await.table_indexes(&table, db).await,
        DbConnection::Mssql(c) => c.lock().await.table_indexes(&table, db).await,
    }
}

#[tauri::command]
async fn table_foreign_keys(
    state: State<'_, AppState>,
    conn_id: String,
    table: String,
    database: String,
) -> Result<Vec<ForeignKeyInfo>, String> {
    let db = if database.is_empty() { None } else { Some(database.as_str()) };
    let map = state.connections.lock().await;
    match map.get(&conn_id).ok_or("Connection not found")? {
        DbConnection::Sqlite(c) => c.lock().await.table_foreign_keys(&table, db),
        DbConnection::Mysql(c) => c.lock().await.table_foreign_keys(&table, db).await,
        DbConnection::Postgres(c) => c.lock().await.table_foreign_keys(&table, db).await,
        DbConnection::Oracle(c) => c.lock().await.table_foreign_keys(&table, db).await,
        DbConnection::Mssql(c) => c.lock().await.table_foreign_keys(&table, db).await,
    }
}

#[tauri::command]
async fn table_triggers(
    state: State<'_, AppState>,
    conn_id: String,
    table: String,
    database: String,
) -> Result<Vec<TriggerInfo>, String> {
    let db = if database.is_empty() { None } else { Some(database.as_str()) };
    let map = state.connections.lock().await;
    match map.get(&conn_id).ok_or("Connection not found")? {
        DbConnection::Sqlite(c) => c.lock().await.table_triggers(&table, db),
        DbConnection::Mysql(c) => c.lock().await.table_triggers(&table, db).await,
        DbConnection::Postgres(c) => c.lock().await.table_triggers(&table, db).await,
        DbConnection::Oracle(c) => c.lock().await.table_triggers(&table, db).await,
        DbConnection::Mssql(c) => c.lock().await.table_triggers(&table, db).await,
    }
}

#[tauri::command]
async fn table_info(
    state: State<'_, AppState>,
    conn_id: String,
    table: String,
    database: String,
) -> Result<TableInfoData, String> {
    let db = if database.is_empty() { None } else { Some(database.as_str()) };
    let map = state.connections.lock().await;
    match map.get(&conn_id).ok_or("Connection not found")? {
        DbConnection::Sqlite(c) => c.lock().await.table_info(&table, db),
        DbConnection::Mysql(c) => c.lock().await.table_info(&table, db).await,
        DbConnection::Postgres(c) => c.lock().await.table_info(&table, db).await,
        DbConnection::Oracle(c) => c.lock().await.table_info(&table, db).await,
        DbConnection::Mssql(c) => c.lock().await.table_info(&table, db).await,
    }
}

// ── Editing commands ────────────────────────────────────────────────────────

/// Update a single cell value. pk_column/pk_value identify the row.
#[tauri::command]
async fn update_cell(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
    pk_column: String,
    pk_value: String,
    column: String,
    value: String,
) -> Result<QueryResult, String> {
    let sql = match {
        let map = state.connections.lock().await;
        match map.get(&conn_id).ok_or("Connection not found")? {
            DbConnection::Sqlite(_) => "sqlite",
            DbConnection::Mysql(_) => "mysql",
            DbConnection::Postgres(_) => "postgres",
            DbConnection::Oracle(_) => "oracle",
            DbConnection::Mssql(_) => "mssql",
        }
    } {
        "oracle" => format!(
            "UPDATE {} SET {} = '{}' WHERE {} = '{}'",
            table,
            column,
            value.replace('\'', "''"),
            pk_column,
            pk_value.replace('\'', "''")
        ),
        "postgres" => format!(
            "UPDATE {} SET {} = '{}' WHERE {} = '{}'",
            table,
            column,
            value.replace('\'', "''"),
            pk_column,
            pk_value.replace('\'', "''")
        ),
        "mssql" => format!(
            "UPDATE [{}] SET [{}] = '{}' WHERE [{}] = '{}'",
            table,
            column,
            value.replace('\'', "''"),
            pk_column,
            pk_value.replace('\'', "''")
        ),
        _ => {
            let tbl = if database.is_empty() {
                table.clone()
            } else {
                format!("`{}`.`{}`", database, table)
            };
            format!(
                "UPDATE {} SET `{}` = '{}' WHERE `{}` = '{}'",
                tbl,
                column,
                value.replace('\'', "\\'"),
                pk_column,
                pk_value.replace('\'', "\\'")
            )
        }
    };
    let map = state.connections.lock().await;
    match map.get(&conn_id).ok_or("Connection not found")? {
        DbConnection::Sqlite(c) => c.lock().await.execute(&sql, None),
        DbConnection::Mysql(c) => c.lock().await.execute(&sql, None).await,
        DbConnection::Postgres(c) => c.lock().await.execute(&sql, None).await,
        DbConnection::Oracle(c) => c.lock().await.execute(&sql, None).await,
        DbConnection::Mssql(c) => c.lock().await.execute(&sql, None).await,
    }
}

/// Delete a row identified by pk_column = pk_value.
#[tauri::command]
async fn delete_row(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
    pk_column: String,
    pk_value: String,
) -> Result<QueryResult, String> {
    let sql = {
        let map = state.connections.lock().await;
        let db_type = match map.get(&conn_id).ok_or("Connection not found")? {
            DbConnection::Sqlite(_) => "sqlite",
            DbConnection::Mysql(_) => "mysql",
            DbConnection::Postgres(_) => "postgres",
            DbConnection::Oracle(_) => "oracle",
            DbConnection::Mssql(_) => "mssql",
        };
        match db_type {
            "oracle" | "postgres" => format!(
                "DELETE FROM {} WHERE {} = '{}'",
                table,
                pk_column,
                pk_value.replace('\'', "''")
            ),
            "mssql" => format!(
                "DELETE FROM [{}] WHERE [{}] = '{}'",
                table,
                pk_column,
                pk_value.replace('\'', "''")
            ),
            _ => {
                let tbl = if database.is_empty() {
                    format!("`{}`", table)
                } else {
                    format!("`{}`.`{}`", database, table)
                };
                format!(
                    "DELETE FROM {} WHERE `{}` = '{}'",
                    tbl,
                    pk_column,
                    pk_value.replace('\'', "\\'")
                )
            }
        }
    };
    let map = state.connections.lock().await;
    match map.get(&conn_id).ok_or("Connection not found")? {
        DbConnection::Sqlite(c) => c.lock().await.execute(&sql, None),
        DbConnection::Mysql(c) => c.lock().await.execute(&sql, None).await,
        DbConnection::Postgres(c) => c.lock().await.execute(&sql, None).await,
        DbConnection::Oracle(c) => c.lock().await.execute(&sql, None).await,
        DbConnection::Mssql(c) => c.lock().await.execute(&sql, None).await,
    }
}

/// Add a new column to a table.
#[tauri::command]
async fn add_column(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
    col_name: String,
    col_type: String,
    nullable: bool,
    default_value: Option<String>,
    after_column: Option<String>,
    extra: Option<String>,
    charset: Option<String>,
    collation: Option<String>,
    comment: Option<String>,
) -> Result<(), String> {
    let null_clause = if nullable { "" } else { " NOT NULL" };
    let default_clause = match &default_value {
        Some(d) if !d.is_empty() => format!(" DEFAULT '{}'", d.replace('\'', "''")),
        _ => String::new(),
    };
    let map = state.connections.lock().await;
    match map.get(&conn_id).ok_or("Connection not found")? {
        DbConnection::Sqlite(c) => {
            let sql = format!(
                "ALTER TABLE \"{}\" ADD COLUMN \"{}\" {}{}{}",
                table.replace('"', "\"\""), col_name.replace('"', "\"\""),
                col_type, null_clause, default_clause
            );
            c.lock().await.execute(&sql, None).map(|_| ())
        }
        DbConnection::Mysql(c) => {
            let tbl = if database.is_empty() {
                format!("`{}`", table.replace('`', ""))
            } else {
                format!("`{}`.`{}`", database.replace('`', ""), table.replace('`', ""))
            };
            let position_clause = match &after_column {
                Some(ac) if ac == "__FIRST__" => " FIRST".to_string(),
                Some(ac) if !ac.is_empty() => format!(" AFTER `{}`", ac.replace('`', "")),
                _ => String::new(),
            };
            let charset_clause = match &charset {
                Some(cs) if !cs.is_empty() => format!(" CHARACTER SET {}", cs),
                _ => String::new(),
            };
            let collation_clause = match &collation {
                Some(col) if !col.is_empty() => format!(" COLLATE {}", col),
                _ => String::new(),
            };
            let extra_clause = match &extra {
                Some(ex) if !ex.is_empty() => format!(" {}", ex),
                _ => String::new(),
            };
            let comment_clause = match &comment {
                Some(cm) if !cm.is_empty() => format!(" COMMENT '{}'", cm.replace('\'', "''")),
                _ => String::new(),
            };
            let sql = format!(
                "ALTER TABLE {} ADD COLUMN `{}` {}{}{}{}{}{}{}{}",
                tbl, col_name.replace('`', ""), col_type, null_clause, default_clause,
                charset_clause, collation_clause, extra_clause, comment_clause, position_clause
            );
            c.lock().await.execute(&sql, None).await.map(|_| ())
        }
        DbConnection::Postgres(c) => {
            let sql = format!(
                "ALTER TABLE \"{}\" ADD COLUMN \"{}\" {}{}{}",
                table.replace('"', "\"\""), col_name.replace('"', "\"\""),
                col_type, null_clause, default_clause
            );
            c.lock().await.execute(&sql, None).await.map(|_| ())
        }
        DbConnection::Mssql(c) => {
            let sql = format!(
                "ALTER TABLE [{}] ADD [{}] {}{}{}",
                table.replace(']', ""), col_name.replace(']', ""),
                col_type, null_clause, default_clause
            );
            c.lock().await.execute(&sql, None).await.map(|_| ())
        }
        DbConnection::Oracle(c) => {
            let sql = format!(
                "ALTER TABLE \"{}\" ADD (\"{}\" {}{}{})",
                table.replace('"', "\"\""), col_name.replace('"', "\"\""),
                col_type, null_clause, default_clause
            );
            c.lock().await.execute(&sql, None).await.map(|_| ())
        }
    }
}

/// Rename and/or retype an existing column.
#[tauri::command]
async fn alter_column(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
    old_name: String,
    new_name: String,
    col_type: String,
    nullable: bool,
    default_value: Option<String>,
    extra: Option<String>,
    charset: Option<String>,
    collation: Option<String>,
    comment: Option<String>,
) -> Result<(), String> {
    let null_clause = if nullable { "" } else { " NOT NULL" };
    let default_clause = match &default_value {
        Some(d) if !d.is_empty() => format!(" DEFAULT '{}'", d.replace('\'', "''")),
        _ => String::new(),
    };
    let map = state.connections.lock().await;
    match map.get(&conn_id).ok_or("Connection not found")? {
        DbConnection::Sqlite(_) => Err(
            "SQLite does not support modifying existing columns. Use Add Column instead.".to_string(),
        ),
        DbConnection::Mysql(c) => {
            let tbl = if database.is_empty() {
                format!("`{}`", table.replace('`', ""))
            } else {
                format!("`{}`.`{}`", database.replace('`', ""), table.replace('`', ""))
            };
            let charset_clause = match &charset {
                Some(cs) if !cs.is_empty() => format!(" CHARACTER SET {}", cs),
                _ => String::new(),
            };
            let collation_clause = match &collation {
                Some(col) if !col.is_empty() => format!(" COLLATE {}", col),
                _ => String::new(),
            };
            let extra_clause = match &extra {
                Some(ex) if !ex.is_empty() => format!(" {}", ex),
                _ => String::new(),
            };
            let comment_clause = match &comment {
                Some(cm) if !cm.is_empty() => format!(" COMMENT '{}'", cm.replace('\'', "''")),
                _ => String::new(),
            };
            let sql = format!(
                "ALTER TABLE {} CHANGE `{}` `{}` {}{}{}{}{}{}{}",
                tbl,
                old_name.replace('`', ""),
                new_name.replace('`', ""),
                col_type,
                null_clause,
                default_clause,
                charset_clause,
                collation_clause,
                extra_clause,
                comment_clause,
            );
            c.lock().await.execute(&sql, None).await.map(|_| ())
        }
        DbConnection::Postgres(c) => {
            let mut conn = c.lock().await;
            let t = table.replace('"', "\"\"");
            if old_name != new_name {
                let rename_sql = format!(
                    "ALTER TABLE \"{}\" RENAME COLUMN \"{}\" TO \"{}\"",
                    t,
                    old_name.replace('"', "\"\""),
                    new_name.replace('"', "\"\"")
                );
                conn.execute(&rename_sql, None).await.map(|_| ())?;
            }
            let type_sql = format!(
                "ALTER TABLE \"{}\" ALTER COLUMN \"{}\" TYPE {}",
                t,
                new_name.replace('"', "\"\""),
                col_type
            );
            conn.execute(&type_sql, None).await.map(|_| ())?;
            let null_sql = if nullable {
                format!("ALTER TABLE \"{}\" ALTER COLUMN \"{}\" DROP NOT NULL", t, new_name.replace('"', "\"\""))
            } else {
                format!("ALTER TABLE \"{}\" ALTER COLUMN \"{}\" SET NOT NULL", t, new_name.replace('"', "\"\""))
            };
            conn.execute(&null_sql, None).await.map(|_| ())
        }
        DbConnection::Mssql(c) => {
            let mut conn = c.lock().await;
            if old_name != new_name {
                let rename_sql = format!(
                    "EXEC sp_rename '[{}].[{}]', '{}', 'COLUMN'",
                    table.replace(']', ""),
                    old_name.replace(']', ""),
                    new_name.replace('\'', "")
                );
                conn.execute(&rename_sql, None).await.map(|_| ())?;
            }
            let type_sql = format!(
                "ALTER TABLE [{}] ALTER COLUMN [{}] {}{}",
                table.replace(']', ""),
                new_name.replace(']', ""),
                col_type,
                null_clause
            );
            conn.execute(&type_sql, None).await.map(|_| ())
        }
        DbConnection::Oracle(c) => {
            let mut conn = c.lock().await;
            let t = table.replace('"', "\"\"");
            if old_name != new_name {
                let rename_sql = format!(
                    "ALTER TABLE \"{}\" RENAME COLUMN \"{}\" TO \"{}\"",
                    t,
                    old_name.replace('"', "\"\""),
                    new_name.replace('"', "\"\"")
                );
                conn.execute(&rename_sql, None).await.map(|_| ())?;
            }
            let modify_sql = format!(
                "ALTER TABLE \"{}\" MODIFY (\"{}\" {}{}{})",
                t,
                new_name.replace('"', "\"\""),
                col_type,
                null_clause,
                default_clause
            );
            conn.execute(&modify_sql, None).await.map(|_| ())
        }
    }
}

/// Drop a column from a table.
#[tauri::command]
async fn drop_column(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
    col_name: String,
) -> Result<(), String> {
    let map = state.connections.lock().await;
    match map.get(&conn_id).ok_or("Connection not found")? {
        DbConnection::Sqlite(c) => {
            let sql = format!(
                "ALTER TABLE \"{}\" DROP COLUMN \"{}\"",
                table.replace('"', "\"\""),
                col_name.replace('"', "\"\"")
            );
            c.lock().await.execute(&sql, None).map(|_| ())
        }
        DbConnection::Mysql(c) => {
            let tbl = if database.is_empty() {
                format!("`{}`", table.replace('`', ""))
            } else {
                format!("`{}`.`{}`", database.replace('`', ""), table.replace('`', ""))
            };
            let sql = format!("ALTER TABLE {} DROP COLUMN `{}`", tbl, col_name.replace('`', ""));
            c.lock().await.execute(&sql, None).await.map(|_| ())
        }
        DbConnection::Postgres(c) => {
            let sql = format!(
                "ALTER TABLE \"{}\" DROP COLUMN \"{}\"",
                table.replace('"', "\"\""),
                col_name.replace('"', "\"\"")
            );
            c.lock().await.execute(&sql, None).await.map(|_| ())
        }
        DbConnection::Mssql(c) => {
            let sql = format!(
                "ALTER TABLE [{}] DROP COLUMN [{}]",
                table.replace(']', ""),
                col_name.replace(']', "")
            );
            c.lock().await.execute(&sql, None).await.map(|_| ())
        }
        DbConnection::Oracle(c) => {
            let sql = format!(
                "ALTER TABLE \"{}\" DROP COLUMN \"{}\"",
                table.replace('"', "\"\""),
                col_name.replace('"', "\"\"")
            );
            c.lock().await.execute(&sql, None).await.map(|_| ())
        }
    }
}

/// Return the native CREATE TABLE DDL for a given table.
#[tauri::command]
async fn get_create_table_sql(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
) -> Result<String, String> {
    let db = if database.is_empty() { None } else { Some(database.as_str()) };
    let map = state.connections.lock().await;
    match map.get(&conn_id).ok_or("Connection not found")? {
        DbConnection::Sqlite(c) => c.lock().await.get_create_table_sql(&table, db),
        DbConnection::Mysql(c) => c.lock().await.get_create_table_sql(&table, db).await,
        DbConnection::Postgres(c) => c.lock().await.get_create_table_sql(&table, db).await,
        DbConnection::Oracle(c) => c.lock().await.get_create_table_sql(&table, db).await,
        DbConnection::Mssql(c) => c.lock().await.get_create_table_sql(&table, db).await,
    }
}

/// CREATE DATABASE (not supported by SQLite or Oracle schemas).
#[tauri::command]
async fn create_database(
    state: State<'_, AppState>,
    conn_id: String,
    name: String,
    charset: Option<String>,
    collation: Option<String>,
) -> Result<QueryResult, String> {
    let map = state.connections.lock().await;
    match map.get(&conn_id).ok_or("Connection not found")? {
        DbConnection::Sqlite(_) => Err("SQLite uses files, not named databases".to_string()),
        DbConnection::Mysql(c) => {
            let mut sql = format!("CREATE DATABASE `{}`", name.replace('`', ""));
            if let Some(cs) = &charset {
                if !cs.is_empty() {
                    sql.push_str(&format!(" DEFAULT CHARACTER SET {}", cs));
                }
            }
            if let Some(col) = &collation {
                if !col.is_empty() {
                    sql.push_str(&format!(" COLLATE {}", col));
                }
            }
            c.lock().await.execute(&sql, None).await
        }
        DbConnection::Postgres(c) => {
            let pg_sql = format!("CREATE DATABASE \"{}\"", name.replace('"', ""));
            c.lock().await.simple_execute(&pg_sql).await
        }
        DbConnection::Oracle(_) => Err("Use Oracle tools to create schemas/databases".to_string()),
        DbConnection::Mssql(c) => {
            let mssql_sql = format!("CREATE DATABASE [{}]", name.replace(']', ""));
            c.lock().await.execute(&mssql_sql, None).await
        }
    }
}

/// DROP DATABASE
#[tauri::command]
async fn drop_database(
    state: State<'_, AppState>,
    conn_id: String,
    name: String,
) -> Result<(), String> {
    let map = state.connections.lock().await;
    match map.get(&conn_id).ok_or("Connection not found")? {
        DbConnection::Sqlite(_) => Err("SQLite uses files, not named databases".to_string()),
        DbConnection::Oracle(_) => Err("Use Oracle tools to drop schemas".to_string()),
        DbConnection::Mysql(c) => {
            let sql = format!("DROP DATABASE `{}`", name.replace('`', ""));
            c.lock().await.execute(&sql, None).await.map(|_| ())
        }
        DbConnection::Postgres(c) => {
            let sql = format!("DROP DATABASE \"{}\"", name.replace('"', ""));
            c.lock().await.simple_execute(&sql).await.map(|_| ())
        }
        DbConnection::Mssql(c) => {
            let sql = format!("DROP DATABASE [{}]", name.replace(']', ""));
            c.lock().await.execute(&sql, None).await.map(|_| ())
        }
    }
}

/// Check which DB servers are reachable on 127.0.0.1
#[tauri::command]
async fn check_server_availability() -> Vec<ServerStatus> {
    use std::time::Duration;
    use tokio::net::TcpStream;
    use tokio::time::timeout;

    let servers: &[(&str, &str)] = &[
        ("MySQL", "127.0.0.1:3306"),
        ("PostgreSQL", "127.0.0.1:5432"),
        ("SQL Server", "127.0.0.1:1433"),
        ("Oracle", "127.0.0.1:1521"),
    ];

    let mut results = Vec::new();
    for (name, addr) in servers {
        let available = timeout(Duration::from_millis(500), TcpStream::connect(addr))
            .await
            .map(|r| r.is_ok())
            .unwrap_or(false);
        results.push(ServerStatus { name: name.to_string(), available });
    }
    // SQLite is file-based — always available
    results.push(ServerStatus { name: "SQLite".to_string(), available: true });
    results
}

/// CREATE TABLE — caller provides the full CREATE TABLE SQL string.
#[tauri::command]
async fn create_table(
    state: State<'_, AppState>,
    conn_id: String,
    sql: String,
) -> Result<QueryResult, String> {
    let map = state.connections.lock().await;
    match map.get(&conn_id).ok_or("Connection not found")? {
        DbConnection::Sqlite(c) => c.lock().await.execute(&sql, None),
        DbConnection::Mysql(c) => c.lock().await.execute(&sql, None).await,
        DbConnection::Postgres(c) => c.lock().await.execute(&sql, None).await,
        DbConnection::Oracle(c) => c.lock().await.execute(&sql, None).await,
        DbConnection::Mssql(c) => c.lock().await.execute(&sql, None).await,
    }
}

/// Set the AUTO_INCREMENT value on a MySQL table.
#[tauri::command]
async fn set_auto_increment(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
    value: u64,
) -> Result<(), String> {
    let map = state.connections.lock().await;
    match map.get(&conn_id).ok_or("Connection not found")? {
        DbConnection::Mysql(c) => {
            let tbl = if database.is_empty() {
                format!("`{}`", table.replace('`', ""))
            } else {
                format!("`{}`.`{}`", database.replace('`', ""), table.replace('`', ""))
            };
            let sql = format!("ALTER TABLE {} AUTO_INCREMENT = {}", tbl, value);
            c.lock().await.execute(&sql, None).await.map(|_| ())
        }
        _ => Err("Auto Increment is only supported on MySQL".into()),
    }
}

/// Create an index on a table.
#[tauri::command]
async fn create_index(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
    index_name: String,
    columns: Vec<String>,
    unique: bool,
    index_type: String,
) -> Result<(), String> {
    let unique_kw = if unique { "UNIQUE " } else { "" };
    let map = state.connections.lock().await;
    match map.get(&conn_id).ok_or("Connection not found")? {
        DbConnection::Mysql(c) => {
            let tbl = if database.is_empty() {
                format!("`{}`", table.replace('`', ""))
            } else {
                format!("`{}`.`{}`", database.replace('`', ""), table.replace('`', ""))
            };
            let cols: Vec<String> = columns.iter().map(|c| format!("`{}`", c.replace('`', ""))).collect();
            let using = if !index_type.is_empty() { format!(" USING {}", index_type) } else { String::new() };
            let sql = format!(
                "CREATE {}INDEX `{}` ON {} ({}){}",
                unique_kw, index_name.replace('`', ""), tbl, cols.join(", "), using
            );
            c.lock().await.execute(&sql, None).await.map(|_| ())
        }
        DbConnection::Postgres(c) => {
            let cols: Vec<String> = columns.iter().map(|c| format!("\"{}\"", c.replace('"', "\"\""))).collect();
            let sql = format!(
                "CREATE {}INDEX \"{}\" ON \"{}\" ({})",
                unique_kw, index_name.replace('"', "\"\""), table.replace('"', "\"\""), cols.join(", ")
            );
            c.lock().await.execute(&sql, None).await.map(|_| ())
        }
        DbConnection::Sqlite(c) => {
            let cols: Vec<String> = columns.iter().map(|c| format!("\"{}\"", c.replace('"', "\"\""))).collect();
            let sql = format!(
                "CREATE {}INDEX \"{}\" ON \"{}\" ({})",
                unique_kw, index_name.replace('"', "\"\""), table.replace('"', "\"\""), cols.join(", ")
            );
            c.lock().await.execute(&sql, None).map(|_| ())
        }
        DbConnection::Mssql(c) => {
            let cols: Vec<String> = columns.iter().map(|c| format!("[{}]", c.replace(']', ""))).collect();
            let sql = format!(
                "CREATE {}INDEX [{}] ON [{}] ({})",
                unique_kw, index_name.replace(']', ""), table.replace(']', ""), cols.join(", ")
            );
            c.lock().await.execute(&sql, None).await.map(|_| ())
        }
        DbConnection::Oracle(c) => {
            let cols: Vec<String> = columns.iter().map(|c| format!("\"{}\"", c.replace('"', "\"\""))).collect();
            let sql = format!(
                "CREATE {}INDEX \"{}\" ON \"{}\" ({})",
                unique_kw, index_name.replace('"', "\"\""), table.replace('"', "\"\""), cols.join(", ")
            );
            c.lock().await.execute(&sql, None).await.map(|_| ())
        }
    }
}

/// Drop an index from a table.
#[tauri::command]
async fn drop_index(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
    index_name: String,
) -> Result<(), String> {
    let map = state.connections.lock().await;
    match map.get(&conn_id).ok_or("Connection not found")? {
        DbConnection::Mysql(c) => {
            let tbl = if database.is_empty() {
                format!("`{}`", table.replace('`', ""))
            } else {
                format!("`{}`.`{}`", database.replace('`', ""), table.replace('`', ""))
            };
            let sql = format!("ALTER TABLE {} DROP INDEX `{}`", tbl, index_name.replace('`', ""));
            c.lock().await.execute(&sql, None).await.map(|_| ())
        }
        DbConnection::Postgres(c) => {
            let sql = format!("DROP INDEX \"{}\"", index_name.replace('"', "\"\""));
            c.lock().await.execute(&sql, None).await.map(|_| ())
        }
        DbConnection::Sqlite(c) => {
            let sql = format!("DROP INDEX \"{}\"", index_name.replace('"', "\"\""));
            c.lock().await.execute(&sql, None).map(|_| ())
        }
        DbConnection::Mssql(c) => {
            let sql = format!("DROP INDEX [{}] ON [{}]", index_name.replace(']', ""), table.replace(']', ""));
            c.lock().await.execute(&sql, None).await.map(|_| ())
        }
        DbConnection::Oracle(c) => {
            let sql = format!("DROP INDEX \"{}\"", index_name.replace('"', "\"\""));
            c.lock().await.execute(&sql, None).await.map(|_| ())
        }
    }
}

// ── MySQL User Management ────────────────────────────────────────────────────

#[tauri::command]
async fn mysql_list_users(state: State<'_, AppState>, conn_id: String) -> Result<Vec<MysqlUser>, String> {
    let map = state.connections.lock().await;
    match map.get(&conn_id).ok_or("Connection not found")? {
        DbConnection::Mysql(c) => c.lock().await.list_users().await,
        _ => Err("User management is only supported on MySQL connections".into()),
    }
}

#[tauri::command]
async fn mysql_create_user(state: State<'_, AppState>, conn_id: String, username: String, host: String, password: String) -> Result<(), String> {
    let map = state.connections.lock().await;
    match map.get(&conn_id).ok_or("Connection not found")? {
        DbConnection::Mysql(c) => c.lock().await.create_user(&username, &host, &password).await,
        _ => Err("User management is only supported on MySQL connections".into()),
    }
}

#[tauri::command]
async fn mysql_drop_user(state: State<'_, AppState>, conn_id: String, username: String, host: String) -> Result<(), String> {
    let map = state.connections.lock().await;
    match map.get(&conn_id).ok_or("Connection not found")? {
        DbConnection::Mysql(c) => c.lock().await.drop_user(&username, &host).await,
        _ => Err("User management is only supported on MySQL connections".into()),
    }
}

#[tauri::command]
async fn mysql_set_password(state: State<'_, AppState>, conn_id: String, username: String, host: String, password: String) -> Result<(), String> {
    let map = state.connections.lock().await;
    match map.get(&conn_id).ok_or("Connection not found")? {
        DbConnection::Mysql(c) => c.lock().await.set_password(&username, &host, &password).await,
        _ => Err("User management is only supported on MySQL connections".into()),
    }
}

#[tauri::command]
async fn mysql_get_global_privs(state: State<'_, AppState>, conn_id: String, username: String, host: String) -> Result<Vec<String>, String> {
    let map = state.connections.lock().await;
    match map.get(&conn_id).ok_or("Connection not found")? {
        DbConnection::Mysql(c) => c.lock().await.get_global_privs(&username, &host).await,
        _ => Err("User management is only supported on MySQL connections".into()),
    }
}

#[tauri::command]
async fn mysql_set_global_privs(state: State<'_, AppState>, conn_id: String, username: String, host: String, privs: Vec<String>) -> Result<(), String> {
    let map = state.connections.lock().await;
    match map.get(&conn_id).ok_or("Connection not found")? {
        DbConnection::Mysql(c) => c.lock().await.set_global_privs(&username, &host, privs).await,
        _ => Err("User management is only supported on MySQL connections".into()),
    }
}

#[tauri::command]
async fn mysql_get_resource_limits(state: State<'_, AppState>, conn_id: String, username: String, host: String) -> Result<MysqlResourceLimits, String> {
    let map = state.connections.lock().await;
    match map.get(&conn_id).ok_or("Connection not found")? {
        DbConnection::Mysql(c) => c.lock().await.get_resource_limits(&username, &host).await,
        _ => Err("User management is only supported on MySQL connections".into()),
    }
}

#[tauri::command]
async fn mysql_set_resource_limits(state: State<'_, AppState>, conn_id: String, username: String, host: String, max_updates: u64, max_connections: u64, max_questions: u64) -> Result<(), String> {
    let map = state.connections.lock().await;
    match map.get(&conn_id).ok_or("Connection not found")? {
        DbConnection::Mysql(c) => c.lock().await.set_resource_limits(&username, &host, max_updates, max_connections, max_questions).await,
        _ => Err("User management is only supported on MySQL connections".into()),
    }
}

#[tauri::command]
async fn mysql_get_schema_privs(state: State<'_, AppState>, conn_id: String, username: String, host: String) -> Result<Vec<MysqlSchemaPriv>, String> {
    let map = state.connections.lock().await;
    match map.get(&conn_id).ok_or("Connection not found")? {
        DbConnection::Mysql(c) => c.lock().await.get_schema_privs_for_user(&username, &host).await,
        _ => Err("User management is only supported on MySQL connections".into()),
    }
}

#[tauri::command]
async fn mysql_set_schema_privs(state: State<'_, AppState>, conn_id: String, username: String, host: String, schema: String, privs: Vec<String>) -> Result<(), String> {
    let map = state.connections.lock().await;
    match map.get(&conn_id).ok_or("Connection not found")? {
        DbConnection::Mysql(c) => c.lock().await.set_schema_privs(&username, &host, &schema, privs).await,
        _ => Err("User management is only supported on MySQL connections".into()),
    }
}

// ── App entry point ─────────────────────────────────────────────────────────

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .manage(AppState {
            connections: db::new_connection_map(),
            tunnels: db::new_tunnel_map(),
        })
        .invoke_handler(tauri::generate_handler![
            connect_sqlite,
            connect_mysql,
            connect_postgres,
            connect_oracle,
            connect_mssql,
            disconnect,
            list_databases,
            list_tables,
            execute_query,
            table_columns,
            table_indexes,
            table_foreign_keys,
            table_triggers,
            table_info,
            update_cell,
            delete_row,
            add_column,
            alter_column,
            drop_column,
            get_create_table_sql,
            create_database,
            create_table,
            drop_database,
            check_server_availability,
            set_auto_increment,
            create_index,
            drop_index,
            mysql_list_users,
            mysql_create_user,
            mysql_drop_user,
            mysql_set_password,
            mysql_get_global_privs,
            mysql_set_global_privs,
            mysql_get_resource_limits,
            mysql_set_resource_limits,
            mysql_get_schema_privs,
            mysql_set_schema_privs,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
