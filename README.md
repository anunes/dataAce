# DataAce

A cross-platform desktop database client built with Tauri, React, and Rust. Supports MySQL, PostgreSQL, SQLite, Oracle, and SQL Server from a single unified interface.

---

## Table of Contents

1. [Supported Databases](#supported-databases)
2. [Installation & Running](#installation--running)
3. [Connections](#connections)
   - [Adding a Connection](#adding-a-connection)
   - [SSH Tunnels](#ssh-tunnels)
   - [Opening a SQLite File](#opening-a-sqlite-file)
   - [Connecting & Disconnecting](#connecting--disconnecting)
   - [Editing & Duplicating](#editing--duplicating)
4. [Sidebar — Databases & Tables](#sidebar--databases--tables)
5. [Browse Tab](#browse-tab)
6. [Structure Tab](#structure-tab)
7. [Query Tab](#query-tab)
8. [Relations Tab](#relations-tab)
9. [Triggers Tab](#triggers-tab)
10. [Info Tab](#info-tab)
11. [Creating a Database](#creating-a-database)
12. [Exporting Data](#exporting-data)
13. [Migrating Data](#migrating-data)
14. [MySQL User Manager](#mysql-user-manager)
15. [Themes](#themes)

---

## Supported Databases

| Database   | Default Port |
|------------|-------------|
| MySQL      | 3306        |
| PostgreSQL | 5432        |
| SQLite     | —           |
| Oracle     | 1521        |
| SQL Server | 1433        |

---

## Installation & Running

```bash
# Install dependencies
pnpm install

# Development
pnpm tauri dev

# Production build
pnpm tauri build
```

---

## Connections

### Adding a Connection

Click the **+** button in the top-right of the connections panel.

Fill in:
- **Name** — display name shown in the sidebar
- **Type** — MySQL, PostgreSQL, SQLite, Oracle, or SQL Server
- **Color** — color dot used to visually identify the connection
- **Host / Port / Username / Password** — for server-based databases
- **File Path** — for SQLite; browse with the file picker or type a path
- **Service Name** — Oracle only

Click **Test Connection** to verify before saving. Click **Save** to store the profile.

### SSH Tunnels

Expand the **SSH Tunnel** section when adding or editing a connection (server-based databases only).

Fill in:
- **SSH Host** and **Port** (default 22)
- **SSH Username** and **Password**

The tunnel is established automatically when connecting.

### Opening a SQLite File

Click the **folder icon** in the connections panel header to open a SQLite file from disk.

A dialog will appear after the file connects asking:
- **Add to Connections** — saves the profile to the connections list permanently
- **Open Only** — connects for this session only, nothing saved

Supported extensions: `.db`, `.sqlite`, `.sqlite3`, `.db3`

### Connecting & Disconnecting

- **Click** a connection in the panel to connect. A green dot appears when connected.
- A spinning indicator shows while connecting.
- **Right-click** a connection → **Disconnect** to close the session.

### Editing & Duplicating

Right-click any connection in the panel:
- **Edit** — opens the connection form pre-filled
- **Duplicate** — creates a copy of the profile
- **Delete** — removes the profile (does not affect data)

---

## Sidebar — Databases & Tables

Once connected, the sidebar shows all databases for that connection.

- **Click a database** to expand it and list its tables and views.
- **Click a table** to select it and open it in the main view.
- **Right-click a table** for: Open in Browse, Copy Table Name, Refresh, Drop Table.
- **Right-click a database** for: Select Database, Refresh, Drop Database.

### Filtering Tables

Type in the **search box** at the top of the sidebar to filter tables by name. Click **×** to clear.

### System Databases

Click the **eye icon** to toggle visibility of system databases (e.g. `information_schema`, `template0`).

### Refreshing

Click the **↻ refresh icon** in the sidebar header to reload the database list and table list. The icon spins while loading. Refresh is also available in both right-click context menus.

### New Table

With a database selected, click **+ New Table** inside the expanded database to open the table creation dialog. Define column names, types, primary key, and NOT NULL constraints. Preview the generated SQL before creating.

---

## Browse Tab

Displays table data with pagination, filtering, sorting, and inline editing.

### Pagination

- Use **◀ ▶** to navigate pages and **⟪ ⟫** to jump to first/last.
- Change the **page size** (25 / 50 / 100 / 250 / 500) with the dropdown.

### Sorting

Click any **column header** to sort ascending. Click again to sort descending.

### Filtering

Click the **filter icon** to open the filter bar. Select:
- **Column** — the column to filter on
- **Operator** — `=`, `!=`, `contains`, `starts with`, `ends with`, `<`, `>`, `IS NULL`, `IS NOT NULL`, `BETWEEN`
- **Value(s)** — text input(s) depending on the operator

Click **Apply** to run the filtered query.

### Inline Editing

- **Double-click** a cell to edit its value inline.
- Press **Enter** to save or **Escape** to cancel.
- Click **+ row** to insert a new empty row.
- Click the **trash icon** on a row to delete it.

### Exporting Table Data

Click **Export Table** in the bottom bar of the sidebar, or trigger it from the toolbar. Choose from:
- **CSV**, **TSV**, **JSON**, **XML**
- **SQL** — INSERT statements for SQLite, MySQL, PostgreSQL, or Oracle

A save dialog opens to choose the file location.

---

## Structure Tab

Shows columns and indexes for the selected table.

### Columns

Each column displays: Name, Type, Nullable, Key, Default, Extra, Charset, Collation, Comment (columns with values only).

- **Edit** (pencil icon) — modify column name, type, nullable, default, extra (AUTO_INCREMENT, ON UPDATE CURRENT_TIMESTAMP), charset, collation, and comment.
- **Delete** (trash icon) — drops the column after confirmation.
- **+ Add Column** — opens a form to define a new column. For MySQL, charset and collation fields are shown.

### Indexes

Below the columns list, all indexes are shown with their columns, type, and uniqueness.

- **+ Add Index** — define index name, select columns (checkboxes), set unique, and choose index type (BTREE / HASH / FULLTEXT for MySQL).
- **Drop** (trash icon) — drops the index immediately.

---

## Query Tab

A full SQL editor for writing and running queries against the selected connection.

### Editor

- Powered by **CodeMirror** with SQL syntax highlighting.
- Adapts to dark or light theme automatically.

### Running Queries

- Click **▶ Run** or press **Ctrl+Enter** / **Cmd+Enter** to execute.
- Results display in a paginated grid below the editor.
- Execution time, affected rows, and last insert ID are shown in the status bar.

### Query History

Click the **clock icon** to open query history (last 50 queries, persisted across sessions). Click any entry to load it into the editor.

### Results Panel

- Drag the **divider** between editor and results to resize.
- Paginate results using the same controls as the Browse tab.

---

## Relations Tab

Shows foreign key relationships for the selected table.

Displays:
- **Constraint name**
- **Column** on this table
- **Referenced table** and **referenced column**

---

## Triggers Tab

Lists all triggers defined on the selected table.

Displays:
- **Trigger name**
- **Event** (INSERT / UPDATE / DELETE)
- **Timing** (BEFORE / AFTER)
- **Statement** — the trigger body

---

## Info Tab

Shows metadata about the selected table or database.

### Table Info

| Field          | Description                                  |
|----------------|----------------------------------------------|
| Row Count      | Approximate number of rows                   |
| Data Size      | Size of data pages (MySQL)                   |
| Index Size     | Size of index pages (MySQL)                  |
| Total Size     | Combined data + index size                   |
| Auto Increment | Current AUTO_INCREMENT value (MySQL only)    |
| Engine         | Storage engine (MySQL only)                  |
| Collation      | Default collation                            |
| Created        | Creation timestamp                           |
| Comment        | Table comment                                |

### Setting Auto Increment (MySQL)

When a table has an AUTO_INCREMENT value, a **Set Auto Increment** control appears. Enter a new value and click **Set** to run `ALTER TABLE … AUTO_INCREMENT = N`.

### Database Info

Selecting a database without selecting a table shows database-level metadata (engine, charset, size, etc.).

---

## Creating a Database

Click **New Database** (grid icon) in the sidebar header, or use the **New Database** wizard from the welcome screen.

**Step 1 — Connection:**
- Choose database type (MySQL, PostgreSQL, SQL Server, SQLite, Oracle).
- For SQLite: enter a database name and optionally browse for a save location. Leave location empty to create an in-memory database.
- For server databases: enter host, port, username, and password. Click **Test & Continue**.

**Step 2 — Database:**
- Enter the new database name.
- For MySQL: choose **Character Set** (utf8mb4, utf8, latin1, ascii) and **Collation**.

Click **Create Database**. The new database is automatically connected and selected.

---

## Exporting Data

### Export a Table

Click **Export Table** in the sidebar bottom bar (requires a table to be selected).

Formats: CSV, TSV, JSON, XML, SQL (SQLite / MySQL / PostgreSQL / Oracle).

### Export a Database

Click **Export DB** in the sidebar bottom bar (requires a database to be selected).

Choose format then whether to include data rows:
- **Structure + Data** — DDL + INSERT statements
- **Structure Only** — DDL only
- **CSV** or **JSON** — data-only exports

---

## Migrating Data

Click the **⇄ migrate icon** in the connections panel header to open the Migration Wizard.

The wizard copies schema and data from one database to another across any supported database type.

### Step 1 — Source

- Select the **source connection** (must be connected).
- Select the **source database**.
- Check the **tables** to migrate. Use **Select all** / **Deselect all** for convenience.

### Step 2 — Target

- Select the **target connection** — any saved profile, connected or not. Profiles not currently connected show `— not connected` and will be auto-connected when selected (a spinner indicates progress).
- Select the **target database** from the dropdown, or choose **＋ Create new database…** to create one. Enter the new database name in the text field that appears.

### Step 3 — Type Mapping

Review auto-generated type mappings from source to target database type. Edit any cell in the **Target Type** column to override a mapping.

Common automatic conversions:
- MySQL `TINYINT(1)` → PostgreSQL `BOOLEAN`
- MySQL `DATETIME` → PostgreSQL `TIMESTAMP`
- MySQL `JSON` → PostgreSQL `JSONB`
- Oracle `VARCHAR2` → `VARCHAR`
- Oracle `NUMBER` → `DECIMAL`

### Step 4 — Execute

Click **Start Migration**. For each table:
1. `CREATE TABLE IF NOT EXISTS` is run on the target.
2. Data is fetched in 500-row batches and inserted.
3. A progress bar per table and a live log show status.

If a table already exists on the target, it is left intact and rows are appended.

---

## MySQL User Manager

Click the **users icon** in the connections panel footer to open the User Manager. The icon is enabled only when a MySQL connection is active.

The modal lists all MySQL user accounts grouped by username. Click a username to expand its hosts, then click a specific user@host entry to load and edit that account.

### General Tab

Configure the account's basic login settings:

| Field             | Description                                      |
|-------------------|--------------------------------------------------|
| Username          | MySQL account name                               |
| Host              | Allowed host (`%` = any, `localhost`, IP, etc.)  |
| Password          | Set or change the account password               |
| Max Queries/Hour  | 0 = unlimited                                    |
| Max Updates/Hour  | 0 = unlimited                                    |
| Max Connections/Hour | 0 = unlimited                                 |
| Max User Connections | 0 = unlimited                                 |

Click **Save Changes** to apply. A new account can be created with **+ New User** at the top of the user list.

### Global Privileges Tab

Toggle server-wide privileges using checkboxes organised into groups:

- **Data** — SELECT, INSERT, UPDATE, DELETE, FILE
- **Structure** — CREATE, ALTER, INDEX, DROP, CREATE TEMPORARY TABLES, SHOW VIEW, CREATE ROUTINE, ALTER ROUTINE, EXECUTE, CREATE VIEW, EVENT, TRIGGER
- **Administration** — GRANT, SUPER, PROCESS, RELOAD, SHUTDOWN, SHOW DATABASES, LOCK TABLES, REFERENCES, REPLICATION CLIENT, REPLICATION SLAVE, CREATE USER

Click **Save Changes** to commit via `GRANT … ON *.* TO user@host`.

### Schema Privileges Tab

Grant per-database privileges:

1. Select a **schema** from the left panel.
2. Check or uncheck individual privileges in the right panel (SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, INDEX, REFERENCES, CREATE VIEW, SHOW VIEW, CREATE ROUTINE, ALTER ROUTINE, EXECUTE, TRIGGER, LOCK TABLES, CREATE TEMPORARY TABLES, EVENT).

Click **Save Changes** to apply `GRANT … ON schema.* TO user@host` / `REVOKE` as needed.

### Resources Tab

Set per-hour and per-connection resource limits (same fields as the General tab, shown inline for convenience).

---

## Themes

Click the **theme icon** in the connections panel header to cycle through:
- **Dark**
- **Light**
- **System** (follows OS preference)

The icon changes to reflect the current mode (moon / sun / monitor).
# dataAce
