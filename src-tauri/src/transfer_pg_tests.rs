use super::*;

fn profile(id: &str, port: u16, database: &str) -> TransferProfile {
    TransferProfile {
        id: id.into(),
        db_type: "postgres".into(),
        host: "127.0.0.1".into(),
        port,
        username: "dataace_transfer_test".into(),
        password: String::new(),
        file_path: String::new(),
        database: database.into(),
        ssh: None,
        require_ssl: false,
        skip_ssl_verify: false,
    }
}

#[tokio::test]
#[ignore = "requires disposable PostgreSQL; set DATAACE_TRANSFER_PG_PORT"]
async fn native_postgres_transfer_preserves_database_and_retains_source() {
    let port: u16 = std::env::var("DATAACE_TRANSFER_PG_PORT")
        .expect("set DATAACE_TRANSFER_PG_PORT to a disposable PostgreSQL server")
        .parse()
        .unwrap();
    let suffix = Uuid::new_v4().simple().to_string();
    // '=' makes libpq treat an unescaped dbname as conninfo; quotes and a
    // backslash exercise both conninfo and SQL identifier escaping.
    let source_db = format!("dataace_src='\\_{suffix}");
    let target_db = format!("dataace_tgt='\\_{suffix}");
    let admin = profile("admin", port, "postgres");
    let source = profile("source", port, &source_db);
    let target = profile("target", port, "postgres");
    let psql = tool("psql").unwrap();
    pg_query(&psql, &admin, "postgres", &format!(
        "CREATE DATABASE {} TEMPLATE template0 ENCODING='UTF8' LOCALE_PROVIDER=libc LC_COLLATE='en_US.UTF-8' LC_CTYPE='en_US.UTF-8'",
        pg_quote(&source_db),
    )).await.unwrap();

    let outcome = async {
        assert_eq!(pg_query(&psql, &source, &source_db, "SELECT current_database()").await?.trim(), source_db);
        let locale_sql = "SELECT jsonb_build_object('encoding',pg_encoding_to_char(encoding),'collate',datcollate,'ctype',datctype,'provider',to_jsonb(d)->>'datlocprovider','locale',coalesce(to_jsonb(d)->>'datlocale',to_jsonb(d)->>'daticulocale'),'rules',to_jsonb(d)->>'daticurules')::text FROM pg_database d WHERE datname=current_database()";
        let source_locale = pg_query(&psql, &source, &source_db, locale_sql).await?;
        assert_ne!(source_locale, pg_query(&psql, &admin, "postgres", locale_sql).await?, "source locale differs from destination defaults");
        pg_query(&psql, &source, &source_db, r#"
            CREATE SCHEMA aux;
            CREATE TYPE aux.mood AS ENUM ('ok', 'great');
            CREATE TABLE aux.parents (id INTEGER PRIMARY KEY);
            INSERT INTO aux.parents VALUES (1);
            CREATE TABLE aux."Record""Rows" (
                id BIGSERIAL PRIMARY KEY,
                parent_id INTEGER NOT NULL REFERENCES aux.parents(id),
                title TEXT NOT NULL DEFAULT 'default title',
                payload BYTEA,
                optional TEXT,
                precise NUMERIC(30,12),
                mood aux.mood NOT NULL DEFAULT 'ok',
                created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX record_title_lower ON aux."Record""Rows" (lower(title));
            CREATE VIEW aux.record_titles AS SELECT id, title FROM aux."Record""Rows";
            CREATE FUNCTION aux.update_timestamp() RETURNS TRIGGER AS $body$
            BEGIN
                NEW.updated_at := clock_timestamp();
                RETURN NEW;
            END;
            $body$ LANGUAGE plpgsql;
            CREATE TRIGGER updated_timestamp BEFORE UPDATE ON aux."Record""Rows"
            FOR EACH ROW EXECUTE FUNCTION aux.update_timestamp();
            INSERT INTO aux."Record""Rows" (parent_id, title, payload, optional, precise, mood)
            VALUES (1, E'Unicode açores: quote\' and newline\nend', decode('00ff0a0001','hex'), NULL, 123456789012345678.123456789012, 'great');
            CREATE TABLE aux.empty_table (id UUID PRIMARY KEY);
        "#).await?;
        let before = pg_query(&psql, &source, &source_db,
            r#"SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM aux."Record""Rows" r"#).await?;
        let result = transfer_database(
            &crate::db::new_connection_map(),
            &std::sync::Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
            source.clone(), target.clone(), source_db.clone(), target_db.clone(), None, None,
        ).await?;
        assert_eq!(result.target_database, target_db);
        assert!(result.source_retained);
        assert!(!result.warnings.is_empty());
        assert_eq!(pg_query(&psql, &target, &target_db, "SELECT current_database()").await?.trim(), target_db);
        assert_eq!(pg_query(&psql, &target, &target_db, locale_sql).await?, source_locale,
            "database encoding, collations and locale provider survive the transfer");
        let after = pg_query(&psql, &target, &target_db,
            r#"SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM aux."Record""Rows" r"#).await?;
        assert_eq!(after, before, "typed data, nulls, binary, precision, Unicode and timestamps survive");
        assert_eq!(pg_query(&psql, &source, &source_db,
            r#"SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM aux."Record""Rows" r"#).await?, before,
            "the original database remains unchanged");

        let objects = pg_query(&psql, &target, &target_db, r#"
            SELECT
              (SELECT COUNT(*) FROM pg_indexes WHERE schemaname='aux' AND indexname='record_title_lower'),
              (SELECT COUNT(*) FROM information_schema.views WHERE table_schema='aux' AND table_name='record_titles'),
              (SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema='aux' AND trigger_name='updated_timestamp'),
              (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='aux' AND table_name='empty_table'),
              (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema='aux' AND constraint_type='FOREIGN KEY');
        "#).await?;
        assert_eq!(objects.trim(), "1|1|1|1|1", "indexes, views, triggers, empty tables and foreign keys survive");
        assert_eq!(pg_query(&psql, &target, &target_db,
            r#"SELECT nextval('aux."Record""Rows_id_seq"')"#).await?.trim(), "2", "sequence state is retained");
        let created_before = pg_query(&psql, &target, &target_db,
            r#"SELECT created_at FROM aux."Record""Rows" WHERE id=1"#).await?;
        pg_query(&psql, &target, &target_db,
            r#"UPDATE aux."Record""Rows" SET title='changed' WHERE id=1"#).await?;
        assert_eq!(pg_query(&psql, &target, &target_db,
            r#"SELECT created_at FROM aux."Record""Rows" WHERE id=1"#).await?, created_before);
        assert_eq!(pg_query(&psql, &target, &target_db,
            r#"SELECT (updated_at > created_at)::text FROM aux."Record""Rows" WHERE id=1"#).await?.trim(), "true");

        let refusal = transfer_database(
            &crate::db::new_connection_map(),
            &std::sync::Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
            source.clone(), target.clone(), source_db.clone(), target_db.clone(), None, None,
        ).await.err().expect("existing destination must be refused");
        assert!(refusal.contains("already exists"), "{refusal}");
        assert_eq!(pg_query(&psql, &target, &target_db,
            r#"SELECT title FROM aux."Record""Rows" WHERE id=1"#).await?.trim(), "changed",
            "refusing an existing destination does not overwrite it");
        Ok::<(), String>(())
    }.await;

    let target_cleanup = pg_query(
        &psql,
        &admin,
        "postgres",
        &format!(
            "DROP DATABASE IF EXISTS {} WITH (FORCE)",
            pg_quote(&target_db)
        ),
    )
    .await;
    let source_cleanup = pg_query(
        &psql,
        &admin,
        "postgres",
        &format!(
            "DROP DATABASE IF EXISTS {} WITH (FORCE)",
            pg_quote(&source_db)
        ),
    )
    .await;
    assert!(target_cleanup.is_ok(), "target cleanup failed");
    assert!(source_cleanup.is_ok(), "source cleanup failed");
    outcome.unwrap();
}
