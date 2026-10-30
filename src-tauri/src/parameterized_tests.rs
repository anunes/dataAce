use super::*;
use std::sync::Arc;
use tokio::sync::Mutex;

fn parameter(kind: ParameterType, value: &str) -> QueryParameter {
    QueryParameter { kind, value: value.into() }
}

async fn database() -> (ConnectionMap, Arc<Mutex<crate::db::sqlite::SqliteConn>>) {
    let connection = Arc::new(Mutex::new(crate::db::sqlite::SqliteConn::new(":memory:").unwrap()));
    connection.lock().await.conn.execute_batch(
        "CREATE TABLE customers(id INTEGER PRIMARY KEY, name TEXT, active INTEGER NOT NULL, note TEXT); \
         CREATE TABLE orders(id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), amount REAL); \
         INSERT INTO customers VALUES (1,'Alice',1,NULL),(2,'Bob',0,'note'),(3,'Carol',1,NULL); \
         INSERT INTO orders VALUES (1,1,25.5),(2,1,30),(3,2,15);",
    ).unwrap();
    let connections = crate::db::new_connection_map();
    connections.lock().await.insert("sqlite".into(), DbConnection::Sqlite(connection.clone()));
    (connections, connection)
}

#[tokio::test]
async fn parameterized_sqlite_treats_injection_payloads_as_values() {
    let (connections, connection) = database().await;
    let payloads = ["' OR 1=1 --", "Alice'; DROP TABLE customers; --", "a\\'; DELETE FROM orders; --", "Alice\nUNION SELECT password FROM users"];
    for payload in payloads {
        let result = execute(&connections, "sqlite", "SELECT name FROM customers WHERE name = ?", Some("memory"), &[parameter(ParameterType::Text, payload)]).await.unwrap();
        assert!(result.rows.is_empty(), "SQL-looking input must be compared as one literal value");
    }
    let count: i64 = connection.lock().await.conn.query_row("SELECT COUNT(*) FROM customers", [], |row| row.get(0)).unwrap();
    assert_eq!(count, 3);
    let count: i64 = connection.lock().await.conn.query_row("SELECT COUNT(*) FROM orders", [], |row| row.get(0)).unwrap();
    assert_eq!(count, 3);
    // Exact text, including quotes, is retrievable with the same binding.
    connection.lock().await.conn.execute("UPDATE customers SET name = ?1 WHERE id = 3", [payloads[1]]).unwrap();
    let result = execute(&connections, "sqlite", "SELECT id FROM customers WHERE name = ?", None, &[parameter(ParameterType::Text, payloads[1])]).await.unwrap();
    assert_eq!(result.rows, vec![vec![Some("3".into())]]);
}

#[tokio::test]
async fn parameterized_sqlite_joins_groups_orders_and_binds_types() {
    let (connections, _) = database().await;
    let result = execute(&connections, "sqlite", "SELECT c.name, COUNT(o.id) AS total, SUM(o.amount) AS spent FROM customers AS c LEFT JOIN orders AS o ON c.id=o.customer_id WHERE c.active = ? AND c.note IS ? GROUP BY c.id,c.name HAVING SUM(o.amount) > ? ORDER BY spent DESC", Some("memory"), &[
        parameter(ParameterType::Boolean, "true"), parameter(ParameterType::Null, "ignored"), parameter(ParameterType::Decimal, "50.50"),
    ]).await.unwrap();
    assert_eq!(result.rows, vec![vec![Some("Alice".into()),Some("2".into()),Some("55.5".into())]]);
    assert_eq!(result.columns.iter().map(|column| column.name.as_str()).collect::<Vec<_>>(), vec!["name","total","spent"]);
    let result = execute(&connections, "sqlite", "SELECT name FROM customers WHERE id = ?", None, &[parameter(ParameterType::Integer, "2")]).await.unwrap();
    assert_eq!(result.rows, vec![vec![Some("Bob".into())]]);
}

#[tokio::test]
async fn parameterized_sqlite_preserves_empty_metadata_and_rejects_batches_and_writes() {
    let (connections, connection) = database().await;
    let result = execute(&connections, "sqlite", "SELECT id, name FROM customers WHERE id = ?", None, &[parameter(ParameterType::Integer, "999")]).await.unwrap();
    assert_eq!(result.columns.len(), 2);
    assert!(result.rows.is_empty());
    for sql in ["SELECT name FROM customers; DROP TABLE customers", "DELETE FROM customers", "SELECT 1 INTO discarded", "SELECT * FROM customers FOR UPDATE", "SELECT 1; SELECT 2"] {
        assert!(execute(&connections, "sqlite", sql, None, &[]).await.is_err(), "must reject {sql}");
    }
    assert!(execute(&connections, "sqlite", "SELECT ?", None, &[]).await.is_err());
    assert!(execute(&connections, "sqlite", "SELECT 1", None, &[parameter(ParameterType::Text,"extra")]).await.is_err());
    assert!(execute(&connections, "sqlite", "SELECT ?", None, &[parameter(ParameterType::Integer,"1 OR 1=1")]).await.is_err());
    assert_eq!(connection.lock().await.conn.query_row("SELECT COUNT(*) FROM customers", [], |row| row.get::<_, i64>(0)).unwrap(), 3);
}

#[test]
fn parameter_values_validate_without_sql_interpolation() {
    for number in ["0", "-123.456", "+.5", "1.", "1e-5", "123456789012345678.123456789012"] { assert!(valid_decimal(number), "{number}"); }
    for number in ["", ".", "-", "NaN", "Infinity", "1e999", "1; DROP TABLE x", "1.2.3", "1e", "--1"] { assert!(!valid_decimal(number), "{number}"); }
    assert!(parameter(ParameterType::Integer,"9223372036854775807").bind_value().is_ok());
    assert!(parameter(ParameterType::Integer,"9223372036854775808").bind_value().is_err());
    assert!(parameter(ParameterType::Boolean,"true OR 1=1").bind_value().is_err());
}

#[test]
fn select_guard_handles_quoted_identifiers_and_comments() {
    for sql in ["SELECT \"semi;colon\" FROM \"DROP\"", "SELECT [name]]; DROP] FROM [table]", "SELECT `a``;b` FROM `create`", "/* leading */ SELECT 1; -- trailing comment", "SELECT 'not;a;batch'", "SELECT /* nested /* comment */ done */ 1"] {
        assert!(validate_select(sql).is_ok(), "{sql}");
    }
    for sql in ["", "/* unfinished SELECT 1", "SELECT \"unfinished", "SELECT 1; /* comment */ SELECT 2", "/* INSERT */ DELETE FROM x"] {
        assert!(validate_select(sql).is_err(), "{sql}");
    }
}

#[test]
fn postgres_numeric_decoder_keeps_precision_scale_and_sign() {
    let encode = |weight: i16, sign: u16, scale: u16, digits: &[u16]| {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&(digits.len() as i16).to_be_bytes());
        bytes.extend_from_slice(&weight.to_be_bytes());
        bytes.extend_from_slice(&sign.to_be_bytes());
        bytes.extend_from_slice(&scale.to_be_bytes());
        for digit in digits { bytes.extend_from_slice(&digit.to_be_bytes()); }
        bytes
    };
    assert_eq!(pg_numeric(&encode(4,0,12,&[12,3456,7890,1234,5678,1234,5678,9012])).unwrap(), "123456789012345678.123456789012");
    assert_eq!(pg_numeric(&encode(-2,0x4000,8,&[12])).unwrap(), "-0.00000012");
    assert_eq!(pg_numeric(&encode(0,0,4,&[])).unwrap(), "0.0000");
    assert_eq!(pg_numeric(&encode(0,0xC000,0,&[])).unwrap(), "NaN");
}

#[tokio::test]
#[ignore = "requires disposable PostgreSQL; set DATAACE_PARAMETERS_PG_PORT"]
async fn parameterized_postgres_native_bindings_and_typed_results() {
    let port = std::env::var("DATAACE_PARAMETERS_PG_PORT").unwrap().parse().unwrap();
    let connection = Arc::new(Mutex::new(crate::db::postgres::PostgresConn::new("127.0.0.1", port, "dataace_parameters_test", "", "postgres").await.unwrap()));
    let payload = "x'; DROP TABLE parameter_values; --";
    {
        let connection = connection.lock().await;
        connection.client.batch_execute("CREATE TEMP TABLE parameter_values(id BIGINT PRIMARY KEY, title TEXT, amount NUMERIC(30,12), active BOOLEAN, recorded TIMESTAMPTZ, unique_id UUID, settings JSONB); INSERT INTO parameter_values VALUES(1,'normal',123456789012345678.123456789012,true,'2026-10-30T12:34:56.123456Z','f47ac10b-58cc-4372-a567-0e02b2c3d479','{\"a\":1}');").await.unwrap();
        connection.client.execute("INSERT INTO parameter_values(id,title,active) VALUES(2,$1,false)", &[&payload]).await.unwrap();
    }
    let connections = crate::db::new_connection_map();
    connections.lock().await.insert("postgres".into(), DbConnection::Postgres(connection.clone()));
    let literal = execute(&connections,"postgres","SELECT id FROM parameter_values WHERE title = $1",Some("postgres"),&[parameter(ParameterType::Text,payload)]).await.unwrap();
    assert_eq!(literal.rows, vec![vec![Some("2".into())]]);
    let typed = execute(&connections,"postgres","SELECT id,amount,recorded,unique_id,settings FROM parameter_values WHERE amount = $1 AND active = $2 AND recorded = $3 AND unique_id = $4",Some("postgres"),&[
        parameter(ParameterType::Decimal,"123456789012345678.123456789012"),
        parameter(ParameterType::Boolean,"true"),
        parameter(ParameterType::Text,"2026-10-30T12:34:56.123456Z"),
        parameter(ParameterType::Text,"f47ac10b-58cc-4372-a567-0e02b2c3d479"),
    ]).await.unwrap();
    assert_eq!(typed.rows.len(), 1);
    assert_eq!(typed.rows[0][1].as_deref(),Some("123456789012345678.123456789012"));
    assert!(typed.rows[0][2].as_ref().unwrap().contains("12:34:56.123456"));
    assert_eq!(typed.rows[0][3].as_deref(),Some("f47ac10b-58cc-4372-a567-0e02b2c3d479"));
    assert_eq!(typed.rows[0][4].as_deref(),Some("{\"a\":1}"));
    let null = execute(&connections,"postgres","SELECT id FROM parameter_values WHERE amount IS NOT DISTINCT FROM $1 ORDER BY id",Some("postgres"),&[parameter(ParameterType::Null,"")]).await.unwrap();
    assert_eq!(null.rows,vec![vec![Some("2".into())]]);
    let aggregate = execute(&connections,"postgres","SELECT active,COUNT(*) AS total,SUM(amount) AS amount FROM parameter_values GROUP BY active HAVING COUNT(*) >= $1 ORDER BY active DESC",Some("postgres"),&[parameter(ParameterType::Integer,"1")]).await.unwrap();
    assert_eq!(aggregate.rows.len(),2);
    assert_eq!(aggregate.rows[0][2].as_deref(),Some("123456789012345678.123456789012"));
    assert!(execute(&connections,"postgres","SELECT 1",Some("wrong-database"),&[]).await.is_err());
    assert!(execute(&connections,"postgres","SELECT 1; DROP TABLE parameter_values",Some("postgres"),&[]).await.is_err());
    assert_eq!(connection.lock().await.client.query_one("SELECT COUNT(*) FROM parameter_values",&[]).await.unwrap().get::<_,i64>(0),2);
}

#[tokio::test]
#[ignore = "requires disposable MySQL; set DATAACE_PARAMETERS_MYSQL_PORT"]
async fn parameterized_mysql_native_bindings_and_selected_database() {
    use mysql_async::prelude::Queryable;
    let port = std::env::var("DATAACE_PARAMETERS_MYSQL_PORT").unwrap().parse().unwrap();
    let connection = Arc::new(Mutex::new(crate::db::mysql::MysqlConn::new("127.0.0.1",port,"root","",None,false,false).await.unwrap()));
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let database = format!("dataace_parameter_values_{suffix}");
    let payload = "x'; DROP TABLE parameter_values; --";
    {
        let connection = connection.lock().await;
        let mut client = connection.pool.get_conn().await.unwrap();
        client.query_drop(format!("CREATE DATABASE `{database}`")).await.unwrap();
        client.query_drop(format!("CREATE TABLE `{database}`.parameter_values(id BIGINT PRIMARY KEY,title TEXT,amount DECIMAL(30,12),active BOOLEAN,recorded DATETIME(6))")).await.unwrap();
        client.query_drop(format!("INSERT INTO `{database}`.parameter_values VALUES(1,'normal',123456789012345678.123456789012,true,'2026-10-30 12:34:56.123456')")).await.unwrap();
        client.exec_drop(format!("INSERT INTO `{database}`.parameter_values(id,title,active) VALUES(2,?,false)"),(payload,)).await.unwrap();
    }
    let connections = crate::db::new_connection_map();
    connections.lock().await.insert("mysql".into(),DbConnection::Mysql(connection.clone()));
    let outcome = async {
        let literal = execute(&connections,"mysql","SELECT id FROM parameter_values WHERE title = ?",Some(&database),&[parameter(ParameterType::Text,payload)]).await?;
        assert_eq!(literal.rows,vec![vec![Some("2".into())]]);
        let typed = execute(&connections,"mysql","SELECT id,amount,recorded FROM parameter_values WHERE amount = ? AND active = ?",Some(&database),&[parameter(ParameterType::Decimal,"123456789012345678.123456789012"),parameter(ParameterType::Boolean,"true")]).await?;
        assert_eq!(typed.rows[0][1].as_deref(),Some("123456789012345678.123456789012"));
        assert_eq!(typed.rows[0][2].as_deref(),Some("2026-10-30 12:34:56.123456"));
        let null = execute(&connections,"mysql","SELECT id FROM parameter_values WHERE amount <=> ?",Some(&database),&[parameter(ParameterType::Null,"")]).await?;
        assert_eq!(null.rows,vec![vec![Some("2".into())]]);
        let count = execute(&connections,"mysql","SELECT COUNT(*) FROM parameter_values",Some(&database),&[]).await?;
        assert_eq!(count.rows,vec![vec![Some("2".into())]]);
        assert!(execute(&connections,"mysql","SELECT 1; DROP TABLE parameter_values",Some(&database),&[]).await.is_err());
        Ok::<(),String>(())
    }.await;
    connection.lock().await.pool.get_conn().await.unwrap().query_drop(format!("DROP DATABASE `{database}`")).await.unwrap();
    outcome.unwrap();
}
