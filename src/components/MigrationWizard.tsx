import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, ArrowRightLeft, Check, Loader2, ChevronRight } from "lucide-react";
import { ConnectionProfile, ColumnInfo, DbType, TableInfo, QueryResult } from "../types";

interface SessionInfo {
  connId: string;
  databases: string[];
  selectedDb: string | null;
}

interface Props {
  sessions: Record<string, SessionInfo>;
  profiles: ConnectionProfile[];
  onClose: () => void;
}

function qi(name: string, dbType: DbType): string {
  if (dbType === "mysql") return `\`${name.replace(/`/g, "``")}\``;
  if (dbType === "mssql") return `[${name.replace(/]/g, "]]")}]`;
  return `"${name.replace(/"/g, '""')}"`;
}

function buildSelectSQL(table: string, dbType: DbType, limit: number, offset: number): string {
  const t = qi(table, dbType);
  if (dbType === "oracle") return `SELECT * FROM ${t} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
  if (dbType === "mssql") return `SELECT * FROM ${t} ORDER BY (SELECT NULL) OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
  return `SELECT * FROM ${t} LIMIT ${limit} OFFSET ${offset}`;
}

function buildInsertSQL(table: string, colNames: string[], rows: (string | null)[][], dbType: DbType): string {
  const t = qi(table, dbType);
  const cols = colNames.map(c => qi(c, dbType)).join(", ");
  const escVal = (v: string | null) => v === null ? "NULL" : `'${v.replace(/'/g, "''")}'`;
  const valueRows = rows.map(r => `(${r.map(escVal).join(", ")})`).join(",\n");
  return `INSERT INTO ${t} (${cols}) VALUES\n${valueRows}`;
}

function buildCreateSQL(table: string, columns: ColumnInfo[], types: Record<string, string>, dbType: DbType): string {
  const t = qi(table, dbType);
  const cols = columns.map(col => {
    const type = types[col.name] ?? col.col_type;
    const nullable = col.nullable ? "" : " NOT NULL";
    return `  ${qi(col.name, dbType)} ${type}${nullable}`;
  });
  return `CREATE TABLE IF NOT EXISTS ${t} (\n${cols.join(",\n")}\n)`;
}

function mapType(t: string, from: DbType, to: DbType): string {
  if (from === to) return t;
  const u = t.toUpperCase().trim();

  if (from === "mysql" && to === "postgres") {
    if (u === "TINYINT(1)") return "BOOLEAN";
    if (u.startsWith("TINYINT")) return "SMALLINT";
    if (u.startsWith("BIGINT")) return "BIGINT";
    if (u.startsWith("INT") || u.startsWith("MEDIUMINT")) return "INTEGER";
    if (u.startsWith("SMALLINT")) return "SMALLINT";
    if (u.startsWith("DATETIME")) return "TIMESTAMP";
    if (u.startsWith("FLOAT")) return "REAL";
    if (u.startsWith("DOUBLE")) return "DOUBLE PRECISION";
    if (u === "JSON") return "JSONB";
    if (u === "LONGTEXT" || u === "MEDIUMTEXT") return "TEXT";
    if (u.endsWith("BLOB")) return "BYTEA";
    if (u === "YEAR") return "SMALLINT";
    if (u.startsWith("ENUM") || u.startsWith("SET")) return "TEXT";
    return t;
  }
  if (from === "postgres" && to === "mysql") {
    if (u === "BOOLEAN" || u === "BOOL") return "TINYINT(1)";
    if (u === "BYTEA") return "LONGBLOB";
    if (u.startsWith("TIMESTAMP")) return "DATETIME";
    if (u === "JSONB" || u === "JSON") return "JSON";
    if (u === "DOUBLE PRECISION") return "DOUBLE";
    if (u === "REAL") return "FLOAT";
    if (u === "SERIAL") return "INT";
    if (u === "BIGSERIAL") return "BIGINT";
    return t;
  }
  if (from === "oracle") {
    if (u === "NUMBER(1)") return to === "postgres" ? "BOOLEAN" : "TINYINT(1)";
    if (u.startsWith("NUMBER")) return "DECIMAL" + t.slice(6);
    if (u.startsWith("VARCHAR2")) return `VARCHAR${t.slice(8) || "(255)"}`;
    if (u === "CLOB") return to === "postgres" ? "TEXT" : "LONGTEXT";
    if (u === "BLOB") return to === "postgres" ? "BYTEA" : "LONGBLOB";
    if (u === "DATE" || u.startsWith("TIMESTAMP")) return to === "mysql" ? "DATETIME" : "TIMESTAMP";
    return t;
  }
  if (to === "oracle") {
    if (u === "BOOLEAN" || u === "TINYINT(1)") return "NUMBER(1)";
    if (u.startsWith("VARCHAR")) return `VARCHAR2${t.slice(7) || "(255)"}`;
    if (u === "TEXT" || u === "LONGTEXT") return "CLOB";
    if (u.endsWith("BLOB") || u === "BYTEA") return "BLOB";
    if (u === "DATETIME" || u.startsWith("TIMESTAMP")) return "TIMESTAMP";
    if (u === "INTEGER" || u === "INT") return "NUMBER(10)";
    if (u === "BIGINT") return "NUMBER(19)";
    return t;
  }
  return t;
}

async function connectProfile(profile: ConnectionProfile): Promise<{ connId: string; databases: string[] }> {
  let connId: string;
  if (profile.type === "sqlite") {
    connId = await invoke<string>("connect_sqlite", { path: profile.filePath || ":memory:" });
  } else if (profile.type === "mysql") {
    connId = await invoke<string>("connect_mysql", { host: profile.host, port: profile.port, username: profile.username, password: profile.password, database: "" });
  } else if (profile.type === "postgres") {
    connId = await invoke<string>("connect_postgres", { host: profile.host, port: profile.port, username: profile.username, password: profile.password, database: "", sshHost: "", sshPort: 0, sshUser: "", sshPassword: "" });
  } else if (profile.type === "mssql") {
    connId = await invoke<string>("connect_mssql", { host: profile.host, port: profile.port, username: profile.username, password: profile.password, database: "" });
  } else {
    connId = await invoke<string>("connect_oracle", { host: profile.host, port: profile.port, service: profile.serviceName, username: profile.username, password: profile.password });
  }
  const databases = await invoke<string[]>("list_databases", { connId });
  return { connId, databases };
}

export default function MigrationWizard({ sessions, profiles, onClose }: Props) {
  const [step, setStep] = useState(1);
  const [srcProfileId, setSrcProfileId] = useState("");
  const [srcDb, setSrcDb] = useState("");
  const [srcTables, setSrcTables] = useState<TableInfo[]>([]);
  const [selectedTables, setSelectedTables] = useState<string[]>([]);
  const [tgtProfileId, setTgtProfileId] = useState("");
  const [tgtDb, setTgtDb] = useState("");
  const [tgtConnId, setTgtConnId] = useState<string | null>(null);
  const [tgtDatabases, setTgtDatabases] = useState<string[]>([]);
  const [connectingTgt, setConnectingTgt] = useState(false);
  const [tgtConnError, setTgtConnError] = useState<string | null>(null);
  const [tgtNewDbName, setTgtNewDbName] = useState("");
  const ownedTgtConnId = useRef<string | null>(null);

  const NEW_DB_SENTINEL = "__new__";
  const tgtDbIsNew = tgtDb === NEW_DB_SENTINEL;
  const [tableColumns, setTableColumns] = useState<Record<string, ColumnInfo[]>>({});
  const [typeMappings, setTypeMappings] = useState<Record<string, Record<string, string>>>({});
  const [loadingCols, setLoadingCols] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [migrating, setMigrating] = useState(false);
  const [done, setDone] = useState(false);
  const [tableProgress, setTableProgress] = useState<Record<string, number>>({});

  const connectedProfiles = profiles.filter(p => sessions[p.id]);
  const srcSession = sessions[srcProfileId];
  const srcProfile = profiles.find(p => p.id === srcProfileId);
  const tgtProfile = profiles.find(p => p.id === tgtProfileId);

  const inp = "w-full bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-2 py-1.5 text-xs focus:outline-none focus:border-blue-500 text-gray-800 dark:text-gray-200";

  // Auto-connect target when profile selected and not already in sessions
  useEffect(() => {
    setTgtDb("");
    setTgtConnError(null);
    if (!tgtProfileId) { setTgtConnId(null); setTgtDatabases([]); return; }
    const session = sessions[tgtProfileId];
    if (session) { setTgtConnId(session.connId); setTgtDatabases(session.databases); return; }
    const profile = profiles.find(p => p.id === tgtProfileId);
    if (!profile) return;
    setConnectingTgt(true);
    connectProfile(profile)
      .then(({ connId, databases }) => {
        ownedTgtConnId.current = connId;
        setTgtConnId(connId);
        setTgtDatabases(databases);
      })
      .catch(e => { setTgtConnError(String(e)); setTgtProfileId(""); setTgtConnId(null); setTgtDatabases([]); })
      .finally(() => setConnectingTgt(false));
  }, [tgtProfileId]);

  // Load tables when srcDb changes
  useEffect(() => {
    if (!srcSession || !srcDb) { setSrcTables([]); return; }
    invoke<TableInfo[]>("list_tables", { connId: srcSession.connId, database: srcDb })
      .then(t => setSrcTables(t.filter(x => x.table_type === "table")))
      .catch(() => setSrcTables([]));
    setSelectedTables([]);
  }, [srcProfileId, srcDb]);

  function toggleTable(name: string) {
    setSelectedTables(prev => prev.includes(name) ? prev.filter(t => t !== name) : [...prev, name]);
  }

  async function goToStep3() {
    if (!tgtConnId) return;
    const effectiveTgtDb = tgtDbIsNew ? tgtNewDbName.trim() : tgtDb;
    if (!effectiveTgtDb) return;
    setLoadingCols(true);
    try {
      if (tgtDbIsNew) {
        await invoke("create_database", { connId: tgtConnId, name: effectiveTgtDb, charset: null, collation: null });
        setTgtDb(effectiveTgtDb);
        setTgtDatabases(prev => [...prev, effectiveTgtDb]);
      }
      const cols: Record<string, ColumnInfo[]> = {};
      for (const tbl of selectedTables) {
        cols[tbl] = await invoke<ColumnInfo[]>("table_columns", { connId: srcSession.connId, table: tbl, database: srcDb });
      }
      setTableColumns(cols);
      const mappings: Record<string, Record<string, string>> = {};
      for (const tbl of selectedTables) {
        mappings[tbl] = {};
        for (const col of cols[tbl]) {
          mappings[tbl][col.name] = mapType(col.col_type, srcProfile!.type, tgtProfile!.type);
        }
      }
      setTypeMappings(mappings);
      setStep(3);
    } catch (e) {
      alert(`Failed to proceed: ${e}`);
    } finally {
      setLoadingCols(false);
    }
  }

  function addLog(msg: string) {
    setLog(prev => [...prev, msg]);
  }

  async function runMigration() {
    if (!srcSession || !tgtConnId) return;
    setMigrating(true);
    setDone(false);
    setLog([]);
    setTableProgress({});
    const BATCH = 500;

    for (const tbl of selectedTables) {
      addLog(`▶ Migrating table: ${tbl}`);
      try {
        const cols = tableColumns[tbl] ?? [];
        const colNames = cols.map(c => c.name);
        const createSQL = buildCreateSQL(tbl, cols, typeMappings[tbl] ?? {}, tgtProfile!.type);
        addLog(`  Creating table on target...`);
        await invoke("execute_query", { connId: tgtConnId, sql: createSQL });

        // Count rows
        const countRes = await invoke<QueryResult>("execute_query", {
          connId: srcSession.connId,
          sql: `SELECT COUNT(*) FROM ${qi(tbl, srcProfile!.type)}`,
        });
        const total = parseInt(countRes.rows?.[0]?.[0] ?? "0") || 0;
        addLog(`  ${total} rows to migrate`);

        if (total === 0) {
          setTableProgress(p => ({ ...p, [tbl]: 100 }));
          addLog(`  Done (0 rows)`);
          continue;
        }

        let offset = 0;
        let migrated = 0;
        while (offset < total) {
          const selSQL = buildSelectSQL(tbl, srcProfile!.type, BATCH, offset);
          const res = await invoke<QueryResult>("execute_query", { connId: srcSession.connId, sql: selSQL });
          const rows = res.rows ?? [];
          if (rows.length === 0) break;
          const insSQL = buildInsertSQL(tbl, colNames, rows, tgtProfile!.type);
          await invoke("execute_query", { connId: tgtConnId, sql: insSQL });
          migrated += rows.length;
          offset += rows.length;
          setTableProgress(p => ({ ...p, [tbl]: Math.round((migrated / total) * 100) }));
        }
        addLog(`  Done (${migrated} rows)`);
      } catch (e) {
        addLog(`  ERROR: ${e}`);
      }
    }
    setDone(true);
    setMigrating(false);
  }

  const steps = ["Source", "Target", "Types", "Execute"];

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-2xl w-[560px] max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-800 flex-shrink-0">
          <div className="flex items-center gap-2">
            <ArrowRightLeft size={16} className="text-purple-500" />
            <h3 className="font-semibold text-gray-800 dark:text-gray-100">Migrate Data</h3>
          </div>
          <button onClick={onClose}><X size={14} className="text-gray-400 hover:text-gray-600" /></button>
        </div>

        {/* Step indicator */}
        <div className="flex items-center gap-1 px-5 py-3 border-b border-gray-100 dark:border-gray-800 flex-shrink-0">
          {steps.map((s, i) => (
            <div key={s} className="flex items-center gap-1">
              <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-medium ${i + 1 < step ? "bg-green-500 text-white" : i + 1 === step ? "bg-purple-600 text-white" : "bg-gray-200 dark:bg-gray-700 text-gray-400"}`}>
                {i + 1 < step ? <Check size={10} /> : i + 1}
              </div>
              <span className={`text-xs ${i + 1 === step ? "text-gray-700 dark:text-gray-200" : "text-gray-400"}`}>{s}</span>
              {i < steps.length - 1 && <ChevronRight size={10} className="text-gray-300 mx-1" />}
            </div>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">
          {/* Step 1 - Source */}
          {step === 1 && (
            <div className="space-y-4">
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Source Connection</label>
                <select className={inp} value={srcProfileId} onChange={e => { setSrcProfileId(e.target.value); setSrcDb(""); }}>
                  <option value="">Select connection...</option>
                  {connectedProfiles.map(p => <option key={p.id} value={p.id}>{p.name} ({p.type})</option>)}
                </select>
              </div>
              {srcSession && (
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Source Database</label>
                  <select className={inp} value={srcDb} onChange={e => setSrcDb(e.target.value)}>
                    <option value="">Select database...</option>
                    {srcSession.databases.map(d => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>
              )}
              {srcTables.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs text-gray-500">Tables to migrate</label>
                    <button className="text-xs text-blue-500 hover:underline"
                      onClick={() => setSelectedTables(selectedTables.length === srcTables.length ? [] : srcTables.map(t => t.name))}>
                      {selectedTables.length === srcTables.length ? "Deselect all" : "Select all"}
                    </button>
                  </div>
                  <div className="border border-gray-200 dark:border-gray-700 rounded max-h-48 overflow-y-auto">
                    {srcTables.map(t => (
                      <label key={t.name} className="flex items-center gap-2 px-3 py-1.5 text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer border-b border-gray-100 dark:border-gray-800 last:border-0">
                        <input type="checkbox" checked={selectedTables.includes(t.name)} onChange={() => toggleTable(t.name)} />
                        <span className="font-mono">{t.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Step 2 - Target */}
          {step === 2 && (
            <div className="space-y-4">
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Target Connection</label>
                <select className={inp} value={tgtProfileId} onChange={e => setTgtProfileId(e.target.value)}>
                  <option value="">Select connection...</option>
                  {profiles.filter(p => p.id !== srcProfileId).map(p => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.type}){sessions[p.id] ? "" : " — not connected"}
                    </option>
                  ))}
                </select>
                {connectingTgt && (
                  <div className="flex items-center gap-1.5 mt-1.5 text-xs text-gray-400">
                    <Loader2 size={11} className="animate-spin" /> Connecting…
                  </div>
                )}
                {tgtConnError && <p className="text-xs text-red-500 mt-1">{tgtConnError}</p>}
              </div>
              {tgtConnId && (
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Target Database</label>
                  <select className={inp} value={tgtDb} onChange={e => { setTgtDb(e.target.value); setTgtNewDbName(""); }}>
                    <option value="">Select database...</option>
                    {tgtDatabases.map(d => <option key={d} value={d}>{d}</option>)}
                    <option value={NEW_DB_SENTINEL}>＋ Create new database…</option>
                  </select>
                  {tgtDbIsNew && (
                    <input
                      className={inp + " mt-2"}
                      placeholder="New database name"
                      value={tgtNewDbName}
                      onChange={e => setTgtNewDbName(e.target.value)}
                      autoFocus
                    />
                  )}
                </div>
              )}
              {tgtProfileId && tgtDb && srcProfile && tgtProfile && (!tgtDbIsNew || tgtNewDbName.trim()) && (
                <div className="bg-purple-50 dark:bg-purple-950/30 border border-purple-200 dark:border-purple-800 rounded p-3 text-xs text-purple-700 dark:text-purple-300">
                  Migrating {selectedTables.length} table(s) from <strong>{srcProfile.name}</strong> / {srcDb} ({srcProfile.type}) → <strong>{tgtProfile.name}</strong> / {tgtDbIsNew ? tgtNewDbName.trim() : tgtDb} ({tgtProfile.type}){tgtDbIsNew && " — will be created"}
                </div>
              )}
            </div>
          )}

          {/* Step 3 - Type Mapping */}
          {step === 3 && (
            <div className="space-y-4">
              <p className="text-xs text-gray-500">Review and adjust the type mappings. Types have been auto-mapped from <strong>{srcProfile?.type}</strong> to <strong>{tgtProfile?.type}</strong>.</p>
              {selectedTables.map(tbl => (
                <div key={tbl}>
                  <div className="text-xs font-semibold text-gray-700 dark:text-gray-200 mb-1 font-mono">{tbl}</div>
                  <div className="border border-gray-200 dark:border-gray-700 rounded overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-50 dark:bg-gray-800">
                        <tr>
                          <th className="px-3 py-1.5 text-left font-medium text-gray-500">Column</th>
                          <th className="px-3 py-1.5 text-left font-medium text-gray-500">Source Type</th>
                          <th className="px-3 py-1.5 text-left font-medium text-gray-500">Target Type</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(tableColumns[tbl] ?? []).map((col, i) => (
                          <tr key={col.name} className={i % 2 === 0 ? "bg-white dark:bg-gray-900" : "bg-gray-50/50 dark:bg-gray-900/50"}>
                            <td className="px-3 py-1.5 font-mono text-gray-700 dark:text-gray-300">{col.name}</td>
                            <td className="px-3 py-1.5 font-mono text-gray-500">{col.col_type}</td>
                            <td className="px-3 py-1.5">
                              <input
                                className="w-full bg-transparent border border-transparent hover:border-gray-300 dark:hover:border-gray-600 focus:border-blue-500 rounded px-1 py-0.5 font-mono text-xs text-gray-700 dark:text-gray-200 focus:outline-none"
                                value={typeMappings[tbl]?.[col.name] ?? ""}
                                onChange={e => setTypeMappings(m => ({
                                  ...m,
                                  [tbl]: { ...m[tbl], [col.name]: e.target.value },
                                }))}
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Step 4 - Execute */}
          {step === 4 && (
            <div className="space-y-4">
              {!migrating && !done && (
                <div className="text-center py-4">
                  <p className="text-sm text-gray-600 dark:text-gray-300 mb-1">Ready to migrate {selectedTables.length} table(s).</p>
                  <p className="text-xs text-gray-400">This will CREATE tables on the target (if not exists) and INSERT all rows.</p>
                </div>
              )}
              {(migrating || done) && (
                <>
                  <div className="space-y-2">
                    {selectedTables.map(tbl => (
                      <div key={tbl}>
                        <div className="flex items-center justify-between mb-0.5">
                          <span className="text-xs font-mono text-gray-600 dark:text-gray-300">{tbl}</span>
                          <span className="text-xs text-gray-400">{tableProgress[tbl] ?? 0}%</span>
                        </div>
                        <div className="h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-purple-500 rounded-full transition-all"
                            style={{ width: `${tableProgress[tbl] ?? 0}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="border border-gray-200 dark:border-gray-700 rounded p-3 max-h-48 overflow-y-auto bg-gray-50 dark:bg-gray-800">
                    {log.map((line, i) => (
                      <div key={i} className={`text-xs font-mono ${line.includes("ERROR") ? "text-red-500" : line.includes("▶") ? "text-purple-500 font-semibold" : "text-gray-600 dark:text-gray-400"}`}>{line}</div>
                    ))}
                    {migrating && <div className="text-xs font-mono text-gray-400 animate-pulse">...</div>}
                  </div>
                  {done && (
                    <div className="flex items-center gap-2 text-green-600 dark:text-green-400 text-sm">
                      <Check size={14} /> Migration complete!
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-gray-200 dark:border-gray-800 flex-shrink-0">
          <button
            onClick={() => step > 1 && !migrating ? setStep(s => s - 1) : onClose}
            className="px-3 py-1.5 text-xs bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded text-gray-700 dark:text-gray-200"
          >
            {step === 1 ? "Cancel" : done ? "Close" : "← Back"}
          </button>

          {step === 1 && (
            <button
              onClick={() => setStep(2)}
              disabled={!srcProfileId || !srcDb || selectedTables.length === 0}
              className="px-4 py-1.5 text-xs bg-purple-600 hover:bg-purple-700 text-white rounded disabled:opacity-50"
            >
              Next →
            </button>
          )}
          {step === 2 && (
            <button
              onClick={goToStep3}
              disabled={!tgtConnId || !tgtDb || (tgtDbIsNew && !tgtNewDbName.trim()) || loadingCols || connectingTgt}
              className="flex items-center gap-1.5 px-4 py-1.5 text-xs bg-purple-600 hover:bg-purple-700 text-white rounded disabled:opacity-50"
            >
              {loadingCols ? <Loader2 size={11} className="animate-spin" /> : null}
              {loadingCols ? "Loading…" : "Next →"}
            </button>
          )}
          {step === 3 && (
            <button
              onClick={() => setStep(4)}
              className="px-4 py-1.5 text-xs bg-purple-600 hover:bg-purple-700 text-white rounded"
            >
              Next →
            </button>
          )}
          {step === 4 && !done && (
            <button
              onClick={runMigration}
              disabled={migrating}
              className="flex items-center gap-1.5 px-4 py-1.5 text-xs bg-purple-600 hover:bg-purple-700 text-white rounded disabled:opacity-50"
            >
              {migrating ? <Loader2 size={11} className="animate-spin" /> : <ArrowRightLeft size={11} />}
              {migrating ? "Migrating…" : "Start Migration"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
