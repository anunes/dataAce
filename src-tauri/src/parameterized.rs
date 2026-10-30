//! Prepared, bound SELECT execution for the visual query builder.
//! SQL text and parameter values never share an interpolation path.

use std::error::Error;
use std::time::Instant;

use bytes::BytesMut;
use mysql_async::consts::ColumnFlags;
use mysql_async::prelude::Queryable;
use serde::Deserialize;
use tokio_postgres::types::{Format, FromSql, IsNull, ToSql, Type};

use crate::db::types::{ColumnDef, QueryResult};
use crate::db::{ConnectionMap, DbConnection};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ParameterType { Text, Integer, Decimal, Boolean, Null }

#[derive(Debug, Clone, Deserialize)]
pub struct QueryParameter {
    #[serde(rename = "type")]
    pub kind: ParameterType,
    #[serde(default)]
    pub value: String,
}

#[derive(Debug, Clone)]
enum BoundValue { Text(String), Integer(i64), Decimal(String), Boolean(bool), Null }

impl QueryParameter {
    fn bind_value(&self) -> Result<BoundValue, String> {
        match self.kind {
            ParameterType::Text => Ok(BoundValue::Text(self.value.clone())),
            ParameterType::Integer => self.value.trim().parse::<i64>().map(BoundValue::Integer)
                .map_err(|_| "Integer parameters must be valid signed 64-bit whole numbers.".to_string()),
            ParameterType::Decimal => {
                let value = self.value.trim();
                if !valid_decimal(value) { return Err("Decimal parameters must be finite numbers, optionally with an exponent.".into()); }
                Ok(BoundValue::Decimal(value.to_string()))
            }
            ParameterType::Boolean => match self.value.trim().to_ascii_lowercase().as_str() {
                "true" | "1" => Ok(BoundValue::Boolean(true)),
                "false" | "0" => Ok(BoundValue::Boolean(false)),
                _ => Err("Boolean parameters must be true or false.".into()),
            },
            ParameterType::Null => Ok(BoundValue::Null),
        }
    }
}

fn valid_decimal(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut index = usize::from(bytes.first().is_some_and(|byte| matches!(byte, b'+' | b'-')));
    let start = index;
    while bytes.get(index).is_some_and(u8::is_ascii_digit) { index += 1; }
    let mut digits = index - start;
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        let start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) { index += 1; }
        digits += index - start;
    }
    if digits == 0 { return false; }
    if bytes.get(index).is_some_and(|byte| matches!(byte, b'e' | b'E')) {
        index += 1;
        if bytes.get(index).is_some_and(|byte| matches!(byte, b'+' | b'-')) { index += 1; }
        let start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) { index += 1; }
        if index == start { return false; }
    }
    index == bytes.len() && value.parse::<f64>().is_ok_and(f64::is_finite)
}

// This guard is deliberately limited to the SELECT statements emitted by the
// builder. Quotes and comments are tracked so unusual catalog identifiers do
// not turn into tokens. Actual values are always sent through driver bindings.
fn validate_select(sql: &str) -> Result<(), String> {
    let bytes = sql.as_bytes();
    let mut index = 0;
    let mut tokens = Vec::new();
    let mut ended = false;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte.is_ascii_whitespace() { index += 1; continue; }
        if bytes.get(index..index + 2) == Some(b"--") {
            index += 2;
            while index < bytes.len() && bytes[index] != b'\n' { index += 1; }
            continue;
        }
        if bytes.get(index..index + 2) == Some(b"/*") {
            index += 2;
            let mut depth = 1;
            while index < bytes.len() && depth > 0 {
                if bytes.get(index..index + 2) == Some(b"/*") { depth += 1; index += 2; }
                else if bytes.get(index..index + 2) == Some(b"*/") { depth -= 1; index += 2; }
                else { index += 1; }
            }
            if depth != 0 { return Err("The query contains an unfinished comment.".into()); }
            continue;
        }
        if ended { return Err("The query builder runs one SELECT statement at a time.".into()); }
        if byte == b';' { ended = true; index += 1; continue; }
        if matches!(byte, b'\'' | b'"' | b'`' | b'[') {
            let closing = if byte == b'[' { b']' } else { byte };
            index += 1;
            let mut closed = false;
            while index < bytes.len() {
                if bytes[index] == closing {
                    if bytes.get(index + 1) == Some(&closing) { index += 2; continue; }
                    index += 1; closed = true; break;
                }
                index += 1;
            }
            if !closed { return Err("The query contains an unfinished quoted value or identifier.".into()); }
            continue;
        }
        if byte.is_ascii_alphabetic() || byte == b'_' {
            let start = index;
            while bytes.get(index).is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'_') { index += 1; }
            tokens.push(sql[start..index].to_ascii_uppercase());
        } else { index += 1; }
    }
    if tokens.first().map(String::as_str) != Some("SELECT") {
        return Err("The visual query builder only runs SELECT queries.".into());
    }
    if tokens.iter().any(|token| matches!(token.as_str(), "INTO" | "INSERT" | "UPDATE" | "DELETE" | "DROP" | "ALTER" | "CREATE" | "TRUNCATE" | "LOCK")) {
        return Err("The visual query builder only runs SELECT queries without data-changing clauses.".into());
    }
    Ok(())
}

pub async fn execute(connections: &ConnectionMap, conn_id: &str, sql: &str, database: Option<&str>, parameters: &[QueryParameter]) -> Result<QueryResult, String> {
    validate_select(sql)?;
    if parameters.len() > 2000 { return Err("A visual query can contain at most 2,000 parameters.".into()); }
    let values = parameters.iter().map(QueryParameter::bind_value).collect::<Result<Vec<_>, _>>()?;
    let database = database.filter(|database| !database.is_empty());
    let map = connections.lock().await;
    match map.get(conn_id).ok_or("Connection not found")? {
        DbConnection::Sqlite(connection) => execute_sqlite(&connection.lock().await.conn, sql, &values),
        DbConnection::Mysql(connection) => execute_mysql(&*connection.lock().await, sql, database, &values).await,
        DbConnection::Postgres(connection) => execute_postgres(&*connection.lock().await, sql, database, &values).await,
        DbConnection::Mssql(connection) => execute_mssql(&mut *connection.lock().await, sql, database, &values).await,
        DbConnection::Oracle(connection) => execute_oracle(&*connection.lock().await, sql, database, &values),
    }
}

fn execute_sqlite(connection: &rusqlite::Connection, sql: &str, values: &[BoundValue]) -> Result<QueryResult, String> {
    let start = Instant::now();
    let mut statement = connection.prepare(sql).map_err(|error| error.to_string())?;
    if !statement.readonly() { return Err("The query builder only executes read-only SQLite statements.".into()); }
    if statement.parameter_count() != values.len() { return Err("The number of SQL placeholders does not match the provided parameters.".into()); }
    let columns = statement.column_names().iter().map(|name| column(name, "")).collect();
    let bindings = values.iter().map(|value| match value {
        BoundValue::Text(value) => rusqlite::types::Value::Text(value.clone()),
        BoundValue::Integer(value) => rusqlite::types::Value::Integer(*value),
        BoundValue::Decimal(value) => rusqlite::types::Value::Real(value.parse().expect("validated decimal")),
        BoundValue::Boolean(value) => rusqlite::types::Value::Integer(i64::from(*value)),
        BoundValue::Null => rusqlite::types::Value::Null,
    });
    let count = statement.column_count();
    let mut stream = statement.query(rusqlite::params_from_iter(bindings)).map_err(|error| error.to_string())?;
    let mut rows = Vec::new();
    while let Some(row) = stream.next().map_err(|error| error.to_string())? {
        let values = (0..count).map(|index| row.get_ref(index).map(|value| match value {
            rusqlite::types::ValueRef::Null => None,
            rusqlite::types::ValueRef::Integer(value) => Some(value.to_string()),
            rusqlite::types::ValueRef::Real(value) => Some(value.to_string()),
            rusqlite::types::ValueRef::Text(value) => Some(String::from_utf8_lossy(value).to_string()),
            rusqlite::types::ValueRef::Blob(value) => Some(hex(value)),
        }).map_err(|error| error.to_string())).collect::<Result<Vec<_>, _>>()?;
        rows.push(values);
    }
    Ok(result(columns, rows, start))
}

async fn execute_mysql(connection: &crate::db::mysql::MysqlConn, sql: &str, database: Option<&str>, values: &[BoundValue]) -> Result<QueryResult, String> {
    let start = Instant::now();
    let mut client = connection.pool.get_conn().await.map_err(|error| error.to_string())?;
    if let Some(database) = database.or(connection.current_db.as_deref()) {
        client.query_drop(format!("USE `{}`", database.replace('`', "``"))).await.map_err(|error| error.to_string())?;
    }
    let statement = client.prep(sql).await.map_err(|error| error.to_string())?;
    if statement.params().len() != values.len() { return Err("The number of SQL placeholders does not match the provided parameters.".into()); }
    let values: Vec<mysql_async::Value> = values.iter().map(|value| match value {
        BoundValue::Text(value) | BoundValue::Decimal(value) => mysql_async::Value::Bytes(value.as_bytes().to_vec()),
        BoundValue::Integer(value) => mysql_async::Value::Int(*value),
        BoundValue::Boolean(value) => mysql_async::Value::Int(i64::from(*value)),
        BoundValue::Null => mysql_async::Value::NULL,
    }).collect();
    let mut stream = client.exec_iter(&statement, mysql_async::Params::Positional(values)).await.map_err(|error| error.to_string())?;
    let columns = stream.columns_ref().iter().map(|meta| ColumnDef {
        name: meta.name_str().to_string(), col_type: format!("{:?}", meta.column_type()),
        nullable: !meta.flags().contains(ColumnFlags::NOT_NULL_FLAG), is_primary_key: meta.flags().contains(ColumnFlags::PRI_KEY_FLAG), default_value: None,
    }).collect();
    let rows: Vec<mysql_async::Row> = stream.collect().await.map_err(|error| error.to_string())?;
    let rows = rows.into_iter().map(|mut row| (0..row.len()).map(|index| row.take::<mysql_async::Value, _>(index).and_then(mysql_value)).collect()).collect();
    Ok(result(columns, rows, start))
}

fn mysql_value(value: mysql_async::Value) -> Option<String> {
    use mysql_async::Value;
    Some(match value {
        Value::NULL => return None,
        Value::Bytes(value) => String::from_utf8(value.clone()).unwrap_or_else(|_| hex(&value)),
        Value::Int(value) => value.to_string(), Value::UInt(value) => value.to_string(),
        Value::Float(value) => value.to_string(), Value::Double(value) => value.to_string(),
        Value::Date(year, month, day, hour, minute, second, micros) => {
            let base = format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}");
            if micros == 0 { base } else { format!("{base}.{micros:06}") }
        }
        Value::Time(negative, days, hour, minute, second, micros) => {
            let base = format!("{}{}:{minute:02}:{second:02}", if negative { "-" } else { "" }, days * 24 + u32::from(hour));
            if micros == 0 { base } else { format!("{base}.{micros:06}") }
        }
    })
}

#[derive(Debug)]
struct PgParameter(Option<String>);

impl ToSql for PgParameter {
    fn to_sql(&self, _: &Type, output: &mut BytesMut) -> Result<IsNull, Box<dyn Error + Sync + Send>> {
        if let Some(value) = &self.0 { output.extend_from_slice(value.as_bytes()); Ok(IsNull::No) } else { Ok(IsNull::Yes) }
    }
    fn accepts(_: &Type) -> bool { true }
    fn encode_format(&self, _: &Type) -> Format { Format::Text }
    tokio_postgres::types::to_sql_checked!();
}

async fn execute_postgres(connection: &crate::db::postgres::PostgresConn, sql: &str, database: Option<&str>, values: &[BoundValue]) -> Result<QueryResult, String> {
    let start = Instant::now();
    if database.is_some_and(|database| database != connection.current_db) {
        return Err("The selected database differs from the PostgreSQL connection. Reconnect to the selected database before running this query.".into());
    }
    let statement = connection.client.prepare(sql).await.map_err(pg_error)?;
    if statement.params().len() != values.len() { return Err("The number of SQL placeholders does not match the provided parameters.".into()); }
    let bindings: Vec<PgParameter> = values.iter().map(|value| PgParameter(match value {
        BoundValue::Text(value) | BoundValue::Decimal(value) => Some(value.clone()),
        BoundValue::Integer(value) => Some(value.to_string()), BoundValue::Boolean(value) => Some(value.to_string()), BoundValue::Null => None,
    })).collect();
    let bindings: Vec<&(dyn ToSql + Sync)> = bindings.iter().map(|value| value as &(dyn ToSql + Sync)).collect();
    let columns = statement.columns().iter().map(|meta| column(meta.name(), meta.type_().name())).collect();
    let rows = connection.client.query(&statement, &bindings).await.map_err(pg_error)?;
    let rows = rows.iter().map(|row| (0..row.len()).map(|index| pg_value(row, index)).collect::<Result<Vec<_>, _>>()).collect::<Result<Vec<_>, _>>()?;
    Ok(result(columns, rows, start))
}

fn pg_error(error: tokio_postgres::Error) -> String {
    error.as_db_error().map(|error| error.message().to_string()).unwrap_or_else(|| error.to_string())
}

#[derive(Debug)]
struct PgRaw(Vec<u8>);
impl<'a> FromSql<'a> for PgRaw {
    fn from_sql(_: &Type, raw: &'a [u8]) -> Result<Self, Box<dyn Error + Sync + Send>> { Ok(Self(raw.to_vec())) }
    fn accepts(_: &Type) -> bool { true }
}

fn pg_value(row: &tokio_postgres::Row, index: usize) -> Result<Option<String>, String> {
    macro_rules! read { ($kind:ty) => { row.try_get::<_, Option<$kind>>(index).map(|value| value.map(|value| value.to_string())).map_err(|error| error.to_string()) }; }
    let kind = row.columns()[index].type_();
    match *kind {
        Type::BOOL => read!(bool), Type::INT2 => read!(i16), Type::INT4 => read!(i32), Type::INT8 => read!(i64),
        Type::FLOAT4 => read!(f32), Type::FLOAT8 => read!(f64),
        Type::DATE => read!(chrono::NaiveDate), Type::TIME => read!(chrono::NaiveTime),
        Type::TIMESTAMP => read!(chrono::NaiveDateTime), Type::TIMESTAMPTZ => read!(chrono::DateTime<chrono::Utc>),
        Type::UUID => read!(uuid::Uuid), Type::JSON | Type::JSONB => read!(serde_json::Value),
        Type::NUMERIC => row.try_get::<_, Option<PgRaw>>(index).map_err(|error| error.to_string())?.map(|value| pg_numeric(&value.0)).transpose(),
        Type::BYTEA => row.try_get::<_, Option<Vec<u8>>>(index).map(|value| value.map(|value| hex(&value))).map_err(|error| error.to_string()),
        _ => {
            if let Ok(value) = row.try_get::<_, Option<String>>(index) { return Ok(value); }
            // Enum values use their label bytes. Unknown binary types are shown
            // as hex, so unsupported display types never panic or become NULL.
            let raw = row.try_get::<_, Option<PgRaw>>(index).map_err(|error| error.to_string())?;
            Ok(raw.map(|value| match kind.kind() {
                tokio_postgres::types::Kind::Enum(_) => String::from_utf8_lossy(&value.0).to_string(),
                _ => hex(&value.0),
            }))
        }
    }
}

fn pg_numeric(raw: &[u8]) -> Result<String, String> {
    if raw.len() < 8 { return Err("Invalid PostgreSQL numeric result.".into()); }
    let short = |index| i16::from_be_bytes([raw[index], raw[index + 1]]);
    let digits = short(0);
    let weight = short(2);
    let sign = u16::from_be_bytes([raw[4], raw[5]]);
    let scale = u16::from_be_bytes([raw[6], raw[7]]) as usize;
    if sign == 0xC000 { return Ok("NaN".into()); }
    if sign == 0xD000 { return Ok("Infinity".into()); }
    if sign == 0xF000 { return Ok("-Infinity".into()); }
    if digits < 0 || raw.len() != 8 + digits as usize * 2 || ![0, 0x4000].contains(&sign) { return Err("Invalid PostgreSQL numeric result.".into()); }
    let group = |exponent: i32| -> Result<u16, String> {
        let index = i32::from(weight) - exponent;
        if index < 0 || index >= i32::from(digits) { return Ok(0); }
        let index = 8 + index as usize * 2;
        let value = u16::from_be_bytes([raw[index], raw[index + 1]]);
        if value > 9999 { Err("Invalid PostgreSQL numeric digit.".into()) } else { Ok(value) }
    };
    let mut value = String::new();
    if sign == 0x4000 { value.push('-'); }
    if weight >= 0 {
        for exponent in (0..=i32::from(weight)).rev() {
            let digit = group(exponent)?;
            if exponent == i32::from(weight) { value.push_str(&digit.to_string()); } else { value.push_str(&format!("{digit:04}")); }
        }
    } else { value.push('0'); }
    if scale > 0 {
        value.push('.');
        let mut fractional = String::new();
        for index in 1..=scale.div_ceil(4) { fractional.push_str(&format!("{:04}", group(-(index as i32))?)); }
        fractional.truncate(scale);
        value.push_str(&fractional);
    }
    Ok(value)
}

async fn execute_mssql(connection: &mut crate::db::mssql::MssqlConn, sql: &str, database: Option<&str>, values: &[BoundValue]) -> Result<QueryResult, String> {
    let start = Instant::now();
    if let Some(database) = database {
        tiberius::Query::new(format!("USE [{}]", database.replace(']', "]]"))).execute(&mut connection.client).await.map_err(|error| error.to_string())?;
    }
    let mut query = tiberius::Query::new(sql);
    for value in values {
        match value {
            BoundValue::Text(value) | BoundValue::Decimal(value) => query.bind(value.as_str()),
            BoundValue::Integer(value) => query.bind(*value), BoundValue::Boolean(value) => query.bind(*value),
            BoundValue::Null => query.bind(Option::<&str>::None),
        }
    }
    let mut stream = query.query(&mut connection.client).await.map_err(|error| error.to_string())?;
    let columns: Vec<_> = stream.columns().await.map_err(|error| error.to_string())?.unwrap_or_default().iter().map(|meta| column(meta.name(), &format!("{:?}", meta.column_type()))).collect();
    let rows = stream.into_first_result().await.map_err(|error| error.to_string())?;
    let rows = rows.iter().map(|row| (0..columns.len()).map(|index| mssql_value(row, index)).collect()).collect();
    Ok(result(columns, rows, start))
}

fn mssql_value(row: &tiberius::Row, index: usize) -> Option<String> {
    use tiberius::ColumnData;
    match row.get_column_data(index).ok()? {
        ColumnData::Numeric(value) => return value.map(|value| value.to_string()),
        ColumnData::Guid(value) => return value.map(|value| value.to_string()),
        ColumnData::Binary(value) => return value.as_ref().map(|value| hex(value)),
        ColumnData::Xml(value) => return value.as_ref().map(|value| value.to_string()),
        _ => {}
    }
    macro_rules! datetime { ($kind:ty) => { if let Ok(Some(value)) = row.try_get::<$kind, _>(index) { return Some(value.to_string()); } }; }
    datetime!(chrono::NaiveDateTime);
    datetime!(chrono::NaiveDate);
    datetime!(chrono::NaiveTime);
    datetime!(chrono::DateTime<chrono::FixedOffset>);
    crate::db::mssql::row_value_to_string(row, index)
}

fn execute_oracle(connection: &crate::db::oracle::OracleConn, sql: &str, database: Option<&str>, values: &[BoundValue]) -> Result<QueryResult, String> {
    #[cfg(feature = "oracle-support")]
    {
        let start = Instant::now();
        let previous: Option<String> = if let Some(database) = database {
            let row = connection.conn.query_row("SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') FROM dual", &[]).map_err(|error| error.to_string())?;
            let previous: String = row.get(0).map_err(|error| error.to_string())?;
            connection.conn.execute(&format!("ALTER SESSION SET CURRENT_SCHEMA = \"{}\"", database.replace('"', "\"\"")), &[]).map_err(|error| error.to_string())?;
            Some(previous)
        } else { None };
        let output = (|| {
            let bindings: Vec<Box<dyn oracle::sql_type::ToSql>> = values.iter().map(|value| -> Box<dyn oracle::sql_type::ToSql> { match value {
                BoundValue::Text(value) | BoundValue::Decimal(value) => Box::new(value.clone()),
                BoundValue::Integer(value) => Box::new(*value), BoundValue::Boolean(value) => Box::new(i64::from(*value)),
                BoundValue::Null => Box::new(Option::<String>::None),
            }}).collect();
            let bindings: Vec<&dyn oracle::sql_type::ToSql> = bindings.iter().map(|value| value.as_ref()).collect();
            let cursor = connection.conn.query(sql, &bindings).map_err(|error| error.to_string())?;
            let columns: Vec<_> = cursor.column_info().iter().map(|meta| ColumnDef {
                name: meta.name().to_string(), col_type: format!("{:?}", meta.oracle_type()), nullable: meta.nullable(), is_primary_key: false, default_value: None,
            }).collect();
            let mut rows = Vec::new();
            for row in cursor {
                let row = row.map_err(|error| error.to_string())?;
                rows.push((0..columns.len()).map(|index| row.get::<_, Option<String>>(index).map_err(|error| error.to_string())).collect::<Result<Vec<_>, _>>()?);
            }
            Ok::<_, String>(result(columns, rows, start))
        })();
        if let Some(previous) = previous {
            connection.conn.execute(&format!("ALTER SESSION SET CURRENT_SCHEMA = \"{}\"", previous.replace('"', "\"\"")), &[]).map_err(|error| format!("Cannot restore Oracle schema: {error}"))?;
        }
        output
    }
    #[cfg(not(feature = "oracle-support"))]
    { let _ = (connection, sql, database, values); Err("Oracle support requires rebuilding with --features oracle-support.".into()) }
}

fn column(name: &str, kind: &str) -> ColumnDef { ColumnDef { name: name.to_string(), col_type: kind.to_string(), nullable: true, is_primary_key: false, default_value: None } }
fn result(columns: Vec<ColumnDef>, rows: Vec<Vec<Option<String>>>, start: Instant) -> QueryResult {
    QueryResult { columns, rows, affected_rows: 0, last_insert_id: 0, execution_time_ms: start.elapsed().as_secs_f64() * 1000.0, error: None }
}
fn hex(value: &[u8]) -> String { format!("0x{}", value.iter().map(|byte| format!("{byte:02x}")).collect::<String>()) }

#[cfg(test)]
#[path = "parameterized_tests.rs"]
mod tests;
