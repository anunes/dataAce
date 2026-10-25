use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ColumnDef {
    pub name: String,
    pub col_type: String,
    pub nullable: bool,
    pub is_primary_key: bool,
    pub default_value: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct QueryResult {
    pub columns: Vec<ColumnDef>,
    pub rows: Vec<Vec<Option<String>>>,
    pub affected_rows: u64,
    pub last_insert_id: u64,
    pub execution_time_ms: f64,
    pub error: Option<String>,
}

impl QueryResult {
    pub fn empty() -> Self {
        Self {
            columns: vec![],
            rows: vec![],
            affected_rows: 0,
            last_insert_id: 0,
            execution_time_ms: 0.0,
            error: None,
        }
    }

    pub fn from_error(msg: String) -> Self {
        Self {
            error: Some(msg),
            ..Self::empty()
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TableInfo {
    pub name: String,
    pub table_type: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ColumnInfo {
    pub name: String,
    pub col_type: String,
    pub nullable: bool,
    pub key_type: String,
    pub default_value: Option<String>,
    pub extra: String,
    pub charset: String,
    pub collation: String,
    pub comment: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct IndexInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
    pub index_type: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ForeignKeyInfo {
    pub constraint_name: String,
    pub column_name: String,
    pub referenced_table: String,
    pub referenced_column: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TriggerInfo {
    pub name: String,
    pub event: String,
    pub timing: String,
    pub statement: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MysqlUser {
    pub username: String,
    pub host: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MysqlSchemaPriv {
    pub schema: String,
    pub privilege_type: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MysqlResourceLimits {
    pub max_updates: u64,
    pub max_connections: u64,
    pub max_questions: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TableInfoData {
    pub row_count: String,
    pub size: String,
    pub data_size: String,
    pub index_size: String,
    pub engine: String,
    pub collation: String,
    pub created: String,
    pub comment: String,
    pub auto_increment: Option<String>,
}
