import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Plus, X, Link } from "lucide-react";
import { ForeignKeyInfo, ColumnInfo } from "../types";

interface Props {
  connId: string;
  table: string;
  database: string;
  dbType: string;
}

export default function RelationsView({ connId, table, database, dbType }: Props) {
  const [fks, setFks] = useState<ForeignKeyInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [form, setForm] = useState({ constraint_name: "", column_name: "", referenced_table: "", referenced_column: "" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<ForeignKeyInfo[]>("table_foreign_keys", { connId, table, database });
      setFks(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [connId, table, database]);

  const openModal = async () => {
    const cols = await invoke<ColumnInfo[]>("table_columns", { connId, table, database }).catch(() => []);
    setColumns(cols);
    setForm({ constraint_name: `fk_${table}_${Date.now()}`, column_name: cols[0]?.name ?? "", referenced_table: "", referenced_column: "" });
    setSaveError(null);
    setShowModal(true);
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    const q = dbType === "mysql"
      ? `ALTER TABLE \`${table}\` ADD CONSTRAINT \`${form.constraint_name}\` FOREIGN KEY (\`${form.column_name}\`) REFERENCES \`${form.referenced_table}\`(\`${form.referenced_column}\`)`
      : `ALTER TABLE "${table}" ADD CONSTRAINT "${form.constraint_name}" FOREIGN KEY ("${form.column_name}") REFERENCES "${form.referenced_table}"("${form.referenced_column}")`;
    try {
      const r = await invoke<{ error: string | null }>("execute_query", { connId, sql: q });
      if (r.error) { setSaveError(r.error); } else { setShowModal(false); load(); }
    } catch (e) { setSaveError(String(e)); }
    setSaving(false);
  };

  const inp = "w-full bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-500 text-gray-800 dark:text-gray-200";

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200 dark:border-gray-800">
        <span className="text-xs font-medium text-gray-500">Foreign Keys</span>
        <button onClick={openModal} className="flex items-center gap-1 px-2 py-1 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded">
          <Plus size={12} /> Add Relation
        </button>
      </div>

      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-xs text-gray-400">Loading...</div>
        ) : error ? (
          <div className="p-4 text-xs text-red-400">{error}</div>
        ) : fks.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 gap-2">
            <Link size={24} className="text-gray-300 dark:text-gray-600" />
            <p className="text-xs text-gray-400">No foreign keys defined</p>
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800">
              <tr>
                {["Constraint", "Column", "→ Referenced Table", "Referenced Column"].map(h => (
                  <th key={h} className="px-3 py-2 text-left font-medium text-gray-500 dark:text-gray-400">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {fks.map((fk, i) => (
                <tr key={i} className={i % 2 === 0 ? "bg-white dark:bg-gray-900" : "bg-gray-50/50 dark:bg-gray-800/30"}>
                  <td className="px-3 py-2 font-mono text-gray-700 dark:text-gray-300">{fk.constraint_name}</td>
                  <td className="px-3 py-2 text-gray-700 dark:text-gray-300">{fk.column_name}</td>
                  <td className="px-3 py-2 text-blue-600 dark:text-blue-400">{fk.referenced_table}</td>
                  <td className="px-3 py-2 text-gray-700 dark:text-gray-300">{fk.referenced_column}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setShowModal(false)}>
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-5 w-96 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-gray-800 dark:text-gray-100">Add Foreign Key</h3>
              <button onClick={() => setShowModal(false)}><X size={14} className="text-gray-400" /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Constraint Name</label>
                <input className={inp} value={form.constraint_name} onChange={e => setForm(f => ({ ...f, constraint_name: e.target.value }))} />
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Source Column</label>
                <select className={inp} value={form.column_name} onChange={e => setForm(f => ({ ...f, column_name: e.target.value }))}>
                  {columns.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Referenced Table</label>
                <input className={inp} value={form.referenced_table} onChange={e => setForm(f => ({ ...f, referenced_table: e.target.value }))} placeholder="other_table" />
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Referenced Column</label>
                <input className={inp} value={form.referenced_column} onChange={e => setForm(f => ({ ...f, referenced_column: e.target.value }))} placeholder="id" />
              </div>
              {saveError && <p className="text-xs text-red-500">{saveError}</p>}
            </div>
            <div className="flex gap-2 justify-end mt-4">
              <button onClick={() => setShowModal(false)} className="px-3 py-1.5 text-sm bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg text-gray-700 dark:text-gray-200">Cancel</button>
              <button onClick={save} disabled={saving || !form.referenced_table || !form.referenced_column} className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg disabled:opacity-50">
                {saving ? "Saving..." : "Add Constraint"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
