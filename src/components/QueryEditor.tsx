import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { sql } from "@codemirror/lang-sql";
import { oneDark } from "@codemirror/theme-one-dark";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { QueryResult, DbType } from "../types";
import { DataGrid } from "./TableBrowser";
import { Play, Trash2, Clock, Loader2, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";

const HISTORY_KEY = "dataace_query_history";
const MAX_HISTORY = 50;

function loadHistory(): string[] {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]"); }
  catch { return []; }
}

function saveHistory(q: string, prev: string[]): string[] {
  const deduped = prev.filter(x => x !== q);
  const next = [q, ...deduped].slice(0, MAX_HISTORY);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  return next;
}

interface Props {
  connId: string;
  selectedTable: string | null;
  selectedDb: string | null;
  isDark: boolean;
  dbType: DbType;
}

export default function QueryEditor({ connId, selectedTable, selectedDb, isDark, dbType }: Props) {
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [isExecuting, setIsExecuting] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [history_, setHistory] = useState<string[]>(loadHistory);
  const [showHistory, setShowHistory] = useState(false);
  const currentSqlRef = useRef("");
  const [resultsHeight, setResultsHeight] = useState(220);
  const [qPageSize, setQPageSize] = useState(100);
  const [qPage, setQPage] = useState(0);
  const isDraggingResultsRef = useRef(false);
  const startYRef = useRef(0);
  const startHeightRef = useRef(220);

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!isDraggingResultsRef.current) return;
      const delta = startYRef.current - e.clientY;
      setResultsHeight(Math.min(600, Math.max(80, startHeightRef.current + delta)));
    }
    function onMouseUp() {
      isDraggingResultsRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => { window.removeEventListener("mousemove", onMouseMove); window.removeEventListener("mouseup", onMouseUp); };
  }, []);

  // Refs so the editor keymap always calls the latest execute/values without recreating the editor
  const executeRef = useRef<() => void>(() => {});
  const selectedDbRef = useRef(selectedDb);
  const dbTypeRef = useRef(dbType);
  selectedDbRef.current = selectedDb;
  dbTypeRef.current = dbType;

  const execute = useCallback(async () => {
    const sql_ = currentSqlRef.current.trim();
    if (!sql_ || isExecuting) return;
    const curDb = selectedDbRef.current;
    setIsExecuting(true);
    setResult(null);
    setStatusMessage("");
    try {
      const r = await invoke<QueryResult>("execute_query", { connId, sql: sql_, database: curDb ?? null });
      setResult(r);
      if (r.error) {
        setStatusMessage(`Error: ${r.error}`);
      } else if (r.columns.length > 0) {
        setStatusMessage(`${r.rows.length} row(s) returned in ${r.execution_time_ms.toFixed(1)}ms`);
      } else {
        setStatusMessage(`${r.affected_rows} row(s) affected in ${r.execution_time_ms.toFixed(1)}ms`);
      }
      setHistory(prev => saveHistory(sql_, prev));
    } catch (e) {
      setStatusMessage(`Error: ${e}`);
    } finally {
      setIsExecuting(false);
    }
  }, [connId, isExecuting]);

  // Keep executeRef current so the keymap doesn't cause editor recreation
  executeRef.current = execute;

  useEffect(() => { setQPage(0); }, [result]);

  useEffect(() => {
    if (!editorRef.current) return;
    const extensions = [
      sql(),
      ...(isDark ? [oneDark] : []),
      lineNumbers(),
      history(),
      keymap.of([
        { key: "Mod-Enter", run: () => { executeRef.current(); return true; } },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      EditorView.theme({
        "&": { height: "100%", fontSize: "13px" },
        ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", overflow: "auto" },
      }),
      EditorView.updateListener.of(update => {
        if (update.docChanged) currentSqlRef.current = update.state.doc.toString();
      }),
    ];
    const view = new EditorView({
      state: EditorState.create({ doc: currentSqlRef.current, extensions }),
      parent: editorRef.current,
    });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
  }, [connId, isDark]); // Recreate editor when connection or theme changes

  function clearEditor() {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "" } });
    currentSqlRef.current = "";
    setResult(null);
    setStatusMessage("");
  }

  function insertQuery(q: string) {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: q } });
    currentSqlRef.current = q;
    setShowHistory(false);
  }

  function insertSelectAll() {
    if (!selectedTable || !selectedDb) return;
    const q = `SELECT * FROM \`${selectedDb}\`.\`${selectedTable}\``;
    insertQuery(q);
  }

  return (
    <div className="flex flex-col h-full overflow-hidden pr-2">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-950">
        <button
          onClick={execute}
          disabled={isExecuting}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-50"
        >
          {isExecuting ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
          Execute
        </button>
        <button
          onClick={clearEditor}
          className="flex items-center gap-1.5 px-2 py-1.5 text-xs bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 rounded text-gray-700 dark:text-gray-300"
        >
          <Trash2 size={12} /> Clear
        </button>
        <div className="relative">
          <button
            onClick={() => setShowHistory(h => !h)}
            className="flex items-center gap-1.5 px-2 py-1.5 text-xs bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 rounded text-gray-700 dark:text-gray-300"
          >
            <Clock size={12} /> History
          </button>
          {showHistory && (
            <div className="absolute left-0 top-full mt-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded shadow-lg z-20 w-96 max-h-64 overflow-y-auto">
              {history_.length === 0 ? (
                <div className="px-3 py-2 text-xs text-gray-400">No history yet</div>
              ) : history_.map((q, i) => (
                <button
                  key={i}
                  onClick={() => insertQuery(q)}
                  className="w-full text-left px-3 py-2 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 border-b border-gray-100 dark:border-gray-700/50 truncate"
                >
                  {q}
                </button>
              ))}
            </div>
          )}
        </div>
        {selectedTable && selectedDb && (
          <button
            onClick={insertSelectAll}
            className="px-2 py-1.5 text-xs bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 rounded text-gray-700 dark:text-gray-300"
          >
            SELECT * FROM {selectedTable}
          </button>
        )}
        {selectedDb && (
          <span className="ml-2 text-xs text-gray-400 bg-gray-200 dark:bg-gray-700 px-2 py-0.5 rounded font-mono">
            db: {selectedDb}
          </span>
        )}
        <span className="ml-auto text-xs font-mono text-gray-400">⌘↩ to run</span>
      </div>

      {/* Editor */}
      <div className="flex-1 overflow-hidden" ref={editorRef} />

      {/* Drag handle */}
      <div
        className="h-1 flex-shrink-0 cursor-row-resize bg-gray-200 dark:bg-gray-800 hover:bg-blue-400 transition-colors"
        onMouseDown={e => {
          isDraggingResultsRef.current = true;
          startYRef.current = e.clientY;
          startHeightRef.current = resultsHeight;
          document.body.style.cursor = "row-resize";
          document.body.style.userSelect = "none";
          e.preventDefault();
        }}
      />

      {/* Results */}
      <div className="flex flex-col overflow-hidden border-t border-gray-200 dark:border-gray-800" style={{ height: resultsHeight }}>
        <div className={`px-3 py-1.5 text-xs border-b border-gray-200 dark:border-gray-800 ${result?.error ? "text-red-500 bg-red-50 dark:bg-red-950/20" : "text-gray-500 bg-gray-50 dark:bg-gray-950"}`}>
          {statusMessage || "Press ⌘↩ to execute query"}
        </div>
        <div className="flex-1 overflow-auto min-h-0">
          {result && !result.error && result.columns.length > 0 && (() => {
            const pagedRows = result.rows.slice(qPage * qPageSize, (qPage + 1) * qPageSize);
            return <DataGrid columns={result.columns} rows={pagedRows} />;
          })()}
          {result?.error && (
            <div className="p-3 text-sm text-red-500">{result.error}</div>
          )}
          {result && !result.error && result.columns.length === 0 && (
            <div className="flex items-center justify-center h-full text-gray-400 text-xs">
              Query executed successfully
            </div>
          )}
        </div>
        {result && !result.error && result.columns.length > 0 && (() => {
          const total = result.rows.length;
          const qMaxPage = Math.max(0, Math.ceil(total / qPageSize) - 1);
          const rowStart = qPage * qPageSize + 1;
          const rowEnd = Math.min((qPage + 1) * qPageSize, total);
          return (
            <div className="flex items-center justify-between px-3 py-1.5 border-t border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-950 flex-shrink-0">
              <span className="text-xs text-gray-500 w-36">
                {total > 0 ? `${rowStart}–${rowEnd} of ${total} rows` : "0 rows"}
              </span>
              <div className="flex items-center gap-0.5">
                <button onClick={() => setQPage(0)} disabled={qPage === 0} className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded disabled:opacity-30 text-gray-500 dark:text-gray-400">
                  <ChevronsLeft size={14} />
                </button>
                <button onClick={() => setQPage(p => p - 1)} disabled={qPage === 0} className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded disabled:opacity-30 text-gray-500 dark:text-gray-400">
                  <ChevronLeft size={14} />
                </button>
                <span className="text-xs text-gray-500 px-2">
                  Page {qPage + 1}{qMaxPage > 0 ? ` of ${qMaxPage + 1}` : ""}
                </span>
                <button onClick={() => setQPage(p => p + 1)} disabled={qPage >= qMaxPage} className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded disabled:opacity-30 text-gray-500 dark:text-gray-400">
                  <ChevronRight size={14} />
                </button>
                <button onClick={() => setQPage(qMaxPage)} disabled={qPage >= qMaxPage} className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded disabled:opacity-30 text-gray-500 dark:text-gray-400">
                  <ChevronsRight size={14} />
                </button>
              </div>
              <div className="flex items-center gap-1.5 w-36 justify-end">
                <label className="text-xs text-gray-400">Rows</label>
                <select
                  className="bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-1.5 py-0.5 text-xs text-gray-600 dark:text-gray-300"
                  value={qPageSize}
                  onChange={e => { setQPageSize(Number(e.target.value)); setQPage(0); }}
                >
                  {[25, 50, 100, 250, 500, 1000].map(n => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
