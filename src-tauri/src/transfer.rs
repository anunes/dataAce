use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::hash::{DefaultHasher, Hasher};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::process::Command;
use uuid::Uuid;

use crate::db::{ConnectionMap, DbConnection, TunnelMap};

// Only transfers acquire this mutex; normal browsing/query commands continue to
// work. Serializing transfers prevents opposite SQLite moves from deadlocking.
static TRANSFER_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferProfile {
    pub id: String,
    #[serde(rename = "type")]
    pub db_type: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub file_path: String,
    #[serde(default)]
    pub database: String,
    #[serde(default)]
    pub ssh: Option<serde_json::Value>,
    #[serde(default)]
    pub require_ssl: bool,
    #[serde(default)]
    pub skip_ssl_verify: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferResult {
    pub target_database: String,
    pub source_retained: bool,
    pub warnings: Vec<String>,
}

struct Workspace(PathBuf);

impl Workspace {
    fn new() -> Result<Self, String> {
        let path = std::env::temp_dir().join(format!("dataace-transfer-{}", Uuid::new_v4()));
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder
            .create(&path)
            .map_err(|e| format!("Cannot create the transfer workspace: {e}"))?;
        Ok(Self(path))
    }

    fn file(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }

    fn write_private(&self, name: &str, contents: &str) -> Result<PathBuf, String> {
        let path = self.file(name);
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&path).map_err(|e| e.to_string())?;
        file.write_all(contents.as_bytes())
            .map_err(|e| e.to_string())?;
        Ok(path)
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn tool(name: &str) -> Result<PathBuf, String> {
    let mut directories: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).collect())
        .unwrap_or_default();
    directories.extend(
        [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/opt/homebrew/opt/libpq/bin",
            "/usr/local/opt/libpq/bin",
        ]
        .into_iter()
        .map(PathBuf::from),
    );
    let names = if cfg!(windows) {
        vec![format!("{name}.exe"), name.to_string()]
    } else {
        vec![name.to_string()]
    };
    for directory in directories {
        for name in &names {
            let path = directory.join(name);
            if path.is_file() {
                return Ok(path);
            }
        }
    }
    Err(format!(
        "Database transfer requires the native {name} client. Install it and try again."
    ))
}

fn redact(message: &str, secrets: &[&str]) -> String {
    secrets
        .iter()
        .filter(|secret| !secret.is_empty())
        .fold(message.to_string(), |text, secret| {
            text.replace(secret, "[redacted]")
        })
}

async fn run(mut command: Command, description: &str, secrets: &[&str]) -> Result<Vec<u8>, String> {
    command.kill_on_drop(true).stdin(Stdio::null());
    run_configured(command, description, secrets).await
}

async fn run_configured(
    mut command: Command,
    description: &str,
    secrets: &[&str],
) -> Result<Vec<u8>, String> {
    command.kill_on_drop(true);
    let result = tokio::time::timeout(Duration::from_secs(3600), command.output())
        .await
        .map_err(|_| format!("{description} timed out. The original database was retained."))?
        .map_err(|e| format!("{description}: {e}"))?;
    if !result.status.success() {
        let error = String::from_utf8_lossy(&result.stderr);
        let error = redact(error.trim(), secrets);
        return Err(format!(
            "{description}: {}",
            if error.is_empty() {
                result.status.to_string()
            } else {
                error
            }
        ));
    }
    Ok(result.stdout)
}

fn valid_database(name: &str, engine: &str) -> Result<(), String> {
    if name.trim().is_empty() || name.contains(['\0', '\n', '\r']) || name.starts_with('-') {
        return Err(
            "Choose a database name without null characters, line breaks, or a leading dash."
                .into(),
        );
    }
    let lower = name.to_ascii_lowercase();
    if (engine == "mysql"
        && ["mysql", "information_schema", "performance_schema", "sys"].contains(&lower.as_str()))
        || (engine == "postgres" && ["template0", "template1"].contains(&lower.as_str()))
    {
        return Err("System databases cannot be transferred.".into());
    }
    Ok(())
}

async fn endpoint(
    profile: &TransferProfile,
    conn_id: Option<&str>,
    tunnels: &TunnelMap,
) -> Result<TransferProfile, String> {
    let mut effective = profile.clone();
    if profile.ssh.is_some() {
        let tunnels = tunnels.lock().await;
        let tunnel = conn_id
            .and_then(|id| tunnels.get(id))
            .ok_or("Connect this SSH profile before transferring its database.")?;
        // Preserve the existing authenticated tunnel; never put SSH credentials
        // in a process argument or silently fall back to a direct connection.
        effective.host = "127.0.0.1".into();
        effective.port = tunnel.local_port;
        if profile.require_ssl && !profile.skip_ssl_verify {
            return Err("Verified TLS through an SSH tunnel is not supported by this transfer. Use a direct verified connection.".into());
        }
    }
    Ok(effective)
}

fn pg_command(binary: &Path, profile: &TransferProfile, database: &str) -> Command {
    let mut command = Command::new(binary);
    // libpq interprets a dbname containing '=' or a URI as connection settings.
    // Always wrap the literal name in a single escaped conninfo property so a
    // database identifier cannot override the authenticated host or user.
    let database = format!(
        "dbname='{}'",
        database.replace('\\', "\\\\").replace('\'', "\\'")
    );
    command.args([
        "--host",
        &profile.host,
        "--port",
        &profile.port.to_string(),
        "--username",
        &profile.username,
        "--no-password",
        "--dbname",
        &database,
    ]);
    command
        .env("PGPASSWORD", &profile.password)
        .env("PGCONNECT_TIMEOUT", "15")
        .env("PGOPTIONS", "-c timezone=UTC -c extra_float_digits=3")
        .env(
            "PGSSLMODE",
            if profile.require_ssl {
                if profile.skip_ssl_verify {
                    "require"
                } else {
                    "verify-full"
                }
            } else {
                "prefer"
            },
        );
    command
}

fn pg_quote(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn pg_literal(value: &str) -> String {
    format!("E'{}'", value.replace('\\', "\\\\").replace('\'', "\\'"))
}

async fn pg_query(
    binary: &Path,
    profile: &TransferProfile,
    database: &str,
    sql: &str,
) -> Result<String, String> {
    let mut command = pg_command(binary, profile, database);
    command.args(["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "--command", sql]);
    String::from_utf8(run(command, "PostgreSQL query failed", &[&profile.password]).await?)
        .map_err(|e| e.to_string())
}

async fn pg_dump(
    binary: &Path,
    profile: &TransferProfile,
    database: &str,
    path: &Path,
) -> Result<(), String> {
    let mut command = pg_command(binary, profile, database);
    command.args([
        "--format=plain",
        "--no-owner",
        "--no-privileges",
        "--no-tablespaces",
        "--no-publications",
        "--no-subscriptions",
        "--quote-all-identifiers",
        "--file",
    ]);
    command.arg(path);
    run(command, "PostgreSQL export failed", &[&profile.password])
        .await
        .map(|_| ())
}

// Compare the native exported records without converting typed data to JS
// strings. Two independent accumulators and a count make row order irrelevant.
#[derive(Debug, Default, PartialEq, Eq)]
struct Fingerprint {
    records: u64,
    sum: u128,
    xor: u64,
    tables: BTreeSet<String>,
}

impl Fingerprint {
    fn record(&mut self, context: &str, data: &[u8]) {
        let mut hasher = DefaultHasher::new();
        hasher.write(context.as_bytes());
        hasher.write_u8(0);
        hasher.write(data);
        let value = hasher.finish();
        self.records += 1;
        self.sum = self.sum.wrapping_add(value as u128);
        self.xor ^= value;
    }
}

fn fingerprint(path: &Path, engine: &str) -> Result<Fingerprint, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    let mut result = Fingerprint::default();
    let mut context: Option<String> = None;
    let mut copy_header: Option<String> = None;
    for line in BufReader::new(file).split(b'\n') {
        let mut line = line.map_err(|e| e.to_string())?;
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        if let Some(table) = &context {
            if line == b"\\." {
                context = None;
            } else {
                result.record(table, &line);
            }
            continue;
        }
        let text = String::from_utf8_lossy(&line);
        if text.starts_with("CREATE TABLE ") {
            result.tables.insert(text.to_string());
        }
        if engine == "postgres" {
            if text.starts_with("COPY ") {
                copy_header = Some(text.to_string());
            } else if let Some(header) = copy_header.as_mut() {
                header.push('\n');
                header.push_str(&text);
            }
            if copy_header
                .as_ref()
                .is_some_and(|header| header.ends_with(" FROM stdin;"))
            {
                context = copy_header.take();
            }
            if text.starts_with("SELECT pg_catalog.setval(")
                || text.starts_with("SELECT pg_catalog.lo_create(")
                || text.starts_with("SELECT pg_catalog.lowrite(")
            {
                result.record("postgres auxiliary data", &line);
            }
        } else if text.starts_with("INSERT INTO ") {
            result.record("mysql data", &line);
        }
    }
    if context.is_some() || copy_header.is_some() {
        return Err("The native export contains an incomplete COPY data block.".into());
    }
    Ok(result)
}

async fn transfer_postgres(
    source: &TransferProfile,
    target: &TransferProfile,
    source_db: &str,
    target_db: &str,
    work: &Workspace,
) -> Result<Vec<String>, String> {
    let dump = tool("pg_dump")?;
    let psql = tool("psql")?;
    let admin = if target.database.is_empty() {
        "postgres"
    } else {
        &target.database
    };
    // hex -> UTF-8 avoids injecting an untrusted database name into SQL text.
    let hex = target_db
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let exists = pg_query(&psql, target, admin, &format!("SELECT count(*) FROM pg_database WHERE datname=convert_from(decode('{hex}','hex'),'UTF8')")).await?;
    if exists.trim() != "0" {
        return Err(
            "A database with this name already exists on the destination. Choose a new name."
                .into(),
        );
    }
    let settings = pg_query(&psql, source, source_db, "SELECT json_build_object('encoding',pg_encoding_to_char(encoding),'collate',datcollate,'ctype',datctype,'provider',to_jsonb(d)->>'datlocprovider','locale',coalesce(to_jsonb(d)->>'datlocale',to_jsonb(d)->>'daticulocale'),'rules',to_jsonb(d)->>'daticurules')::text FROM pg_database d WHERE datname=current_database()").await?;
    let settings: serde_json::Value = serde_json::from_str(settings.trim())
        .map_err(|_| "Cannot read the source PostgreSQL locale settings.")?;
    let setting = |name: &str| {
        settings[name]
            .as_str()
            .ok_or_else(|| format!("Cannot determine the PostgreSQL {name} setting."))
    };
    let target_version = pg_query(&psql, target, admin, "SHOW server_version_num")
        .await?
        .trim()
        .parse::<u32>()
        .map_err(|_| "Cannot determine the target PostgreSQL version.")?;
    let provider = match settings["provider"].as_str().unwrap_or("c") {
        "c" => {
            if target_version >= 150000 {
                " LOCALE_PROVIDER=libc".to_string()
            } else {
                String::new()
            }
        }
        "i" if target_version >= 150000 => {
            let mut provider = format!(
                " LOCALE_PROVIDER=icu ICU_LOCALE={}",
                pg_literal(setting("locale")?)
            );
            if let Some(rules) = settings["rules"].as_str().filter(|rules| !rules.is_empty()) {
                if target_version < 160000 {
                    return Err("The destination PostgreSQL version does not support the source ICU collation rules.".into());
                }
                provider.push_str(&format!(" ICU_RULES={}", pg_literal(rules)));
            }
            provider
        }
        "b" if target_version >= 170000 => format!(
            " LOCALE_PROVIDER=builtin BUILTIN_LOCALE={}",
            pg_literal(setting("locale")?)
        ),
        _ => {
            return Err(
                "The destination PostgreSQL version cannot preserve the source locale provider."
                    .into(),
            )
        }
    };
    let create = format!(
        "CREATE DATABASE {} TEMPLATE template0 ENCODING={} LC_COLLATE={} LC_CTYPE={}{}",
        pg_quote(target_db),
        pg_literal(setting("encoding")?),
        pg_literal(setting("collate")?),
        pg_literal(setting("ctype")?),
        provider
    );
    let original = work.file("source.sql");
    pg_dump(&dump, source, source_db, &original).await?;
    let expected = fingerprint(&original, "postgres")?;
    pg_query(&psql, target, admin, &create).await?;
    let copied = async {
        let mut restore = pg_command(&psql, target, target_db);
        restore
            .args([
                "-X",
                "-v",
                "ON_ERROR_STOP=1",
                "--single-transaction",
                "--file",
            ])
            .arg(&original);
        run(
            restore,
            "PostgreSQL restore failed",
            &[&source.password, &target.password],
        )
        .await?;
        let verified = work.file("verified.sql");
        pg_dump(&dump, target, target_db, &verified).await?;
        if fingerprint(&verified, "postgres")? != expected {
            return Err(
                "Destination data verification did not match the native source snapshot.".into(),
            );
        }
        Ok::<(), String>(())
    }
    .await;
    if let Err(error) = copied {
        let cleanup = pg_query(
            &psql,
            target,
            admin,
            &format!("DROP DATABASE {}", pg_quote(target_db)),
        )
        .await;
        return Err(match cleanup {
            Ok(_) => format!("{error} The incomplete destination was removed; the original database is unchanged."),
            Err(_) => format!("{error} The original database is unchanged. The incomplete destination {target_db} could not be removed; inspect it before retrying."),
        });
    }
    Ok(vec!["The original database remains available as a backup. Changes made there after the export began are not included in the transferred snapshot.".into(), "Database ownership is assigned to the destination user; source grants, publications, subscriptions, and tablespace assignments are not copied.".into()])
}

fn option_value(value: &str) -> Result<String, String> {
    if value.contains('\0') {
        return Err("Connection settings cannot contain null characters.".into());
    }
    Ok(format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n")
            .replace('\r', "\\r")
            .replace('\t', "\\t")
    ))
}

async fn mysql_options(
    binary: &Path,
    profile: &TransferProfile,
    work: &Workspace,
    name: &str,
) -> Result<PathBuf, String> {
    let mut help = Command::new(binary);
    help.args(["--no-defaults", "--help"]);
    let help =
        String::from_utf8_lossy(&run(help, "Cannot inspect the native MySQL client", &[]).await?)
            .to_string();
    let ssl = if help.contains("ssl-mode") {
        format!(
            "ssl-mode={}\n",
            if profile.require_ssl {
                if profile.skip_ssl_verify {
                    "REQUIRED"
                } else {
                    "VERIFY_IDENTITY"
                }
            } else {
                "DISABLED"
            }
        )
    } else if help.contains("ssl-verify-server-cert") {
        format!(
            "ssl={}\nssl-verify-server-cert={}\n",
            profile.require_ssl as u8,
            (profile.require_ssl && !profile.skip_ssl_verify) as u8
        )
    } else if profile.require_ssl {
        return Err("The installed MySQL client cannot honor this profile's TLS settings.".into());
    } else {
        String::new()
    };
    let timeout = if help.contains("connect-timeout") {
        "connect-timeout=15\n"
    } else {
        ""
    };
    work.write_private(
        name,
        &format!(
            "[client]\nhost={}\nport={}\nuser={}\npassword={}\nprotocol=tcp\n{}{}",
            option_value(&profile.host)?,
            profile.port,
            option_value(&profile.username)?,
            option_value(&profile.password)?,
            timeout,
            ssl
        ),
    )
}

fn mysql_command(binary: &Path, options: &Path) -> Command {
    let mut command = Command::new(binary);
    command.arg(format!("--defaults-file={}", options.display()));
    // Explicit defaults alone still allow ~/.mylogin.cnf to override them.
    command.env(
        "MYSQL_TEST_LOGIN_FILE",
        options.with_extension("unused-login-file"),
    );
    command
}

async fn mysql_query(
    binary: &Path,
    options: &Path,
    sql: &str,
    secrets: &[&str],
) -> Result<String, String> {
    let mut command = mysql_command(binary, options);
    command.args(["--batch", "--raw", "--skip-column-names", "--execute", sql]);
    String::from_utf8(run(command, "MySQL query failed", secrets).await?).map_err(|e| e.to_string())
}

async fn mysql_dump(
    binary: &Path,
    options: &Path,
    database: &str,
    path: &Path,
    secrets: &[&str],
) -> Result<(), String> {
    let mut help = Command::new(binary);
    help.args(["--no-defaults", "--help"]);
    let help =
        String::from_utf8_lossy(&run(help, "Cannot inspect mysqldump", &[]).await?).to_string();
    let mut command = mysql_command(binary, options);
    command.args([
        "--lock-all-tables",
        "--routines",
        "--triggers",
        "--events",
        "--hex-blob",
        "--no-tablespaces",
        "--skip-comments",
        "--skip-extended-insert",
        "--complete-insert",
        "--skip-add-locks",
        "--default-character-set=utf8mb4",
    ]);
    if help.contains("set-gtid-purged") {
        command.arg("--set-gtid-purged=OFF");
    }
    if help.contains("column-statistics") {
        command.arg("--column-statistics=0");
    }
    command
        .arg(format!("--result-file={}", path.display()))
        .arg(database);
    run(command, "MySQL export failed", secrets)
        .await
        .map(|_| ())
}

async fn transfer_mysql(
    source: &TransferProfile,
    target: &TransferProfile,
    source_db: &str,
    target_db: &str,
    work: &Workspace,
) -> Result<Vec<String>, String> {
    if source_db != target_db {
        return Err("MySQL transfers preserve the database name so stored routines and views retain their references. Choose a destination without that database.".into());
    }
    let mysql = tool("mysql").or_else(|_| tool("mariadb"))?;
    let dump = tool("mysqldump").or_else(|_| tool("mariadb-dump"))?;
    let source_options = mysql_options(&mysql, source, work, "source-client.cnf").await?;
    let target_options = mysql_options(&mysql, target, work, "target-client.cnf").await?;
    // Dump and client binaries may be from different vendors; independently
    // inspect their TLS options instead of silently weakening transport.
    let source_dump = mysql_options(&dump, source, work, "source-dump.cnf").await?;
    let target_dump = mysql_options(&dump, target, work, "target-dump.cnf").await?;
    let secrets = [&*source.password, &*target.password];
    let db_hex = source_db
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let db_literal = format!("CONVERT(0x{db_hex} USING utf8mb4)");
    let exists = mysql_query(
        &mysql,
        &target_options,
        &format!("SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME={db_literal}"),
        &secrets,
    )
    .await?;
    if exists.trim() != "0" {
        return Err("A database with this name already exists on the destination. Choose another connection.".into());
    }
    let settings = mysql_query(&mysql, &source_options, &format!("SELECT DEFAULT_CHARACTER_SET_NAME,DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME={db_literal}"), &secrets).await?;
    let settings: Vec<_> = settings.trim().split('\t').collect();
    if settings.len() != 2
        || settings.iter().any(|part| {
            part.is_empty() || !part.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
        })
    {
        return Err("Cannot determine the source database's character set and collation.".into());
    }
    let events = mysql_query(&mysql, &source_options, &format!("SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA={db_literal} AND STATUS='ENABLED'"), &secrets).await?;
    if events.trim() != "0" {
        let scheduler = mysql_query(
            &mysql,
            &target_options,
            "SELECT @@GLOBAL.event_scheduler",
            &secrets,
        )
        .await?;
        if scheduler.trim().eq_ignore_ascii_case("ON") {
            return Err("The source has enabled scheduled events and the destination event scheduler is running. Disable the destination scheduler before transfer to prevent duplicate jobs; it will not be changed automatically.".into());
        }
    }
    let original = work.file("source.sql");
    mysql_dump(&dump, &source_dump, source_db, &original, &secrets).await?;
    let expected = fingerprint(&original, "mysql")?;
    let database = format!("`{}`", target_db.replace('`', "``"));
    mysql_query(
        &mysql,
        &target_options,
        &format!(
            "CREATE DATABASE {database} DEFAULT CHARACTER SET {} COLLATE {}",
            settings[0], settings[1]
        ),
        &secrets,
    )
    .await?;
    let copied = async {
        let mut restore = mysql_command(&mysql, &target_options);
        restore
            .arg("--binary-mode")
            .arg(format!("--database={target_db}"));
        restore.stdin(Stdio::from(
            File::open(&original).map_err(|e| e.to_string())?,
        ));
        run_configured(restore, "MySQL restore failed", &secrets).await?;
        let verified = work.file("verified.sql");
        mysql_dump(&dump, &target_dump, target_db, &verified, &secrets).await?;
        if fingerprint(&verified, "mysql")? != expected {
            return Err(
                "Destination data verification did not match the native source snapshot.".into(),
            );
        }
        Ok::<(), String>(())
    }
    .await;
    if let Err(error) = copied {
        let cleanup = mysql_query(
            &mysql,
            &target_options,
            &format!("DROP DATABASE {database}"),
            &secrets,
        )
        .await;
        return Err(match cleanup {
            Ok(_) => format!("{error} The incomplete destination was removed; the original database is unchanged."),
            Err(_) => format!("{error} The original database is unchanged. The incomplete destination {target_db} could not be removed; inspect it before retrying."),
        });
    }
    let mut warnings = vec!["The original database remains available as a backup. Changes made there after the export began are not included in the transferred snapshot.".into(), "Server users and grants are not copied. Routines, views, triggers, and events retain their original DEFINER accounts, which must exist on the destination.".into()];
    if events.trim() != "0" {
        warnings.push("Scheduled events were preserved. Plan their activation and source cutover before enabling the destination scheduler to avoid running jobs twice.".into());
    }
    Ok(warnings)
}

fn same_sqlite_file(source: &str, target: &str) -> bool {
    if source.is_empty() || target.is_empty() || source == ":memory:" || target == ":memory:" {
        return false;
    }
    if let (Ok(source), Ok(target)) = (fs::canonicalize(source), fs::canonicalize(target)) {
        if source == target {
            return true;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if let (Ok(source), Ok(target)) = (fs::metadata(source), fs::metadata(target)) {
                return source.dev() == target.dev() && source.ino() == target.ino();
            }
        }
    }
    false
}

fn sqlite_backup(
    source: &rusqlite::Connection,
    target: &mut rusqlite::Connection,
) -> Result<(), String> {
    let backup = rusqlite::backup::Backup::new(source, target).map_err(|e| e.to_string())?;
    backup
        .run_to_completion(128, Duration::from_millis(10), None)
        .map_err(|e| e.to_string())
}

async fn transfer_sqlite(
    connections: &ConnectionMap,
    source: &TransferProfile,
    target: &TransferProfile,
    source_id: Option<&str>,
    target_id: Option<&str>,
    work: &Workspace,
) -> Result<Vec<String>, String> {
    if same_sqlite_file(&source.file_path, &target.file_path) {
        return Err("Source and destination refer to the same SQLite file.".into());
    }
    let (source_connection, target_connection) = {
        let map = connections.lock().await;
        let get = |id: Option<&str>| match id.and_then(|id| map.get(id)) {
            Some(DbConnection::Sqlite(connection)) => Ok(connection.clone()),
            _ => {
                Err("Connect both SQLite profiles before transferring their databases.".to_string())
            }
        };
        (get(source_id)?, get(target_id)?)
    };
    if std::sync::Arc::ptr_eq(&source_connection, &target_connection) {
        return Err("Source and destination are the same SQLite connection.".into());
    }
    let source_guard = source_connection.lock_owned().await;
    let mut target_guard = target_connection.lock_owned().await;
    if same_sqlite_file(&source_guard.path, &target_guard.path) {
        return Err("Source and destination refer to the same SQLite file.".into());
    }
    let snapshot = work.file("snapshot.sqlite");
    tokio::task::spawn_blocking(move || {
        if !source_guard.conn.is_autocommit() || !target_guard.conn.is_autocommit() {
            return Err("Finish pending SQLite transactions before transferring the database.".into());
        }
        let attached: u64 = target_guard.conn.query_row("SELECT COUNT(*) FROM pragma_database_list WHERE name NOT IN ('main','temp')", [], |row| row.get(0)).map_err(|e| e.to_string())?;
        if attached != 0 { return Err("Detach additional databases from the destination SQLite connection before transferring. Its attached databases will not be changed.".into()); }
        let mut snapshot = rusqlite::Connection::open(snapshot).map_err(|e| e.to_string())?;
        sqlite_backup(&source_guard.conn, &mut snapshot)?;
        let integrity: String = snapshot.query_row("PRAGMA integrity_check", [], |row| row.get(0)).map_err(|e| e.to_string())?;
        if integrity != "ok" { return Err("The source SQLite snapshot did not pass its integrity check.".into()); }
        let objects: u64 = target_guard.conn.query_row("SELECT (SELECT COUNT(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%') + (SELECT COUNT(*) FROM sqlite_temp_master WHERE name NOT LIKE 'sqlite_%')", [], |row| row.get(0)).map_err(|e| e.to_string())?;
        if objects != 0 { return Err("The destination SQLite database must be empty. Existing data will not be overwritten.".into()); }
        let prior_mode: String = target_guard.conn.query_row("PRAGMA locking_mode", [], |row| row.get(0)).map_err(|e| e.to_string())?;
        let journal_mode: String = target_guard.conn.query_row("PRAGMA journal_mode", [], |row| row.get(0)).map_err(|e| e.to_string())?;
        let mut pragmas = Vec::new();
        for name in ["foreign_keys", "recursive_triggers", "busy_timeout", "synchronous", "cache_size", "temp_store", "trusted_schema", "query_only"] {
            let value: i64 = target_guard.conn.query_row(&format!("PRAGMA {name}"), [], |row| row.get(0)).map_err(|e| e.to_string())?;
            pragmas.push((name, value));
        }
        if pragmas.iter().any(|(name, value)| *name == "query_only" && *value != 0) { return Err("The destination SQLite connection is read-only.".into()); }
        // Hold an exclusive file lock across the empty check and the backup so
        // another process cannot add data to the destination in between.
        let result = (|| {
            target_guard.conn.execute_batch("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT").map_err(|e| format!("The SQLite destination is busy ({e}). Close it in other applications and retry."))?;
            let objects: u64 = target_guard.conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'", [], |row| row.get(0)).map_err(|e| e.to_string())?;
            if objects != 0 { return Err("The destination SQLite database must be empty. Existing data will not be overwritten.".into()); }
            sqlite_backup(&snapshot, &mut target_guard.conn)?;
            let integrity: String = target_guard.conn.query_row("PRAGMA integrity_check", [], |row| row.get(0)).map_err(|e| e.to_string())?;
            if integrity != "ok" { return Err("The destination SQLite database did not pass its integrity check.".into()); }
            Ok::<(), String>(())
        })();
        if !target_guard.path.is_empty() && target_guard.path != ":memory:" {
            // WAL connections that entered exclusive locking can retain their
            // shared-memory lock despite PRAGMA locking_mode=NORMAL. Reopen this
            // empty, transaction-free destination handle to release it fully.
            // The Arc/connection id survives; restore its connection pragmas.
            let path = target_guard.path.clone();
            let reopened = rusqlite::Connection::open(&path).map_err(|e| format!("Cannot reopen the destination SQLite database: {e}"))?;
            // sqlite3_open defers page access until the first query. Open first,
            // then replace/drop the exclusive handle; a failed reopen must
            // never leave an in-memory connection under a file profile's id.
            target_guard.conn = reopened;
            let journal = match journal_mode.as_str() { "wal" => "WAL", "truncate" => "TRUNCATE", "persist" => "PERSIST", "memory" => "MEMORY", "off" => "OFF", _ => "DELETE" };
            target_guard.conn.execute_batch(&format!("PRAGMA journal_mode={journal}")).map_err(|e| e.to_string())?;
            for (name, value) in pragmas { target_guard.conn.execute_batch(&format!("PRAGMA {name}={value}")).map_err(|e| e.to_string())?; }
            if prior_mode.eq_ignore_ascii_case("exclusive") { target_guard.conn.execute_batch("PRAGMA locking_mode=EXCLUSIVE").map_err(|e| e.to_string())?; }
        } else if !prior_mode.eq_ignore_ascii_case("exclusive") {
            target_guard.conn.execute_batch("PRAGMA locking_mode=NORMAL").map_err(|e| e.to_string())?;
        }
        result
    }).await.map_err(|e| e.to_string())??;
    Ok(vec![
        "The original SQLite database remains available as a backup.".into(),
    ])
}

pub async fn transfer_database(
    connections: &ConnectionMap,
    tunnels: &TunnelMap,
    source: TransferProfile,
    target: TransferProfile,
    source_database: String,
    target_database: String,
    source_conn_id: Option<String>,
    target_conn_id: Option<String>,
) -> Result<TransferResult, String> {
    let _transfer = TRANSFER_LOCK.lock().await;
    if source.id == target.id {
        return Err("Choose a different destination connection.".into());
    }
    if source.db_type != target.db_type {
        return Err("Full database transfers require matching database engines. Use the migration wizard to convert selected tables between engines.".into());
    }
    if !["sqlite", "mysql", "postgres"].contains(&source.db_type.as_str()) {
        return Err("Full database transfer currently supports SQLite, MySQL/MariaDB, and PostgreSQL. SQL Server and Oracle require their native administration tools.".into());
    }
    valid_database(&source_database, &source.db_type)?;
    valid_database(&target_database, &target.db_type)?;
    let work = Workspace::new()?;
    let warnings = if source.db_type == "sqlite" {
        transfer_sqlite(
            connections,
            &source,
            &target,
            source_conn_id.as_deref(),
            target_conn_id.as_deref(),
            &work,
        )
        .await?
    } else {
        let source = endpoint(&source, source_conn_id.as_deref(), tunnels).await?;
        let target = endpoint(&target, target_conn_id.as_deref(), tunnels).await?;
        if source.db_type == "postgres" {
            transfer_postgres(&source, &target, &source_database, &target_database, &work).await?
        } else {
            transfer_mysql(&source, &target, &source_database, &target_database, &work).await?
        }
    };
    Ok(TransferResult {
        target_database,
        source_retained: true,
        warnings,
    })
}

#[cfg(test)]
#[path = "transfer_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "transfer_pg_tests.rs"]
mod postgres_tests;

#[cfg(test)]
#[path = "transfer_mysql_tests.rs"]
mod mysql_tests;
