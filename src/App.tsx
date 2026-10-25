import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save, open as openDialog } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { desktopDir } from "@tauri-apps/api/path";
import { ConnectionProfile, ActiveTab, TableInfo, Theme, QueryResult, ServerStatus } from "./types";
import ConnectionsPanel from "./components/ConnectionsPanel";
import AddConnectionModal from "./components/AddConnectionModal";
import CreateDatabaseWizard from "./components/CreateDatabaseWizard";
import Sidebar from "./components/Sidebar";
import MainView from "./components/MainView";
import { Sun, Moon, Monitor, Database, CheckCircle, XCircle, ArrowRightLeft } from "lucide-react";
import MigrationWizard from "./components/MigrationWizard";
import AboutModal from "./components/AboutModal";
import UserManagerModal from "./components/UserManagerModal";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface SessionState {
  connId: string;
  databases: string[];
  selectedDb: string | null;
  tables: TableInfo[];
  selectedTable: string | null;
  activeTab: ActiveTab;
}

const PROFILES_KEY = "dataace_profiles";
const THEME_KEY = "dataace_theme";

function generateId() {
  return crypto.randomUUID();
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "dark") {
    root.classList.add("dark");
  } else if (theme === "light") {
    root.classList.remove("dark");
  } else {
    if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
  }
}

async function invokeConnect(profile: ConnectionProfile): Promise<string> {
  if (profile.type === "sqlite") {
    return invoke<string>("connect_sqlite", { path: profile.filePath || ":memory:" });
  }
  if (profile.type === "mysql") {
    return invoke<string>("connect_mysql", {
      host: profile.host,
      port: profile.port,
      username: profile.username,
      password: profile.password,
      database: profile.database,
    });
  }
  if (profile.type === "postgres") {
    return invoke<string>("connect_postgres", {
      host: profile.host,
      port: profile.port,
      username: profile.username,
      password: profile.password,
      database: profile.database,
      sshHost: profile.ssh?.host ?? "",
      sshPort: profile.ssh?.port ?? 0,
      sshUser: profile.ssh?.user ?? "",
      sshPassword: profile.ssh?.password ?? "",
    });
  }
  if (profile.type === "oracle") {
    return invoke<string>("connect_oracle", {
      host: profile.host,
      port: profile.port,
      service: profile.serviceName,
      username: profile.username,
      password: profile.password,
    });
  }
  if (profile.type === "mssql") {
    return invoke<string>("connect_mssql", {
      host: profile.host,
      port: profile.port,
      username: profile.username,
      password: profile.password,
      database: profile.database,
    });
  }
  throw new Error("Unknown db type");
}

export default function App() {
  const [profiles, setProfiles] = useState<ConnectionProfile[]>(() => {
    try {
      const stored = localStorage.getItem(PROFILES_KEY);
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

  const [theme, setTheme] = useState<Theme>(() => {
    return (localStorage.getItem(THEME_KEY) as Theme) ?? "dark";
  });

  const [systemDark, setSystemDark] = useState(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );

  const [sessions, setSessions] = useState<Record<string, SessionState>>({});
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingProfile, setEditingProfile] = useState<ConnectionProfile | null>(null);
  const [tableExportPending, setTableExportPending] = useState(false);
  const [showCreateDbWizard, setShowCreateDbWizard] = useState(false);
  const [showMigration, setShowMigration] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showUserManager, setShowUserManager] = useState(false);
  const [serverStatus, setServerStatus] = useState<ServerStatus[]>([]);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [exportFormat, setExportFormat] = useState<"sql" | "csv" | "json" | null>(null);
  const [pendingSqlite, setPendingSqlite] = useState<{
    profile: ConnectionProfile;
    connId: string;
    databases: string[];
    firstDb: string | null;
    tables: TableInfo[];
  } | null>(null);

  // Connections panel resize state
  const [connectionsWidth, setConnectionsWidth] = useState(200);
  const isResizingConnsRef = useRef(false);
  const connsStartXRef = useRef(0);
  const connsStartWidthRef = useRef(200);

  // Sidebar resize state
  const [sidebarWidth, setSidebarWidth] = useState(208);
  const isDraggingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(208);

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (isResizingConnsRef.current) {
        const delta = e.clientX - connsStartXRef.current;
        setConnectionsWidth(Math.min(400, Math.max(160, connsStartWidthRef.current + delta)));
      }
      if (isDraggingRef.current) {
        const delta = e.clientX - startXRef.current;
        setSidebarWidth(Math.min(480, Math.max(140, startWidthRef.current + delta)));
      }
    }
    function onMouseUp() {
      isResizingConnsRef.current = false;
      isDraggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  // Check server availability on startup
  useEffect(() => {
    invoke<ServerStatus[]>("check_server_availability").then(setServerStatus).catch(() => {});
  }, []);

  // Disable auto-capitalize / auto-correct on all inputs globally
  useEffect(() => {
    function patchInput(el: Element) {
      if (
        el instanceof HTMLInputElement &&
        el.type !== "checkbox" &&
        el.type !== "radio" &&
        el.type !== "number"
      ) {
        el.setAttribute("autocapitalize", "none");
        el.setAttribute("autocorrect", "off");
        el.setAttribute("spellcheck", "false");
      }
    }
    document.querySelectorAll("input").forEach(patchInput);
    const observer = new MutationObserver(mutations => {
      for (const m of mutations) {
        m.addedNodes.forEach(node => {
          if (node instanceof Element) {
            patchInput(node);
            node.querySelectorAll("input").forEach(patchInput);
          }
        });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
  }, [profiles]);

  useEffect(() => {
    localStorage.setItem(THEME_KEY, theme);
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    const session = selectedProfileId ? sessions[selectedProfileId] : null;
    const profile = profiles.find(p => p.id === selectedProfileId);
    const parts: string[] = [];
    if (session?.selectedTable) parts.push(session.selectedTable);
    if (session?.selectedDb) parts.push(session.selectedDb);
    if (profile?.name) parts.push(profile.name);
    parts.push("DataAce");
    getCurrentWindow().setTitle(parts.join(" — "));
  }, [selectedProfileId, sessions, profiles]);

  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => { applyTheme("system"); setSystemDark(mq.matches); };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  const isDark = theme === "dark" || (theme === "system" && systemDark);

  const cycleTheme = useCallback(() => {
    setTheme(prev => prev === "dark" ? "light" : prev === "light" ? "system" : "dark");
  }, []);

  const saveProfile = useCallback((profile: ConnectionProfile) => {
    setProfiles(prev => {
      const idx = prev.findIndex(p => p.id === profile.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = profile;
        return next;
      }
      return [...prev, profile];
    });
    setShowAddModal(false);
    setEditingProfile(null);
  }, []);

  const deleteProfile = useCallback(async (id: string) => {
    if (sessions[id]) {
      try { await invoke("disconnect", { connId: sessions[id].connId }); } catch {}
      setSessions(prev => { const n = { ...prev }; delete n[id]; return n; });
    }
    setProfiles(prev => prev.filter(p => p.id !== id));
    if (selectedProfileId === id) setSelectedProfileId(null);
  }, [sessions, selectedProfileId]);

  const duplicateProfile = useCallback((profile: ConnectionProfile) => {
    const dup: ConnectionProfile = { ...profile, id: generateId(), name: profile.name + " Copy" };
    setProfiles(prev => [...prev, dup]);
  }, []);

  const connectToProfile = useCallback(async (profile: ConnectionProfile) => {
    if (sessions[profile.id]) {
      setSelectedProfileId(profile.id);
      return;
    }
    setConnectingId(profile.id);
    setSelectedProfileId(profile.id);
    try {
      const connId = await invokeConnect(profile);
      const databases = await invoke<string[]>("list_databases", { connId });
      const firstDb = databases[0] ?? null;
      let tables: TableInfo[] = [];
      if (firstDb) {
        tables = await invoke<TableInfo[]>("list_tables", { connId, database: firstDb });
      }
      setSessions(prev => ({
        ...prev,
        [profile.id]: {
          connId,
          databases,
          selectedDb: firstDb,
          tables,
          selectedTable: null,
          activeTab: "browse",
        },
      }));
    } catch (e) {
      alert(`Connection failed: ${e}`);
      setSelectedProfileId(null);
    } finally {
      setConnectingId(null);
    }
  }, [sessions]);

  const disconnectProfile = useCallback(async (profileId: string) => {
    const session = sessions[profileId];
    if (!session) return;
    try { await invoke("disconnect", { connId: session.connId }); } catch {}
    setSessions(prev => { const n = { ...prev }; delete n[profileId]; return n; });
    if (selectedProfileId === profileId) setSelectedProfileId(null);
  }, [sessions, selectedProfileId]);

  const handleSelectDb = useCallback(async (profileId: string, db: string) => {
    const session = sessions[profileId];
    if (!session) return;
    const profile = profiles.find(p => p.id === profileId);
    try {
      // Postgres (and Oracle) bind a connection to a specific database — reconnect when switching.
      let connId = session.connId;
      if (profile && (profile.type === "postgres" || profile.type === "oracle")) {
        const newConnId = await invokeConnect({ ...profile, database: db });
        // Disconnect the old connection in the background; ignore errors.
        invoke("disconnect", { connId: session.connId }).catch(() => {});
        connId = newConnId;
      }
      const tables = await invoke<TableInfo[]>("list_tables", { connId, database: db });
      setSessions(prev => ({
        ...prev,
        [profileId]: { ...prev[profileId], connId, selectedDb: db, tables, selectedTable: null },
      }));
    } catch (e) {
      console.error(e);
    }
  }, [sessions, profiles]);

  const handleSelectTable = useCallback((profileId: string, table: string) => {
    setSessions(prev => ({
      ...prev,
      [profileId]: { ...prev[profileId], selectedTable: table, activeTab: "browse" },
    }));
  }, []);

  const handleTabChange = useCallback((profileId: string, tab: ActiveTab) => {
    setSessions(prev => ({
      ...prev,
      [profileId]: { ...prev[profileId], activeTab: tab },
    }));
  }, []);

  const handleDropTable = useCallback(async (profileId: string, table: string) => {
    const session = sessions[profileId];
    if (!session || !session.selectedDb) return;
    const profile = profiles.find(p => p.id === profileId);
    const dbType = profile?.type ?? "mysql";
    function qi(name: string) {
      if (dbType === "mysql") return `\`${name.replace(/`/g, "``")}\``;
      if (dbType === "mssql") return `[${name.replace(/]/g, "]]")}]`;
      return `"${name.replace(/"/g, '""')}"`;
    }
    try {
      await invoke("execute_query", {
        connId: session.connId,
        sql: `DROP TABLE ${qi(table)}`,
      });
      const tables = await invoke<TableInfo[]>("list_tables", {
        connId: session.connId,
        database: session.selectedDb,
      });
      setSessions(prev => ({
        ...prev,
        [profileId]: {
          ...prev[profileId],
          tables,
          selectedTable: prev[profileId].selectedTable === table ? null : prev[profileId].selectedTable,
        },
      }));
    } catch (e) {
      alert(`Drop failed: ${e}`);
    }
  }, [sessions]);

  const handleRefresh = useCallback(async (profileId: string) => {
    const session = sessions[profileId];
    if (!session) return;
    try {
      const databases = await invoke<string[]>("list_databases", { connId: session.connId });
      let tables: TableInfo[] = [];
      if (session.selectedDb) {
        tables = await invoke<TableInfo[]>("list_tables", { connId: session.connId, database: session.selectedDb });
      }
      setSessions(prev => ({ ...prev, [profileId]: { ...prev[profileId], databases, tables } }));
    } catch (e) {
      console.error(e);
    }
  }, [sessions]);

  const handleCreateDatabase = useCallback(async (profileId: string, name: string) => {
    const session = sessions[profileId];
    if (!session) return;
    await invoke("create_database", { connId: session.connId, name });
    await handleRefresh(profileId);
  }, [sessions, handleRefresh]);

  const handleCreateTable = useCallback(async (profileId: string, sql: string) => {
    const session = sessions[profileId];
    if (!session) return;
    await invoke("create_table", { connId: session.connId, sql });
    await handleRefresh(profileId);
  }, [sessions, handleRefresh]);

  const handleOpenSqliteFile = useCallback(async () => {
    try {
      const result = await openDialog({
        multiple: false,
        filters: [{ name: "SQLite Database", extensions: ["db", "sqlite", "sqlite3", "db3"] }],
      });
      const filePath = typeof result === "string" ? result : Array.isArray(result) ? result[0] : null;
      if (!filePath) return;
      const connId = await invoke<string>("connect_sqlite", { path: filePath });
      const filename = filePath.split("/").pop()?.split("\\").pop() ?? filePath;
      const databases = await invoke<string[]>("list_databases", { connId });
      const firstDb = databases[0] ?? null;
      const tables = firstDb ? await invoke<TableInfo[]>("list_tables", { connId, database: firstDb }) : [];
      const profile: ConnectionProfile = {
        id: crypto.randomUUID(),
        name: filename,
        type: "sqlite",
        color: "green",
        filePath,
        host: "", port: 0, username: "", password: "",
        database: "", serviceName: "", ssh: null,
      };
      setPendingSqlite({ profile, connId, databases, firstDb, tables });
    } catch (e) {
      alert(`Failed to open SQLite file: ${e}`);
    }
  }, []);

  const confirmOpenSqlite = useCallback((save: boolean) => {
    if (!pendingSqlite) return;
    const { profile, connId, databases, firstDb, tables } = pendingSqlite;
    if (save) setProfiles(prev => [...prev, profile]);
    setSessions(prev => ({
      ...prev,
      [profile.id]: { connId, databases, selectedDb: firstDb, tables, selectedTable: null, activeTab: "browse" },
    }));
    setSelectedProfileId(profile.id);
    setPendingSqlite(null);
  }, [pendingSqlite]);

  const handleDropDatabase = useCallback(async (profileId: string, dbName: string) => {
    const session = sessions[profileId];
    if (!session) return;
    try {
      await invoke("drop_database", { connId: session.connId, name: dbName });
      const databases = await invoke<string[]>("list_databases", { connId: session.connId });
      setSessions(prev => ({
        ...prev,
        [profileId]: {
          ...prev[profileId],
          databases,
          selectedDb: prev[profileId].selectedDb === dbName ? (databases[0] ?? null) : prev[profileId].selectedDb,
          tables: prev[profileId].selectedDb === dbName ? [] : prev[profileId].tables,
          selectedTable: prev[profileId].selectedDb === dbName ? null : prev[profileId].selectedTable,
        },
      }));
    } catch (e) {
      alert(`Drop database failed: ${e}`);
    }
  }, [sessions]);

  const handleExportDatabase = useCallback(async (includeData: boolean, format: "sql" | "csv" | "json") => {
    if (!selectedProfileId) return;
    const session = sessions[selectedProfileId];
    if (!session || !session.selectedDb) return;
    const { connId, selectedDb, tables } = session;
    if (!connId || !selectedDb || tables.length === 0) return;

    const dataTables = tables.filter(t => t.table_type === "table");
    let output = "";

    if (format === "sql") {
      const now = new Date().toISOString().replace("T", " ").slice(0, 19);
      output =
        `-- DataAce Database Export\n` +
        `-- Database: ${selectedDb}\n` +
        `-- Date: ${now}\n` +
        `-- Tables: ${dataTables.length}\n\n`;

      for (const tbl of dataTables) {
        try {
          const rawDdl = await invoke<string>("get_create_table_sql", { connId, database: selectedDb, table: tbl.name });
          const ddl = rawDdl.replace(/^CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS\s)/i, "CREATE TABLE IF NOT EXISTS ").trimEnd() + ";\n";
          output += `-- Table: ${tbl.name}\n${ddl}\n`;

          if (includeData) {
            const result = await invoke<QueryResult>("execute_query", { connId, sql: `SELECT * FROM \`${tbl.name}\`` });
            if (result.rows && result.rows.length > 0) {
              output += `-- Data: ${result.rows.length} rows\n`;
              for (const row of result.rows) {
                const values = row.map(v => v === null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`).join(", ");
                output += `INSERT INTO \`${tbl.name}\` VALUES (${values});\n`;
              }
              output += "\n";
            }
          }
        } catch {
          output += `-- Export failed for table: ${tbl.name}\n\n`;
        }
      }
    } else if (format === "csv") {
      const sections: string[] = [];
      for (const tbl of dataTables) {
        try {
          const result = await invoke<QueryResult>("execute_query", { connId, sql: `SELECT * FROM \`${tbl.name}\`` });
          const cols = result.columns.map(c => c.name);
          const escCsv = (v: string | null) => v === null ? "" : /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
          const lines = [cols.join(",")];
          for (const row of result.rows ?? []) {
            lines.push(row.map(escCsv).join(","));
          }
          sections.push(`# Table: ${tbl.name}\n${lines.join("\n")}`);
        } catch {
          sections.push(`# Export failed for table: ${tbl.name}`);
        }
      }
      output = sections.join("\n\n");
    } else {
      // json
      const obj: Record<string, Record<string, string | null>[]> = {};
      for (const tbl of dataTables) {
        try {
          const result = await invoke<QueryResult>("execute_query", { connId, sql: `SELECT * FROM \`${tbl.name}\`` });
          const cols = result.columns.map(c => c.name);
          obj[tbl.name] = (result.rows ?? []).map(row =>
            Object.fromEntries(cols.map((col, i) => [col, row[i] ?? null]))
          );
        } catch {
          obj[tbl.name] = [];
        }
      }
      output = JSON.stringify(obj, null, 2);
    }

    try {
      const defaultPath = await desktopDir();
      const ext = format === "csv" ? "csv" : format === "json" ? "json" : "sql";
      const filterName = format === "csv" ? "CSV" : format === "json" ? "JSON" : "SQL";
      const filePath = await save({
        defaultPath: `${defaultPath}/${selectedDb}_export_${Date.now()}.${ext}`,
        filters: [{ name: filterName, extensions: [ext] }],
      });
      if (filePath) {
        await writeTextFile(filePath, output);
      }
    } catch {
      // user cancelled
    }
  }, [sessions, selectedProfileId]);

  const handleDatabaseCreated = useCallback((profile: ConnectionProfile, connId: string, dbName: string) => {
    setProfiles(prev => [...prev, profile]);
    setSessions(prev => ({
      ...prev,
      [profile.id]: {
        connId,
        databases: [dbName],
        selectedDb: dbName,
        tables: [],
        selectedTable: null,
        activeTab: "browse" as ActiveTab,
      },
    }));
    setSelectedProfileId(profile.id);
    setShowCreateDbWizard(false);
  }, []);

  const testConnection = useCallback(async (profile: ConnectionProfile): Promise<boolean> => {
    try {
      const connId = await invokeConnect(profile);
      await invoke("disconnect", { connId });
      return true;
    } catch {
      return false;
    }
  }, []);

  const selectedProfile = profiles.find(p => p.id === selectedProfileId) ?? null;
  const selectedSession = selectedProfileId ? sessions[selectedProfileId] ?? null : null;

  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;

  return (
    <div className="flex h-screen w-screen bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 overflow-hidden">
      {/* Connections panel — resizable */}
      <div style={{ width: connectionsWidth, minWidth: connectionsWidth }} className="flex-shrink-0 overflow-hidden flex">
        <ConnectionsPanel
          profiles={profiles}
          activeSessions={new Set(Object.keys(sessions))}
          selectedId={selectedProfileId}
          connectingId={connectingId}
          onSelect={id => {
            const p = profiles.find(x => x.id === id);
            if (p) connectToProfile(p);
          }}
          onAdd={() => { setEditingProfile(null); setShowAddModal(true); }}
          onEdit={p => { setEditingProfile(p); setShowAddModal(true); }}
          onDelete={deleteProfile}
          onDuplicate={duplicateProfile}
          onDisconnect={disconnectProfile}
          onOpenSqlite={handleOpenSqliteFile}
          themeIcon={<ThemeIcon size={14} />}
          onCycleTheme={cycleTheme}
          onMigrate={() => setShowMigration(true)}
          onAbout={() => setShowAbout(true)}
          onManageUsers={() => setShowUserManager(true)}
          hasMysqlSession={
            selectedProfileId !== null &&
            profiles.find(p => p.id === selectedProfileId)?.type === "mysql" &&
            sessions[selectedProfileId] !== undefined
          }
        />
      </div>
      {/* Connections panel drag handle */}
      <div
        className="w-1 flex-shrink-0 cursor-col-resize hover:bg-blue-400 transition-colors bg-gray-200 dark:bg-gray-800"
        onMouseDown={e => {
          isResizingConnsRef.current = true;
          connsStartXRef.current = e.clientX;
          connsStartWidthRef.current = connectionsWidth;
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
          e.preventDefault();
        }}
      />

      <div className="flex flex-1 overflow-hidden">
        {selectedProfile && selectedSession ? (
          <>
            <div style={{ width: sidebarWidth, minWidth: sidebarWidth }} className="flex-shrink-0 overflow-hidden flex">
              <Sidebar
                connId={selectedSession.connId}
                databases={selectedSession.databases}
                selectedDb={selectedSession.selectedDb}
                tables={selectedSession.tables}
                selectedTable={selectedSession.selectedTable}
                dbType={selectedProfile.type}
                onSelectDb={db => handleSelectDb(selectedProfileId!, db)}
                onSelectTable={t => handleSelectTable(selectedProfileId!, t)}
                onRefresh={() => handleRefresh(selectedProfileId!)}
                onDropTable={t => handleDropTable(selectedProfileId!, t)}
                onDropDatabase={db => handleDropDatabase(selectedProfileId!, db)}
                onCreateDatabase={name => handleCreateDatabase(selectedProfileId!, name)}
                onCreateTable={sql => handleCreateTable(selectedProfileId!, sql)}
                onNewConnection={() => { setEditingProfile(null); setShowAddModal(true); }}
                onExportTable={() => setTableExportPending(true)}
                onExportDatabase={() => { setExportFormat(null); setShowExportDialog(true); }}
              />
            </div>
            {/* Sidebar drag handle */}
            <div
              className="w-1 flex-shrink-0 cursor-col-resize hover:bg-blue-400 transition-colors bg-gray-200 dark:bg-gray-800"
              onMouseDown={e => {
                isDraggingRef.current = true;
                startXRef.current = e.clientX;
                startWidthRef.current = sidebarWidth;
                document.body.style.cursor = "col-resize";
                document.body.style.userSelect = "none";
                e.preventDefault();
              }}
            />
            <MainView
              connId={selectedSession.connId}
              profile={selectedProfile}
              selectedDb={selectedSession.selectedDb}
              selectedTable={selectedSession.selectedTable}
              activeTab={selectedSession.activeTab}
              onTabChange={tab => handleTabChange(selectedProfileId!, tab)}
              isDark={isDark}
              triggerExport={tableExportPending}
              onExportDone={() => setTableExportPending(false)}
            />
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center flex-col gap-4">
            <img src="/icon.png" alt="DataAce" className="w-20 h-20 opacity-80" />
            <div className="text-4xl font-bold text-gray-300 dark:text-gray-600">DataAce</div>
            <p className="text-gray-400 dark:text-gray-500">Select a connection or add a new one</p>
            <div className="flex gap-3 mb-2">
              <button
                onClick={() => { setEditingProfile(null); setShowAddModal(true); }}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm font-medium text-white"
              >
                + New Connection
              </button>
              <button
                onClick={() => setShowCreateDbWizard(true)}
                className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm font-medium"
              >
                <Database size={15} /> New Database
              </button>
              <button
                onClick={() => setShowMigration(true)}
                className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-sm font-medium"
              >
                <ArrowRightLeft size={15} /> Migrate Data
              </button>
            </div>
            {serverStatus.length > 0 && (
              <div className="flex flex-col items-center gap-2">
                <p className="text-xs text-gray-400 dark:text-gray-500 uppercase tracking-wider">Server Availability</p>
                <div className="flex flex-wrap justify-center gap-2">
                  {serverStatus.map(s => (
                    <div key={s.name} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border ${s.available ? "border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-950 text-green-700 dark:text-green-400" : "border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 text-gray-400 dark:text-gray-600"}`}>
                      {s.available
                        ? <CheckCircle size={11} className="text-green-500" />
                        : <XCircle size={11} className="text-gray-400" />}
                      {s.name}
                    </div>
                  ))}
                </div>
              </div>
            )}
            <p className="text-xs text-gray-400 dark:text-gray-600 mt-2">
              &copy; 2006–{new Date().getFullYear()} @nunes. All rights reserved.
            </p>
          </div>
        )}
      </div>

      {showAddModal && (
        <AddConnectionModal
          key={editingProfile?.id ?? "new"}
          profile={editingProfile}
          onSave={saveProfile}
          onClose={() => { setShowAddModal(false); setEditingProfile(null); }}
          onTestConnection={testConnection}
        />
      )}
      {showCreateDbWizard && (
        <CreateDatabaseWizard
          onClose={() => setShowCreateDbWizard(false)}
          onCreated={handleDatabaseCreated}
        />
      )}
      {showMigration && (
        <MigrationWizard
          sessions={sessions}
          profiles={profiles}
          onClose={() => setShowMigration(false)}
        />
      )}

      {showAbout && <AboutModal onClose={() => setShowAbout(false)} />}
      {showUserManager && selectedSession && (
        <UserManagerModal connId={selectedSession.connId} onClose={() => setShowUserManager(false)} />
      )}

      {/* SQLite open — add to connections prompt */}
      {pendingSqlite && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => confirmOpenSqlite(false)}>
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-5 w-80 shadow-2xl" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold text-gray-800 dark:text-gray-100 mb-1">SQLite Database Opened</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-1 truncate" title={pendingSqlite.profile.filePath}>
              {pendingSqlite.profile.name}
            </p>
            <p className="text-xs text-gray-400 dark:text-gray-500 mb-4 truncate" title={pendingSqlite.profile.filePath}>
              {pendingSqlite.profile.filePath}
            </p>
            <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">Add this database to your saved connections?</p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => confirmOpenSqlite(false)}
                className="px-3 py-1.5 text-sm bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg text-gray-700 dark:text-gray-200"
              >
                Open Only
              </button>
              <button
                onClick={() => confirmOpenSqlite(true)}
                className="px-3 py-1.5 text-sm bg-green-600 hover:bg-green-700 text-white rounded-lg"
              >
                Add to Connections
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Export database dialog */}
      {showExportDialog && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-5 w-80 shadow-2xl">
            {exportFormat === null ? (
              <>
                <h3 className="font-semibold mb-2 text-gray-800 dark:text-gray-100">Export Database</h3>
                <p className="text-sm text-gray-500 mb-4">Choose export format:</p>
                <div className="flex flex-col gap-2">
                  <button
                    className="px-3 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg"
                    onClick={() => setExportFormat("sql")}
                  >
                    SQL
                  </button>
                  <button
                    className="px-3 py-2 text-sm bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 rounded-lg"
                    onClick={() => { setShowExportDialog(false); setExportFormat(null); handleExportDatabase(true, "csv"); }}
                  >
                    CSV
                  </button>
                  <button
                    className="px-3 py-2 text-sm bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 rounded-lg"
                    onClick={() => { setShowExportDialog(false); setExportFormat(null); handleExportDatabase(true, "json"); }}
                  >
                    JSON
                  </button>
                  <button
                    className="px-3 py-2 text-sm text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                    onClick={() => setShowExportDialog(false)}
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3 className="font-semibold mb-2 text-gray-800 dark:text-gray-100">Export as SQL</h3>
                <p className="text-sm text-gray-500 mb-4">Include the data rows from each table in the export?</p>
                <div className="flex flex-col gap-2">
                  <button
                    className="px-3 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg"
                    onClick={() => { setShowExportDialog(false); setExportFormat(null); handleExportDatabase(true, "sql"); }}
                  >
                    Structure + Data
                  </button>
                  <button
                    className="px-3 py-2 text-sm bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 rounded-lg"
                    onClick={() => { setShowExportDialog(false); setExportFormat(null); handleExportDatabase(false, "sql"); }}
                  >
                    Structure Only
                  </button>
                  <button
                    className="px-3 py-2 text-sm text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                    onClick={() => setExportFormat(null)}
                  >
                    ← Back
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
