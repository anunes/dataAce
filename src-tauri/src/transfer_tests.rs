use super::*;
use crate::db::{self, sqlite::SqliteConn};
use rusqlite::Connection;
use std::sync::Arc;
use tokio::sync::Mutex;

fn sqlite_profile(id: &str, path: &str) -> TransferProfile {
    serde_json::from_value(serde_json::json!({
        "id": id,
        "type": "sqlite",
        "filePath": path,
    }))
    .unwrap()
}

async fn memory_pair() -> (
    ConnectionMap,
    Arc<Mutex<SqliteConn>>,
    Arc<Mutex<SqliteConn>>,
) {
    let map = db::new_connection_map();
    let source = Arc::new(Mutex::new(SqliteConn::new(":memory:").unwrap()));
    let target = Arc::new(Mutex::new(SqliteConn::new(":memory:").unwrap()));
    map.lock().await.insert(
        "source-session".into(),
        DbConnection::Sqlite(source.clone()),
    );
    map.lock().await.insert(
        "target-session".into(),
        DbConnection::Sqlite(target.clone()),
    );
    (map, source, target)
}

async fn copy_memory(map: &ConnectionMap) -> Result<TransferResult, String> {
    transfer_database(
        map,
        &db::new_tunnel_map(),
        sqlite_profile("source-profile", ":memory:"),
        sqlite_profile("target-profile", ":memory:"),
        "memory".into(),
        "memory".into(),
        Some("source-session".into()),
        Some("target-session".into()),
    )
    .await
}

fn schema(connection: &Connection) -> Vec<(String, String, String, Option<String>)> {
    let mut statement = connection
        .prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name")
        .unwrap();
    statement
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}

type Entry = (i64, String, Option<Vec<u8>>, Option<String>, String, String);

fn entries(connection: &Connection) -> Vec<Entry> {
    let mut statement = connection
        .prepare("SELECT id,label,payload,nullable,created_at,updated_at FROM entries ORDER BY id")
        .unwrap();
    statement
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}

#[tokio::test]
async fn sqlite_transfer_preserves_native_schema_data_and_original() {
    let (map, source, target) = memory_pair().await;
    {
        let source = source.lock().await;
        source
            .conn
            .execute_batch(
                "CREATE TABLE entries (id INTEGER PRIMARY KEY AUTOINCREMENT,
             label TEXT NOT NULL DEFAULT 'untitled', payload BLOB, nullable TEXT,
             created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
             updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
             CREATE INDEX entries_label_idx ON entries(label);
             CREATE VIEW labels AS SELECT id,label FROM entries;
             CREATE TRIGGER entries_timestamp AFTER UPDATE OF label ON entries
             BEGIN UPDATE entries SET updated_at='trigger fired' WHERE id=NEW.id; END;",
            )
            .unwrap();
        source
            .conn
            .execute(
                "INSERT INTO entries(label,payload,nullable) VALUES (?1,?2,NULL)",
                rusqlite::params![
                    "O'Brien\nbackslash\\ and unicode ☃",
                    vec![0_u8, 255, 128, 10, 13]
                ],
            )
            .unwrap();
        source
            .conn
            .execute("INSERT INTO entries DEFAULT VALUES", [])
            .unwrap();
    }
    let before = entries(&source.lock().await.conn);
    let before_schema = schema(&source.lock().await.conn);
    let result = copy_memory(&map)
        .await
        .expect("native backup should succeed");
    assert!(result.source_retained);
    assert_eq!(result.target_database, "memory");
    assert_eq!(entries(&target.lock().await.conn), before);
    assert_eq!(schema(&target.lock().await.conn), before_schema);
    assert_eq!(entries(&source.lock().await.conn), before);

    // Native objects remain functional, not just present in a metadata list.
    {
        let target = target.lock().await;
        target
            .conn
            .execute("UPDATE entries SET label='changed' WHERE id=1", [])
            .unwrap();
        let timestamp: String = target
            .conn
            .query_row("SELECT updated_at FROM entries WHERE id=1", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(timestamp, "trigger fired");
        target
            .conn
            .execute("INSERT INTO entries DEFAULT VALUES", [])
            .unwrap();
        assert_eq!(target.conn.last_insert_rowid(), 3);
        let label: String = target
            .conn
            .query_row("SELECT label FROM labels WHERE id=3", [], |row| row.get(0))
            .unwrap();
        assert_eq!(label, "untitled");
        let mode: String = target
            .conn
            .query_row("PRAGMA locking_mode", [], |row| row.get(0))
            .unwrap();
        assert_eq!(mode.to_ascii_lowercase(), "normal");
        let foreign_keys: i64 = target
            .conn
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .unwrap();
        assert_eq!(foreign_keys, 1);
    }
    assert_eq!(entries(&source.lock().await.conn), before);
}

#[tokio::test]
async fn sqlite_transfer_rejects_nonempty_destination_without_changes() {
    let (map, source, target) = memory_pair().await;
    source
        .lock()
        .await
        .conn
        .execute_batch(
            "CREATE TABLE source_data(value BLOB); INSERT INTO source_data VALUES (X'00FF')",
        )
        .unwrap();
    target
        .lock()
        .await
        .conn
        .execute_batch(
            "CREATE TABLE existing(value TEXT); INSERT INTO existing VALUES ('keep this')",
        )
        .unwrap();
    let before_source = schema(&source.lock().await.conn);
    let before_target = schema(&target.lock().await.conn);
    let error = copy_memory(&map)
        .await
        .err()
        .expect("nonempty destination must be rejected");
    assert!(error.contains("must be empty"), "{error}");
    assert_eq!(schema(&source.lock().await.conn), before_source);
    assert_eq!(schema(&target.lock().await.conn), before_target);
    assert_eq!(
        target
            .lock()
            .await
            .conn
            .query_row("SELECT value FROM existing", [], |row| row
                .get::<_, String>(0))
            .unwrap(),
        "keep this"
    );
    let mode: String = target
        .lock()
        .await
        .conn
        .query_row("PRAGMA locking_mode", [], |row| row.get(0))
        .unwrap();
    assert_eq!(mode.to_ascii_lowercase(), "normal");
}

#[tokio::test]
async fn sqlite_transfer_rejects_same_connection_before_locking() {
    let map = db::new_connection_map();
    let connection = Arc::new(Mutex::new(SqliteConn::new(":memory:").unwrap()));
    connection
        .lock()
        .await
        .conn
        .execute_batch("CREATE TABLE original(value TEXT)")
        .unwrap();
    map.lock().await.insert(
        "source-session".into(),
        DbConnection::Sqlite(connection.clone()),
    );
    map.lock().await.insert(
        "target-session".into(),
        DbConnection::Sqlite(connection.clone()),
    );
    let result = tokio::time::timeout(Duration::from_secs(2), copy_memory(&map))
        .await
        .expect("same-connection detection must not deadlock");
    let error = result.err().expect("same connection must fail");
    assert!(error.contains("same SQLite connection"), "{error}");
    assert!(schema(&connection.lock().await.conn)
        .iter()
        .any(|entry| entry.1 == "original"));
}

#[tokio::test]
async fn sqlite_transfer_rejects_same_file_aliases() {
    let work = Workspace::new().unwrap();
    let path = work.file("original.sqlite");
    let alias = work.file("alias.sqlite");
    let connection = Arc::new(Mutex::new(SqliteConn::new(path.to_str().unwrap()).unwrap()));
    connection
        .lock()
        .await
        .conn
        .execute_batch("CREATE TABLE original(value BLOB); INSERT INTO original VALUES(X'00FF')")
        .unwrap();
    fs::hard_link(&path, &alias).unwrap();
    assert!(same_sqlite_file(
        path.to_str().unwrap(),
        alias.to_str().unwrap()
    ));
    let map = db::new_connection_map();
    // File-identity validation runs before the session lookup.
    let error = transfer_database(
        &map,
        &db::new_tunnel_map(),
        sqlite_profile("source", path.to_str().unwrap()),
        sqlite_profile("target", alias.to_str().unwrap()),
        "original".into(),
        "alias".into(),
        None,
        None,
    )
    .await
    .err()
    .expect("hard links must be rejected");
    assert!(error.contains("same SQLite file"), "{error}");
    assert_eq!(
        connection
            .lock()
            .await
            .conn
            .query_row("SELECT hex(value) FROM original", [], |row| row
                .get::<_, String>(0))
            .unwrap(),
        "00FF"
    );
}

#[tokio::test]
async fn sqlite_transfer_preserves_pending_transactions_on_rejection() {
    for pending_source in [true, false] {
        let (map, source, target) = memory_pair().await;
        source
            .lock()
            .await
            .conn
            .execute_batch("CREATE TABLE pending(value TEXT)")
            .unwrap();
        if pending_source {
            source
                .lock()
                .await
                .conn
                .execute_batch("BEGIN; INSERT INTO pending VALUES('keep pending')")
                .unwrap();
        } else {
            target.lock().await.conn.execute_batch("BEGIN").unwrap();
        }
        let error = copy_memory(&map)
            .await
            .err()
            .expect("pending transaction must fail");
        assert!(error.contains("pending SQLite transactions"), "{error}");
        let connection = if pending_source { &source } else { &target };
        assert!(!connection.lock().await.conn.is_autocommit());
        if pending_source {
            let count: i64 = source
                .lock()
                .await
                .conn
                .query_row("SELECT COUNT(*) FROM pending", [], |row| row.get(0))
                .unwrap();
            assert_eq!(count, 1);
        }
        connection
            .lock()
            .await
            .conn
            .execute_batch("ROLLBACK")
            .unwrap();
        assert!(connection.lock().await.conn.is_autocommit());
        assert!(schema(&target.lock().await.conn).is_empty());
    }
}

#[tokio::test]
async fn sqlite_transfer_preserves_attached_destination_databases_on_rejection() {
    let (map, source, target) = memory_pair().await;
    source
        .lock()
        .await
        .conn
        .execute_batch(
            "CREATE TABLE source_data(value TEXT); INSERT INTO source_data VALUES('source')",
        )
        .unwrap();
    target.lock().await.conn.execute_batch("ATTACH DATABASE ':memory:' AS extra; CREATE TABLE extra.pending(value TEXT); INSERT INTO extra.pending VALUES('keep attached')").unwrap();
    let error = copy_memory(&map)
        .await
        .err()
        .expect("attached destination databases must be preserved");
    assert!(error.contains("attached databases"), "{error}");
    assert!(schema(&target.lock().await.conn).is_empty());
    let pending: String = target
        .lock()
        .await
        .conn
        .query_row("SELECT value FROM extra.pending", [], |row| row.get(0))
        .unwrap();
    assert_eq!(pending, "keep attached");
    let original: String = source
        .lock()
        .await
        .conn
        .query_row("SELECT value FROM source_data", [], |row| row.get(0))
        .unwrap();
    assert_eq!(original, "source");
}

#[tokio::test]
async fn sqlite_transfer_copies_file_databases_using_wal() {
    let work = Workspace::new().unwrap();
    let source_path = work.file("source.sqlite");
    let target_path = work.file("target.sqlite");
    let source = Arc::new(Mutex::new(
        SqliteConn::new(source_path.to_str().unwrap()).unwrap(),
    ));
    let target = Arc::new(Mutex::new(
        SqliteConn::new(target_path.to_str().unwrap()).unwrap(),
    ));
    source.lock().await.conn.execute_batch("CREATE TABLE records(id INTEGER PRIMARY KEY, value BLOB); INSERT INTO records VALUES(1,X'00FF0080')").unwrap();
    let map = db::new_connection_map();
    map.lock().await.insert(
        "source-session".into(),
        DbConnection::Sqlite(source.clone()),
    );
    map.lock().await.insert(
        "target-session".into(),
        DbConnection::Sqlite(target.clone()),
    );
    let result = transfer_database(
        &map,
        &db::new_tunnel_map(),
        sqlite_profile("source", source_path.to_str().unwrap()),
        sqlite_profile("target", target_path.to_str().unwrap()),
        "source".into(),
        "target".into(),
        Some("source-session".into()),
        Some("target-session".into()),
    )
    .await
    .expect("WAL source/destination backup should succeed");
    assert!(result.source_retained);
    for connection in [&source, &target] {
        let data: Vec<u8> = connection
            .lock()
            .await
            .conn
            .query_row("SELECT value FROM records WHERE id=1", [], |row| row.get(0))
            .unwrap();
        assert_eq!(data, vec![0, 255, 0, 128]);
    }
    // Reopening verifies copied content survives the live connection.
    let reopened = Connection::open(&target_path).unwrap();
    assert_eq!(
        reopened
            .query_row("SELECT COUNT(*) FROM records", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[tokio::test]
async fn sqlite_transfer_restores_settings_when_destination_is_busy() {
    let work = Workspace::new().unwrap();
    let path = work.file("busy.sqlite");
    let source = Arc::new(Mutex::new(SqliteConn::new(":memory:").unwrap()));
    source
        .lock()
        .await
        .conn
        .execute_batch(
            "CREATE TABLE records(value TEXT); INSERT INTO records VALUES('source remains')",
        )
        .unwrap();
    let target = Arc::new(Mutex::new(SqliteConn::new(path.to_str().unwrap()).unwrap()));
    target
        .lock()
        .await
        .conn
        .busy_timeout(Duration::from_millis(50))
        .unwrap();
    let external = Connection::open(&path).unwrap();
    external
        .execute_batch("BEGIN IMMEDIATE; CREATE TABLE external_pending(value TEXT)")
        .unwrap();
    let map = db::new_connection_map();
    map.lock().await.insert(
        "source-session".into(),
        DbConnection::Sqlite(source.clone()),
    );
    map.lock().await.insert(
        "target-session".into(),
        DbConnection::Sqlite(target.clone()),
    );
    let tunnels = db::new_tunnel_map();
    let transfer = || {
        transfer_database(
            &map,
            &tunnels,
            sqlite_profile("source", ":memory:"),
            sqlite_profile("target", path.to_str().unwrap()),
            "memory".into(),
            "busy".into(),
            Some("source-session".into()),
            Some("target-session".into()),
        )
    };
    let error = transfer()
        .await
        .err()
        .expect("a busy destination must reject the transfer");
    assert!(
        error.contains("locked") || error.contains("busy"),
        "{error}"
    );
    let mode: String = target
        .lock()
        .await
        .conn
        .query_row("PRAGMA locking_mode", [], |row| row.get(0))
        .unwrap();
    assert_eq!(mode.to_ascii_lowercase(), "normal");
    assert_eq!(
        source
            .lock()
            .await
            .conn
            .query_row("SELECT value FROM records", [], |row| row
                .get::<_, String>(0))
            .unwrap(),
        "source remains"
    );
    external.execute_batch("ROLLBACK").unwrap();
    // Exclusive empty-destination protection also excludes idle WAL handles:
    // the other application must close the database before this operation.
    drop(external);
    transfer()
        .await
        .expect("retry should succeed after the external database handle closes");
}
