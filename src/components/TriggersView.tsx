import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Plus, X, Zap, ChevronDown, ChevronUp } from "lucide-react";
import { TriggerInfo } from "../types";

interface Props {
  connId: string;
  table: string;
  database: string;
  dbType: string;
}

export default function TriggersView({ connId, table, database, dbType }: Props) {
  const [triggers, setTriggers] = useState<TriggerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", event: "INSERT", timing: "AFTER", body: "" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<TriggerInfo[]>("table_triggers", { connId, table, database });
      setTriggers(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [connId, table, database]);

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    let sql: string;
    if (dbType === "sqlite") {
      sql = `CREATE TRIGGER "${form.name}" ${form.timing} ${form.event} ON "${table}" FOR EACH ROW BEGIN ${form.body} END`;
    } else if (dbType === "mysql") {
      sql = `CREATE TRIGGER \`${form.name}\` ${form.timing} ${form.event} ON \`${table}\` FOR EACH ROW BEGIN ${form.body} END`;
    } else {
      sql = `CREATE OR REPLACE TRIGGER "${form.name}" ${form.timing} ${form.event} ON "${table}" FOR EACH ROW BEGIN ${form.body} END`;
    }
    try {
      const r = await invoke<{ error: string | null }>("execute_query", { connId, sql });
      if (r.error) { setSaveError(r.error); } else { setShowModal(false); load(); }
    } catch (e) { setSaveError(String(e)); }
    setSaving(false);
  };

  const inp = "w-full bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-500 text-gray-800 dark:text-gray-200";

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200 dark:border-gray-800">
        <span className="text-xs font-medium text-gray-500">Triggers</span>
        <button onClick={() => { setSaveError(null); setForm({ name: "", event: "INSERT", timing: "AFTER", body: "" }); setShowModal(true); }}
          className="flex items-center gap-1 px-2 py-1 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded">
          <Plus size={12} /> Add Trigger
        </button>
      </div>

      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-xs text-gray-400">Loading...</div>
        ) : error ? (
          <div className="p-4 text-xs text-red-400">{error}</div>
        ) : triggers.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 gap-2">
            <Zap size={24} className="text-gray-300 dark:text-gray-600" />
            <p className="text-xs text-gray-400">No triggers defined</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {triggers.map((t, i) => (
              <div key={i} className={i % 2 === 0 ? "bg-white dark:bg-gray-900" : "bg-gray-50/50 dark:bg-gray-800/30"}>
                <button
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-left"
                  onClick={() => setExpanded(expanded === t.name ? null : t.name)}
                >
                  <Zap size={13} className="text-yellow-500 flex-shrink-0" />
                  <span className="flex-1 font-mono text-xs text-gray-700 dark:text-gray-300">{t.name}</span>
                  {t.timing && <span className="text-xs text-gray-400">{t.timing} {t.event}</span>}
                  {expanded === t.name ? <ChevronUp size={13} className="text-gray-400" /> : <ChevronDown size={13} className="text-gray-400" />}
                </button>
                {expanded === t.name && (
                  <pre className="px-4 pb-3 text-xs font-mono text-gray-600 dark:text-gray-400 overflow-x-auto whitespace-pre-wrap">{t.statement}</pre>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setShowModal(false)}>
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-5 w-[480px] shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-gray-800 dark:text-gray-100">Add Trigger</h3>
              <button onClick={() => setShowModal(false)}><X size={14} className="text-gray-400" /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Trigger Name</label>
                <input className={inp} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="trg_name" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Timing</label>
                  <select className={inp} value={form.timing} onChange={e => setForm(f => ({ ...f, timing: e.target.value }))}>
                    <option>BEFORE</option><option>AFTER</option><option>INSTEAD OF</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Event</label>
                  <select className={inp} value={form.event} onChange={e => setForm(f => ({ ...f, event: e.target.value }))}>
                    <option>INSERT</option><option>UPDATE</option><option>DELETE</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Body (SQL statements)</label>
                <textarea className={inp + " h-32 font-mono resize-none"} value={form.body} onChange={e => setForm(f => ({ ...f, body: e.target.value }))} placeholder="SET NEW.updated_at = NOW();" />
              </div>
              {saveError && <p className="text-xs text-red-500">{saveError}</p>}
            </div>
            <div className="flex gap-2 justify-end mt-4">
              <button onClick={() => setShowModal(false)} className="px-3 py-1.5 text-sm bg-gray-100 dark:bg-gray-700 rounded-lg text-gray-700 dark:text-gray-200">Cancel</button>
              <button onClick={save} disabled={saving || !form.name} className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg disabled:opacity-50">
                {saving ? "Creating..." : "Create Trigger"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
