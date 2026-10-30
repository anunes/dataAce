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
mod transfer;
mod parameterized;
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

#[tauri::command]
async fn transfer_database(
    state: State<'_, AppState>,
    source: transfer::TransferProfile,
    target: transfer::TransferProfile,
    source_database: String,
    target_database: String,
    source_conn_id: Option<String>,
    target_conn_id: Option<String>,
) -> Result<transfer::TransferResult, String> {
    transfer::transfer_database(
        &state.connections, &state.tunnels, source, target,
        source_database, target_database, source_conn_id, target_conn_id,
    ).await
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
async fn execute_parameterized_query(
    state: State<'_, AppState>,
    conn_id: String,
    sql: String,
    database: Option<String>,
    parameters: Vec<parameterized::QueryParameter>,
) -> Result<QueryResult, String> {
    parameterized::execute(&state.connections, &conn_id, &sql, database.as_deref(), &parameters).await
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

/// Create a table and any supporting timestamp triggers as one operation.
#[tauri::command]
async fn create_table(
    state: State<'_, AppState>,
    conn_id: String,
    sql: String,
    database: Option<String>,
    additional_statements: Option<Vec<String>>,
) -> Result<QueryResult, String> {
    create_table_with_statements(
        &state.connections,
        &conn_id,
        &sql,
        database.as_deref(),
        additional_statements.as_deref().unwrap_or_default(),
    )
    .await
}

#[cfg(test)]
async fn create_table_with_database(
    connections: &ConnectionMap,
    conn_id: &str,
    sql: &str,
    database: Option<&str>,
) -> Result<QueryResult, String> {
    create_table_with_statements(connections, conn_id, sql, database, &[]).await
}

async fn execute_table_statement(
    connection: &DbConnection,
    sql: &str,
    database: Option<&str>,
) -> Result<QueryResult, String> {
    match connection {
        DbConnection::Sqlite(c) => {
            // The query editor's statement splitter cannot parse trigger bodies.
            // SQLite's parser handles the entire DDL statement, including its BEGIN/END.
            match c.lock().await.conn.execute_batch(sql) {
                Ok(()) => Ok(QueryResult::empty()),
                Err(e) => Ok(QueryResult::from_error(e.to_string())),
            }
        }
        DbConnection::Mysql(c) => c.lock().await.execute(sql, database).await,
        // PostgreSQL's connection already selects its database; its name is not
        // a schema/search_path override. batch_execute also accepts function bodies.
        DbConnection::Postgres(c) => match c.lock().await.client.batch_execute(sql).await {
            Ok(()) => Ok(QueryResult::empty()),
            Err(e) => Ok(QueryResult::from_error(e.to_string())),
        },
        DbConnection::Oracle(c) => c.lock().await.execute(sql, None).await,
        DbConnection::Mssql(c) => {
            let mut connection = c.lock().await;
            if let Some(database) = database {
                let selected = connection
                    .execute(&format!("USE [{}]", database.replace(']', "]]")), None)
                    .await?;
                if selected.error.is_some() {
                    return Ok(selected);
                }
            }
            connection.execute(sql, None).await
        }
    }
}

async fn create_table_with_statements(
    connections: &ConnectionMap,
    conn_id: &str,
    sql: &str,
    database: Option<&str>,
    additional_statements: &[String],
) -> Result<QueryResult, String> {
    let db = database.filter(|name| !name.is_empty());
    // Keep other commands from using this connection between transaction steps.
    let map = connections.lock().await;
    let connection = map.get(conn_id).ok_or("Connection not found")?;

    // Oracle's database selector contains schema owners. Set and restore the
    // session schema so an unqualified CREATE TABLE honors the selected owner.
    let previous_schema = if matches!(connection, DbConnection::Oracle(_)) && db.is_some() {
        let current = execute_table_statement(
            connection,
            "SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') FROM dual",
            None,
        )
        .await?;
        if let Some(error) = current.error {
            return Ok(QueryResult::from_error(error));
        }
        let previous = current.rows.first().and_then(|row| row.first()).cloned().flatten()
            .ok_or("Cannot determine the current Oracle schema")?;
        let selected = db.unwrap().replace('"', "\"\"");
        let changed = execute_table_statement(
            connection,
            &format!("ALTER SESSION SET CURRENT_SCHEMA = \"{}\"", selected),
            None,
        )
        .await?;
        if changed.error.is_some() {
            return Ok(changed);
        }
        Some(previous)
    } else {
        None
    };

    // A savepoint isolates this operation from work already pending in the
    // query editor. SQL Server limits savepoint names to 32 characters.
    let savepoint = format!("dataace_{}", &Uuid::new_v4().simple().to_string()[..24]);
    let (on_success, on_failure) = match connection {
        DbConnection::Sqlite(_) => {
            let started = execute_table_statement(connection, &format!("SAVEPOINT {}", savepoint), None).await?;
            if started.error.is_some() {
                return Ok(started);
            }
            (
                Some(format!("RELEASE SAVEPOINT {}", savepoint)),
                Some(format!("ROLLBACK TO SAVEPOINT {0}; RELEASE SAVEPOINT {0}", savepoint)),
            )
        }
        DbConnection::Postgres(c) => {
            let postgres = c.lock().await;
            match postgres.client.batch_execute(&format!("SAVEPOINT {}", savepoint)).await {
                Ok(()) => (
                    Some(format!("RELEASE SAVEPOINT {}", savepoint)),
                    Some(format!("ROLLBACK TO SAVEPOINT {0}; RELEASE SAVEPOINT {0}", savepoint)),
                ),
                // SAVEPOINT outside a transaction has SQLSTATE 25P01. Other
                // errors (including an already aborted transaction) must not
                // commit or roll back the user's transaction.
                Err(error) if error.code().map(|code| code.code()) == Some("25P01") => {
                    postgres.client.batch_execute("BEGIN").await.map_err(|e| e.to_string())?;
                    (Some("COMMIT".to_string()), Some("ROLLBACK".to_string()))
                }
                Err(error) => return Ok(QueryResult::from_error(error.to_string())),
            }
        }
        DbConnection::Mssql(_) => {
            let current = execute_table_statement(connection, "SELECT @@TRANCOUNT", db).await?;
            if current.error.is_some() {
                return Ok(current);
            }
            let transaction_count = current.rows.first().and_then(|row| row.first())
                .and_then(|value| value.as_deref()).and_then(|value| value.parse::<u32>().ok())
                .ok_or("Cannot determine the current SQL Server transaction state")?;
            let begin = if transaction_count == 0 {
                "BEGIN TRANSACTION".to_string()
            } else {
                format!("SAVE TRANSACTION {}", savepoint)
            };
            let started = execute_table_statement(connection, &begin, None).await?;
            if started.error.is_some() {
                return Ok(started);
            }
            if transaction_count == 0 {
                (
                    Some("COMMIT TRANSACTION".to_string()),
                    Some("IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION".to_string()),
                )
            } else {
                // A doomed transaction cannot roll back to a savepoint. Leave
                // that outer transaction for the user to resolve, rather than
                // discarding all of their pending work here.
                (None, Some(format!("IF XACT_STATE() = 1 ROLLBACK TRANSACTION {}", savepoint)))
            }
        }
        // MySQL and Oracle commit DDL implicitly.
        _ => (None, None),
    };

    let result = async {
        let mut last_result = QueryResult::empty();
        for (index, statement) in std::iter::once(sql)
            .chain(additional_statements.iter().map(String::as_str))
            .enumerate()
        {
            last_result = execute_table_statement(connection, statement, db).await?;
            if let Some(error) = last_result.error.as_mut() {
                if index > 0 && on_failure.is_none() {
                    *error = format!("The table was created, but its timestamp setup failed: {}", error);
                }
                return Ok(last_result);
            }
        }
        Ok::<QueryResult, String>(last_result)
    }
    .await;

    let failed = result.as_ref().map_or(true, |result| result.error.is_some());
    if let Some(finish) = if failed { on_failure } else { on_success } {
        let finalized = execute_table_statement(connection, &finish, None).await?;
        if let Some(error) = finalized.error {
            return Err(format!("Failed to finish table creation: {}", error));
        }
    }
    if let Some(schema) = previous_schema {
        let restored = execute_table_statement(
            connection,
            &format!("ALTER SESSION SET CURRENT_SCHEMA = \"{}\"", schema.replace('"', "\"\"")),
            None,
        )
        .await?;
        if let Some(error) = restored.error {
            return Err(format!("Failed to restore the Oracle schema: {}", error));
        }
    }
    result
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
            transfer_database,
            list_databases,
            list_tables,
            execute_query,
            execute_parameterized_query,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn create_table_preserves_sqlite_database_and_errors() {
        let connections = db::new_connection_map();
        let sqlite = Arc::new(Mutex::new(SqliteConn::new(":memory:").unwrap()));
        connections.lock().await.insert(
            "sqlite".to_string(),
            DbConnection::Sqlite(Arc::clone(&sqlite)),
        );

        let sql = "CREATE TABLE \"MixedCase\" (\"select\" INTEGER PRIMARY KEY)";
        let result = create_table_with_database(&connections, "sqlite", sql, Some("memory"))
            .await
            .unwrap();
        assert!(result.error.is_none());
        assert!(sqlite
            .lock()
            .await
            .list_tables(None)
            .unwrap()
            .iter()
            .any(|table| table.name == "MixedCase"));

        let duplicate = create_table_with_database(&connections, "sqlite", sql, Some("memory"))
            .await
            .unwrap();
        assert!(duplicate.error.is_some());
        let missing = create_table_with_database(&connections, "missing", sql, None).await;
        assert_eq!(missing.err().as_deref(), Some("Connection not found"));
    }

    #[tokio::test]
    async fn create_table_installs_sqlite_timestamp_trigger() {
        let connections = db::new_connection_map();
        let sqlite = Arc::new(Mutex::new(SqliteConn::new(":memory:").unwrap()));
        connections.lock().await.insert(
            "sqlite".to_string(),
            DbConnection::Sqlite(Arc::clone(&sqlite)),
        );
        let result = create_table_with_statements(
            &connections,
            "sqlite",
            "CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT, \
             created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, \
             updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)",
            Some("memory"),
            &["CREATE TRIGGER records_updated_at AFTER UPDATE ON records \
               FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at \
               AND NEW.updated_at <> CURRENT_TIMESTAMP BEGIN \
               UPDATE records SET updated_at = CURRENT_TIMESTAMP WHERE rowid = NEW.rowid; \
               END".to_string()],
        )
        .await
        .unwrap();
        assert!(result.error.is_none(), "{:?}", result.error);

        let sqlite = sqlite.lock().await;
        sqlite.conn.execute_batch("PRAGMA recursive_triggers = ON").unwrap();
        sqlite.conn.execute("INSERT INTO records (value) VALUES ('first')", []).unwrap();
        let initial: (String, String) = sqlite.conn.query_row(
            "SELECT created_at, updated_at FROM records WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        assert!(!initial.0.is_empty());
        assert_eq!(initial.0, initial.1);

        // An older explicit value makes the clock-independent update test exact.
        sqlite.conn.execute(
            "UPDATE records SET updated_at = '2000-01-01 00:00:00' WHERE id = 1",
            [],
        ).unwrap();
        sqlite.conn.execute("UPDATE records SET value = 'second' WHERE id = 1", []).unwrap();
        sqlite.conn.execute("UPDATE records SET value = 'third' WHERE id = 1", []).unwrap();
        let updated: (String, String) = sqlite.conn.query_row(
            "SELECT created_at, updated_at FROM records WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        assert_eq!(updated.0, initial.0);
        assert_ne!(updated.1, "2000-01-01 00:00:00");
    }

    #[tokio::test]
    async fn create_table_rolls_back_when_sqlite_timestamp_setup_fails() {
        let connections = db::new_connection_map();
        let sqlite = Arc::new(Mutex::new(SqliteConn::new(":memory:").unwrap()));
        connections.lock().await.insert(
            "sqlite".to_string(),
            DbConnection::Sqlite(Arc::clone(&sqlite)),
        );
        let result = create_table_with_statements(
            &connections,
            "sqlite",
            "CREATE TABLE rolled_back (id INTEGER PRIMARY KEY)",
            Some("memory"),
            &["CREATE TRIGGER broken AFTER UPDATE ON missing_table BEGIN SELECT 1; END".to_string()],
        )
        .await
        .unwrap();
        assert!(result.error.is_some());
        assert!(sqlite.lock().await.list_tables(None).unwrap().is_empty());

        // The failed batch must leave the connection ready for another attempt.
        let retry = create_table_with_database(
            &connections,
            "sqlite",
            "CREATE TABLE rolled_back (id INTEGER PRIMARY KEY)",
            Some("memory"),
        )
        .await
        .unwrap();
        assert!(retry.error.is_none(), "{:?}", retry.error);
    }

    #[tokio::test]
    async fn create_table_preserves_pending_sqlite_transaction() {
        let connections = db::new_connection_map();
        let sqlite = Arc::new(Mutex::new(SqliteConn::new(":memory:").unwrap()));
        connections.lock().await.insert(
            "sqlite".to_string(),
            DbConnection::Sqlite(Arc::clone(&sqlite)),
        );
        sqlite.lock().await.conn.execute_batch(
            "CREATE TABLE pending (value TEXT); BEGIN; INSERT INTO pending VALUES ('keep pending');",
        ).unwrap();

        let created = create_table_with_database(
            &connections,
            "sqlite",
            "CREATE TABLE new_table (id INTEGER PRIMARY KEY)",
            Some("memory"),
        ).await.unwrap();
        assert!(created.error.is_none(), "{:?}", created.error);
        let failed = create_table_with_statements(
            &connections,
            "sqlite",
            "CREATE TABLE failed_table (id INTEGER PRIMARY KEY)",
            Some("memory"),
            &["CREATE TRIGGER broken AFTER UPDATE ON missing_table BEGIN SELECT 1; END".to_string()],
        ).await.unwrap();
        assert!(failed.error.is_some());

        let sqlite = sqlite.lock().await;
        assert!(!sqlite.conn.is_autocommit());
        let pending: u32 = sqlite.conn.query_row("SELECT COUNT(*) FROM pending", [], |row| row.get(0)).unwrap();
        assert_eq!(pending, 1);
        let tables = sqlite.list_tables(None).unwrap();
        assert!(tables.iter().any(|table| table.name == "new_table"));
        assert!(!tables.iter().any(|table| table.name == "failed_table"));

        sqlite.conn.execute_batch("ROLLBACK").unwrap();
        assert!(sqlite.conn.is_autocommit());
        let pending: u32 = sqlite.conn.query_row("SELECT COUNT(*) FROM pending", [], |row| row.get(0)).unwrap();
        assert_eq!(pending, 0);
        let tables = sqlite.list_tables(None).unwrap();
        assert_eq!(tables.len(), 1);
        assert_eq!(tables[0].name, "pending");
    }

    #[tokio::test]
    #[ignore = "requires a disposable MySQL server; set DATAACE_TEST_MYSQL_PORT"]
    async fn create_table_uses_selected_mysql_database() {
        let port: u16 = std::env::var("DATAACE_TEST_MYSQL_PORT")
            .expect("set DATAACE_TEST_MYSQL_PORT to an isolated MySQL server port")
            .parse()
            .unwrap();
        let admin = MysqlConn::new("127.0.0.1", port, "root", "", None, false, false)
            .await
            .unwrap();
        let suffix = Uuid::new_v4().simple().to_string();
        let default_db = format!("dataace_default_{}", suffix);
        let selected_db = format!("dataace_selected_{}", suffix);
        for database in [&default_db, &selected_db] {
            let result = admin
                .execute(&format!("CREATE DATABASE `{}`", database), None)
                .await
                .unwrap();
            assert!(result.error.is_none(), "{:?}", result.error);
        }

        let connections = db::new_connection_map();
        for (id, default) in [("default", Some(default_db.as_str())), ("no_default", None)] {
            let conn = MysqlConn::new("127.0.0.1", port, "root", "", default, false, false)
                .await
                .unwrap();
            connections.lock().await.insert(
                id.to_string(),
                DbConnection::Mysql(Arc::new(Mutex::new(conn))),
            );
            let sql = format!("CREATE TABLE `{}` (`id` INTEGER PRIMARY KEY)", id);
            let result = create_table_with_database(&connections, id, &sql, Some(&selected_db))
                .await
                .unwrap();
            assert!(result.error.is_none(), "{:?}", result.error);
        }

        let selected = admin.list_tables(Some(&selected_db)).await.unwrap();
        assert_eq!(selected.len(), 2);
        assert!(selected.iter().any(|table| table.name == "default"));
        assert!(selected.iter().any(|table| table.name == "no_default"));
        assert!(admin
            .list_tables(Some(&default_db))
            .await
            .unwrap()
            .is_empty());

        for database in [&default_db, &selected_db] {
            let result = admin
                .execute(&format!("DROP DATABASE `{}`", database), None)
                .await
                .unwrap();
            assert!(result.error.is_none(), "{:?}", result.error);
        }
    }

    #[tokio::test]
    #[ignore = "requires a disposable PostgreSQL server; set DATAACE_TEST_POSTGRES_PORT"]
    async fn create_table_keeps_postgres_database_separate_from_schema() {
        let port: u16 = std::env::var("DATAACE_TEST_POSTGRES_PORT")
            .expect("set DATAACE_TEST_POSTGRES_PORT to an isolated PostgreSQL server port")
            .parse()
            .unwrap();
        let conn = Arc::new(Mutex::new(
            PostgresConn::new(
                "127.0.0.1",
                port,
                "dataace_test",
                "dataace_test",
                "postgres",
            )
            .await
            .unwrap(),
        ));
        let connections = db::new_connection_map();
        connections.lock().await.insert(
            "postgres".to_string(),
            DbConnection::Postgres(Arc::clone(&conn)),
        );

        // Browsing or running a query before creating a table must not set the
        // database name as the connection's schema search path.
        let query = conn
            .lock()
            .await
            .execute(
                "SELECT current_database()::text, current_schema()::text",
                Some("postgres"),
            )
            .await
            .unwrap();
        assert!(query.error.is_none(), "{:?}", query.error);
        assert_eq!(
            query.rows,
            vec![vec![Some("postgres".into()), Some("public".into())]]
        );

        let table = format!("dataace_{}", Uuid::new_v4().simple());
        let sql = format!("CREATE TABLE \"{}\" (\"id\" INTEGER PRIMARY KEY)", table);
        let result = create_table_with_database(&connections, "postgres", &sql, Some("postgres"))
            .await
            .unwrap();
        assert!(result.error.is_none(), "{:?}", result.error);
        assert!(conn
            .lock()
            .await
            .list_tables(Some("postgres"))
            .await
            .unwrap()
            .iter()
            .any(|entry| entry.name == table));
        let cleanup = conn
            .lock()
            .await
            .execute(&format!("DROP TABLE \"public\".\"{}\"", table), None)
            .await
            .unwrap();
        assert!(cleanup.error.is_none(), "{:?}", cleanup.error);

        let pending = conn.lock().await.execute(
            "CREATE TEMP TABLE dataace_pending (value TEXT)", None,
        ).await.unwrap();
        assert!(pending.error.is_none(), "{:?}", pending.error);
        let started = conn.lock().await.execute("BEGIN", None).await.unwrap();
        assert!(started.error.is_none());
        let inserted = conn.lock().await.execute(
            "INSERT INTO dataace_pending VALUES ('keep pending')", None,
        ).await.unwrap();
        assert!(inserted.error.is_none());
        let nested = create_table_with_database(
            &connections, "postgres", &sql, Some("postgres"),
        ).await.unwrap();
        assert!(nested.error.is_none(), "{:?}", nested.error);
        let failed = create_table_with_statements(
            &connections,
            "postgres",
            &format!("CREATE TABLE \"{}_failed\" (id INTEGER PRIMARY KEY)", table),
            Some("postgres"),
            &["SELECT dataace_missing_function()".to_string()],
        ).await.unwrap();
        assert!(failed.error.is_some());
        let pending = conn.lock().await.execute(
            "SELECT COUNT(*)::text FROM dataace_pending", None,
        ).await.unwrap();
        assert!(pending.error.is_none(), "{:?}", pending.error);
        assert_eq!(pending.rows, vec![vec![Some("1".into())]]);
        let rolled_back = conn.lock().await.execute("ROLLBACK", None).await.unwrap();
        assert!(rolled_back.error.is_none());
        let pending = conn.lock().await.execute(
            "SELECT COUNT(*)::text FROM dataace_pending", None,
        ).await.unwrap();
        assert_eq!(pending.rows, vec![vec![Some("0".into())]]);
        let absent = conn.lock().await.execute(
            &format!("SELECT (to_regclass('\"{}\"') IS NULL)::text", table), None,
        ).await.unwrap();
        assert_eq!(absent.rows, vec![vec![Some("true".into())]]);

        // An aborted user transaction must remain aborted until they roll it back.
        conn.lock().await.execute("BEGIN", None).await.unwrap();
        let broken = conn.lock().await.execute("SELECT dataace_missing_function()", None).await.unwrap();
        assert!(broken.error.is_some());
        let aborted = create_table_with_database(
            &connections, "postgres", &sql, Some("postgres"),
        ).await.unwrap();
        assert!(aborted.error.is_some());
        let still_aborted = conn.lock().await.execute("SELECT 1", None).await.unwrap();
        assert!(still_aborted.error.is_some());
        conn.lock().await.execute("ROLLBACK", None).await.unwrap();
    }
}
