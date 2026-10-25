pub mod mssql;
pub mod mysql;
pub mod oracle;
pub mod postgres;
pub mod sqlite;
pub mod ssh;
pub mod types;

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

pub enum DbConnection {
    Sqlite(Arc<Mutex<sqlite::SqliteConn>>),
    Mysql(Arc<Mutex<mysql::MysqlConn>>),
    Postgres(Arc<Mutex<postgres::PostgresConn>>),
    Oracle(Arc<Mutex<oracle::OracleConn>>),
    Mssql(Arc<Mutex<mssql::MssqlConn>>),
}

pub type ConnectionMap = Arc<Mutex<HashMap<String, DbConnection>>>;
pub type TunnelMap = Arc<Mutex<HashMap<String, ssh::SshTunnel>>>;

pub fn new_connection_map() -> ConnectionMap {
    Arc::new(Mutex::new(HashMap::new()))
}

pub fn new_tunnel_map() -> TunnelMap {
    Arc::new(Mutex::new(HashMap::new()))
}
