use super::*;

fn profile(id: &str, port: u16) -> TransferProfile {
    TransferProfile {
        id: id.into(),
        db_type: "mysql".into(),
        host: "127.0.0.1".into(),
        port,
        username: "root".into(),
        password: String::new(),
        file_path: String::new(),
        database: String::new(),
        ssh: None,
        require_ssl: false,
        skip_ssl_verify: false,
    }
}

#[tokio::test]
#[ignore = "requires two disposable MySQL servers; set DATAACE_TRANSFER_MYSQL_SOURCE_PORT and DATAACE_TRANSFER_MYSQL_TARGET_PORT"]
async fn native_mysql_preserves_full_database_and_retains_source() {
    let source = profile(
        "source",
        std::env::var("DATAACE_TRANSFER_MYSQL_SOURCE_PORT")
            .unwrap()
            .parse()
            .unwrap(),
    );
    let target = profile(
        "target",
        std::env::var("DATAACE_TRANSFER_MYSQL_TARGET_PORT")
            .unwrap()
            .parse()
            .unwrap(),
    );
    let mysql = tool("mysql").unwrap();
    let work = Workspace::new().unwrap();
    let source_options = mysql_options(&mysql, &source, &work, "seed-source.cnf")
        .await
        .unwrap();
    let target_options = mysql_options(&mysql, &target, &work, "verify-target.cnf")
        .await
        .unwrap();
    let name = format!("dataace_native_{}", Uuid::new_v4().simple());
    mysql_query(
        &mysql,
        &source_options,
        &format!("CREATE DATABASE `{name}` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin"),
        &[],
    )
    .await
    .unwrap();
    let seed = format!("USE `{name}`; CREATE TABLE records (id BIGINT AUTO_INCREMENT PRIMARY KEY, note VARCHAR(255), bytes BLOB, amount DECIMAL(30,10), created_at TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP(6), updated_at TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP(6)); CREATE INDEX note_idx ON records(note); CREATE VIEW records_view AS SELECT id,note FROM records; CREATE TRIGGER records_updated BEFORE UPDATE ON records FOR EACH ROW SET NEW.updated_at=CURRENT_TIMESTAMP(6); CREATE PROCEDURE get_record_count() SELECT COUNT(*) FROM records; CREATE FUNCTION get_one() RETURNS INT DETERMINISTIC RETURN 1; CREATE EVENT future_event ON SCHEDULE EVERY 1 DAY STARTS CURRENT_TIMESTAMP + INTERVAL 1 DAY DO SET @dataace_event = 1; INSERT INTO records (note,bytes,amount) VALUES (CONVERT(0x5072696d6569726f20f09f8eb20a71756f746527 USING utf8mb4),0x00ff0100275c,12345678901234567890.1234567890),(NULL,NULL,NULL);");
    mysql_query(&mysql, &source_options, &seed, &[])
        .await
        .unwrap();
    let connections = crate::db::new_connection_map();
    let tunnels = std::sync::Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()));
    // Enabled source events must not start duplicate scheduled jobs on target.
    mysql_query(
        &mysql,
        &target_options,
        "SET GLOBAL event_scheduler=ON",
        &[],
    )
    .await
    .unwrap();
    let guarded = transfer_database(
        &connections,
        &tunnels,
        source.clone(),
        target.clone(),
        name.clone(),
        name.clone(),
        None,
        None,
    )
    .await;
    assert!(guarded.err().unwrap().contains("event scheduler"));
    mysql_query(
        &mysql,
        &target_options,
        "SET GLOBAL event_scheduler=OFF",
        &[],
    )
    .await
    .unwrap();
    let moved = transfer_database(
        &connections,
        &tunnels,
        source.clone(),
        target.clone(),
        name.clone(),
        name.clone(),
        None,
        None,
    )
    .await
    .unwrap();
    assert!(moved.source_retained);
    assert_eq!(moved.target_database, name);
    assert!(moved
        .warnings
        .iter()
        .any(|warning| warning.contains("Scheduled events")));
    let sql = format!("SELECT id,HEX(note),HEX(bytes),amount,created_at,updated_at FROM `{name}`.records ORDER BY id");
    assert_eq!(
        mysql_query(&mysql, &source_options, &sql, &[])
            .await
            .unwrap(),
        mysql_query(&mysql, &target_options, &sql, &[])
            .await
            .unwrap()
    );
    let schema = format!("SELECT DEFAULT_CHARACTER_SET_NAME,DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='{name}'");
    assert_eq!(
        mysql_query(&mysql, &source_options, &schema, &[])
            .await
            .unwrap(),
        mysql_query(&mysql, &target_options, &schema, &[])
            .await
            .unwrap()
    );
    let objects = format!("SELECT (SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA='{name}'),(SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA='{name}'),(SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA='{name}'),(SELECT COUNT(*) FROM information_schema.VIEWS WHERE TABLE_SCHEMA='{name}')");
    assert_eq!(
        mysql_query(&mysql, &target_options, &objects, &[])
            .await
            .unwrap()
            .trim(),
        "1\t2\t1\t1"
    );
    let existing = transfer_database(
        &connections,
        &tunnels,
        source.clone(),
        target.clone(),
        name.clone(),
        name.clone(),
        None,
        None,
    )
    .await;
    assert!(existing.err().unwrap().contains("already exists"));
    assert_eq!(
        mysql_query(&mysql, &source_options, &sql, &[])
            .await
            .unwrap(),
        mysql_query(&mysql, &target_options, &sql, &[])
            .await
            .unwrap()
    );
    mysql_query(
        &mysql,
        &source_options,
        &format!("DROP DATABASE `{name}`"),
        &[],
    )
    .await
    .unwrap();
    mysql_query(
        &mysql,
        &target_options,
        &format!("DROP DATABASE `{name}`"),
        &[],
    )
    .await
    .unwrap();
}
