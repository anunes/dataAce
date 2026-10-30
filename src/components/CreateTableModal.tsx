import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Loader2, Plus, X } from "lucide-react";
import { ConnectionProfile, DbType } from "../types";
import { buildCreateTableStatements, COLUMN_TYPES, TableColumn, validateTableDefinition } from "../utils/createTable";

interface Props {
  profiles: ConnectionProfile[];
  initialProfileId: string | null;
  initialDatabase: string | null;
  onLoadDatabases: (profileId: string) => Promise<string[]>;
  onCreateTable: (profileId: string, database: string, statements: string[]) => Promise<void>;
  onNewConnection: () => Promise<string | null>;
  onClose: () => void;
}

const inputCls = "w-full min-w-0 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-2 py-1.5 text-xs focus:outline-none focus:border-blue-500 text-gray-800 dark:text-gray-200 disabled:opacity-50";
const initialColumns: TableColumn[] = [{ name: "id", type: "INTEGER", pk: true, notNull: true }];
const databaseLabels: Record<DbType, string> = {
  mysql: "MySQL / MariaDB", postgres: "PostgreSQL", sqlite: "SQLite", oracle: "Oracle", mssql: "SQL Server",
};

function ColumnTypeInput({ value, dbType, label, onChange }: {
  value: string;
  dbType: DbType;
  label: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [filter, setFilter] = useState("");
  const listRef = useRef<HTMLUListElement>(null);
  const options = COLUMN_TYPES[dbType].filter(type => type.toLowerCase().includes(filter.trim().toLowerCase()));

  useEffect(() => {
    if (open) listRef.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active, open, filter]);

  function choose(type: string) {
    onChange(type);
    setOpen(false);
  }

  return (
    <div className="relative min-w-0">
      <input
        role="combobox"
        aria-label={label}
        aria-autocomplete="list"
        aria-expanded={open && options.length > 0}
        aria-controls={id}
        aria-activedescendant={open && options[active] ? `${id}-${active}` : undefined}
        autoComplete="off"
        className={inputCls + " pr-6"}
        placeholder="Choose or enter a type"
        value={value}
        onFocus={() => { setFilter(""); setActive(0); setOpen(true); }}
        onBlur={() => setOpen(false)}
        onChange={e => { onChange(e.target.value); setFilter(e.target.value); setActive(0); setOpen(true); }}
        onKeyDown={e => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!open) { setFilter(""); setActive(0); setOpen(true); }
            else setActive(current => options.length ? (current + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length : 0);
          } else if (e.key === "Enter" && open && options[active]) {
            e.preventDefault();
            choose(options[active]);
          } else if (e.key === "Escape" && open) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }
        }}
      />
      <ChevronDown size={11} className="absolute right-2 top-2 pointer-events-none text-gray-400" />
      {open && options.length > 0 && (
        <ul ref={listRef} id={id} role="listbox" aria-label={`${label} suggestions`} className="absolute top-full left-0 right-0 z-10 mt-1 max-h-40 overflow-y-auto bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded shadow-lg py-1">
          {options.map((type, idx) => (
            <li
              key={type}
              id={`${id}-${idx}`}
              role="option"
              aria-selected={idx === active}
              className={`px-2 py-1.5 text-xs cursor-pointer ${idx === active ? "bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-100" : "text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700"}`}
              onMouseDown={e => e.preventDefault()}
              onClick={() => choose(type)}
              onMouseMove={() => setActive(idx)}
            >{type}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function CreateTableModal({ profiles, initialProfileId, initialDatabase, onLoadDatabases, onCreateTable, onNewConnection, onClose }: Props) {
  const [step, setStep] = useState<"connection" | "table">("connection");
  const [profileId, setProfileId] = useState(initialProfileId ?? profiles[0]?.id ?? "");
  const [databases, setDatabases] = useState<string[]>([]);
  const [database, setDatabase] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [tableName, setTableName] = useState("");
  const [columns, setColumns] = useState<TableColumn[]>(initialColumns);
  const [timestamps, setTimestamps] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [addingConnection, setAddingConnection] = useState(false);
  const loadDatabases = useRef(onLoadDatabases);
  loadDatabases.current = onLoadDatabases;
  const profile = profiles.find(p => p.id === profileId);
  const dbType = profile?.type ?? "mysql";
  const definitionError = validateTableDefinition(dbType, tableName, columns, timestamps);
  const completeDefinition = tableName.trim() && columns.every(c => c.name.trim() && c.type.trim());
  const statements = buildCreateTableStatements(dbType, tableName, columns, timestamps);
  const canContinue = !!profile && !!database && !loading && !loadError;

  useEffect(() => {
    let cancelled = false;
    setDatabases([]);
    setDatabase("");
    setLoadError(null);
    setCreateError(null);
    if (!profileId || !profile) { setLoading(false); return; }
    setLoading(true);
    loadDatabases.current(profileId).then(names => {
      if (cancelled) return;
      setDatabases(names);
      const preferred = profileId === initialProfileId ? initialDatabase : profile.database;
      setDatabase(preferred && names.includes(preferred) ? preferred : names[0] ?? "");
    }).catch(error => {
      if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [profileId, profile?.id, loadAttempt]);

  async function addConnection() {
    setAddingConnection(true);
    try {
      const id = await onNewConnection();
      if (id) setProfileId(id);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error));
    } finally {
      setAddingConnection(false);
    }
  }

  async function createTable() {
    if (step !== "table" || creating || !canContinue) return;
    if (definitionError) { setCreateError(definitionError); return; }
    setCreating(true);
    setCreateError(null);
    try {
      await onCreateTable(profileId, database, statements);
      onClose();
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreating(false);
    }
  }

  function updateColumn<K extends keyof TableColumn>(idx: number, key: K, value: TableColumn[K]) {
    setColumns(previous => previous.map((column, i) => i === idx ? { ...column, [key]: value } : column));
    setCreateError(null);
  }

  function continueToTable() {
    if (!canContinue) return;
    setCreateError(null);
    setStep("table");
  }

  function changeConnection() {
    setCreateError(null);
    setStep("connection");
  }

  if (addingConnection) return null;

  return createPortal(
    <div className="table-modal-backdrop">
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-table-title"
        className="table-modal-dialog bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-2xl"
        onSubmit={e => { e.preventDefault(); if (step === "connection") continueToTable(); else void createTable(); }}
        onKeyDown={e => { if (e.key === "Escape" && !creating) onClose(); }}
      >
        <div className="flex items-center justify-between px-5 pt-5 pb-3">
          <h3 id="create-table-title" className="font-semibold text-gray-800 dark:text-gray-100">New Table</h3>
          <button type="button" aria-label="Close table creation" disabled={creating} onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 disabled:opacity-50"><X size={16} /></button>
        </div>
        <div className="table-modal-body px-5 pb-5">
          <ol aria-label="Table creation steps" className="flex items-center gap-4 mb-4 text-xs">
            <li aria-current={step === "connection" ? "step" : undefined} className={step === "connection" ? "font-medium text-blue-500" : "text-gray-400"}>1. Connection</li>
            <li aria-current={step === "table" ? "step" : undefined} className={step === "table" ? "font-medium text-blue-500" : "text-gray-400"}>2. Table</li>
          </ol>
          <fieldset disabled={creating} className="space-y-4 min-w-0">
            {step === "connection" ? <>
            <p className="text-sm text-gray-600 dark:text-gray-300">Choose a connection and database for your new table.</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="flex justify-between items-center mb-1 gap-1">
                  <label htmlFor="create-table-connection" className="text-xs text-gray-400">Connection</label>
                  <button type="button" onClick={() => void addConnection()} className="text-xs text-blue-500 hover:text-blue-400 flex items-center gap-1"><Plus size={10} /> New Connection</button>
                </div>
                <select id="create-table-connection" autoFocus className={inputCls} value={profileId} onChange={e => setProfileId(e.target.value)}>
                  <option value="" disabled>Select a connection</option>
                  {profiles.map(p => <option key={p.id} value={p.id}>{p.name} ({databaseLabels[p.type]})</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="create-table-database" className="text-xs text-gray-400 mb-1 block">Database</label>
                <select id="create-table-database" className={inputCls} disabled={loading || databases.length === 0} value={database} onChange={e => { setDatabase(e.target.value); setCreateError(null); }}>
                  <option value="" disabled>{loading ? "Loading databases..." : "Select a database"}</option>
                  {databases.map(name => <option key={name} value={name}>{name}</option>)}
                </select>
              </div>
            </div>
            {loading && <p role="status" className="flex items-center gap-1.5 text-xs text-gray-400"><Loader2 size={12} className="animate-spin" /> Loading databases...</p>}
            {loadError && <div role="alert" className="text-xs text-red-600 dark:text-red-400 break-words">{loadError} <button type="button" onClick={() => setLoadAttempt(n => n + 1)} className="underline">Retry</button></div>}
            {!loading && !loadError && profile && databases.length === 0 && <p className="text-xs text-gray-400">No databases available. Create a database on this connection first.</p>}
            </> : <>
            <div className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2">
              <div className="min-w-0 text-xs">
                <p className="font-medium text-gray-700 dark:text-gray-200 truncate">{profile?.name} · {database}</p>
                <p className="text-gray-400 mt-0.5">{databaseLabels[dbType]}</p>
              </div>
              <button type="button" onClick={changeConnection} className="text-xs text-blue-500 hover:text-blue-400 shrink-0">Change connection</button>
            </div>
            <div>
              <label htmlFor="create-table-name" className="text-xs text-gray-400 mb-1 block">Table Name</label>
              <input id="create-table-name" autoFocus className={inputCls} placeholder="table_name" value={tableName} onChange={e => { setTableName(e.target.value); setCreateError(null); }} />
            </div>
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-gray-400">Columns</span>
                <button type="button" onClick={() => setColumns(previous => [...previous, { name: "", type: dbType === "sqlite" ? "TEXT" : dbType === "oracle" ? "VARCHAR2(255)" : "VARCHAR(255)", pk: false, notNull: false }])} className="text-xs text-blue-500 hover:text-blue-400 flex items-center gap-1"><Plus size={10} /> Add Column</button>
              </div>
              <div className="space-y-2">
                <div className="table-modal-columns text-xs text-gray-400"><span>Name</span><span>Type</span><span title="Primary key">PK</span><span title="Not null">NN</span><span /></div>
                {columns.map((column, idx) => (
                  <div key={idx} className="table-modal-columns">
                    <input aria-label={`Column ${idx + 1} name`} className={inputCls} placeholder="column_name" value={column.name} onChange={e => updateColumn(idx, "name", e.target.value)} />
                    <ColumnTypeInput key={`${idx}-${dbType}`} label={`Column ${idx + 1} type`} dbType={dbType} value={column.type} onChange={type => updateColumn(idx, "type", type)} />
                    <input aria-label={`Column ${idx + 1} primary key`} type="checkbox" checked={column.pk} onChange={e => updateColumn(idx, "pk", e.target.checked)} className="w-4 h-4 accent-blue-500" />
                    <input aria-label={`Column ${idx + 1} not null`} type="checkbox" checked={column.pk || column.notNull} disabled={column.pk} onChange={e => updateColumn(idx, "notNull", e.target.checked)} className="w-4 h-4 accent-blue-500 disabled:opacity-40" />
                    <button type="button" aria-label={`Remove column ${idx + 1}`} disabled={columns.length === 1} onClick={() => { setColumns(previous => previous.filter((_, i) => i !== idx)); setCreateError(null); }} className="text-gray-400 hover:text-red-500 disabled:opacity-30"><X size={12} /></button>
                  </div>
                ))}
              </div>
              <p className="text-xs text-gray-400 mt-2">Choose a suggested type or enter a custom type.</p>
            </div>
            <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-3">
              <label className="flex items-center gap-2 cursor-pointer text-xs font-medium text-gray-700 dark:text-gray-200">
                <input type="checkbox" checked={timestamps} onChange={e => { setTimestamps(e.target.checked); setCreateError(null); }} className="w-4 h-4 accent-blue-500" />
                Add timestamps
              </label>
              {timestamps && (
                <div className="mt-2 space-y-2 text-xs text-gray-500 dark:text-gray-400">
                  <p><code className="text-gray-700 dark:text-gray-200">created_at</code> — default <code>CURRENT_TIMESTAMP</code></p>
                  <p><code className="text-gray-700 dark:text-gray-200">updated_at</code> — default <code>CURRENT_TIMESTAMP</code>{dbType === "mysql" ? <>; extra <code>ON UPDATE CURRENT_TIMESTAMP</code></> : "; updates automatically when a row changes."}</p>
                </div>
              )}
            </div>
            <details>
              <summary className="text-xs text-gray-400 cursor-pointer">Preview SQL</summary>
              <pre className="mt-2 p-2 bg-gray-100 dark:bg-gray-800 rounded text-xs text-gray-700 dark:text-gray-300 overflow-x-auto">{statements.map(sql => sql.trimEnd().endsWith(";") ? sql : `${sql};`).join("\n\n")}</pre>
            </details>
            </>}
          </fieldset>
        </div>
        <div className="table-modal-footer p-4 border-t border-gray-200 dark:border-gray-700">
          {(createError || (step === "table" && completeDefinition && definitionError)) && <p role="alert" className="w-full text-sm text-red-600 dark:text-red-400 break-words">{createError ?? definitionError}</p>}
          <button type="button" disabled={creating} onClick={onClose} className="px-3 py-1.5 text-sm bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg text-gray-700 dark:text-gray-200 disabled:opacity-50">Cancel</button>
          {step === "table" && <button type="button" disabled={creating} onClick={changeConnection} className="px-3 py-1.5 text-sm bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg text-gray-700 dark:text-gray-200 disabled:opacity-50">Back</button>}
          <button type="submit" disabled={creating || !canContinue || (step === "table" && !!definitionError)} className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg disabled:opacity-50">{step === "connection" ? "Continue" : creating ? "Creating..." : "Create Table"}</button>
        </div>
      </form>
    </div>,
    document.body
  );
}
