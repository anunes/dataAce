import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowDown, ArrowUp, ArrowUpDown, Check, ChevronDown, ChevronLeft, ChevronRight,
  Columns3, Copy, Database, Filter, GitMerge, Layers3, Loader2, Play,
  Plus, RotateCcw, ShieldCheck, Table2, X,
} from "lucide-react";
import type { ColumnInfo, DbType, ForeignKeyInfo, QueryResult, TableInfo } from "../types";
import {
  availableJoinTypes, compileQuery, createEmptyQuery,
  type BuilderFilter, type BuilderJoin, type BuilderOrder, type BuilderSelection,
  type BuilderTable, type ColumnRef, type QueryBuilderState, type QueryParameter,
} from "../utils/queryBuilder";
import { DataGrid } from "./TableBrowser";
import "./visual-query-builder.css";

interface Props {
  connId: string;
  selectedDb: string | null;
  selectedTable: string | null;
  dbType: DbType;
  isDark: boolean;
}

type Panel = "columns" | "filters" | "grouping";
type ColumnOption = { ref: ColumnRef; label: string; info: ColumnInfo };

const aggregates: BuilderSelection["aggregate"][] = ["", "COUNT", "SUM", "AVG", "MIN", "MAX"];
const operators: BuilderFilter["operator"][] = ["=", "!=", ">", ">=", "<", "<=", "LIKE", "NOT LIKE", "IN", "NOT IN", "BETWEEN", "IS NULL", "IS NOT NULL"];
const joinOperators: BuilderJoin["conditions"][number]["operator"][] = ["=", "!=", ">", ">=", "<", "<="];
const parameterTypes: QueryParameter["type"][] = ["text", "integer", "decimal", "boolean", "null"];
const typeLabels: Record<QueryParameter["type"], string> = { text: "Text", integer: "Integer", decimal: "Decimal", boolean: "Boolean", null: "NULL" };

function uid() { return crypto.randomUUID(); }
function sameColumn(left: ColumnRef | null, right: ColumnRef | null) { return !!left && !!right && left.tableId === right.tableId && left.column === right.column; }
function encodeColumn(column: ColumnRef) { return JSON.stringify([column.tableId, column.column]); }
function decodeColumn(value: string): ColumnRef | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string" ? { tableId: parsed[0], column: parsed[1] } : null;
  } catch { return null; }
}
function inferredParameter(info?: ColumnInfo): QueryParameter {
  const type = info?.col_type.toLowerCase() ?? "";
  if (/bool|^bit$|tinyint\(1\)/.test(type)) return { type: "boolean", value: "true" };
  if (/int|serial/.test(type)) return { type: "integer", value: "" };
  if (/numeric|decimal|number|float|double|real|money/.test(type)) return { type: "decimal", value: "" };
  return { type: "text", value: "" };
}

function ColumnSelect({ value, options, label, onChange, allRows = false, disabled = false }: {
  value: ColumnRef | null;
  options: ColumnOption[];
  label: string;
  onChange: (value: ColumnRef | null) => void;
  allRows?: boolean;
  disabled?: boolean;
}) {
  return <select className="vqb-input" aria-label={label} value={value ? encodeColumn(value) : ""} disabled={disabled} onChange={event => onChange(decodeColumn(event.target.value))}>
    <option value="" disabled={!allRows}>{allRows ? "* · all rows" : "Choose a column"}</option>
    {options.map(option => <option key={encodeColumn(option.ref)} value={encodeColumn(option.ref)}>{option.label}</option>)}
  </select>;
}

export default function VisualQueryBuilder({ connId, selectedDb, selectedTable, dbType }: Props) {
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [schema, setSchema] = useState<Record<string, ColumnInfo[]>>({});
  const [query, setQuery] = useState<QueryBuilderState>(createEmptyQuery);
  const [panel, setPanel] = useState<Panel>("columns");
  const [tablesLoading, setTablesLoading] = useState(false);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [addingJoin, setAddingJoin] = useState(false);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [retryVersion, setRetryVersion] = useState(0);
  const [joinCandidate, setJoinCandidate] = useState("");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [executionError, setExecutionError] = useState<string | null>(null);
  const [executing, setExecuting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set());
  const cache = useRef<Record<string, ColumnInfo[]>>({});
  const requests = useRef(new Map<string, Promise<ColumnInfo[]>>());
  const initialTable = useRef(selectedTable);
  initialTable.current = selectedTable;
  const scope = `${connId}\0${selectedDb ?? ""}`;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const executionId = useRef(0);
  const executingRef = useRef(false);
  const resultsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    executionId.current += 1;
    executingRef.current = false;
    cache.current = {};
    requests.current.clear();
    setTables([]);
    setSchema({});
    setQuery(createEmptyQuery());
    setResult(null);
    setExecutionError(null);
    setExecuting(false);
    setMetadataError(null);
    setSchemaLoading(false);
    setAddingJoin(false);
    setPage(0);
    setExpandedTables(new Set());
    if (!selectedDb) { setTablesLoading(false); return; }
    setTablesLoading(true);
    invoke<TableInfo[]>("list_tables", { connId, database: selectedDb }).then(entries => {
      if (cancelled) return;
      const available = entries.filter(table => !table.name.startsWith("sqlite_"));
      setTables(available);
      const name = available.some(table => table.name === initialTable.current) ? initialTable.current! : available[0]?.name;
      if (name) setQuery({ ...createEmptyQuery(), source: { id: uid(), name, alias: name } });
      setJoinCandidate(available.find(table => table.name !== name)?.name ?? name ?? "");
    }).catch(error => {
      if (!cancelled) setMetadataError(String(error));
    }).finally(() => {
      if (!cancelled) setTablesLoading(false);
    });
    return () => { cancelled = true; };
  }, [connId, selectedDb, retryVersion]);

  const selectedTables = useMemo(() => query.source ? [query.source, ...query.joins.map(join => join.table)] : [], [query.source, query.joins]);
  const tableNamesKey = JSON.stringify([...new Set(selectedTables.map(table => table.name))]);

  function loadColumns(name: string): Promise<ColumnInfo[]> {
    if (cache.current[name]) return Promise.resolve(cache.current[name]);
    const existing = requests.current.get(name);
    if (existing) return existing;
    const requestScope = scope;
    const request = invoke<ColumnInfo[]>("table_columns", { connId, database: selectedDb ?? "", table: name }).then(columns => {
      if (currentScope.current === requestScope) cache.current[name] = columns;
      return columns;
    });
    requests.current.set(name, request);
    void request.finally(() => {
      if (requests.current.get(name) === request) requests.current.delete(name);
    }).catch(() => {});
    return request;
  }

  useEffect(() => {
    let cancelled = false;
    if (!selectedDb || selectedTables.length === 0) { setSchemaLoading(false); return; }
    const names: string[] = JSON.parse(tableNamesKey);
    setSchemaLoading(true);
    Promise.all(names.map(async name => [name, await loadColumns(name)] as const)).then(entries => {
      if (cancelled) return;
      setSchema(Object.fromEntries(entries));
      setMetadataError(null);
    }).catch(error => {
      if (!cancelled) setMetadataError(`Cannot read table columns: ${String(error)}`);
    }).finally(() => {
      if (!cancelled) setSchemaLoading(false);
    });
    return () => { cancelled = true; };
  }, [connId, selectedDb, tableNamesKey, retryVersion]);

  const columns = useMemo<ColumnOption[]>(() => selectedTables.flatMap(table => (schema[table.name] ?? []).map(info => ({ ref: { tableId: table.id, column: info.name }, label: `${table.alias || table.name}.${info.name}`, info }))), [selectedTables, schema]);
  const compiled = useMemo(() => compileQuery(dbType, query, schema), [dbType, query, schema]);
  const loading = tablesLoading || schemaLoading || addingJoin;
  const canRun = !!selectedDb && !!query.source && !loading && !metadataError && !compiled.error;
  const resultPageCount = Math.max(1, Math.ceil((result?.rows.length ?? 0) / pageSize));

  function mutate(update: (previous: QueryBuilderState) => QueryBuilderState) {
    setQuery(update);
    setExecutionError(null);
    setCopied(false);
  }

  function reset() {
    executionId.current += 1;
    const name = tables.some(table => table.name === initialTable.current) ? initialTable.current! : tables[0]?.name;
    setQuery({ ...createEmptyQuery(), source: name ? { id: uid(), name, alias: name } : null });
    setResult(null);
    setExecutionError(null);
    setPanel("columns");
    setPage(0);
  }

  function replaceSource(name: string) {
    mutate(previous => ({ ...createEmptyQuery(), source: { id: uid(), name, alias: name }, limit: previous.limit }));
    setResult(null);
  }

  function withoutTableReferences(previous: QueryBuilderState, tableId: string): QueryBuilderState {
    const removedSelectionIds = new Set(previous.selections.filter(selection => selection.column?.tableId === tableId).map(selection => selection.id));
    return {
      ...previous,
      selections: previous.selections.filter(selection => selection.column?.tableId !== tableId),
      filters: previous.filters.filter(filter => filter.column.tableId !== tableId),
      groupBy: previous.groupBy.filter(column => column.tableId !== tableId),
      orderBy: previous.orderBy.filter(order => order.column?.tableId !== tableId && !removedSelectionIds.has(order.selectionId ?? "")),
      joins: previous.joins.map(join => ({ ...join, conditions: join.conditions.filter(condition => condition.left.tableId !== tableId && condition.right.tableId !== tableId) })),
    };
  }

  function removeJoin(joinId: string) {
    mutate(previous => {
      const removed = previous.joins.find(join => join.id === joinId);
      if (!removed) return previous;
      const next = withoutTableReferences(previous, removed.table.id);
      return { ...next, joins: next.joins.filter(join => join.id !== joinId) };
    });
  }

  async function suggestedJoinCondition(table: BuilderTable, existing: BuilderTable[]): Promise<BuilderJoin["conditions"]> {
    const targetColumns = await loadColumns(table.name);
    const foreignKeys = await Promise.all([table, ...existing].map(async entry => ({
      table: entry,
      keys: await invoke<ForeignKeyInfo[]>("table_foreign_keys", { connId, database: selectedDb ?? "", table: entry.name }).catch(() => []),
    })));
    for (const existingTable of existing) {
      const targetKey = foreignKeys[0].keys.find(key => key.referenced_table === existingTable.name && targetColumns.some(column => column.name === key.column_name) && (cache.current[existingTable.name] ?? []).some(column => column.name === key.referenced_column));
      if (targetKey) return [{ id: uid(), left: { tableId: existingTable.id, column: targetKey.referenced_column }, operator: "=", right: { tableId: table.id, column: targetKey.column_name } }];
      const existingKey = foreignKeys.find(entry => entry.table.id === existingTable.id)?.keys.find(key => key.referenced_table === table.name && targetColumns.some(column => column.name === key.referenced_column));
      if (existingKey) return [{ id: uid(), left: { tableId: existingTable.id, column: existingKey.column_name }, operator: "=", right: { tableId: table.id, column: existingKey.referenced_column } }];
    }
    return [{ id: uid(), left: { tableId: existing[0].id, column: "" }, operator: "=", right: { tableId: table.id, column: "" } }];
  }

  async function addJoin() {
    if (!joinCandidate || !query.source || addingJoin) return;
    const requestScope = scope;
    setAddingJoin(true);
    setMetadataError(null);
    try {
      const aliases = new Set(selectedTables.map(table => table.alias.toLowerCase()));
      let alias = joinCandidate;
      let number = 2;
      while (aliases.has(alias.toLowerCase())) { alias = `${joinCandidate}_${number++}`; }
      const table = { id: uid(), name: joinCandidate, alias };
      const conditions = await suggestedJoinCondition(table, selectedTables);
      if (currentScope.current !== requestScope) return;
      setSchema(previous => ({ ...previous, [table.name]: cache.current[table.name] ?? [] }));
      mutate(previous => ({ ...previous, joins: [...previous.joins, { id: uid(), type: "LEFT", table, conditions }] }));
    } catch (error) {
      if (currentScope.current === requestScope) setMetadataError(`Cannot add this table: ${String(error)}`);
    } finally {
      if (currentScope.current === requestScope) setAddingJoin(false);
    }
  }

  async function changeJoinTable(joinId: string, name: string) {
    const joinIndex = query.joins.findIndex(join => join.id === joinId);
    const join = query.joins[joinIndex];
    if (!join || !query.source || addingJoin) return;
    const requestScope = scope;
    setAddingJoin(true);
    try {
      const table = { ...join.table, name };
      const conditions = await suggestedJoinCondition(table, [query.source, ...query.joins.slice(0, joinIndex).map(entry => entry.table)]);
      if (currentScope.current !== requestScope) return;
      setSchema(previous => ({ ...previous, [name]: cache.current[name] ?? [] }));
      mutate(previous => {
        const next = withoutTableReferences(previous, table.id);
        return { ...next, joins: next.joins.map(entry => entry.id === joinId ? { ...entry, table, conditions } : entry) };
      });
    } catch (error) {
      if (currentScope.current === requestScope) setMetadataError(`Cannot read this table: ${String(error)}`);
    } finally {
      if (currentScope.current === requestScope) setAddingJoin(false);
    }
  }

  function selectColumn(column: ColumnRef) {
    mutate(previous => {
      const existing = previous.selections.find(selection => selection.aggregate === "" && sameColumn(selection.column, column));
      if (existing) return { ...previous, selections: previous.selections.filter(selection => selection.id !== existing.id), orderBy: previous.orderBy.filter(order => order.selectionId !== existing.id) };
      return { ...previous, selections: [...previous.selections, { id: uid(), column, aggregate: "", alias: "" }] };
    });
  }

  function selectionLabel(selection: BuilderSelection) {
    if (selection.alias) return selection.alias;
    const column = columns.find(option => sameColumn(option.ref, selection.column))?.label ?? "*";
    return selection.aggregate ? `${selection.aggregate}(${column})` : column;
  }

  function updateSelection(id: string, update: Partial<BuilderSelection>) {
    mutate(previous => ({ ...previous, selections: previous.selections.map(selection => selection.id === id ? { ...selection, ...update } : selection) }));
  }

  function addFilter() {
    if (!columns[0]) return;
    mutate(previous => ({ ...previous, filters: [...previous.filters, { id: uid(), column: columns[0].ref, operator: "=", parameters: [inferredParameter(columns[0].info)] }] }));
  }

  function updateFilter(id: string, update: Partial<BuilderFilter>) {
    mutate(previous => ({ ...previous, filters: previous.filters.map(filter => filter.id === id ? { ...filter, ...update } : filter) }));
  }

  function changeFilterOperator(filter: BuilderFilter, operator: BuilderFilter["operator"]) {
    const fallback = inferredParameter(columns.find(column => sameColumn(column.ref, filter.column))?.info);
    const parameters = operator === "IS NULL" || operator === "IS NOT NULL" ? []
      : operator === "BETWEEN" ? [filter.parameters[0] ?? fallback, filter.parameters[1] ?? { ...fallback }]
      : operator === "IN" || operator === "NOT IN" ? filter.parameters.length ? filter.parameters : [fallback]
      : [filter.parameters[0] ?? fallback];
    updateFilter(filter.id, { operator, parameters });
  }

  function updateParameter(filter: BuilderFilter, index: number, update: Partial<QueryParameter>) {
    updateFilter(filter.id, { parameters: filter.parameters.map((parameter, i) => i === index ? { ...parameter, ...update } : parameter) });
  }

  function addOrder() {
    const firstSelection = query.selections[0];
    if (!firstSelection && !columns[0]) return;
    mutate(previous => ({ ...previous, orderBy: [...previous.orderBy, firstSelection
      ? { id: uid(), column: null, selectionId: firstSelection.id, direction: "ASC" }
      : { id: uid(), column: columns[0].ref, direction: "ASC" }] }));
  }

  async function runQuery() {
    if (!canRun || executingRef.current) return;
    executingRef.current = true;
    setExecuting(true);
    setExecutionError(null);
    const request = ++executionId.current;
    const requestScope = scope;
    try {
      const next = await invoke<QueryResult>("execute_parameterized_query", { connId, database: selectedDb, sql: compiled.sql, parameters: compiled.parameters });
      if (currentScope.current !== requestScope || executionId.current !== request) return;
      setResult(next);
      setPage(0);
      if (next.error) setExecutionError(next.error);
      requestAnimationFrame(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
    } catch (error) {
      if (currentScope.current === requestScope && executionId.current === request) { setResult(null); setExecutionError(String(error)); }
    } finally {
      if (currentScope.current === requestScope && executionId.current === request) { setExecuting(false); executingRef.current = false; }
    }
  }

  async function copySql() {
    try {
      await navigator.clipboard.writeText(compiled.sql);
      setCopied(true);
    } catch { setExecutionError("Cannot copy SQL. Select the SQL preview and copy it manually."); }
  }

  function tableCard(table: BuilderTable, index: number) {
    const tableColumns = schema[table.name] ?? [];
    const expanded = expandedTables.has(table.id);
    const visibleColumns = expanded ? tableColumns : tableColumns.slice(0, 6);
    const join = index > 0 ? query.joins[index - 1] : null;
    return <div className="vqb-table-segment" key={table.id}>
      {join && <div className="vqb-table-connector"><span>{join.type} JOIN</span><GitMerge size={15} /></div>}
      <section className={`vqb-table-card ${index === 0 ? "vqb-table-card-source" : ""}`} aria-label={`${index === 0 ? "Source" : "Joined"} table ${table.alias}`}>
        <div className="vqb-table-card-title"><span><Table2 size={14} />{index === 0 ? "FROM" : `${join?.type} JOIN`}</span>{join && <button type="button" className="vqb-icon-button" aria-label={`Remove join ${index}`} onClick={() => removeJoin(join.id)}><X size={13} /></button>}</div>
        <div className="vqb-table-card-controls">
          <select className="vqb-input vqb-table-select" aria-label={index === 0 ? "Source table" : `Join ${index} table`} value={table.name} disabled={addingJoin} onChange={event => index === 0 ? replaceSource(event.target.value) : void changeJoinTable(join!.id, event.target.value)}>
            {tables.map(entry => <option key={entry.name} value={entry.name}>{entry.name}</option>)}
          </select>
          <label className="vqb-alias-label">AS <input aria-label={`${index === 0 ? "Source" : `Join ${index}`} alias`} className="vqb-alias-input" value={table.alias} onChange={event => mutate(previous => index === 0 ? { ...previous, source: previous.source ? { ...previous.source, alias: event.target.value } : null } : { ...previous, joins: previous.joins.map(entry => entry.id === join!.id ? { ...entry, table: { ...entry.table, alias: event.target.value } } : entry) })} /></label>
        </div>
        <div className="vqb-table-columns">
          {visibleColumns.map(column => {
            const ref = { tableId: table.id, column: column.name };
            const selected = query.selections.some(selection => selection.aggregate === "" && sameColumn(selection.column, ref));
            return <button type="button" className={`vqb-table-column ${selected ? "vqb-table-column-selected" : ""}`} key={column.name} aria-label={`Select ${table.alias}.${column.name}`} aria-pressed={selected} onClick={() => selectColumn(ref)}>
              <span className="vqb-column-mark">{selected ? <Check size={11} /> : column.key_type === "PRI" ? <span className="vqb-key-mark">◆</span> : <Plus size={10} />}</span>
              <span className="vqb-column-name" title={column.name}>{column.name}</span><span className="vqb-column-type" title={column.col_type}>{column.col_type}</span>
            </button>;
          })}
          {tableColumns.length === 0 && <p className="vqb-card-loading">{schemaLoading ? "Reading columns…" : "No columns available"}</p>}
        </div>
        <button type="button" className="vqb-table-card-footer" disabled={tableColumns.length <= 6} onClick={() => setExpandedTables(previous => { const next = new Set(previous); if (next.has(table.id)) next.delete(table.id); else next.add(table.id); return next; })}>
          {tableColumns.length} columns{tableColumns.length > 6 && <><span>· {expanded ? "Show less" : "Show all"}</span><ChevronDown size={11} /></>}
        </button>
      </section>
    </div>;
  }

  return <div className="visual-query-builder">
    <header className="vqb-header">
      <div className="vqb-heading"><div className="vqb-heading-icon"><GitMerge size={19} /></div><div><h2>Visual Query Builder</h2><p>Connect tables. Shape your results.</p></div></div>
      <div className="vqb-header-actions"><span className="vqb-security-badge"><ShieldCheck size={12} />Bound parameters</span><button type="button" className="vqb-button vqb-button-subtle" onClick={reset} disabled={executing || tablesLoading} title="Reset query"><RotateCcw size={13} /><span>Reset</span></button><button type="button" className="vqb-button vqb-button-primary" onClick={() => void runQuery()} disabled={!canRun || executing}>{executing ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}{executing ? "Running…" : "Run query"}</button></div>
    </header>
    {!selectedDb ? <div className="vqb-empty vqb-main-empty"><Database size={30} /><h3>Choose a database to start</h3><p>Select a database from the sidebar, then build a query with its tables.</p></div>
      : tablesLoading ? <div className="vqb-empty vqb-main-empty" role="status"><Loader2 size={26} className="animate-spin" /><p>Loading your database…</p></div>
      : <div className="vqb-scroll">
        <div className="vqb-context"><span><Database size={12} />{selectedDb}</span><span>{tables.length} tables & views</span><span className="vqb-context-engine">{dbType === "postgres" ? "PostgreSQL" : dbType === "mssql" ? "SQL Server" : dbType === "mysql" ? "MySQL / MariaDB" : dbType === "sqlite" ? "SQLite" : "Oracle"}</span></div>
        {metadataError && <div role="alert" className="vqb-error">{metadataError}<button type="button" onClick={() => setRetryVersion(value => value + 1)}>Reload schema</button></div>}
        {tables.length === 0 && !metadataError ? <div className="vqb-empty vqb-main-empty"><Table2 size={28} /><h3>No tables yet</h3><p>Create a table in this database before building a query.</p></div> : <>
          <section className="vqb-model-section" aria-label="Query tables">
            <div className="vqb-section-heading"><div><h3>Tables & relationships</h3><p>Choose columns from the table cards. Add a table to join its data.</p></div><span className="vqb-count">{selectedTables.length} {selectedTables.length === 1 ? "table" : "tables"}</span></div>
            <div className="vqb-table-canvas">{selectedTables.map(tableCard)}<div className="vqb-add-table-card"><div className="vqb-add-table-icon"><Plus size={18} /></div><label htmlFor="vqb-add-table">Add a joined table</label><select id="vqb-add-table" className="vqb-input" value={joinCandidate} onChange={event => setJoinCandidate(event.target.value)}>{tables.map(table => <option value={table.name} key={table.name}>{table.name}</option>)}</select><button type="button" className="vqb-button vqb-button-outline" disabled={!query.source || !joinCandidate || loading} onClick={() => void addJoin()}>{addingJoin ? <Loader2 size={12} className="animate-spin" /> : <GitMerge size={12} />}Add join</button></div></div>
            {query.joins.length > 0 && <div className="vqb-joins">{query.joins.map((join, index) => {
              const priorTables = selectedTables.slice(0, index + 1);
              const leftColumns = columns.filter(column => priorTables.some(table => table.id === column.ref.tableId));
              const rightColumns = columns.filter(column => column.ref.tableId === join.table.id);
              return <div className="vqb-join-editor" key={join.id}>
                <div className="vqb-join-type"><select className="vqb-input" aria-label={`Join ${index + 1} type`} value={join.type} onChange={event => mutate(previous => ({ ...previous, joins: previous.joins.map(entry => entry.id === join.id ? { ...entry, type: event.target.value as BuilderJoin["type"] } : entry) }))}>{availableJoinTypes(dbType).map(type => <option key={type} value={type}>{type} JOIN</option>)}</select><span>{join.table.alias}</span></div>
                {join.type === "CROSS" ? <p className="vqb-help">Returns every combination of rows. No join condition is needed.</p> : <div className="vqb-join-conditions">{join.conditions.map((condition, conditionIndex) => <div className="vqb-join-condition" key={condition.id}><span className="vqb-clause-label">{conditionIndex === 0 ? "ON" : "AND"}</span><ColumnSelect label={`Join ${index + 1} left column ${conditionIndex + 1}`} value={condition.left.column ? condition.left : null} options={leftColumns} onChange={column => column && mutate(previous => ({ ...previous, joins: previous.joins.map(entry => entry.id === join.id ? { ...entry, conditions: entry.conditions.map(item => item.id === condition.id ? { ...item, left: column } : item) } : entry) }))} /><select className="vqb-input vqb-comparison" aria-label={`Join ${index + 1} comparison ${conditionIndex + 1}`} value={condition.operator} onChange={event => mutate(previous => ({ ...previous, joins: previous.joins.map(entry => entry.id === join.id ? { ...entry, conditions: entry.conditions.map(item => item.id === condition.id ? { ...item, operator: event.target.value as typeof item.operator } : item) } : entry) }))}>{joinOperators.map(operator => <option key={operator}>{operator}</option>)}</select><ColumnSelect label={`Join ${index + 1} right column ${conditionIndex + 1}`} value={condition.right.column ? condition.right : null} options={rightColumns} onChange={column => column && mutate(previous => ({ ...previous, joins: previous.joins.map(entry => entry.id === join.id ? { ...entry, conditions: entry.conditions.map(item => item.id === condition.id ? { ...item, right: column } : item) } : entry) }))} /><button type="button" className="vqb-icon-button" aria-label={`Remove join ${index + 1} condition ${conditionIndex + 1}`} disabled={join.conditions.length <= 1} onClick={() => mutate(previous => ({ ...previous, joins: previous.joins.map(entry => entry.id === join.id ? { ...entry, conditions: entry.conditions.filter(item => item.id !== condition.id) } : entry) }))}><X size={13} /></button></div>)}<button type="button" className="vqb-text-button" onClick={() => mutate(previous => ({ ...previous, joins: previous.joins.map(entry => entry.id === join.id ? { ...entry, conditions: [...entry.conditions, { id: uid(), left: leftColumns[0]?.ref ?? { tableId: priorTables[0].id, column: "" }, operator: "=", right: rightColumns[0]?.ref ?? { tableId: join.table.id, column: "" } }] } : entry) }))}><Plus size={11} />Add condition</button></div>}
              </div>;
            })}</div>}
          </section>

          <div className="vqb-workspace">
            <section className="vqb-config-panel">
              <div className="vqb-tabs" role="tablist" aria-label="Query clauses">{([
                { id: "columns" as const, label: "Columns", icon: Columns3, count: query.selections.length },
                { id: "filters" as const, label: "Filters", icon: Filter, count: query.filters.length },
                { id: "grouping" as const, label: "Group & sort", icon: Layers3, count: query.groupBy.length + query.orderBy.length },
              ]).map(({ id, label, icon: Icon, count }) => <button type="button" role="tab" aria-selected={panel === id} aria-controls={`vqb-panel-${id}`} id={`vqb-tab-${id}`} key={id} className={`vqb-tab ${panel === id ? "vqb-tab-active" : ""}`} onClick={() => setPanel(id)}><Icon size={13} />{label}{count > 0 && <span>{count}</span>}</button>)}</div>
              {panel === "columns" && <div id="vqb-panel-columns" role="tabpanel" aria-labelledby="vqb-tab-columns" className="vqb-panel-body">
                <div className="vqb-panel-heading"><div><h3>Result columns</h3><p>Pick the fields and calculations to include.</p></div><div className="vqb-panel-actions"><button type="button" className="vqb-text-button" disabled={columns.length === 0} onClick={() => columns[0] && mutate(previous => ({ ...previous, selections: [...previous.selections, { id: uid(), column: columns[0].ref, aggregate: "", alias: "" }] }))}><Plus size={11} />Column</button><button type="button" className="vqb-text-button" disabled={columns.length === 0} onClick={() => mutate(previous => ({ ...previous, selections: [...previous.selections, { id: uid(), column: null, aggregate: "COUNT", alias: "" }] }))}><Plus size={11} />Aggregate</button></div></div>
                {query.selections.length === 0 ? <div className="vqb-inline-empty"><Columns3 size={22} /><strong>All columns selected</strong><p>Click a column in a table card or add a result column to choose specific fields.</p><span className="vqb-code-chip">SELECT *</span></div> : <div className="vqb-selection-list">{query.selections.map((selection, index) => <div className="vqb-selection-row" key={selection.id}><span className="vqb-row-number">{index + 1}</span><div className="vqb-selection-main"><select className="vqb-input vqb-aggregate" aria-label={`Output ${index + 1} aggregate`} value={selection.aggregate} onChange={event => { const aggregate = event.target.value as BuilderSelection["aggregate"]; updateSelection(selection.id, { aggregate, column: aggregate === "COUNT" ? selection.column : selection.column ?? columns[0]?.ref ?? null }); }}>{aggregates.map(aggregate => <option key={aggregate} value={aggregate}>{aggregate || "Column"}</option>)}</select><ColumnSelect label={`Output ${index + 1} column`} value={selection.column} options={columns} allRows={selection.aggregate === "COUNT"} onChange={column => updateSelection(selection.id, { column })} /></div><input className="vqb-input vqb-output-alias" aria-label={`Output ${index + 1} alias`} placeholder="Alias (optional)" value={selection.alias} onChange={event => updateSelection(selection.id, { alias: event.target.value })} /><button type="button" className="vqb-icon-button" aria-label={`Remove output ${index + 1}`} onClick={() => mutate(previous => ({ ...previous, selections: previous.selections.filter(entry => entry.id !== selection.id), orderBy: previous.orderBy.filter(order => order.selectionId !== selection.id) }))}><X size={13} /></button></div>)}</div>}
              </div>}

              {panel === "filters" && <div id="vqb-panel-filters" role="tabpanel" aria-labelledby="vqb-tab-filters" className="vqb-panel-body">
                <div className="vqb-panel-heading"><div><h3>Filter rows</h3><p>Values are sent separately as bound parameters.</p></div><button type="button" className="vqb-text-button" disabled={columns.length === 0} onClick={addFilter}><Plus size={11} />Add filter</button></div>
                {query.filters.length > 1 && <label className="vqb-filter-mode">Match<select className="vqb-input" aria-label="Filter matching" value={query.filterMode} onChange={event => mutate(previous => ({ ...previous, filterMode: event.target.value as "AND" | "OR" }))}><option value="AND">all conditions (AND)</option><option value="OR">any condition (OR)</option></select></label>}
                {query.filters.length === 0 ? <div className="vqb-inline-empty"><Filter size={22} /><strong>Every row is included</strong><p>Add a filter to find exactly the data you need.</p><button type="button" className="vqb-text-button" disabled={columns.length === 0} onClick={addFilter}><Plus size={11} />Add your first filter</button></div> : <div className="vqb-filter-list">{query.filters.map((filter, index) => <div className="vqb-filter-card" key={filter.id}>
                  <div className="vqb-filter-header"><span className="vqb-condition-badge">{index === 0 ? "WHERE" : query.filterMode}</span><ColumnSelect label={`Filter ${index + 1} column`} value={filter.column} options={columns} onChange={column => column && updateFilter(filter.id, { column, parameters: filter.parameters.map(() => inferredParameter(columns.find(option => sameColumn(option.ref, column))?.info)) })} /><select className="vqb-input vqb-filter-operator" aria-label={`Filter ${index + 1} operator`} value={filter.operator} onChange={event => changeFilterOperator(filter, event.target.value as BuilderFilter["operator"])}>{operators.map(operator => <option value={operator} key={operator}>{operator}</option>)}</select><button type="button" className="vqb-icon-button" aria-label={`Remove filter ${index + 1}`} onClick={() => mutate(previous => ({ ...previous, filters: previous.filters.filter(entry => entry.id !== filter.id) }))}><X size={13} /></button></div>
                  {filter.parameters.length > 0 && <div className="vqb-filter-values">{filter.parameters.map((parameter, valueIndex) => <div className="vqb-parameter-input" key={valueIndex}><span className="vqb-value-label">{filter.operator === "BETWEEN" ? valueIndex === 0 ? "From" : "To" : filter.parameters.length > 1 ? `Value ${valueIndex + 1}` : "Value"}</span><select className="vqb-input vqb-value-type" aria-label={`Filter ${index + 1} value ${valueIndex + 1} type`} value={parameter.type} onChange={event => { const type = event.target.value as QueryParameter["type"]; updateParameter(filter, valueIndex, { type, value: type === "boolean" ? "true" : type === "null" ? "" : parameter.value }); }}>{parameterTypes.map(type => <option key={type} value={type}>{typeLabels[type]}</option>)}</select>{parameter.type === "boolean" ? <select className="vqb-input" aria-label={`Filter ${index + 1} value ${valueIndex + 1}`} value={parameter.value} onChange={event => updateParameter(filter, valueIndex, { value: event.target.value })}><option value="true">True</option><option value="false">False</option></select> : parameter.type === "null" ? <span className="vqb-null-value">SQL NULL</span> : <input className="vqb-input" aria-label={`Filter ${index + 1} value ${valueIndex + 1}`} inputMode={parameter.type === "text" ? "text" : "decimal"} placeholder={parameter.type === "text" ? "Enter a value" : "Enter a number"} value={parameter.value} onChange={event => updateParameter(filter, valueIndex, { value: event.target.value })} />}{(filter.operator === "IN" || filter.operator === "NOT IN") && <button type="button" className="vqb-icon-button" aria-label={`Remove filter ${index + 1} value ${valueIndex + 1}`} disabled={filter.parameters.length <= 1} onClick={() => updateFilter(filter.id, { parameters: filter.parameters.filter((_, i) => i !== valueIndex) })}><X size={12} /></button>}</div>)}{(filter.operator === "IN" || filter.operator === "NOT IN") && <button type="button" className="vqb-text-button" onClick={() => updateFilter(filter.id, { parameters: [...filter.parameters, inferredParameter(columns.find(column => sameColumn(column.ref, filter.column))?.info)] })}><Plus size={11} />Add value</button>}</div>}
                </div>)}</div>}
              </div>}

              {panel === "grouping" && <div id="vqb-panel-grouping" role="tabpanel" aria-labelledby="vqb-tab-grouping" className="vqb-panel-body">
                <div className="vqb-panel-heading"><div><h3>Group results</h3><p>Combine rows before applying aggregate calculations.</p></div><button type="button" className="vqb-text-button" disabled={columns.every(column => query.groupBy.some(group => sameColumn(group, column.ref)))} onClick={() => { const next = columns.find(column => !query.groupBy.some(group => sameColumn(group, column.ref))); if (next) mutate(previous => ({ ...previous, groupBy: [...previous.groupBy, next.ref] })); }}><Plus size={11} />Add group</button></div>
                {query.groupBy.length === 0 ? <p className="vqb-help vqb-empty-clause">No grouping. Add columns here when mixing fields and aggregates.</p> : <div className="vqb-simple-list">{query.groupBy.map((column, index) => <div className="vqb-simple-row" key={index}><span className="vqb-clause-label">{index === 0 ? "BY" : ","}</span><ColumnSelect label={`Group ${index + 1} column`} value={column} options={columns} onChange={value => value && mutate(previous => ({ ...previous, groupBy: previous.groupBy.map((entry, i) => i === index ? value : entry) }))} /><button type="button" className="vqb-icon-button" aria-label={`Remove group ${index + 1}`} onClick={() => mutate(previous => ({ ...previous, groupBy: previous.groupBy.filter((_, i) => i !== index) }))}><X size={13} /></button></div>)}</div>}
                {query.selections.some(selection => selection.aggregate) && query.selections.some(selection => !selection.aggregate) && <button type="button" className="vqb-text-button vqb-group-shortcut" onClick={() => mutate(previous => ({ ...previous, groupBy: previous.selections.filter(selection => !selection.aggregate && selection.column).map(selection => selection.column!).filter((column, index, entries) => entries.findIndex(entry => sameColumn(entry, column)) === index) }))}>Group by selected fields</button>}
                <div className="vqb-panel-divider" />
                <div className="vqb-panel-heading"><div><h3><ArrowUpDown size={13} />Sort order</h3><p>Rules are applied from top to bottom.</p></div><button type="button" className="vqb-text-button" disabled={columns.length === 0} onClick={addOrder}><Plus size={11} />Add sort</button></div>
                {query.orderBy.length === 0 ? <p className="vqb-help vqb-empty-clause">No sorting. The database determines the row order.</p> : <div className="vqb-simple-list">{query.orderBy.map((order, index) => <div className="vqb-order-row" key={order.id}><span className="vqb-row-number">{index + 1}</span><select className="vqb-input" aria-label={`Sort ${index + 1} column`} value={order.selectionId ? `selection:${order.selectionId}` : order.column ? `column:${encodeColumn(order.column)}` : ""} onChange={event => { const value = event.target.value; const update: Partial<BuilderOrder> = value.startsWith("selection:") ? { column: null, selectionId: value.slice(10) } : { column: decodeColumn(value.slice(7)), selectionId: undefined }; mutate(previous => ({ ...previous, orderBy: previous.orderBy.map(entry => entry.id === order.id ? { ...entry, ...update } : entry) })); }}><option value="" disabled>Choose a field</option>{query.selections.length > 0 && <optgroup label="Selected outputs">{query.selections.map(selection => <option key={selection.id} value={`selection:${selection.id}`}>{selectionLabel(selection)}</option>)}</optgroup>}<optgroup label="Table columns">{columns.map(column => <option key={encodeColumn(column.ref)} value={`column:${encodeColumn(column.ref)}`}>{column.label}</option>)}</optgroup></select><select className="vqb-input vqb-sort-direction" aria-label={`Sort ${index + 1} direction`} value={order.direction} onChange={event => mutate(previous => ({ ...previous, orderBy: previous.orderBy.map(entry => entry.id === order.id ? { ...entry, direction: event.target.value as "ASC" | "DESC" } : entry) }))}><option value="ASC">Ascending ↑</option><option value="DESC">Descending ↓</option></select><div className="vqb-row-actions"><button type="button" className="vqb-icon-button" aria-label={`Move sort ${index + 1} up`} disabled={index === 0} onClick={() => mutate(previous => { const next = [...previous.orderBy]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; return { ...previous, orderBy: next }; })}><ArrowUp size={12} /></button><button type="button" className="vqb-icon-button" aria-label={`Move sort ${index + 1} down`} disabled={index === query.orderBy.length - 1} onClick={() => mutate(previous => { const next = [...previous.orderBy]; [next[index + 1], next[index]] = [next[index], next[index + 1]]; return { ...previous, orderBy: next }; })}><ArrowDown size={12} /></button><button type="button" className="vqb-icon-button" aria-label={`Remove sort ${index + 1}`} onClick={() => mutate(previous => ({ ...previous, orderBy: previous.orderBy.filter(entry => entry.id !== order.id) }))}><X size={13} /></button></div></div>)}</div>}
              </div>}
              <div className="vqb-limit"><label htmlFor="vqb-limit">Result limit</label><input id="vqb-limit" type="number" min={1} max={10000} className="vqb-input" value={query.limit} onChange={event => mutate(previous => ({ ...previous, limit: event.target.value === "" ? 0 : Number(event.target.value) }))} /><span>rows</span><span className="vqb-limit-note">Maximum 10,000</span></div>
            </section>

            <aside className="vqb-preview" aria-label="Generated SQL and parameters">
              <div className="vqb-preview-header"><span><span className="vqb-live-dot" />SQL preview</span><button type="button" className="vqb-icon-button" disabled={!compiled.sql} onClick={() => void copySql()} aria-label="Copy SQL">{copied ? <Check size={13} /> : <Copy size={13} />}</button></div>
              {loading ? <div className="vqb-preview-status" role="status"><Loader2 size={13} className="animate-spin" />Reading table metadata…</div> : compiled.error ? <div className="vqb-validation" role="status"><span>Complete your query</span><p>{compiled.error}</p></div> : <pre className="vqb-sql"><code>{compiled.sql}</code></pre>}
              <div className="vqb-parameters-header"><span>Parameters</span><span>{compiled.parameters.length}</span></div>
              {compiled.parameters.length === 0 ? <p className="vqb-parameters-empty">Filter values will appear here, separate from SQL.</p> : <ol className="vqb-bound-parameters">{compiled.parameters.map((parameter, index) => <li key={index}><span className="vqb-placeholder">{dbType === "postgres" ? `$${index + 1}` : dbType === "mssql" ? `@P${index + 1}` : dbType === "oracle" ? `:${index + 1}` : `?${index + 1}`}</span><span className="vqb-parameter-type">{typeLabels[parameter.type]}</span><code title={parameter.value}>{parameter.type === "null" ? "NULL" : parameter.value === "" ? '""' : parameter.value}</code></li>)}</ol>}
              <p className="vqb-parameter-note"><ShieldCheck size={12} />Values are bound by the database driver.</p>
            </aside>
          </div>

          <section className="vqb-results" aria-label="Query results" ref={resultsRef}>
            <div className="vqb-results-heading"><h3>Results{result && !result.error && <span>{result.rows.length.toLocaleString()} rows</span>}</h3><span>{executing ? "Running query…" : result && !result.error ? `${result.execution_time_ms.toFixed(1)} ms` : "Run your query to preview the data"}</span></div>
            {executionError ? <div role="alert" className="vqb-result-error">{executionError}</div> : result && !result.error ? <><div className="vqb-result-grid"><DataGrid columns={result.columns} rows={result.rows.slice(page * pageSize, (page + 1) * pageSize)} /></div><div className="vqb-results-footer"><span>{result.rows.length === 0 ? "No matching rows" : `${page * pageSize + 1}–${Math.min((page + 1) * pageSize, result.rows.length)} of ${result.rows.length}`}</span><div><button type="button" className="vqb-icon-button" aria-label="Previous result page" disabled={page === 0} onClick={() => setPage(value => value - 1)}><ChevronLeft size={14} /></button><span>Page {page + 1} of {resultPageCount}</span><button type="button" className="vqb-icon-button" aria-label="Next result page" disabled={page + 1 >= resultPageCount} onClick={() => setPage(value => value + 1)}><ChevronRight size={14} /></button></div><select className="vqb-input" aria-label="Results per page" value={pageSize} onChange={event => { setPageSize(Number(event.target.value)); setPage(0); }}>{[25, 50, 100, 250].map(size => <option key={size} value={size}>{size} / page</option>)}</select></div></> : <div className="vqb-results-empty"><Play size={20} /><p>Your results will appear here.</p><span>Build a query above, then choose Run query.</span></div>}
          </section>
        </>}
      </div>}
  </div>;
}
