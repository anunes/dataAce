import { useState, useRef, useEffect } from "react";
import { TableInfo, DbType } from "../types";
import { RefreshCw, ChevronDown, ChevronRight, Grid3x3, Eye, EyeOff, Search, X, Plus, Database, Download } from "lucide-react";

const SYSTEM_DBS: Partial<Record<DbType, string[]>> = {
  mysql: ["information_schema", "mysql", "performance_schema", "sys"],
  postgres: ["template0", "template1"],
  oracle: ["sys", "system", "outln", "dbsnmp", "appqossys", "ctxsys", "dvsys", "lbacsys", "mdsys", "olapsys", "orddata", "ordsys", "wmsys", "xdb"],
  mssql: ["master", "tempdb", "model", "msdb"],
};

interface Props {
  connId: string;
  databases: string[];
  selectedDb: string | null;
  tables: TableInfo[];
  selectedTable: string | null;
  dbType: DbType;
  onSelectDb: (db: string) => void;
  onSelectTable: (table: string) => void;
  onRefresh: () => Promise<void> | void;
  onDropTable: (table: string) => void;
  onDropDatabase: (db: string) => void;
  onCreateDatabase: (name: string) => Promise<void>;
  onNewTable: () => void;
  onNewConnection: () => void;
  onExportTable: () => void;
  onExportDatabase: () => void;
}

interface ContextMenu {
  x: number;
  y: number;
  table: string;
}

interface DbContextMenu {
  x: number;
  y: number;
  db: string;
}

export default function Sidebar({
  databases, selectedDb, tables, selectedTable, dbType,
  onSelectDb, onSelectTable, onRefresh, onDropTable, onDropDatabase,
  onCreateDatabase, onNewTable, onNewConnection,
  onExportTable, onExportDatabase,
}: Props) {
  const [search, setSearch] = useState("");
  const [showSystemDbs, setShowSystemDbs] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [dropConfirm, setDropConfirm] = useState<string | null>(null);
  const [dbContextMenu, setDbContextMenu] = useState<DbContextMenu | null>(null);
  const [dropDbConfirm, setDropDbConfirm] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Create database modal
  const [refreshing, setRefreshing] = useState(false);
  const [showCreateDb, setShowCreateDb] = useState(false);
  const [newDbName, setNewDbName] = useState("");
  const [creatingDb, setCreatingDb] = useState(false);

  useEffect(() => {
    const handler = () => { setContextMenu(null); setDbContextMenu(null); };
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, []);

  const filtered = tables.filter(t => t.name.toLowerCase().includes(search.toLowerCase()));

  async function handleCreateDb() {
    if (!newDbName.trim()) return;
    setCreatingDb(true);
    try {
      await onCreateDatabase(newDbName.trim());
      setShowCreateDb(false);
      setNewDbName("");
    } catch (e) {
      alert(`Failed: ${e}`);
    } finally {
      setCreatingDb(false);
    }
  }

  const systemDbs = SYSTEM_DBS[dbType] ?? [];
  const visibleDbs = showSystemDbs ? databases : databases.filter(db => !systemDbs.includes(db.toLowerCase()));

  const canCreateDb = dbType === "mysql" || dbType === "postgres" || dbType === "mssql";
  const inputCls = "w-full min-w-0 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-500 text-gray-800 dark:text-gray-200";

  return (
    <div className="w-full flex-shrink-0 bg-gray-50 dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-1 px-2 py-2 border-b border-gray-200 dark:border-gray-800">
        <div className="flex-1 flex items-center gap-1 bg-gray-100 dark:bg-gray-800 rounded px-2 py-1">
          <Search size={11} className="text-gray-400 flex-shrink-0" />
          <input
            className="flex-1 bg-transparent text-xs focus:outline-none text-gray-700 dark:text-gray-200 placeholder-gray-400 min-w-0"
            placeholder="Filter tables..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {search && (
            <button onClick={() => setSearch("")}>
              <X size={10} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300" />
            </button>
          )}
        </div>
        <button
          onClick={async () => { setRefreshing(true); try { await onRefresh(); } finally { setRefreshing(false); } }}
          disabled={refreshing}
          className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 disabled:opacity-50"
          title="Refresh"
        >
          <RefreshCw size={13} className={refreshing ? "animate-spin" : ""} />
        </button>
        {systemDbs.length > 0 && (
          <button
            onClick={() => setShowSystemDbs(v => !v)}
            className={`p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 ${showSystemDbs ? "text-blue-500" : "text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"}`}
            title={showSystemDbs ? "Hide system databases" : "Show system databases"}
          >
            {showSystemDbs ? <Eye size={13} /> : <EyeOff size={13} />}
          </button>
        )}
        {canCreateDb && (
          <button onClick={() => setShowCreateDb(true)} className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200" title="New Database">
            <Database size={13} />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {visibleDbs.map(db => (
          <div key={db}>
            <button
              className={`w-full flex items-center gap-1.5 px-2 py-1.5 text-xs font-semibold hover:bg-gray-100 dark:hover:bg-gray-800 text-left ${selectedDb === db ? "text-blue-500" : "text-gray-500 dark:text-gray-400"}`}
              onClick={() => onSelectDb(db)}
              onContextMenu={e => {
                e.preventDefault();
                setDbContextMenu({ x: e.clientX, y: e.clientY, db });
              }}
            >
              {selectedDb === db ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <span className="truncate uppercase tracking-wider">{db}</span>
            </button>

            {selectedDb === db && (
              <div>
                {/* New Table button */}
                <button
                  onClick={onNewTable}
                  className="w-full flex items-center gap-2 px-4 py-1 text-xs text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-blue-500"
                >
                  <Plus size={10} />
                  <span>New Table</span>
                </button>

                {filtered.length === 0 && (
                  <div className="px-6 py-2 text-xs text-gray-400">No tables</div>
                )}
                {filtered.map(t => (
                  <button
                    key={t.name}
                    className={`w-full flex items-center gap-2 px-4 py-1.5 text-xs text-left hover:bg-gray-100 dark:hover:bg-gray-800 ${selectedTable === t.name ? "bg-gray-100 dark:bg-gray-800 text-blue-500" : "text-gray-600 dark:text-gray-300"}`}
                    onClick={() => onSelectTable(t.name)}
                    onContextMenu={e => {
                      e.preventDefault();
                      setContextMenu({ x: e.clientX, y: e.clientY, table: t.name });
                    }}
                  >
                    {t.table_type === "view" ? (
                      <Eye size={12} className="flex-shrink-0 text-gray-400" />
                    ) : (
                      <Grid3x3 size={12} className="flex-shrink-0 text-gray-400" />
                    )}
                    <span className="truncate">{t.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Bottom export bar */}
      <div className="border-t border-gray-200 dark:border-gray-800 px-2 py-2 flex gap-1">
        <button
          onClick={onExportTable}
          disabled={!selectedTable}
          title="Export current table"
          className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 rounded disabled:opacity-30"
        >
          <Download size={12} /> Export Table
        </button>
        <button
          onClick={onExportDatabase}
          disabled={!selectedDb}
          title="Export entire database"
          className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 rounded disabled:opacity-30"
        >
          <Download size={12} /> Export DB
        </button>
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={menuRef}
          className="fixed z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded shadow-lg py-1 min-w-44"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={e => e.stopPropagation()}
        >
          <button className="w-full text-left px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700"
            onClick={() => { onSelectTable(contextMenu.table); setContextMenu(null); }}>Open in Browse</button>
          <button className="w-full text-left px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700"
            onClick={() => { navigator.clipboard.writeText(contextMenu.table); setContextMenu(null); }}>Copy Table Name</button>
          <button className="w-full text-left px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700"
            onClick={() => { onRefresh(); setContextMenu(null); }}>Refresh</button>
          <div className="border-t border-gray-200 dark:border-gray-700 my-1" />
          <button className="w-full text-left px-3 py-1.5 text-sm text-red-500 hover:bg-gray-100 dark:hover:bg-gray-700"
            onClick={() => { setDropConfirm(contextMenu.table); setContextMenu(null); }}>Drop Table</button>
        </div>
      )}

      {/* DB context menu */}
      {dbContextMenu && (
        <div
          className="fixed z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded shadow-lg py-1 min-w-44"
          style={{ left: dbContextMenu.x, top: dbContextMenu.y }}
          onClick={e => e.stopPropagation()}
        >
          <button className="w-full text-left px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700"
            onClick={() => { onSelectDb(dbContextMenu.db); setDbContextMenu(null); }}>
            Select Database
          </button>
          <button className="w-full text-left px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700"
            onClick={async () => { setDbContextMenu(null); setRefreshing(true); try { await onRefresh(); } finally { setRefreshing(false); } }}>
            Refresh
          </button>
          <div className="border-t border-gray-200 dark:border-gray-700 my-1" />
          <button className="w-full text-left px-3 py-1.5 text-sm text-red-500 hover:bg-gray-100 dark:hover:bg-gray-700"
            onClick={() => { setDropDbConfirm(dbContextMenu.db); setDbContextMenu(null); }}>
            Drop Database…
          </button>
        </div>
      )}

      {/* Drop DB confirm */}
      {dropDbConfirm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-5 w-96 shadow-2xl">
            <h3 className="font-semibold mb-2 text-gray-800 dark:text-gray-100">Drop Database</h3>
            <p className="text-sm text-gray-500 mb-1">
              Are you sure you want to drop <span className="text-red-500 font-mono">{dropDbConfirm}</span>?
            </p>
            <p className="text-xs text-red-400 mb-4 font-medium">
              This will permanently delete the database and ALL its data. This cannot be undone.
            </p>
            <div className="flex gap-2 justify-end">
              <button className="px-3 py-1.5 text-sm bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg text-gray-700 dark:text-gray-200"
                onClick={() => setDropDbConfirm(null)}>Cancel</button>
              <button className="px-3 py-1.5 text-sm bg-red-600 hover:bg-red-700 text-white rounded-lg"
                onClick={() => { onDropDatabase(dropDbConfirm); setDropDbConfirm(null); }}>
                Drop Database
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Drop confirm */}
      {dropConfirm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-5 w-80 shadow-2xl">
            <h3 className="font-semibold mb-2 text-gray-800 dark:text-gray-100">Drop Table</h3>
            <p className="text-sm text-gray-500 mb-4">
              Are you sure you want to drop <span className="text-red-500 font-mono">{dropConfirm}</span>? This cannot be undone.
            </p>
            <div className="flex gap-2 justify-end">
              <button className="px-3 py-1.5 text-sm bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg text-gray-700 dark:text-gray-200" onClick={() => setDropConfirm(null)}>Cancel</button>
              <button className="px-3 py-1.5 text-sm bg-red-600 hover:bg-red-700 text-white rounded-lg" onClick={() => { onDropTable(dropConfirm); setDropConfirm(null); }}>Drop</button>
            </div>
          </div>
        </div>
      )}

      {/* Create Database modal */}
      {showCreateDb && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-5 w-72 shadow-2xl">
            <h3 className="font-semibold mb-1 text-gray-800 dark:text-gray-100">New Database</h3>
            <p className="text-xs text-gray-400 mb-3">
              Using current connection.{" "}
              <button
                className="text-blue-500 hover:underline"
                onClick={() => { setShowCreateDb(false); onNewConnection(); }}
              >
                Use a different connection →
              </button>
            </p>
            <input
              autoFocus
              className={inputCls + " mb-3"}
              placeholder="database_name"
              value={newDbName}
              onChange={e => setNewDbName(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") handleCreateDb(); if (e.key === "Escape") setShowCreateDb(false); }}
            />
            <div className="flex gap-2 justify-end">
              <button className="px-3 py-1.5 text-sm bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg text-gray-700 dark:text-gray-200" onClick={() => setShowCreateDb(false)}>Cancel</button>
              <button disabled={!newDbName.trim() || creatingDb} className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg disabled:opacity-50" onClick={handleCreateDb}>
                {creatingDb ? "Creating..." : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
