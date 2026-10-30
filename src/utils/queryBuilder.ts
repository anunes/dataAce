import type { ColumnInfo, DbType } from "../types";

export interface QueryParameter {
  type: "text" | "integer" | "decimal" | "boolean" | "null";
  value: string;
}

export interface ColumnRef {
  tableId: string;
  column: string;
}

export interface BuilderTable {
  id: string;
  name: string;
  alias: string;
}

export const JOIN_OPERATORS = ["=", "!=", "<", ">", "<=", ">="] as const;
export const FILTER_OPERATORS = ["=", "!=", "<", ">", "<=", ">=", "LIKE", "NOT LIKE", "IS NULL", "IS NOT NULL", "IN", "NOT IN", "BETWEEN"] as const;
export const AGGREGATES = ["", "COUNT", "SUM", "AVG", "MIN", "MAX"] as const;

export interface BuilderJoin {
  id: string;
  type: "INNER" | "LEFT" | "RIGHT" | "FULL" | "CROSS";
  table: BuilderTable;
  conditions: Array<{
    id: string;
    left: ColumnRef;
    operator: typeof JOIN_OPERATORS[number];
    right: ColumnRef;
  }>;
}

export interface BuilderSelection {
  id: string;
  column: ColumnRef | null;
  aggregate: typeof AGGREGATES[number];
  alias: string;
}

export interface BuilderFilter {
  id: string;
  column: ColumnRef;
  operator: typeof FILTER_OPERATORS[number];
  parameters: QueryParameter[];
}

export interface BuilderOrder {
  id: string;
  column: ColumnRef | null;
  selectionId?: string;
  direction: "ASC" | "DESC";
}

export interface QueryBuilderState {
  source: BuilderTable | null;
  joins: BuilderJoin[];
  selections: BuilderSelection[];
  filters: BuilderFilter[];
  filterMode: "AND" | "OR";
  groupBy: ColumnRef[];
  orderBy: BuilderOrder[];
  limit: number;
}

export interface CompiledQuery {
  sql: string;
  parameters: QueryParameter[];
  error: string | null;
}

const DATABASES = new Set<DbType>(["sqlite", "mysql", "postgres", "oracle", "mssql"]);
const PARAMETER_TYPES = new Set<QueryParameter["type"]>(["text", "integer", "decimal", "boolean", "null"]);
const ALL_JOINS: BuilderJoin["type"][] = ["INNER", "LEFT", "RIGHT", "FULL", "CROSS"];
const MAX_PARAMETERS = 2000;

export function createEmptyQuery(): QueryBuilderState {
  return { source: null, joins: [], selections: [], filters: [], filterMode: "AND", groupBy: [], orderBy: [], limit: 100 };
}

export function availableJoinTypes(dbType: DbType): BuilderJoin["type"][] {
  return ALL_JOINS.filter(type => dbType !== "mysql" || type !== "FULL");
}

export function quoteIdentifier(dbType: DbType, name: string): string {
  if (dbType === "mysql") return `\`${name.replace(/`/g, "``")}\``;
  if (dbType === "mssql") return `[${name.replace(/]/g, "]]")}]`;
  return `"${name.replace(/"/g, '""')}"`;
}

function requireIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Enter ${label}.`);
  if (value.includes("\0")) throw new Error(`${label[0].toUpperCase() + label.slice(1)} cannot contain a null character.`);
  return value;
}

function requireParameter(parameter: QueryParameter): QueryParameter {
  if (!parameter || !PARAMETER_TYPES.has(parameter.type) || typeof parameter.value !== "string") {
    throw new Error("Choose a supported type and enter a value for each parameter.");
  }
  const value = parameter.value.trim();
  if (parameter.type === "integer") {
    if (!/^[+-]?\d+$/.test(value)) throw new Error("Integer parameters must contain a whole number.");
    const number = BigInt(value);
    if (number < -9223372036854775808n || number > 9223372036854775807n) {
      throw new Error("Integer parameters must fit in a signed 64-bit integer. Use Decimal for larger values.");
    }
  } else if (parameter.type === "decimal") {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) || !Number.isFinite(Number(value))) {
      throw new Error("Decimal parameters must contain a finite number.");
    }
  } else if (parameter.type === "boolean" && value.toLowerCase() !== "true" && value.toLowerCase() !== "false") {
    throw new Error("Boolean parameters must be true or false.");
  }
  return { type: parameter.type, value: parameter.value };
}

function referenceKey(reference: ColumnRef): string {
  return JSON.stringify([reference.tableId, reference.column]);
}

/** Compile only structured identifiers/operators; values leave this function as bind parameters. */
export function compileQuery(dbType: DbType, state: QueryBuilderState, schema: Record<string, ColumnInfo[]>): CompiledQuery {
  try {
    if (!DATABASES.has(dbType)) throw new Error("Choose a supported database engine.");
    if (!state?.source) throw new Error("Choose a source table to start building your query.");
    if (![state.joins, state.selections, state.filters, state.groupBy, state.orderBy].every(Array.isArray)) {
      throw new Error("The query definition is incomplete. Reset the builder and try again.");
    }
    if (state.filterMode !== "AND" && state.filterMode !== "OR") throw new Error("Choose AND or OR for the filter conditions.");
    if (!Number.isInteger(state.limit) || state.limit < 1 || state.limit > 10000) {
      throw new Error("The row limit must be a whole number between 1 and 10000.");
    }

    const tables = new Map<string, BuilderTable>();
    const aliases = new Set<string>();
    const quote = (name: string) => quoteIdentifier(dbType, name);
    function addTable(table: BuilderTable) {
      if (!table || typeof table.id !== "string" || !table.id) throw new Error("Choose a valid table.");
      if (tables.has(table.id)) throw new Error("Each table in the query needs a unique table reference.");
      const name = requireIdentifier(table.name, "a table name");
      if (!schema || !Object.prototype.hasOwnProperty.call(schema, name) || !Array.isArray(schema[name])) {
        throw new Error(`Load columns for the table “${name}” before running the query.`);
      }
      const alias = requireIdentifier(table.alias, "a table alias").trim();
      if (aliases.has(alias.toLowerCase())) throw new Error(`Table aliases must be unique: ${alias}.`);
      aliases.add(alias.toLowerCase());
      tables.set(table.id, { ...table, alias });
    }
    function columnSql(reference: ColumnRef | null): string {
      if (!reference || typeof reference.tableId !== "string" || typeof reference.column !== "string") {
        throw new Error("Choose a column for each query field.");
      }
      const table = tables.get(reference.tableId);
      if (!table) throw new Error("A query field refers to a table that is no longer in the query.");
      if (!schema[table.name].some(column => column.name === reference.column)) {
        throw new Error(`Choose an existing column from ${table.alias}; “${reference.column}” is unavailable.`);
      }
      requireIdentifier(reference.column, "a column name");
      return `${quote(table.alias)}.${quote(reference.column)}`;
    }
    function tableSql(table: BuilderTable): string {
      return `${quote(table.name)} ${quote(tables.get(table.id)!.alias)}`;
    }

    addTable(state.source);
    const joinLines: string[] = [];
    for (const join of state.joins) {
      if (!join || !availableJoinTypes(dbType).includes(join.type)) {
        throw new Error(dbType === "mysql" && join?.type === "FULL" ? "MySQL does not support FULL OUTER JOIN. Choose another join type." : "Choose a supported join type.");
      }
      const previousTables = new Set(tables.keys());
      addTable(join.table);
      if (join.type === "CROSS") {
        joinLines.push(`CROSS JOIN ${tableSql(join.table)}`);
        continue;
      }
      if (!Array.isArray(join.conditions) || !join.conditions.length) throw new Error("Add at least one condition connecting each joined table.");
      const conditions = join.conditions.map(condition => {
        if (!condition || !JOIN_OPERATORS.includes(condition.operator)) throw new Error("Choose a supported comparison for each join condition.");
        const left = columnSql(condition.left);
        const right = columnSql(condition.right);
        const connectsNewTable = (condition.left.tableId === join.table.id && previousTables.has(condition.right.tableId))
          || (condition.right.tableId === join.table.id && previousTables.has(condition.left.tableId));
        if (!connectsNewTable) throw new Error("Join conditions must connect the new table to a previously added table.");
        return `${left} ${condition.operator} ${right}`;
      });
      const type = join.type === "FULL" ? "FULL OUTER" : join.type;
      joinLines.push(`${type} JOIN ${tableSql(join.table)} ON ${conditions.join(" AND ")}`);
    }

    const groups = new Set<string>();
    const groupExpressions = state.groupBy.map(reference => {
      const expression = columnSql(reference);
      const key = referenceKey(reference);
      if (groups.has(key)) throw new Error("Choose each GROUP BY column only once.");
      groups.add(key);
      return expression;
    });
    const grouped = groupExpressions.length > 0 || state.selections.some(selection => !!selection.aggregate);
    if (grouped && !state.selections.length) throw new Error("Choose output columns or aggregates for a grouped query.");
    const selectionExpressions = new Map<string, string>();
    const selectionAliases = new Set<string>();
    const selected = state.selections.map(selection => {
      if (!selection || typeof selection.id !== "string" || !selection.id || selectionExpressions.has(selection.id)) {
        throw new Error("Each output column needs a unique reference.");
      }
      if (!AGGREGATES.includes(selection.aggregate)) throw new Error("Choose a supported aggregate function.");
      if (!selection.column && selection.aggregate !== "COUNT") throw new Error("Choose an output column; only COUNT supports all rows (*).");
      const column = selection.column ? columnSql(selection.column) : "*";
      if (grouped && !selection.aggregate && selection.column && !groups.has(referenceKey(selection.column))) {
        throw new Error("Add every non-aggregated output column to GROUP BY.");
      }
      const expression = selection.aggregate ? `${selection.aggregate}(${column})` : column;
      selectionExpressions.set(selection.id, expression);
      if (typeof selection.alias !== "string") throw new Error("Enter a valid output alias.");
      const alias = selection.alias.trim();
      if (!alias) return expression;
      requireIdentifier(alias, "an output alias");
      if (selectionAliases.has(alias.toLowerCase())) throw new Error(`Output aliases must be unique: ${alias}.`);
      selectionAliases.add(alias.toLowerCase());
      return `${expression} AS ${quote(alias)}`;
    });

    const parameters: QueryParameter[] = [];
    function bind(parameter: QueryParameter): string {
      parameters.push(requireParameter(parameter));
      if (parameters.length > MAX_PARAMETERS) throw new Error(`Use no more than ${MAX_PARAMETERS} parameters in a query.`);
      if (dbType === "postgres") return `$${parameters.length}`;
      if (dbType === "mssql") return `@P${parameters.length}`;
      if (dbType === "oracle") return `:${parameters.length}`;
      return "?";
    }
    const filters = state.filters.map(filter => {
      if (!filter || !FILTER_OPERATORS.includes(filter.operator)) throw new Error("Choose a supported filter operator.");
      const column = columnSql(filter.column);
      if (!Array.isArray(filter.parameters)) throw new Error("Enter the filter's parameter values.");
      if (filter.operator === "IS NULL" || filter.operator === "IS NOT NULL") return `${column} ${filter.operator}`;
      if (filter.operator === "IN" || filter.operator === "NOT IN") {
        if (!filter.parameters.length) throw new Error("Add at least one parameter for IN or NOT IN.");
        if (dbType === "oracle" && filter.parameters.length > 1000) throw new Error("Oracle IN filters support up to 1000 values per condition.");
        return `${column} ${filter.operator} (${filter.parameters.map(bind).join(", ")})`;
      }
      const expected = filter.operator === "BETWEEN" ? 2 : 1;
      if (filter.parameters.length !== expected) throw new Error(`Enter ${expected === 2 ? "two parameters for BETWEEN" : "one parameter for each comparison"}.`);
      if (filter.operator === "BETWEEN") return `${column} BETWEEN ${bind(filter.parameters[0])} AND ${bind(filter.parameters[1])}`;
      return `${column} ${filter.operator} ${bind(filter.parameters[0])}`;
    });
    const ordered = state.orderBy.map(order => {
      if (!order || (order.direction !== "ASC" && order.direction !== "DESC")) throw new Error("Choose ASC or DESC for each sort field.");
      let expression: string;
      if (order.selectionId) {
        const selection = selectionExpressions.get(order.selectionId);
        if (!selection) throw new Error("Choose an existing output column for ORDER BY.");
        expression = selection;
      } else {
        expression = columnSql(order.column);
        if (grouped && order.column && !groups.has(referenceKey(order.column))) {
          throw new Error("ORDER BY must use a grouped column or a selected aggregate in a grouped query.");
        }
      }
      return `${expression} ${order.direction}`;
    });

    const lines = [
      `SELECT${dbType === "mssql" ? ` TOP (${state.limit})` : ""} ${selected.length ? selected.join(", ") : "*"}`,
      `FROM ${tableSql(state.source)}`,
      ...joinLines,
    ];
    if (filters.length) lines.push(`WHERE ${filters.map(filter => `(${filter})`).join(` ${state.filterMode} `)}`);
    if (groupExpressions.length) lines.push(`GROUP BY ${groupExpressions.join(", ")}`);
    if (ordered.length) lines.push(`ORDER BY ${ordered.join(", ")}`);
    if (dbType === "oracle") lines.push(`FETCH FIRST ${state.limit} ROWS ONLY`);
    else if (dbType !== "mssql") lines.push(`LIMIT ${state.limit}`);
    return { sql: lines.join("\n"), parameters, error: null };
  } catch (error) {
    return { sql: "", parameters: [], error: error instanceof Error ? error.message : "The query definition is invalid." };
  }
}
