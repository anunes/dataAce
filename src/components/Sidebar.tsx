import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
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
  onCreateTable: (sql: string) => Promise<void>;
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
  onCreateDatabase, onCreateTable, onNewConnection,
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

  // Create table modal
  const [showCreateTable, setShowCreateTable] = useState(false);
  const [newTableName, setNewTableName] = useState("");
  const [tableCols, setTableCols] = useState([{ name: "id", type: "INTEGER", pk: true, notNull: true }]);
  const [creatingTable, setCreatingTable] = useState(false);
  const [createTableError, setCreateTableError] = useState<string | null>(null);

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

  function buildCreateTableSql(): string {
    const db = dbType;
    const colDefs = tableCols.map(c => {
      let def = `  ${c.name} ${c.type}`;
      if (c.pk) {
        if (db === "sqlite") def += " PRIMARY KEY AUTOINCREMENT";
        else if (db === "mysql") def += " PRIMARY KEY AUTO_INCREMENT";
        else if (db === "postgres") return `  ${c.name} SERIAL PRIMARY KEY`;
        else def += " PRIMARY KEY";
      } else {
        if (c.notNull) def += " NOT NULL";
      }
      return def;
    });
    const name = newTableName.toLowerCase();
    const tbl = dbType === "mysql" ? `\`${name}\`` : `"${name}"`;
    return `CREATE TABLE ${tbl} (\n${colDefs.join(",\n")}\n)`;
  }

  async function handleCreateTable() {
    if (creatingTable || !newTableName.trim() || tableCols.length === 0 || tableCols.some(c => !c.name.trim() || !c.type.trim())) return;
    setCreateTableError(null);
    setCreatingTable(true);
    try {
      await onCreateTable(buildCreateTableSql());
      setShowCreateTable(false);
      setNewTableName("");
      setTableCols([{ name: "id", type: "INTEGER", pk: true, notNull: true }]);
    } catch (e) {
      setCreateTableError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreatingTable(false);
    }
  }

  function addCol() {
    setTableCols(prev => [...prev, { name: "", type: "VARCHAR(255)", pk: false, notNull: false }]);
  }

  function updateCol(idx: number, field: string, value: string | boolean) {
    setTableCols(prev => prev.map((c, i) => i === idx ? { ...c, [field]: value } : c));
  }

  function removeCol(idx: number) {
    setTableCols(prev => prev.filter((_, i) => i !== idx));
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
                  onClick={() => { setCreateTableError(null); setShowCreateTable(true); }}
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

      {/* Create Table modal */}
      {showCreateTable && createPortal(
        <div className="table-modal-backdrop">
          <form
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-table-title"
            className="table-modal-dialog bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-2xl"
            onSubmit={e => { e.preventDefault(); void handleCreateTable(); }}
          >
            <div className="table-modal-body p-5">
              <h3 id="create-table-title" className="font-semibold mb-3 text-gray-800 dark:text-gray-100">New Table{selectedDb ? ` in ${selectedDb}` : ""}</h3>

              <div className="mb-3">
                <label htmlFor="create-table-name" className="text-xs text-gray-400 mb-1 block">Table Name</label>
                <input
                  id="create-table-name"
                  autoFocus
                  className={inputCls}
                  placeholder="table_name"
                  value={newTableName}
                  onChange={e => setNewTableName(e.target.value)}
                />
              </div>

              <div className="mb-2">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-gray-400">Columns</span>
                  <button type="button" onClick={addCol} className="text-xs text-blue-500 hover:text-blue-400 flex items-center gap-1">
                    <Plus size={10} /> Add Column
                  </button>
                </div>

                <div className="space-y-1">
                  {/* Header */}
                  <div className="table-modal-columns text-xs text-gray-400">
                    <span>Name</span><span>Type</span><span>PK</span><span>NN</span><span></span>
                  </div>
                  {tableCols.map((col, idx) => (
                    <div key={idx} className="table-modal-columns">
                      <input
                        aria-label={`Column ${idx + 1} name`}
                        className={inputCls}
                        placeholder="column_name"
                        value={col.name}
                        onChange={e => updateCol(idx, "name", e.target.value)}
                      />
                      <input
                        aria-label={`Column ${idx + 1} type`}
                        className={inputCls}
                        placeholder="INTEGER"
                        value={col.type}
                        onChange={e => updateCol(idx, "type", e.target.value)}
                      />
                      <input
                        aria-label={`Column ${idx + 1} primary key`}
                        type="checkbox"
                        checked={col.pk}
                        onChange={e => updateCol(idx, "pk", e.target.checked)}
                        className="w-4 h-4 accent-blue-500"
                      />
                      <input
                        aria-label={`Column ${idx + 1} not null`}
                        type="checkbox"
                        checked={col.notNull}
                        disabled={col.pk}
                        onChange={e => updateCol(idx, "notNull", e.target.checked)}
                        className="w-4 h-4 accent-blue-500 disabled:opacity-40"
                      />
                      <button type="button" aria-label={`Remove column ${idx + 1}`} onClick={() => removeCol(idx)} disabled={tableCols.length === 1} className="text-gray-400 hover:text-red-500 disabled:opacity-30">
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <details className="mb-1">
                <summary className="text-xs text-gray-400 cursor-pointer">Preview SQL</summary>
                <pre className="mt-1 p-2 bg-gray-100 dark:bg-gray-800 rounded text-xs text-gray-700 dark:text-gray-300 overflow-x-auto">{buildCreateTableSql()}</pre>
              </details>
            </div>

            <div className="table-modal-footer p-4 border-t border-gray-200 dark:border-gray-700">
              {createTableError && <p role="alert" className="w-full text-sm text-red-600 dark:text-red-400 break-words">{createTableError}</p>}
              <button type="button" disabled={creatingTable} className="px-3 py-1.5 text-sm bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg text-gray-700 dark:text-gray-200 disabled:opacity-50" onClick={() => setShowCreateTable(false)}>Cancel</button>
              <button
                type="submit"
                disabled={!newTableName.trim() || tableCols.some(c => !c.name.trim() || !c.type.trim()) || creatingTable}
                className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg disabled:opacity-50"
              >
                {creatingTable ? "Creating..." : "Create Table"}
              </button>
            </div>
          </form>
        </div>,
        document.body
      )}
    </div>
  );
}
