import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { X, Database, ChevronRight, Check } from "lucide-react";
import { ConnectionProfile } from "../types";

interface Props {
  onClose: () => void;
  onCreated: (profile: ConnectionProfile, connId: string, dbName: string) => void;
}

const DB_TYPES = [
  { type: "mysql" as const, label: "MySQL", defaultPort: 3306 },
  { type: "postgres" as const, label: "PostgreSQL", defaultPort: 5432 },
  { type: "mssql" as const, label: "SQL Server", defaultPort: 1433 },
  { type: "sqlite" as const, label: "SQLite", defaultPort: 0 },
  { type: "oracle" as const, label: "Oracle", defaultPort: 1521 },
];

type DbType = "mysql" | "postgres" | "mssql" | "sqlite" | "oracle";

export default function CreateDatabaseWizard({ onClose, onCreated }: Props) {
  const [step, setStep] = useState(1);
  const [dbType, setDbType] = useState<DbType>("mysql");
  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState(3306);
  const [username, setUsername] = useState("root");
  const [password, setPassword] = useState("");
  const [serviceName, setServiceName] = useState("");
  const [dbName, setDbName] = useState("");
  const [sqliteDbName, setSqliteDbName] = useState("");
  const [sqliteDir, setSqliteDir] = useState("");
  const [connId, setConnId] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [charset, setCharset] = useState("utf8mb4");
  const [collation, setCollation] = useState("utf8mb4_0900_ai_ci");

  const charsetCollations: Record<string, string[]> = {
    utf8mb4: ["utf8mb4_0900_ai_ci", "utf8mb4_unicode_ci", "utf8mb4_general_ci"],
    utf8: ["utf8_general_ci", "utf8_unicode_ci"],
    latin1: ["latin1_swedish_ci", "latin1_general_ci"],
    ascii: ["ascii_general_ci"],
  };

  const inp = "w-full bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-2 py-1.5 text-xs focus:outline-none focus:border-blue-500 text-gray-800 dark:text-gray-200";

  const isSqlite = dbType === "sqlite";

  async function browseDir() {
    try {
      const result = await open({ directory: true, multiple: false });
      if (typeof result === "string") setSqliteDir(result);
    } catch {}
  }

  const connect = async () => {
    setConnecting(true);
    setError(null);
    try {
      if (isSqlite) {
        const name = sqliteDbName.trim();
        const dir = sqliteDir.trim();
        const path = name && dir ? `${dir}/${name}.db` : ":memory:";
        const id = await invoke<string>("connect_sqlite", { path });
        const displayName = name || "memory";
        const profile: ConnectionProfile = {
          id: crypto.randomUUID(),
          name: displayName,
          type: "sqlite",
          color: "green",
          filePath: path,
          host: "", port: 0, username: "", password: "",
          database: "", serviceName: "", ssh: null, requireSsl: false, skipSslVerify: false,
        };
        onCreated(profile, id, displayName);
        return;
      }

      let id: string;
      if (dbType === "mysql") {
        id = await invoke<string>("connect_mysql", { host, port, username, password, database: "", sshHost: "", sshPort: 0, sshUser: "", sshPassword: "", requireSsl: false, skipSslVerify: false });
      } else if (dbType === "postgres") {
        id = await invoke<string>("connect_postgres", {
          host, port, username, password, database: "",
          sshHost: "", sshPort: 0, sshUser: "", sshPassword: "",
        });
      } else if (dbType === "mssql") {
        id = await invoke<string>("connect_mssql", { host, port, username, password, database: "" });
      } else {
        // oracle
        id = await invoke<string>("connect_oracle", { host, port, service: serviceName, username, password });
      }
      setConnId(id);
      setStep(2);
    } catch (e) {
      setError(String(e));
    } finally {
      setConnecting(false);
    }
  };

  const createDb = async () => {
    setCreating(true);
    setError(null);
    try {
      await invoke("create_database", {
        connId, name: dbName,
        charset: dbType === "mysql" ? charset : null,
        collation: dbType === "mysql" ? collation : null,
      });
      const profile: ConnectionProfile = {
        id: crypto.randomUUID(),
        name: `${dbName} (${dbType})`,
        type: dbType as ConnectionProfile["type"],
        color: "blue",
        filePath: "",
        host, port, username, password, database: dbName,
        serviceName: dbType === "oracle" ? serviceName : "",
        ssh: null, requireSsl: false, skipSslVerify: false,
      };
      onCreated(profile, connId, dbName);
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-6 w-96 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Database size={16} className="text-blue-500" />
            <h3 className="font-semibold text-gray-800 dark:text-gray-100">New Database</h3>
          </div>
          <button onClick={onClose}><X size={14} className="text-gray-400 hover:text-gray-600" /></button>
        </div>

        {!isSqlite && (
          <div className="flex items-center gap-2 mb-5">
            {[1, 2].map(s => (
              <div key={s} className="flex items-center gap-2">
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium ${s < step ? "bg-green-500 text-white" : s === step ? "bg-blue-600 text-white" : "bg-gray-200 dark:bg-gray-700 text-gray-400"}`}>
                  {s < step ? <Check size={12} /> : s}
                </div>
                <span className="text-xs text-gray-400">{s === 1 ? "Connection" : "Database"}</span>
                {s < 2 && <ChevronRight size={12} className="text-gray-300" />}
              </div>
            ))}
          </div>
        )}

        {step === 1 ? (
          <div className="space-y-3">
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Database Type</label>
              <div className="space-y-1">
                <div className="grid grid-cols-3 gap-1">
                  {DB_TYPES.slice(0, 3).map(t => (
                    <button key={t.type} onClick={() => { setDbType(t.type); setPort(t.defaultPort); }}
                      className={`px-2 py-1.5 text-xs rounded border ${dbType === t.type ? "border-blue-500 bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400" : "border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-gray-300"}`}>
                      {t.label}
                    </button>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-1">
                  {DB_TYPES.slice(3).map(t => (
                    <button key={t.type} onClick={() => { setDbType(t.type); setPort(t.defaultPort); }}
                      className={`px-2 py-1.5 text-xs rounded border ${dbType === t.type ? "border-blue-500 bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400" : "border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-gray-300"}`}>
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {isSqlite ? (
              <>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Database Name</label>
                  <input
                    className={inp}
                    value={sqliteDbName}
                    onChange={e => setSqliteDbName(e.target.value)}
                    placeholder="my_database"
                    autoFocus
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Save Location</label>
                  <div className="flex gap-2">
                    <input
                      className={inp + " flex-1"}
                      value={sqliteDir}
                      onChange={e => setSqliteDir(e.target.value)}
                      placeholder="/path/to/folder"
                    />
                    <button
                      onClick={browseDir}
                      className="px-2 py-1.5 text-xs bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 flex-shrink-0"
                    >
                      Browse…
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="grid grid-cols-3 gap-2">
                  <div className="col-span-2">
                    <label className="text-xs text-gray-500 mb-1 block">Host</label>
                    <input className={inp} value={host} onChange={e => setHost(e.target.value)} />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Port</label>
                    <input className={inp} type="number" value={port} onChange={e => setPort(+e.target.value)} />
                  </div>
                </div>
                {dbType === "oracle" && (
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Service Name</label>
                    <input className={inp} value={serviceName} onChange={e => setServiceName(e.target.value)} placeholder="ORCL" />
                  </div>
                )}
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Username</label>
                  <input className={inp} value={username} onChange={e => setUsername(e.target.value)} />
                </div>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Password</label>
                  <input className={inp} type="password" value={password} onChange={e => setPassword(e.target.value)} />
                </div>
              </>
            )}

            {error && <p className="text-xs text-red-500">{error}</p>}
            <div className="flex gap-2 justify-end pt-1">
              <button onClick={onClose} className="px-3 py-1.5 text-sm bg-gray-100 dark:bg-gray-700 rounded-lg text-gray-700 dark:text-gray-200">Cancel</button>
              <button onClick={connect} disabled={connecting || (isSqlite ? !sqliteDbName.trim() : (!host || !username))}
                className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg disabled:opacity-50">
                {connecting ? "Connecting..." : isSqlite ? "Connect" : "Test & Continue →"}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <label className="text-xs text-gray-500 mb-1 block">New Database Name</label>
              <input
                className={inp}
                autoFocus
                value={dbName}
                onChange={e => setDbName(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && dbName.trim()) createDb(); }}
                placeholder="my_database"
              />
            </div>
            {dbType === "mysql" && (
              <>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Character Set</label>
                  <select
                    className={inp}
                    value={charset}
                    onChange={e => { setCharset(e.target.value); setCollation(charsetCollations[e.target.value][0]); }}
                  >
                    {Object.keys(charsetCollations).map(cs => (
                      <option key={cs} value={cs}>{cs}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Collation</label>
                  <select
                    className={inp}
                    value={collation}
                    onChange={e => setCollation(e.target.value)}
                  >
                    {(charsetCollations[charset] ?? []).map(col => (
                      <option key={col} value={col}>{col}</option>
                    ))}
                  </select>
                </div>
              </>
            )}
            {error && <p className="text-xs text-red-500">{error}</p>}
            <div className="flex gap-2 justify-end pt-1">
              <button onClick={() => { setStep(1); setError(null); }} className="px-3 py-1.5 text-sm bg-gray-100 dark:bg-gray-700 rounded-lg text-gray-700 dark:text-gray-200">← Back</button>
              <button onClick={createDb} disabled={creating || !dbName.trim()}
                className="px-3 py-1.5 text-sm bg-green-600 hover:bg-green-700 text-white rounded-lg disabled:opacity-50">
                {creating ? "Creating..." : "Create Database"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
