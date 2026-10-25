import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ColumnInfo, IndexInfo, DbType } from "../types";
import { Loader2, Key, Plus, Pencil, Trash2, X, Check } from "lucide-react";

interface Props {
  connId: string;
  table: string;
  database: string;
  dbType: DbType;
}

interface ColForm {
  name: string;
  col_type: string;
  nullable: boolean;
  default_value: string;
  after_column: string;
  extra: string;
  charset: string;
  collation: string;
  comment: string;
}

const emptyForm = (): ColForm => ({
  name: "", col_type: "", nullable: true, default_value: "",
  after_column: "", extra: "", charset: "", collation: "", comment: "",
});

interface IndexForm {
  name: string;
  unique: boolean;
  columns: string[];
  indexType: string;
}

type ModalMode = "add" | "edit" | "delete" | null;

export default function StructureView({ connId, table, database, dbType }: Props) {
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [indexes, setIndexes] = useState<IndexInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [modal, setModal] = useState<ModalMode>(null);
  const [editTarget, setEditTarget] = useState<ColumnInfo | null>(null);
  const [form, setForm] = useState<ColForm>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  const [indexModal, setIndexModal] = useState<"add" | null>(null);
  const [indexForm, setIndexForm] = useState<IndexForm>({ name: "", unique: false, columns: [], indexType: "BTREE" });
  const [indexModalError, setIndexModalError] = useState<string | null>(null);
  const [indexSaving, setIndexSaving] = useState(false);

  function loadSchema() {
    if (!table || !database) return;
    setIsLoading(true);
    setError(null);
    Promise.all([
      invoke<ColumnInfo[]>("table_columns", { connId, table, database }),
      invoke<IndexInfo[]>("table_indexes", { connId, table, database }),
    ]).then(([cols, idxs]) => {
      setColumns(cols);
      setIndexes(idxs);
    }).catch(e => setError(String(e)))
      .finally(() => setIsLoading(false));
  }

  useEffect(() => { loadSchema(); }, [connId, table, database]);

  function openAdd() {
    setForm(emptyForm());
    setModalError(null);
    setEditTarget(null);
    setModal("add");
  }

  function openEdit(col: ColumnInfo) {
    setForm({
      name: col.name,
      col_type: col.col_type,
      nullable: col.nullable,
      default_value: col.default_value ?? "",
      after_column: "",
      extra: col.extra,
      charset: col.charset,
      collation: col.collation,
      comment: col.comment,
    });
    setModalError(null);
    setEditTarget(col);
    setModal("edit");
  }

  function openDelete(col: ColumnInfo) {
    setEditTarget(col);
    setModalError(null);
    setModal("delete");
  }

  function closeModal() {
    setModal(null);
    setEditTarget(null);
    setModalError(null);
  }

  async function handleSave() {
    setSaving(true);
    setModalError(null);
    try {
      if (modal === "add") {
        await invoke("add_column", {
          connId, database, table,
          colName: form.name.trim(),
          colType: form.col_type.trim(),
          nullable: form.nullable,
          defaultValue: form.default_value.trim() || null,
          afterColumn: form.after_column || null,
          extra: form.extra || null,
          charset: form.charset || null,
          collation: form.collation || null,
          comment: form.comment || null,
        });
      } else if (modal === "edit" && editTarget) {
        await invoke("alter_column", {
          connId, database, table,
          oldName: editTarget.name,
          newName: form.name.trim(),
          colType: form.col_type.trim(),
          nullable: form.nullable,
          defaultValue: form.default_value.trim() || null,
          extra: form.extra || null,
          charset: form.charset || null,
          collation: form.collation || null,
          comment: form.comment || null,
        });
      }
      closeModal();
      loadSchema();
    } catch (e) {
      setModalError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!editTarget) return;
    setSaving(true);
    setModalError(null);
    try {
      await invoke("drop_column", { connId, database, table, colName: editTarget.name });
      closeModal();
      loadSchema();
    } catch (e) {
      setModalError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleCreateIndex() {
    if (!indexForm.name.trim() || indexForm.columns.length === 0) {
      setIndexModalError("Index name and at least one column are required");
      return;
    }
    setIndexSaving(true);
    setIndexModalError(null);
    try {
      await invoke("create_index", {
        connId, database, table,
        indexName: indexForm.name.trim(),
        columns: indexForm.columns,
        unique: indexForm.unique,
        indexType: indexForm.indexType,
      });
      setIndexModal(null);
      loadSchema();
    } catch (e) {
      setIndexModalError(String(e));
    } finally {
      setIndexSaving(false);
    }
  }

  async function handleDropIndex(indexName: string) {
    try {
      await invoke("drop_index", { connId, database, table, indexName });
      loadSchema();
    } catch (e) {
      setError(String(e));
    }
  }

  function toggleIndexColumn(col: string) {
    setIndexForm(f => ({
      ...f,
      columns: f.columns.includes(col) ? f.columns.filter(c => c !== col) : [...f.columns, col],
    }));
  }

  const canEdit = dbType !== "sqlite";
  const showCharset = columns.some(c => c.charset);
  const showCollation = columns.some(c => c.collation);
  const showComment = columns.some(c => c.comment);

  if (isLoading) return (
    <div className="flex items-center justify-center h-full">
      <Loader2 size={20} className="animate-spin text-gray-400" />
    </div>
  );
  if (error) return <div className="p-4 text-red-500 text-sm">{error}</div>;

  function keyColor(key: string) {
    if (key === "PRI") return "text-orange-500";
    if (key === "UNI") return "text-blue-500";
    if (key === "MUL") return "text-purple-500";
    return "text-gray-400";
  }

  const inp = "w-full bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-2 py-1.5 text-xs focus:outline-none focus:border-blue-500 text-gray-800 dark:text-gray-200";
  const thTd = "px-3 py-2 border-b border-gray-100 dark:border-gray-800/50";
  const thead = "bg-gray-100 dark:bg-gray-950";
  const thClass = `text-left ${thTd} font-medium text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-800`;
  const tableWrap = "border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden";
  const evenRow = "bg-white dark:bg-gray-900";
  const oddRow  = "bg-gray-50/50 dark:bg-gray-900/50";

  return (
    <div className="flex flex-col h-full overflow-auto p-4 gap-6">
      {/* Columns */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Columns</h3>
          <button
            onClick={openAdd}
            className="flex items-center gap-1 px-2 py-1 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded"
          >
            <Plus size={11} /> Add Column
          </button>
        </div>
        <div className={tableWrap}>
          <table className="w-full text-xs">
            <thead className={thead}>
              <tr>
                {["Name", "Type", "Nullable", "Key", "Default", "Extra",
                  ...(showCharset ? ["Charset"] : []),
                  ...(showCollation ? ["Collation"] : []),
                  ...(showComment ? ["Comment"] : []),
                  ""].map(h => (
                  <th key={h} className={thClass}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {columns.map((col, i) => {
                const isPK = col.key_type === "PRI";
                return (
                  <tr key={col.name} className={i % 2 === 0 ? evenRow : oddRow}>
                    <td className={thTd}>
                      <div className="flex items-center gap-1.5">
                        {isPK && <Key size={10} className="text-orange-400" />}
                        <span className={isPK ? "font-semibold text-orange-500 dark:text-orange-300" : "text-gray-800 dark:text-gray-200"}>{col.name}</span>
                      </div>
                    </td>
                    <td className={`${thTd} font-mono text-gray-600 dark:text-gray-300`}>{col.col_type}</td>
                    <td className={`${thTd} ${!col.nullable ? "text-red-500" : "text-gray-400"}`}>
                      {col.nullable ? "YES" : "NO"}
                    </td>
                    <td className={`${thTd} font-medium ${keyColor(col.key_type)}`}>
                      {col.key_type || "—"}
                    </td>
                    <td className={`${thTd} text-gray-500 font-mono`}>
                      {col.default_value ?? <span className="text-gray-300 dark:text-gray-600">NULL</span>}
                    </td>
                    <td className={`${thTd} ${col.extra ? "text-purple-500" : "text-gray-300 dark:text-gray-600"}`}>
                      {col.extra || "—"}
                    </td>
                    {showCharset && <td className={`${thTd} text-gray-500 font-mono`}>{col.charset || "—"}</td>}
                    {showCollation && <td className={`${thTd} text-gray-500 font-mono`}>{col.collation || "—"}</td>}
                    {showComment && <td className={`${thTd} text-gray-500`}>{col.comment || "—"}</td>}
                    <td className={`${thTd} text-right`}>
                      <div className="flex items-center justify-end gap-1">
                        {canEdit && (
                          <button
                            onClick={() => openEdit(col)}
                            className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-400 hover:text-blue-500"
                            title="Edit column"
                          >
                            <Pencil size={11} />
                          </button>
                        )}
                        <button
                          onClick={() => openDelete(col)}
                          className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-400 hover:text-red-500"
                          title="Drop column"
                        >
                          <Trash2 size={11} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Indexes */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Indexes</h3>
          <button
            onClick={() => { setIndexForm({ name: "", unique: false, columns: [], indexType: "BTREE" }); setIndexModalError(null); setIndexModal("add"); }}
            className="flex items-center gap-1 px-2 py-1 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded"
          >
            <Plus size={11} /> Add Index
          </button>
        </div>
        {indexes.length === 0 ? (
          <p className="text-xs text-gray-400">No indexes found</p>
        ) : (
          <div className={tableWrap}>
            <table className="w-full text-xs">
              <thead className={thead}>
                <tr>
                  {["Name", "Columns", "Unique", "Type", ""].map(h => (
                    <th key={h} className={thClass}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {indexes.map((idx, i) => (
                  <tr key={idx.name} className={i % 2 === 0 ? evenRow : oddRow}>
                    <td className={`${thTd} text-gray-800 dark:text-gray-200`}>{idx.name}</td>
                    <td className={`${thTd} text-gray-600 dark:text-gray-300 font-mono`}>{idx.columns.join(", ")}</td>
                    <td className={`${thTd} ${idx.unique ? "text-green-500" : "text-gray-400"}`}>
                      {idx.unique ? "YES" : "NO"}
                    </td>
                    <td className={`${thTd} text-gray-500`}>{idx.index_type}</td>
                    <td className={`${thTd} text-right`}>
                      <button
                        onClick={() => handleDropIndex(idx.name)}
                        className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-400 hover:text-red-500"
                        title="Drop index"
                      >
                        <Trash2 size={11} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Column Modal */}
      {modal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={closeModal}>
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-5 w-96 shadow-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">
                {modal === "add" ? "Add Column" : modal === "edit" ? "Edit Column" : "Drop Column"}
              </span>
              <button onClick={closeModal}><X size={14} className="text-gray-400 hover:text-gray-600" /></button>
            </div>

            {modal === "delete" ? (
              <div className="space-y-4">
                <p className="text-xs text-gray-600 dark:text-gray-300">
                  Drop column <span className="font-mono font-semibold text-red-500">{editTarget?.name}</span>? This cannot be undone.
                </p>
                {modalError && <p className="text-xs text-red-500">{modalError}</p>}
                <div className="flex gap-2 justify-end">
                  <button onClick={closeModal} className="px-3 py-1.5 text-xs bg-gray-100 dark:bg-gray-700 rounded text-gray-700 dark:text-gray-200">Cancel</button>
                  <button onClick={handleDelete} disabled={saving} className="px-3 py-1.5 text-xs bg-red-600 hover:bg-red-700 text-white rounded disabled:opacity-50">
                    {saving ? "Dropping…" : "Drop Column"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Column Name</label>
                  <input className={inp} autoFocus value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="column_name" />
                </div>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Data Type</label>
                  <input className={inp} value={form.col_type} onChange={e => setForm(f => ({ ...f, col_type: e.target.value }))} placeholder="VARCHAR(255)" />
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => setForm(f => ({ ...f, nullable: !f.nullable }))}
                    className={`w-8 h-4 rounded-full transition-colors flex-shrink-0 ${form.nullable ? "bg-blue-500" : "bg-gray-300 dark:bg-gray-600"}`}>
                    <div className={`w-3 h-3 rounded-full bg-white mx-0.5 transition-transform ${form.nullable ? "translate-x-4" : "translate-x-0"}`} />
                  </button>
                  <span className="text-xs text-gray-600 dark:text-gray-300">Nullable</span>
                </div>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Default Value <span className="text-gray-400">(optional)</span></label>
                  <input className={inp} value={form.default_value} onChange={e => setForm(f => ({ ...f, default_value: e.target.value }))} placeholder="Leave empty for none" />
                </div>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Extra</label>
                  <select className={inp} value={form.extra} onChange={e => setForm(f => ({ ...f, extra: e.target.value }))}>
                    <option value="">None</option>
                    <option value="AUTO_INCREMENT">AUTO_INCREMENT</option>
                    <option value="ON UPDATE CURRENT_TIMESTAMP">ON UPDATE CURRENT_TIMESTAMP</option>
                  </select>
                </div>
                {dbType === "mysql" && (
                  <>
                    <div>
                      <label className="text-xs text-gray-500 mb-1 block">Character Set <span className="text-gray-400">(optional)</span></label>
                      <input className={inp} value={form.charset} onChange={e => setForm(f => ({ ...f, charset: e.target.value }))} placeholder="utf8mb4" />
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 mb-1 block">Collation <span className="text-gray-400">(optional)</span></label>
                      <input className={inp} value={form.collation} onChange={e => setForm(f => ({ ...f, collation: e.target.value }))} placeholder="utf8mb4_0900_ai_ci" />
                    </div>
                  </>
                )}
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Comment <span className="text-gray-400">(optional)</span></label>
                  <input className={inp} value={form.comment} onChange={e => setForm(f => ({ ...f, comment: e.target.value }))} placeholder="Column description" />
                </div>
                {modal === "add" && dbType === "mysql" && (
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Position</label>
                    <select className={inp} value={form.after_column} onChange={e => setForm(f => ({ ...f, after_column: e.target.value }))}>
                      <option value="">Last (default)</option>
                      <option value="__FIRST__">First</option>
                      {columns.map(c => <option key={c.name} value={c.name}>After: {c.name}</option>)}
                    </select>
                  </div>
                )}
                {modalError && <p className="text-xs text-red-500">{modalError}</p>}
                <div className="flex gap-2 justify-end pt-1">
                  <button onClick={closeModal} className="px-3 py-1.5 text-xs bg-gray-100 dark:bg-gray-700 rounded text-gray-700 dark:text-gray-200">Cancel</button>
                  <button onClick={handleSave} disabled={saving || !form.name.trim() || !form.col_type.trim()}
                    className="flex items-center gap-1 px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-50">
                    {saving ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
                    {saving ? "Saving…" : modal === "add" ? "Add Column" : "Save Changes"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Index Modal */}
      {indexModal === "add" && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setIndexModal(null)}>
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-5 w-80 shadow-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">Add Index</span>
              <button onClick={() => setIndexModal(null)}><X size={14} className="text-gray-400 hover:text-gray-600" /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Index Name</label>
                <input className={inp} autoFocus value={indexForm.name} onChange={e => setIndexForm(f => ({ ...f, name: e.target.value }))} placeholder="idx_column_name" />
              </div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => setIndexForm(f => ({ ...f, unique: !f.unique }))}
                  className={`w-8 h-4 rounded-full transition-colors flex-shrink-0 ${indexForm.unique ? "bg-blue-500" : "bg-gray-300 dark:bg-gray-600"}`}>
                  <div className={`w-3 h-3 rounded-full bg-white mx-0.5 transition-transform ${indexForm.unique ? "translate-x-4" : "translate-x-0"}`} />
                </button>
                <span className="text-xs text-gray-600 dark:text-gray-300">Unique</span>
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Columns</label>
                <div className="space-y-1 max-h-36 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded p-2">
                  {columns.map(c => (
                    <label key={c.name} className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300 cursor-pointer">
                      <input type="checkbox" checked={indexForm.columns.includes(c.name)} onChange={() => toggleIndexColumn(c.name)} className="rounded" />
                      <span className="font-mono">{c.name}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Index Type</label>
                <select className={inp} value={indexForm.indexType} onChange={e => setIndexForm(f => ({ ...f, indexType: e.target.value }))}>
                  <option value="BTREE">BTREE</option>
                  {dbType === "mysql" && <option value="HASH">HASH</option>}
                  {dbType === "mysql" && <option value="FULLTEXT">FULLTEXT</option>}
                </select>
              </div>
              {indexModalError && <p className="text-xs text-red-500">{indexModalError}</p>}
              <div className="flex gap-2 justify-end pt-1">
                <button onClick={() => setIndexModal(null)} className="px-3 py-1.5 text-xs bg-gray-100 dark:bg-gray-700 rounded text-gray-700 dark:text-gray-200">Cancel</button>
                <button onClick={handleCreateIndex} disabled={indexSaving || !indexForm.name.trim() || indexForm.columns.length === 0}
                  className="flex items-center gap-1 px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-50">
                  {indexSaving ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
                  {indexSaving ? "Creating…" : "Create Index"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
