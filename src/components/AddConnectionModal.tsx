import { useState } from "react";
import { ConnectionProfile, DbType, SshConfig } from "../types";
import { open } from "@tauri-apps/plugin-dialog";
import { X, Loader2, CheckCircle, AlertCircle, ChevronDown, ChevronRight } from "lucide-react";

const COLORS = ["blue", "green", "red", "orange", "purple", "gray"];
const COLOR_MAP: Record<string, string> = {
  blue: "#3b82f6", green: "#22c55e", red: "#ef4444",
  orange: "#f97316", purple: "#a855f7", gray: "#6b7280",
};

const DEFAULT_PORTS: Record<DbType, number> = {
  sqlite: 0, mysql: 3306, postgres: 5432, oracle: 1521, mssql: 1433,
};

function defaultProfile(): ConnectionProfile {
  return {
    id: crypto.randomUUID(),
    name: "",
    type: "mysql",
    color: "blue",
    filePath: "",
    host: "127.0.0.1",
    port: 3306,
    username: "root",
    password: "",
    database: "",
    serviceName: "",
    ssh: null,
    requireSsl: false,
    skipSslVerify: false,
  };
}

interface Props {
  profile: ConnectionProfile | null;
  onSave: (p: ConnectionProfile) => void;
  onClose: () => void;
  onTestConnection: (p: ConnectionProfile) => Promise<boolean>;
}

export default function AddConnectionModal({ profile, onSave, onClose, onTestConnection }: Props) {
  const [form, setForm] = useState<ConnectionProfile>(() => profile ? { ...profile } : defaultProfile());
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [testMessage, setTestMessage] = useState("");
  const [showSsh, setShowSsh] = useState(false);


  function set<K extends keyof ConnectionProfile>(key: K, value: ConnectionProfile[K]) {
    setForm(prev => ({ ...prev, [key]: value }));
  }

  function setSsh(field: keyof SshConfig, value: string | number) {
    setForm(prev => ({
      ...prev,
      ssh: { host: "", port: 22, user: "", password: "", ...(prev.ssh ?? {}), [field]: value },
    }));
  }

  async function browseFile() {
    const path = await open({ multiple: false, directory: false });
    if (typeof path === "string") {
      set("filePath", path);
      if (!form.name) set("name", path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "");
    }
  }

  async function handleTest() {
    setTestStatus("testing");
    try {
      const ok = await onTestConnection(form);
      setTestStatus(ok ? "success" : "error");
      setTestMessage(ok ? "Connected successfully" : "Connection failed");
    } catch (e) {
      setTestStatus("error");
      setTestMessage(String(e));
    }
  }

  function handleTypeChange(t: DbType) {
    setForm(prev => ({ ...prev, type: t, port: DEFAULT_PORTS[t] }));
    setTestStatus("idle");
  }

  function toggleSsh(enabled: boolean) {
    setShowSsh(enabled);
    setForm(prev => ({ ...prev, ssh: enabled ? { host: "", port: 22, user: "", password: "" } : null }));
  }

  const DB_TYPES: { type: DbType; label: string }[] = [
    { type: "sqlite", label: "SQLite" },
    { type: "mysql", label: "MySQL / MariaDB" },
    { type: "postgres", label: "PostgreSQL" },
    { type: "oracle", label: "Oracle" },
    { type: "mssql", label: "SQL Server" },
  ];

  const input = "w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-blue-500 text-gray-100";

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-[520px] max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <h2 className="font-semibold text-base">{profile ? "Edit Connection" : "New Connection"}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-100"><X size={16} /></button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Type toggle */}
          <div className="space-y-1">
            <div className="grid grid-cols-3 gap-1">
              {DB_TYPES.slice(0, 3).map(({ type, label }) => (
                <button
                  key={type}
                  onClick={() => handleTypeChange(type)}
                  className={`py-1.5 rounded-lg text-xs font-medium border ${form.type === type ? "bg-blue-600 border-blue-500 text-white" : "bg-gray-800 border-gray-700 text-gray-300 hover:bg-gray-750"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-1">
              {DB_TYPES.slice(3).map(({ type, label }) => (
                <button
                  key={type}
                  onClick={() => handleTypeChange(type)}
                  className={`py-1.5 rounded-lg text-xs font-medium border ${form.type === type ? "bg-blue-600 border-blue-500 text-white" : "bg-gray-800 border-gray-700 text-gray-300 hover:bg-gray-750"}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Name + color */}
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Name</label>
            <div className="flex gap-2">
              <input
                className={input + " flex-1"}
                value={form.name}
                onChange={e => set("name", e.target.value)}
                placeholder="My Connection"
              />
              <div className="flex gap-1 items-center">
                {COLORS.map(c => (
                  <button
                    key={c}
                    onClick={() => set("color", c)}
                    className={`w-5 h-5 rounded-full border-2 ${form.color === c ? "border-white" : "border-transparent"}`}
                    style={{ backgroundColor: COLOR_MAP[c] }}
                  />
                ))}
              </div>
            </div>
          </div>

          {form.type === "sqlite" ? (
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Database File</label>
              <div className="flex gap-2">
                <input
                  className={input + " flex-1"}
                  value={form.filePath}
                  onChange={e => set("filePath", e.target.value)}
                  placeholder="/path/to/database.db or leave empty for in-memory"
                />
                <button onClick={browseFile} className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm text-gray-200">
                  Browse
                </button>
              </div>
              <p className="text-xs text-gray-500 mt-1">Leave empty for an in-memory database</p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Host</label>
                  <input className={input} value={form.host} onChange={e => set("host", e.target.value)} placeholder="127.0.0.1" />
                </div>
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Port</label>
                  <input
                    type="number"
                    className={input}
                    value={form.port}
                    onChange={e => set("port", parseInt(e.target.value) || DEFAULT_PORTS[form.type])}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Username</label>
                  <input className={input} value={form.username} onChange={e => set("username", e.target.value)} placeholder="root" />
                </div>
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Password</label>
                  <input type="password" className={input} value={form.password} onChange={e => set("password", e.target.value)} />
                </div>
              </div>

              {form.type === "oracle" ? (
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Service Name</label>
                  <input className={input} value={form.serviceName} onChange={e => set("serviceName", e.target.value)} placeholder="ORCL" />
                </div>
              ) : (
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Default Database (optional)</label>
                  <input className={input} value={form.database} onChange={e => set("database", e.target.value)} placeholder="my_database" />
                </div>
              )}

              {/* SSH Tunnel (postgres + mysql only) */}
              {(form.type === "postgres" || form.type === "mysql") && (
                <div className="border border-gray-700 rounded-lg overflow-hidden">
                  <button
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-gray-300 hover:bg-gray-800 text-left"
                    onClick={() => toggleSsh(!showSsh)}
                  >
                    {showSsh ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    SSH Tunnel
                    {showSsh && <span className="ml-auto text-blue-400">enabled</span>}
                  </button>
                  {showSsh && (
                    <div className="px-3 pb-3 space-y-3 border-t border-gray-700 pt-3">
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="text-xs text-gray-400 mb-1 block">SSH Host</label>
                          <input
                            className={input}
                            value={form.ssh?.host ?? ""}
                            onChange={e => setSsh("host", e.target.value)}
                            placeholder="bastion.example.com"
                          />
                        </div>
                        <div>
                          <label className="text-xs text-gray-400 mb-1 block">SSH Port</label>
                          <input
                            type="number"
                            className={input}
                            value={form.ssh?.port ?? 22}
                            onChange={e => setSsh("port", parseInt(e.target.value) || 22)}
                          />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="text-xs text-gray-400 mb-1 block">SSH User</label>
                          <input
                            className={input}
                            value={form.ssh?.user ?? ""}
                            onChange={e => setSsh("user", e.target.value)}
                            placeholder="ubuntu"
                          />
                        </div>
                        <div>
                          <label className="text-xs text-gray-400 mb-1 block">SSH Password / Passphrase</label>
                          <input
                            type="password"
                            className={input}
                            value={form.ssh?.password ?? ""}
                            onChange={e => setSsh("password", e.target.value)}
                            placeholder="leave empty for key auth"
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Require SSL (mysql only) */}
              {form.type === "mysql" && (
                <div className="space-y-2">
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={form.requireSsl ?? false}
                      onChange={e => set("requireSsl", e.target.checked)}
                      className="w-4 h-4 rounded accent-blue-500"
                    />
                    <span className="text-xs text-gray-300">Require SSL</span>
                  </label>
                  {form.requireSsl && (
                    <label className="flex items-center gap-2 cursor-pointer select-none pl-6">
                      <input
                        type="checkbox"
                        checked={form.skipSslVerify ?? false}
                        onChange={e => set("skipSslVerify", e.target.checked)}
                        className="w-4 h-4 rounded accent-yellow-500"
                      />
                      <span className="text-xs text-gray-400">Skip SSL certificate verification</span>
                    </label>
                  )}
                </div>
              )}
            </>
          )}

          {testStatus !== "idle" && (
            <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${testStatus === "success" ? "bg-green-900/40 text-green-300" : testStatus === "error" ? "bg-red-900/40 text-red-300" : "bg-gray-800 text-gray-300"}`}>
              {testStatus === "testing" && <Loader2 size={14} className="animate-spin" />}
              {testStatus === "success" && <CheckCircle size={14} />}
              {testStatus === "error" && <AlertCircle size={14} />}
              {testStatus === "testing" ? "Testing connection..." : testMessage}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between px-5 py-4 border-t border-gray-800">
          <button
            onClick={handleTest}
            disabled={testStatus === "testing"}
            className="px-3 py-1.5 text-sm bg-gray-700 hover:bg-gray-600 rounded-lg disabled:opacity-50 text-gray-200"
          >
            Test Connection
          </button>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-sm bg-gray-800 hover:bg-gray-700 rounded-lg text-gray-200">
              Cancel
            </button>
            <button
              onClick={() => onSave(form)}
              disabled={!form.name.trim()}
              className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-50 text-white"
            >
              {profile ? "Save" : "Add Connection"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
