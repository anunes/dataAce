import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Plus, Minus, ChevronRight, ChevronDown, X } from "lucide-react";

interface MysqlUser {
  username: string;
  host: string;
}

interface MysqlSchemaPriv {
  schema: string;
  privilege_type: string;
}

interface MysqlResourceLimits {
  max_updates: number;
  max_connections: number;
  max_questions: number;
}

interface Props {
  connId: string;
  onClose: () => void;
}

type Tab = "general" | "global" | "schema" | "resources";

const GLOBAL_PRIV_GROUPS = [
  {
    label: "Database and Tables",
    privs: ["SELECT", "INSERT", "UPDATE", "DELETE", "REFERENCES", "CREATE", "DROP", "ALTER", "INDEX", "TRIGGER"],
  },
  {
    label: "Replication",
    privs: ["REPLICATION CLIENT", "REPLICATION SLAVE", "REPLICATION_SLAVE_ADMIN"],
  },
  {
    label: "Views and Procedures",
    privs: ["CREATE VIEW", "SHOW VIEW", "CREATE ROUTINE", "ALTER ROUTINE", "EXECUTE"],
  },
  {
    label: "Administration",
    privs: [
      "RELOAD", "SHUTDOWN", "FILE", "PROCESS", "SUPER",
      "CREATE TEMPORARY TABLES", "LOCK TABLES", "SHOW DATABASES",
      "CREATE USER", "GRANT OPTION", "SET_ANY_DEFINER", "EVENT",
      "CREATE TABLESPACE", "CREATE ROLE", "DROP ROLE",
      "BINLOG_ADMIN", "CONNECTION_ADMIN",
    ],
  },
];

const ALL_GLOBAL_PRIVS = GLOBAL_PRIV_GROUPS.flatMap(g => g.privs);

const SCHEMA_PRIVS = [
  "ALTER", "ALTER ROUTINE", "CREATE", "CREATE ROUTINE",
  "CREATE TEMPORARY TABLES", "CREATE VIEW", "DELETE", "DROP",
  "EVENT", "EXECUTE", "GRANT OPTION", "INDEX", "INSERT",
  "LOCK TABLES", "REFERENCES", "SELECT", "SHOW VIEW", "TRIGGER", "UPDATE",
];

export default function UserManagerModal({ connId, onClose }: Props) {
  const [users, setUsers] = useState<MysqlUser[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedUser, setSelectedUser] = useState<MysqlUser | null>(null);
  const [tab, setTab] = useState<Tab>("general");

  // General form
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  // Global privs
  const [globalPrivs, setGlobalPrivs] = useState<Set<string>>(new Set());

  // Schema privs: schema -> set of privs
  const [schemaPrivMap, setSchemaPrivMap] = useState<Record<string, Set<string>>>({});
  const [schemas, setSchemas] = useState<string[]>([]);
  const [selectedSchema, setSelectedSchema] = useState<string | null>(null);

  // Resources
  const [maxUpdates, setMaxUpdates] = useState(0);
  const [maxConnections, setMaxConnections] = useState(0);
  const [maxQuestions, setMaxQuestions] = useState(0);

  const [isNew, setIsNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const loadUsers = useCallback(async () => {
    try {
      const list = await invoke<MysqlUser[]>("mysql_list_users", { connId });
      setUsers(list);
    } catch (e) {
      setError(String(e));
    }
  }, [connId]);

  const loadSchemas = useCallback(async () => {
    try {
      const dbs = await invoke<string[]>("list_databases", { connId });
      setSchemas(dbs);
    } catch {}
  }, [connId]);

  useEffect(() => {
    loadUsers();
    loadSchemas();
  }, [loadUsers, loadSchemas]);

  const selectUser = useCallback(async (user: MysqlUser) => {
    setSelectedUser(user);
    setIsNew(false);
    setError(null);
    setPassword("");
    setLoading(true);
    try {
      const [privs, schemaPrivs, limits] = await Promise.all([
        invoke<string[]>("mysql_get_global_privs", { connId, username: user.username, host: user.host }),
        invoke<MysqlSchemaPriv[]>("mysql_get_schema_privs", { connId, username: user.username, host: user.host }),
        invoke<MysqlResourceLimits>("mysql_get_resource_limits", { connId, username: user.username, host: user.host }),
      ]);
      setUsername(user.username);
      setGlobalPrivs(new Set(privs));
      // Build schema priv map
      const map: Record<string, Set<string>> = {};
      for (const sp of schemaPrivs) {
        if (!map[sp.schema]) map[sp.schema] = new Set();
        map[sp.schema].add(sp.privilege_type);
      }
      setSchemaPrivMap(map);
      setMaxUpdates(limits.max_updates);
      setMaxConnections(limits.max_connections);
      setMaxQuestions(limits.max_questions);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [connId]);

  function startNewUser() {
    setSelectedUser(null);
    setIsNew(true);
    setUsername("");
    setPassword("");
    setGlobalPrivs(new Set());
    setSchemaPrivMap({});
    setMaxUpdates(0);
    setMaxConnections(0);
    setMaxQuestions(0);
    setError(null);
    setTab("general");
  }

  async function removeUser() {
    if (!selectedUser) return;
    if (!confirm(`Drop user '${selectedUser.username}'@'${selectedUser.host}'?`)) return;
    setSaving(true);
    setError(null);
    try {
      await invoke("mysql_drop_user", { connId, username: selectedUser.username, host: selectedUser.host });
      setSelectedUser(null);
      setIsNew(false);
      await loadUsers();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function apply() {
    setSaving(true);
    setError(null);
    try {
      if (isNew) {
        const host = "%";
        await invoke("mysql_create_user", { connId, username, host, password });
        await invoke("mysql_set_global_privs", { connId, username, host, privs: [...globalPrivs] });
        for (const [schema, privSet] of Object.entries(schemaPrivMap)) {
          if (privSet.size > 0) {
            await invoke("mysql_set_schema_privs", { connId, username, host, schema, privs: [...privSet] });
          }
        }
        await invoke("mysql_set_resource_limits", { connId, username, host, maxUpdates, maxConnections, maxQuestions });
        await loadUsers();
        setIsNew(false);
        setSelectedUser({ username, host });
      } else if (selectedUser) {
        if (password) {
          await invoke("mysql_set_password", { connId, username: selectedUser.username, host: selectedUser.host, password });
        }
        await invoke("mysql_set_global_privs", { connId, username: selectedUser.username, host: selectedUser.host, privs: [...globalPrivs] });
        for (const schema of schemas) {
          const privSet = schemaPrivMap[schema] ?? new Set<string>();
          await invoke("mysql_set_schema_privs", { connId, username: selectedUser.username, host: selectedUser.host, schema, privs: [...privSet] });
        }
        await invoke("mysql_set_resource_limits", { connId, username: selectedUser.username, host: selectedUser.host, maxUpdates, maxConnections, maxQuestions });
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  function toggleGlobalPriv(priv: string) {
    setGlobalPrivs(prev => {
      const next = new Set(prev);
      if (next.has(priv)) next.delete(priv); else next.add(priv);
      return next;
    });
  }

  function toggleSchemaPriv(priv: string) {
    if (!selectedSchema) return;
    setSchemaPrivMap(prev => {
      const next = { ...prev };
      const set = new Set(next[selectedSchema] ?? []);
      if (set.has(priv)) set.delete(priv); else set.add(priv);
      next[selectedSchema] = set;
      return next;
    });
  }

  // Group users by username for tree display
  const userGroups: Record<string, string[]> = {};
  for (const u of users) {
    if (!userGroups[u.username]) userGroups[u.username] = [];
    userGroups[u.username].push(u.host);
  }

  const hasSelection = isNew || selectedUser !== null;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-2xl flex overflow-hidden"
        style={{ width: 900, height: 600 }}
        onClick={e => e.stopPropagation()}
      >
        {/* Left panel — user list */}
        <div className="flex flex-col border-r border-gray-200 dark:border-gray-700" style={{ width: 200 }}>
          <div className="px-3 py-2 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Accounts</span>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
              <X size={13} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto py-1">
            {Object.entries(userGroups).map(([uname, hosts]) => {
              const isExpanded = expanded.has(uname);
              return (
                <div key={uname}>
                  <div
                    className="flex items-center gap-1 px-2 py-1 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800 text-sm text-gray-800 dark:text-gray-200"
                    onClick={() => {
                      const next = new Set(expanded);
                      if (isExpanded) next.delete(uname); else next.add(uname);
                      setExpanded(next);
                    }}
                  >
                    {isExpanded ? <ChevronDown size={12} className="text-gray-400 flex-shrink-0" /> : <ChevronRight size={12} className="text-gray-400 flex-shrink-0" />}
                    <span className="text-gray-500 dark:text-gray-400 mr-0.5">👤</span>
                    <span className="truncate">{uname}</span>
                  </div>
                  {isExpanded && hosts.map(host => {
                    const isSelected = selectedUser?.username === uname && selectedUser?.host === host;
                    return (
                      <div
                        key={host}
                        className={`flex items-center gap-1 pl-7 pr-2 py-1 cursor-pointer text-xs ${isSelected ? "bg-purple-600 text-white" : "hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-400"}`}
                        onClick={() => selectUser({ username: uname, host })}
                      >
                        <span>🌐</span>
                        <span>{host}</span>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
          {/* Bottom action bar */}
          <div className="flex items-center gap-1 px-2 py-2 border-t border-gray-200 dark:border-gray-700">
            <button
              onClick={startNewUser}
              className="w-7 h-7 flex items-center justify-center rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400"
              title="Add user"
            >
              <Plus size={14} />
            </button>
            <button
              onClick={removeUser}
              disabled={!selectedUser || saving}
              className="w-7 h-7 flex items-center justify-center rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 disabled:opacity-40"
              title="Remove user"
            >
              <Minus size={14} />
            </button>
          </div>
        </div>

        {/* Right panel */}
        <div className="flex flex-col flex-1 overflow-hidden">
          {/* Tabs */}
          <div className="flex border-b border-gray-200 dark:border-gray-700 px-4 pt-2 gap-1">
            {(["general", "global", "schema", "resources"] as Tab[]).map(t => (
              <button
                key={t}
                disabled={!hasSelection}
                onClick={() => setTab(t)}
                className={`px-4 py-1.5 text-xs rounded-t border ${tab === t && hasSelection
                  ? "border-gray-200 dark:border-gray-700 border-b-white dark:border-b-gray-900 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 font-medium"
                  : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 disabled:opacity-40"}`}
              >
                {t === "general" ? "General" : t === "global" ? "Global Privileges" : t === "schema" ? "Schema Privileges" : "Resources"}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-y-auto p-6">
            {!hasSelection && (
              <div className="flex items-center justify-center h-full text-gray-400 text-sm">
                Select a user or click + to add one
              </div>
            )}

            {hasSelection && loading && (
              <div className="flex items-center justify-center h-full text-gray-400 text-sm">Loading…</div>
            )}

            {hasSelection && !loading && tab === "general" && (
              <div className="max-w-sm">
                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-4">Login Information</div>
                <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4 flex flex-col gap-4">
                  <div className="flex items-center gap-3">
                    <label className="text-sm text-gray-600 dark:text-gray-400 w-24 text-right">Username:</label>
                    <input
                      type="text"
                      value={username}
                      onChange={e => setUsername(e.target.value)}
                      disabled={!isNew}
                      className="flex-1 px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 disabled:opacity-60"
                    />
                  </div>
                  <div className="flex items-center gap-3">
                    <label className="text-sm text-gray-600 dark:text-gray-400 w-24 text-right">Password:</label>
                    <input
                      type="password"
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      placeholder={isNew ? "" : "Leave blank to keep current"}
                      className="flex-1 px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder:text-gray-400"
                    />
                  </div>
                </div>
              </div>
            )}

            {hasSelection && !loading && tab === "global" && (
              <div>
                <div className="grid grid-cols-2 gap-6">
                  {GLOBAL_PRIV_GROUPS.map(group => (
                    <div key={group.label}>
                      <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">{group.label}</div>
                      <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 flex flex-col gap-1.5">
                        {group.privs.map(priv => (
                          <label key={priv} className="flex items-center gap-2 cursor-pointer select-none">
                            <input
                              type="checkbox"
                              checked={globalPrivs.has(priv)}
                              onChange={() => toggleGlobalPriv(priv)}
                              className="rounded accent-purple-600"
                            />
                            <span className="text-sm text-gray-700 dark:text-gray-300">{priv.charAt(0).toUpperCase() + priv.slice(1).toLowerCase().replace(/_/g, ' ')}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="flex gap-3 mt-4">
                  <button
                    onClick={() => setGlobalPrivs(new Set(ALL_GLOBAL_PRIVS))}
                    className="px-4 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300"
                  >
                    Check All
                  </button>
                  <button
                    onClick={() => setGlobalPrivs(new Set())}
                    className="px-4 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300"
                  >
                    Uncheck All
                  </button>
                </div>
              </div>
            )}

            {hasSelection && !loading && tab === "schema" && (
              <div className="flex gap-4 h-full">
                {/* Schemas column */}
                <div className="flex flex-col" style={{ width: 160 }}>
                  <div className="text-xs font-semibold text-gray-500 mb-2">Schemas</div>
                  <div className="flex-1 border border-gray-200 dark:border-gray-700 rounded overflow-y-auto bg-white dark:bg-gray-800">
                    {schemas.map(s => (
                      <div
                        key={s}
                        onClick={() => setSelectedSchema(s)}
                        className={`px-3 py-1.5 text-sm cursor-pointer ${selectedSchema === s ? "bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200" : "hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300"}`}
                      >
                        {s}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Privileges checkboxes */}
                <div className="flex flex-col flex-1">
                  <div className="text-xs font-semibold text-gray-500 mb-2">
                    {selectedSchema ? `Privileges for ${selectedSchema}` : "Privileges"}
                  </div>
                  <div className="flex-1 border border-gray-200 dark:border-gray-700 rounded overflow-y-auto bg-white dark:bg-gray-800 p-2">
                    {!selectedSchema ? (
                      <div className="flex items-center justify-center h-full text-xs text-gray-400">Select a schema</div>
                    ) : (
                      <div className="grid grid-cols-2 gap-1">
                        {SCHEMA_PRIVS.map(p => (
                          <label key={p} className="flex items-center gap-2 px-2 py-1 cursor-pointer select-none hover:bg-gray-50 dark:hover:bg-gray-700 rounded">
                            <input
                              type="checkbox"
                              checked={!!(schemaPrivMap[selectedSchema] ?? new Set()).has(p)}
                              onChange={() => toggleSchemaPriv(p)}
                              className="rounded accent-purple-600"
                            />
                            <span className="text-sm text-gray-700 dark:text-gray-300">{p.toLowerCase()}</span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {hasSelection && !loading && tab === "resources" && (
              <div className="max-w-sm">
                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-4">Resource Limits</div>
                <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4 flex flex-col gap-4">
                  {[
                    { label: "Max Updates:", value: maxUpdates, set: setMaxUpdates },
                    { label: "Max Connections:", value: maxConnections, set: setMaxConnections },
                    { label: "Max Questions:", value: maxQuestions, set: setMaxQuestions },
                  ].map(({ label, value, set }) => (
                    <div key={label} className="flex items-center gap-3">
                      <label className="text-sm text-gray-600 dark:text-gray-400 w-32 text-right">{label}</label>
                      <input
                        type="number"
                        min={0}
                        value={value}
                        onChange={e => set(Math.max(0, parseInt(e.target.value) || 0))}
                        className="w-32 px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Error */}
          {error && (
            <div className="px-6 py-2 text-xs text-red-500 bg-red-50 dark:bg-red-950/20 border-t border-red-200 dark:border-red-900">
              {error}
            </div>
          )}

          {/* Footer */}
          <div className="flex items-center justify-end gap-3 px-6 py-3 border-t border-gray-200 dark:border-gray-700">
            <button
              onClick={onClose}
              className="px-4 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300"
            >
              Cancel
            </button>
            <button
              onClick={apply}
              disabled={!hasSelection || saving || loading}
              className="px-5 py-1.5 text-sm bg-purple-600 hover:bg-purple-700 text-white rounded-lg disabled:opacity-50 font-medium"
            >
              {saving ? "Applying…" : "Apply"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
