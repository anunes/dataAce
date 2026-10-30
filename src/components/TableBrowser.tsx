import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { desktopDir } from "@tauri-apps/api/path";
import { QueryResult, ColumnDef, DbType } from "../types";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ChevronUp, ChevronDown, Key, Loader2, Plus, Trash2, X } from "lucide-react";

type ExportFormat = "csv" | "tsv" | "json" | "xml" | "sql_sqlite" | "sql_mysql" | "sql_postgres" | "sql_oracle";

const EXPORT_FORMATS: { id: ExportFormat; label: string; ext: string }[] = [
  { id: "csv",        label: "CSV",             ext: "csv" },
  { id: "tsv",        label: "TSV",             ext: "tsv" },
  { id: "json",       label: "JSON",            ext: "json" },
  { id: "xml",        label: "XML",             ext: "xml" },
  { id: "sql_sqlite", label: "SQL — SQLite",    ext: "sql" },
  { id: "sql_mysql",  label: "SQL — MySQL",     ext: "sql" },
  { id: "sql_postgres", label: "SQL — PostgreSQL", ext: "sql" },
  { id: "sql_oracle", label: "SQL — Oracle",    ext: "sql" },
];

function quoteIdent(name: string, db: "sqlite" | "mysql" | "postgres" | "oracle"): string {
  if (db === "mysql") return `\`${name.replace(/`/g, "``")}\``;
  return `"${name.replace(/"/g, '""')}"`;
}

function buildSql(format: ExportFormat, table: string, cols: string[], rows: (string | null)[][]): string {
  const db = format.replace("sql_", "") as "sqlite" | "mysql" | "postgres" | "oracle";
  const tbl = quoteIdent(table, db);
  const colList = cols.map(c => quoteIdent(c, db)).join(", ");
  return rows.map(row => {
    const vals = row.map(v => v === null ? "NULL" : `'${v.replace(/'/g, "''")}'`).join(", ");
    return `INSERT INTO ${tbl} (${colList}) VALUES (${vals});`;
  }).join("\n");
}

type FilterOp = "=" | "!=" | "contains" | "starts with" | "ends with" | "<" | ">" | "IS NULL" | "IS NOT NULL" | "BETWEEN";
const FILTER_OPS: FilterOp[] = ["=", "!=", "contains", "starts with", "ends with", "<", ">", "IS NULL", "IS NOT NULL", "BETWEEN"];
const needsValue = (op: FilterOp) => op !== "IS NULL" && op !== "IS NOT NULL";
const needsSecond = (op: FilterOp) => op === "BETWEEN";

function buildWhere(col: string, op: FilterOp, val: string, val2: string, qi: (n: string) => string): string {
  const c = qi(col);
  const v = `'${val.replace(/'/g, "''")}'`;
  const v2 = `'${val2.replace(/'/g, "''")}'`;
  switch (op) {
    case "=": return `${c} = ${v}`;
    case "!=": return `${c} != ${v}`;
    case "contains": return `${c} LIKE '%${val.replace(/'/g, "''")}%'`;
    case "starts with": return `${c} LIKE '${val.replace(/'/g, "''")}%'`;
    case "ends with": return `${c} LIKE '%${val.replace(/'/g, "''")}'`;
    case "<": return `${c} < ${v}`;
    case ">": return `${c} > ${v}`;
    case "IS NULL": return `${c} IS NULL`;
    case "IS NOT NULL": return `${c} IS NOT NULL`;
    case "BETWEEN": return `${c} BETWEEN ${v} AND ${v2}`;
  }
}

interface Props {
  connId: string;
  table: string;
  database: string;
  dbType: DbType;
  triggerExport?: boolean;
  onExportDone?: () => void;
}

export default function TableBrowser({ connId, table, database, dbType, triggerExport, onExportDone }: Props) {
  const [result, setResult] = useState<QueryResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(0);
  const [totalRows, setTotalRows] = useState(0);
  const [pageSize, setPageSize] = useState(100);

  const [filterCol, setFilterCol] = useState("");
  const [filterOp, setFilterOp] = useState<FilterOp>("=");
  const [filterVal, setFilterVal] = useState("");
  const [filterVal2, setFilterVal2] = useState("");
  const [isFilterActive, setIsFilterActive] = useState(false);

  const [showExportModal, setShowExportModal] = useState(false);

  // Inline editing state
  const [editingCell, setEditingCell] = useState<{ row: number; col: number } | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [savingCell, setSavingCell] = useState(false);

  const [showInsertModal, setShowInsertModal] = useState(false);
  const [insertValues, setInsertValues] = useState<Record<string, string>>({});

  const [selectedRowIdx, setSelectedRowIdx] = useState<number | null>(null);
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"ASC" | "DESC">("ASC");

  // Quote an identifier for the connected DB type
  const qi = useCallback((name: string): string => {
    if (dbType === "mysql") return `\`${name.replace(/`/g, "``")}\``;
    if (dbType === "mssql") return `[${name.replace(/]/g, "]]")}]`;
    return `"${name.replace(/"/g, '""')}"`;
  }, [dbType]);

  // MySQL can reference database.table; for others just quote the table name
  const tableRef = dbType === "mysql" && database
    ? `${qi(database)}.${qi(table)}`
    : qi(table);

  const loadCount = useCallback(async (where?: string) => {
    const sql = `SELECT COUNT(*) FROM ${tableRef}${where ? ` WHERE ${where}` : ""}`;
    const r = await invoke<QueryResult>("execute_query", { connId, sql });
    if (!r.error && r.rows[0]?.[0]) setTotalRows(parseInt(r.rows[0][0] ?? "0"));
  }, [connId, tableRef]);

  const loadData = useCallback(async (page: number, where?: string, sc?: string | null, sd?: "ASC" | "DESC", ps?: number) => {
    setIsLoading(true);
    setError(null);
    setEditingCell(null);
    try {
      const activeSortCol = sc !== undefined ? sc : sortCol;
      const activeSortDir = sd !== undefined ? sd : sortDir;
      const activePageSize = ps !== undefined ? ps : pageSize;
      const orderBy = activeSortCol ? ` ORDER BY ${qi(activeSortCol)} ${activeSortDir}` : "";
      const sql = `SELECT * FROM ${tableRef}${where ? ` WHERE ${where}` : ""}${orderBy} LIMIT ${activePageSize} OFFSET ${page * activePageSize}`;
      const r = await invoke<QueryResult>("execute_query", { connId, sql });
      if (r.error) { setError(r.error); setResult(null); }
      else { setResult(r); }
      await loadCount(where);
    } catch (e) {
      setError(String(e));
    } finally {
      setIsLoading(false);
    }
  }, [connId, tableRef, loadCount, pageSize]);

  useEffect(() => {
    setCurrentPage(0);
    setIsFilterActive(false);
    setFilterCol("");
    setFilterVal("");
    setFilterVal2("");
    setSelectedRowIdx(null);
    setSortCol(null);
    setSortDir("ASC");
    loadData(0, undefined, null, "ASC");
  }, [table, database, connId]);

  function handleSort(col: string) {
    const newDir = sortCol === col && sortDir === "ASC" ? "DESC" : "ASC";
    const newCol = col;
    setSortCol(newCol);
    setSortDir(newDir);
    setCurrentPage(0);
    loadData(0, currentWhere(), newCol, newDir);
  }

  // Open export modal when triggered externally (from Sidebar)
  useEffect(() => {
    if (triggerExport) {
      setShowExportModal(true);
      onExportDone?.();
    }
  }, [triggerExport]);

  function currentWhere() {
    return isFilterActive && filterCol
      ? buildWhere(filterCol, filterOp, filterVal, filterVal2, qi)
      : undefined;
  }

  function applyFilter() {
    if (!filterCol || !needsValue(filterOp) || filterVal) {
      const where = filterCol ? buildWhere(filterCol, filterOp, filterVal, filterVal2, qi) : undefined;
      setIsFilterActive(!!filterCol);
      setCurrentPage(0);
      loadData(0, where);
    }
  }

  function clearFilter() {
    setIsFilterActive(false);
    setFilterCol("");
    setFilterVal("");
    setFilterVal2("");
    setCurrentPage(0);
    loadData(0);
  }

  function goPage(p: number) {
    setCurrentPage(p);
    loadData(p, currentWhere());
  }

  // Find the primary key column index
  function pkColIndex(): number {
    if (!result) return 0;
    const idx = result.columns.findIndex(c => c.is_primary_key);
    return idx >= 0 ? idx : 0;
  }

  function startEdit(rowIdx: number, colIdx: number, value: string | null) {
    setEditingCell({ row: rowIdx, col: colIdx });
    setEditingValue(value ?? "");
  }

  async function commitEdit() {
    if (!editingCell || !result) return;
    const { row, col } = editingCell;
    const pkIdx = pkColIndex();
    const pkCol = result.columns[pkIdx]?.name ?? result.columns[0]?.name ?? "id";
    const pkValue = result.rows[row][pkIdx] ?? "";
    const column = result.columns[col].name;

    setSavingCell(true);
    try {
      const res = await invoke<QueryResult>("update_cell", {
        connId,
        database,
        table,
        pkColumn: pkCol,
        pkValue,
        column,
        value: editingValue,
      });
      if (res.error) {
        alert(`Update failed: ${res.error}`);
      } else {
        // Update local data immediately
        setResult(prev => {
          if (!prev) return prev;
          const rows = prev.rows.map((r, ri) =>
            ri === row ? r.map((v, ci) => ci === col ? editingValue : v) : r
          );
          return { ...prev, rows };
        });
      }
    } catch (e) {
      alert(`Update failed: ${e}`);
    } finally {
      setSavingCell(false);
      setEditingCell(null);
    }
  }

  function cancelEdit() {
    setEditingCell(null);
  }

  async function insertRow() {
    if (!result) return;
    const cols = result.columns.map(c => c.name);
    const quotedCols = cols.map(c =>
      dbType === "mysql" ? `\`${c.replace(/`/g, "``")}\`` : `"${c.replace(/"/g, '""')}"`
    ).join(", ");
    const quotedVals = cols.map(c => {
      const v = insertValues[c] ?? "";
      return v === "" ? "NULL" : `'${v.replace(/'/g, "''")}'`;
    }).join(", ");
    const tbl = dbType === "mysql"
      ? (database ? `\`${database.replace(/`/g, "``")}\`.\`${table.replace(/`/g, "``")}\`` : `\`${table.replace(/`/g, "``")}\``)
      : `"${table.replace(/"/g, '""')}"`;
    const sql = `INSERT INTO ${tbl} (${quotedCols}) VALUES (${quotedVals})`;
    try {
      const res = await invoke<QueryResult>("execute_query", { connId, sql });
      if (res.error) {
        alert(`Insert failed: ${res.error}`);
      } else {
        setShowInsertModal(false);
        setInsertValues({});
        await loadData(currentPage, currentWhere());
      }
    } catch (e) {
      alert(`Insert failed: ${e}`);
    }
  }

  async function deleteRow(rowIdx: number) {
    if (!result) return;
    const pkIdx = pkColIndex();
    const pkCol = result.columns[pkIdx]?.name ?? "id";
    const pkValue = result.rows[rowIdx][pkIdx] ?? "";
    if (!confirm(`Delete row where ${pkCol} = ${pkValue}?`)) return;

    try {
      const res = await invoke<QueryResult>("delete_row", {
        connId,
        database,
        table,
        pkColumn: pkCol,
        pkValue,
      });
      if (res.error) {
        alert(`Delete failed: ${res.error}`);
      } else {
        setSelectedRowIdx(null);
        await loadData(currentPage, currentWhere());
      }
    } catch (e) {
      alert(`Delete failed: ${e}`);
    }
  }

  async function exportData(format: ExportFormat) {
    if (!result) return;
    setShowExportModal(false);
    const fmt = EXPORT_FORMATS.find(f => f.id === format)!;
    const desktop = await desktopDir();
    const defaultPath = `${desktop}/${table}.${fmt.ext}`;
    const path = await save({ defaultPath, filters: [{ name: fmt.label, extensions: [fmt.ext] }] });
    if (!path) return;

    const cols = result.columns.map(c => c.name);
    let content = "";

    if (format === "csv") {
      const quoteCSV = (v: string | null) => {
        if (v === null) return "";
        if (v.includes(",") || v.includes('"') || v.includes("\n")) return `"${v.replace(/"/g, '""')}"`;
        return v;
      };
      content = cols.join(",") + "\n";
      content += result.rows.map(row => row.map(quoteCSV).join(",")).join("\n");
    } else if (format === "tsv") {
      content = cols.join("\t") + "\n";
      content += result.rows.map(row => row.map(v => v === null ? "" : v.replace(/\t/g, " ")).join("\t")).join("\n");
    } else if (format === "json") {
      const objects = result.rows.map(row => {
        const obj: Record<string, string | null> = {};
        cols.forEach((c, i) => { obj[c] = row[i]; });
        return obj;
      });
      content = JSON.stringify(objects, null, 2);
    } else if (format === "xml") {
      const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      const tagName = table.replace(/[^a-zA-Z0-9_]/g, "_");
      content = `<?xml version="1.0" encoding="UTF-8"?>\n<${tagName}s>\n`;
      content += result.rows.map(row => {
        const fields = cols.map((c, i) => {
          const colTag = c.replace(/[^a-zA-Z0-9_]/g, "_");
          const val = row[i] === null ? "" : esc(row[i]!);
          return `    <${colTag}>${val}</${colTag}>`;
        }).join("\n");
        return `  <${tagName}>\n${fields}\n  </${tagName}>`;
      }).join("\n");
      content += `\n</${tagName}s>`;
    } else if (format.startsWith("sql_")) {
      const targetDb = format.replace("sql_", "") as "sqlite" | "mysql" | "postgres" | "oracle";
      let ddl = "";
      try {
        const rawDdl = await invoke<string>("get_create_table_sql", { connId, database, table });
        ddl = rawDdl.replace(/^CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS\s)/i, "CREATE TABLE IF NOT EXISTS ").trimEnd() + ";\n";
      } catch {
        // DDL unavailable — export data only
      }
      const now = new Date().toISOString().replace("T", " ").slice(0, 19);
      const header =
        `-- DataAce Export\n` +
        `-- Target DB: ${targetDb}\n` +
        `-- Database:  ${database || "(default)"}\n` +
        `-- Table:     ${table}\n` +
        `-- Date:      ${now}\n` +
        `-- Rows:      ${result.rows.length}\n` +
        `\n`;
      const inserts = buildSql(format, table, cols, result.rows);
      content = header + ddl + (ddl ? "\n" : "") + inserts;
    }

    await writeTextFile(path, content);
  }

  const maxPage = Math.max(0, Math.ceil(totalRows / pageSize) - 1);
  const rowStart = currentPage * pageSize + 1;
  const rowEnd = Math.min((currentPage + 1) * pageSize, totalRows);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-950 flex-wrap">
        <select
          className="bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-2 py-1 text-xs text-gray-800 dark:text-gray-200"
          value={filterCol}
          onChange={e => setFilterCol(e.target.value)}
        >
          <option value="">All Columns</option>
          {result?.columns.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
        </select>
        {filterCol && (
          <>
            <select
              className="bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-2 py-1 text-xs text-gray-800 dark:text-gray-200"
              value={filterOp}
              onChange={e => setFilterOp(e.target.value as FilterOp)}
            >
              {FILTER_OPS.map(op => <option key={op}>{op}</option>)}
            </select>
            {needsValue(filterOp) && (
              <input
                className="bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-2 py-1 text-xs w-32 focus:outline-none focus:border-blue-500 text-gray-800 dark:text-gray-200"
                value={filterVal}
                onChange={e => setFilterVal(e.target.value)}
                placeholder="value"
              />
            )}
            {needsSecond(filterOp) && (
              <input
                className="bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-2 py-1 text-xs w-32 focus:outline-none focus:border-blue-500 text-gray-800 dark:text-gray-200"
                value={filterVal2}
                onChange={e => setFilterVal2(e.target.value)}
                placeholder="value 2"
              />
            )}
            <button onClick={applyFilter} className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded">Apply</button>
          </>
        )}
        {isFilterActive && (
          <button onClick={clearFilter} className="px-2 py-1 text-xs bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 rounded text-gray-700 dark:text-gray-300">Clear</button>
        )}

        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => { setInsertValues({}); setShowInsertModal(true); }}
            disabled={!result}
            className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 disabled:opacity-40"
            title="Insert Row"
          >
            <Plus size={13} /> Insert Row
          </button>
          <button
            onClick={() => { if (selectedRowIdx !== null) deleteRow(selectedRowIdx); }}
            disabled={selectedRowIdx === null}
            className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 disabled:opacity-40"
            title="Delete selected row"
          >
            <Trash2 size={13} /> Delete Row
          </button>
        </div>
      </div>

      {/* Export modal */}
      {showExportModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setShowExportModal(false)}>
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-5 w-72 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-gray-800 dark:text-gray-100">Export — {table}</h3>
              <button onClick={() => setShowExportModal(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
                <X size={14} />
              </button>
            </div>
            <p className="text-xs text-gray-400 mb-3">Choose format. File will default to your Desktop.</p>
            <div className="space-y-1">
              {EXPORT_FORMATS.map(fmt => (
                <button
                  key={fmt.id}
                  onClick={() => exportData(fmt.id)}
                  className="w-full text-left px-3 py-2 text-sm rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-200 flex items-center justify-between"
                >
                  <span>{fmt.label}</span>
                  <span className="text-xs text-gray-400 uppercase">.{fmt.ext}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Insert Row modal */}
      {showInsertModal && result && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setShowInsertModal(false)}>
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-5 w-[480px] max-h-[80vh] overflow-y-auto shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-gray-800 dark:text-gray-100">Insert Row — {table}</h3>
              <button onClick={() => setShowInsertModal(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"><X size={14} /></button>
            </div>
            <div className="space-y-2 mb-4">
              {result.columns.map(col => (
                <div key={col.name}>
                  <label className="text-xs text-gray-400 mb-0.5 block">
                    {col.name}
                    {col.col_type && <span className="text-gray-300 dark:text-gray-600 ml-1">{col.col_type}</span>}
                  </label>
                  <input
                    className="w-full bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-500 text-gray-800 dark:text-gray-200"
                    placeholder="NULL"
                    value={insertValues[col.name] ?? ""}
                    onChange={e => setInsertValues(prev => ({ ...prev, [col.name]: e.target.value }))}
                    onKeyDown={e => { if (e.key === "Enter") insertRow(); if (e.key === "Escape") setShowInsertModal(false); }}
                  />
                </div>
              ))}
            </div>
            <div className="flex gap-2 justify-end">
              <button className="px-3 py-1.5 text-sm bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg text-gray-700 dark:text-gray-200" onClick={() => setShowInsertModal(false)}>Cancel</button>
              <button className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg" onClick={insertRow}>Insert</button>
            </div>
          </div>
        </div>
      )}

      {/* Data grid */}
      <div className="flex-1 overflow-auto min-h-0">
        {isLoading && (
          <div className="flex items-center justify-center h-full">
            <Loader2 size={20} className="animate-spin text-gray-400" />
          </div>
        )}
        {!isLoading && error && (
          <div className="p-4 text-red-500 text-sm">{error}</div>
        )}
        {!isLoading && !error && result && (
          result.rows.length === 0 ? (
            <div className="flex flex-col h-full">
              {result.columns.length > 0 && (
                <table className="text-xs border-collapse min-w-full">
                  <thead>
                    <tr className="bg-gray-50 dark:bg-gray-950 border-b border-gray-200 dark:border-gray-800">
                      {result.columns.map(c => (
                        <th key={c.name} className="px-3 py-2 text-left font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">
                          {c.is_primary_key && <Key size={10} className="inline mr-1 text-yellow-500" />}
                          {c.name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                </table>
              )}
              <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
                Database Empty — no rows in this table
              </div>
            </div>
          ) : (
            <EditableDataGrid
              columns={result.columns}
              rows={result.rows}
              editingCell={editingCell}
              editingValue={editingValue}
              savingCell={savingCell}
              onStartEdit={startEdit}
              onEditChange={setEditingValue}
              onCommitEdit={commitEdit}
              onCancelEdit={cancelEdit}
              onDeleteRow={deleteRow}
              selectedRowIdx={selectedRowIdx}
              onRowSelect={setSelectedRowIdx}
              sortCol={sortCol}
              sortDir={sortDir}
              onSort={handleSort}
            />
          )
        )}
      </div>

      {/* Pagination bar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-t border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-950 flex-shrink-0">
        <span className="text-xs text-gray-500 w-36">
          {totalRows > 0 ? `${rowStart}–${rowEnd} of ${totalRows} rows` : "0 rows"}
        </span>
        <div className="flex items-center gap-0.5">
          <button onClick={() => goPage(0)} disabled={currentPage === 0} className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded disabled:opacity-30 text-gray-500 dark:text-gray-400">
            <ChevronsLeft size={14} />
          </button>
          <button onClick={() => goPage(currentPage - 1)} disabled={currentPage === 0} className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded disabled:opacity-30 text-gray-500 dark:text-gray-400">
            <ChevronLeft size={14} />
          </button>
          <span className="text-xs text-gray-500 px-2">
            Page {currentPage + 1}{maxPage > 0 ? ` of ${maxPage + 1}` : ""}
          </span>
          <button onClick={() => goPage(currentPage + 1)} disabled={currentPage >= maxPage} className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded disabled:opacity-30 text-gray-500 dark:text-gray-400">
            <ChevronRight size={14} />
          </button>
          <button onClick={() => goPage(maxPage)} disabled={currentPage >= maxPage} className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded disabled:opacity-30 text-gray-500 dark:text-gray-400">
            <ChevronsRight size={14} />
          </button>
        </div>
        <div className="flex items-center gap-1.5 w-36 justify-end">
          <label className="text-xs text-gray-400">Rows</label>
          <select
            className="bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-1.5 py-0.5 text-xs text-gray-600 dark:text-gray-300"
            value={pageSize}
            onChange={e => {
              const ps = Number(e.target.value);
              setPageSize(ps);
              setCurrentPage(0);
              loadData(0, currentWhere(), sortCol, sortDir, ps);
            }}
          >
            {[25, 50, 100, 250, 500, 1000].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
      </div>
    </div>
  );
}

interface GridProps {
  columns: ColumnDef[];
  rows: (string | null)[][];
  editingCell: { row: number; col: number } | null;
  editingValue: string;
  savingCell: boolean;
  onStartEdit: (row: number, col: number, value: string | null) => void;
  onEditChange: (v: string) => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
  onDeleteRow: (row: number) => void;
  selectedRowIdx: number | null;
  onRowSelect: (idx: number) => void;
  sortCol: string | null;
  sortDir: "ASC" | "DESC";
  onSort: (col: string) => void;
}

function EditableDataGrid({
  columns, rows, editingCell, editingValue, savingCell,
  onStartEdit, onEditChange, onCommitEdit, onCancelEdit, onDeleteRow,
  selectedRowIdx, onRowSelect, sortCol, sortDir, onSort,
}: GridProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingCell && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingCell]);

  return (
    <table className="w-full text-xs border-collapse" style={{ minWidth: "max-content" }}>
      <thead className="sticky top-0 bg-gray-50 dark:bg-gray-950 z-10">
        <tr>
          {columns.map(col => (
            <th
              key={col.name}
              className="text-left px-3 py-2 border-b border-gray-200 dark:border-gray-800 font-medium whitespace-nowrap text-gray-700 dark:text-gray-200 cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-gray-900"
              onClick={() => onSort(col.name)}
            >
              <div className="flex items-center gap-1">
                {col.is_primary_key && <Key size={10} className="text-orange-400" />}
                <span>{col.name}</span>
                {sortCol === col.name
                  ? sortDir === "ASC"
                    ? <ChevronUp size={11} className="text-blue-500 flex-shrink-0" />
                    : <ChevronDown size={11} className="text-blue-500 flex-shrink-0" />
                  : <ChevronUp size={11} className="text-gray-400 dark:text-gray-500 flex-shrink-0" />
                }
              </div>
            </th>
          ))}
          <th className="w-8 border-b border-gray-200 dark:border-gray-800" />
        </tr>
      </thead>
      <tbody>
        {rows.map((row, ri) => (
          <tr
            key={ri}
            className={`group cursor-pointer ${
              selectedRowIdx === ri
                ? "bg-blue-50 dark:bg-blue-950/30"
                : ri % 2 === 0 ? "bg-white dark:bg-gray-900" : "bg-gray-50/50 dark:bg-gray-900/50"
            }`}
            onClick={() => onRowSelect(ri)}
          >
            {row.map((cell, ci) => {
              const isEditing = editingCell?.row === ri && editingCell?.col === ci;
              return (
                <td
                  key={ci}
                  className="px-0 py-0 border-b border-gray-100 dark:border-gray-800/50 whitespace-nowrap max-w-xs"
                  onDoubleClick={e => { e.stopPropagation(); onStartEdit(ri, ci, cell); }}
                >
                  {isEditing ? (
                    <div className="flex items-center">
                      <input
                        ref={inputRef}
                        className="w-full px-3 py-1.5 bg-blue-50 dark:bg-blue-900/30 border border-blue-400 outline-none text-xs text-gray-900 dark:text-gray-100"
                        value={editingValue}
                        onChange={e => onEditChange(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === "Enter") onCommitEdit();
                          if (e.key === "Escape") onCancelEdit();
                        }}
                        onBlur={onCommitEdit}
                        disabled={savingCell}
                        onClick={e => e.stopPropagation()}
                      />
                      {savingCell && <Loader2 size={12} className="animate-spin ml-1 text-blue-400 flex-shrink-0" />}
                    </div>
                  ) : (
                    <div className="px-3 py-1.5 cursor-text truncate max-w-xs">
                      {cell === null ? (
                        <span className="italic text-gray-400">NULL</span>
                      ) : (
                        <span className="text-gray-800 dark:text-gray-200">{cell}</span>
                      )}
                    </div>
                  )}
                </td>
              );
            })}
            <td className="border-b border-gray-100 dark:border-gray-800/50 px-1" onClick={e => e.stopPropagation()}>
              <button
                onClick={() => onDeleteRow(ri)}
                className="p-1 text-gray-300 dark:text-gray-700 hover:text-red-500 rounded opacity-0 group-hover:opacity-100 hover:!opacity-100"
                title="Delete row"
              >
                <Trash2 size={11} />
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Query results can include identically named columns from joined tables.
export function DataGrid({ columns, rows }: { columns: ColumnDef[]; rows: (string | null)[][] }) {
  return (
    <table className="w-full text-xs border-collapse" style={{ minWidth: "max-content" }}>
      <thead className="sticky top-0 bg-gray-50 dark:bg-gray-950 z-10">
        <tr>
          {columns.map((col, index) => (
            <th key={index} className="text-left px-3 py-2 border-b border-gray-200 dark:border-gray-800 font-medium whitespace-nowrap text-gray-700 dark:text-gray-200">
              <div className="flex items-center gap-1">
                {col.is_primary_key && <Key size={10} className="text-orange-400" />}
                <span>{col.name}</span>
                {col.col_type && <span className="text-gray-400 font-normal ml-1">{col.col_type}</span>}
              </div>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, ri) => (
          <tr key={ri} className={ri % 2 === 0 ? "bg-white dark:bg-gray-900" : "bg-gray-50/50 dark:bg-gray-900/50"}>
            {row.map((cell, ci) => (
              <td key={ci} className="px-3 py-1.5 border-b border-gray-100 dark:border-gray-800/50 whitespace-nowrap max-w-xs truncate">
                {cell === null ? (
                  <span className="italic text-gray-400">NULL</span>
                ) : (
                  <span className="text-gray-800 dark:text-gray-200">{cell}</span>
                )}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
