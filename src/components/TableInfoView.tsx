import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { TableInfoData } from "../types";

interface Props {
  connId: string;
  table: string;
  database: string;
  dbType?: string;
}

export default function TableInfoView({ connId, table, database, dbType }: Props) {
  const [info, setInfo] = useState<TableInfoData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ddl, setDdl] = useState<string | null>(null);
  const [aiValue, setAiValue] = useState("");
  const [aiSaving, setAiSaving] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  const loadInfo = useCallback(() => {
    setLoading(true);
    setDdl(null);
    Promise.all([
      invoke<TableInfoData>("table_info", { connId, table, database }),
      invoke<string>("get_create_table_sql", { connId, table, database }),
    ])
      .then(([r, sql]) => { setInfo(r); setDdl(sql); setError(null); setAiValue(r.auto_increment ?? ""); })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [connId, table, database]);

  useEffect(() => { loadInfo(); }, [loadInfo]);

  const handleSetAI = async () => {
    const val = parseInt(aiValue);
    if (isNaN(val) || val < 1) { setAiError("Enter a valid positive number"); return; }
    setAiSaving(true);
    setAiError(null);
    try {
      await invoke("set_auto_increment", { connId, database, table, value: val });
      loadInfo();
    } catch (e) {
      setAiError(String(e));
    } finally {
      setAiSaving(false);
    }
  };

  const rows: [string, string][] = info ? [
    ["Table Name", table],
    ["Database", database],
    ["Row Count", info.row_count],
    ["Data Size", info.data_size],
    ["Index Size", info.index_size],
    ["Total Size", info.size],
    ["Auto Increment", info.auto_increment ?? "N/A"],
    ["Engine / Type", info.engine],
    ["Collation", info.collation],
    ["Created", info.created],
    ["Comment", info.comment || "—"],
  ] : [];

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-4 py-2 border-b border-gray-200 dark:border-gray-800">
        <span className="text-xs font-medium text-gray-500">Table Information</span>
      </div>
      <div className="flex-1 overflow-auto p-4">
        {loading ? (
          <div className="text-xs text-gray-400">Loading...</div>
        ) : error ? (
          <div className="text-xs text-red-400">{error}</div>
        ) : (
          <div className="max-w-2xl space-y-5">
            <table className="w-full text-xs border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden">
              <tbody>
                {rows.map(([label, value], i) => (
                  <tr key={label} className={i % 2 === 0 ? "bg-white dark:bg-gray-900" : "bg-gray-50 dark:bg-gray-800/40"}>
                    <td className="px-4 py-2.5 font-medium text-gray-500 dark:text-gray-400 w-40">{label}</td>
                    <td className="px-4 py-2.5 text-gray-800 dark:text-gray-200 font-mono">{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {dbType === "mysql" && info?.auto_increment !== null && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500 dark:text-gray-400">Set Auto Increment:</span>
                <input
                  type="number"
                  min={1}
                  value={aiValue}
                  onChange={e => setAiValue(e.target.value)}
                  className="w-28 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-500 text-gray-800 dark:text-gray-200"
                />
                <button
                  onClick={handleSetAI}
                  disabled={aiSaving}
                  className="px-3 py-1 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-50"
                >
                  {aiSaving ? "Saving..." : "Set"}
                </button>
                {aiError && <span className="text-xs text-red-500">{aiError}</span>}
              </div>
            )}

            {ddl && (
              <div>
                <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5 uppercase tracking-wider">Create Statement</div>
                <pre className="text-xs font-mono bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-3 whitespace-pre-wrap break-all text-gray-800 dark:text-gray-200 select-all">{ddl}</pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
