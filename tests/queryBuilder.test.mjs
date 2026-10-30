import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { availableJoinTypes, compileQuery, createEmptyQuery, quoteIdentifier } from "../src/utils/queryBuilder.ts";

const column = (name, col_type = "TEXT") => ({ name, col_type, nullable: true, key_type: "", default_value: null, extra: "", charset: "", collation: "", comment: "" });
const schema = {
  users: [column("id", "INTEGER"), column("name"), column("active", "INTEGER")],
  orders: [column("id", "INTEGER"), column("user_id", "INTEGER"), column("total", "NUMERIC")],
};
const ref = (tableId, name) => ({ tableId, column: name });
const parameter = (value, type = "text") => ({ type, value });
const selection = (id, tableId, name, aggregate = "", alias = "") => ({ id, column: tableId ? ref(tableId, name) : null, aggregate, alias });
const state = () => ({ ...createEmptyQuery(), source: { id: "users", name: "users", alias: "u" } });
const join = (type = "LEFT") => ({ id: "join-orders", type, table: { id: "orders", name: "orders", alias: "o" }, conditions: [{ id: "on-user", left: ref("users", "id"), operator: "=", right: ref("orders", "user_id") }] });

function compiled(definition, engine = "sqlite", metadata = schema) {
  const result = compileQuery(engine, definition, metadata);
  assert.equal(result.error, null, result.error ?? undefined);
  return result;
}

function values(query) {
  return query.parameters.map(value => {
    if (value.type === "integer") return BigInt(value.value.trim());
    if (value.type === "decimal") return value.value;
    if (value.type === "boolean") return value.value.trim().toLowerCase() === "true" ? 1 : 0;
    if (value.type === "null") return null;
    return value.value;
  });
}

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, active INTEGER);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER, total NUMERIC);
    INSERT INTO users VALUES (1, 'Alice', 1), (2, 'Bob', 0), (3, 'Carol', 1);
    INSERT INTO orders VALUES (10, 1, 40), (11, 1, 60), (12, 2, 20), (13, 4, 15);
  `);
  return db;
}

test("LEFT JOIN, grouping, multiple aggregates, aggregate ordering and bound filters return expected rows", () => {
  const db = database();
  try {
    const query = compiled({
      ...state(),
      joins: [join()],
      selections: [selection("user", "users", "name", "", "customer"), selection("count", "orders", "id", "COUNT", "order_count"), selection("total", "orders", "total", "SUM", "spent")],
      filters: [{ id: "active", column: ref("users", "active"), operator: "=", parameters: [parameter("true", "boolean")] }],
      groupBy: [ref("users", "name")],
      orderBy: [{ id: "sort-total", column: null, selectionId: "total", direction: "DESC" }],
      limit: 25,
    });
    assert.match(query.sql, /ORDER BY SUM\("o"\."total"\) DESC/);
    const rows = db.prepare(query.sql).all(...values(query)).map(row => ({ ...row }));
    assert.deepEqual(rows, [
      { customer: "Alice", order_count: 2, spent: 100 },
      { customer: "Carol", order_count: 0, spent: null },
    ]);
  } finally { db.close(); }
});

test("INNER, RIGHT, FULL OUTER and CROSS JOIN retain their actual join semantics", () => {
  const db = database();
  try {
    const definition = {
      ...state(),
      selections: [selection("user-id", "users", "id", "", "user_id"), selection("order-id", "orders", "id", "", "order_id")],
      orderBy: [{ id: "sort-user", column: ref("users", "id"), direction: "ASC" }, { id: "sort-order", column: ref("orders", "id"), direction: "ASC" }],
    };
    const inner = compiled({ ...definition, joins: [join("INNER")] });
    assert.deepEqual(db.prepare(inner.sql).all().map(row => ({ ...row })), [
      { user_id: 1, order_id: 10 }, { user_id: 1, order_id: 11 }, { user_id: 2, order_id: 12 },
    ]);
    const right = compiled({ ...definition, joins: [join("RIGHT")] });
    assert.deepEqual(db.prepare(right.sql).all().map(row => ({ ...row })), [
      { user_id: null, order_id: 13 }, { user_id: 1, order_id: 10 }, { user_id: 1, order_id: 11 }, { user_id: 2, order_id: 12 },
    ]);
    const full = compiled({ ...definition, joins: [join("FULL")] });
    assert.deepEqual(db.prepare(full.sql).all().map(row => ({ ...row })), [
      { user_id: null, order_id: 13 }, { user_id: 1, order_id: 10 }, { user_id: 1, order_id: 11 }, { user_id: 2, order_id: 12 }, { user_id: 3, order_id: null },
    ]);
    const cross = compiled({ ...state(), joins: [{ ...join("CROSS"), conditions: [] }], selections: [selection("all", null, null, "COUNT", "combinations")] });
    assert.doesNotMatch(cross.sql, /\bON\b/);
    assert.equal(db.prepare(cross.sql).get().combinations, 12);
  } finally { db.close(); }
});

test("self joins use independent aliases, and chained joins can connect through earlier joined tables", () => {
  const db = database();
  try {
    db.exec("CREATE TABLE employees (id INTEGER, name TEXT, manager_id INTEGER); INSERT INTO employees VALUES (1, 'Manager', NULL), (2, 'Member', 1)");
    const employees = [column("id"), column("name"), column("manager_id")];
    const query = compiled({
      ...createEmptyQuery(), source: { id: "employee", name: "employees", alias: "e" },
      joins: [{ id: "manager-join", type: "INNER", table: { id: "manager", name: "employees", alias: "m" }, conditions: [{ id: "manager-match", left: ref("employee", "manager_id"), operator: "=", right: ref("manager", "id") }] }],
      selections: [selection("member", "employee", "name", "", "member"), selection("boss", "manager", "name", "", "boss")],
    }, "sqlite", { employees });
    assert.deepEqual({ ...db.prepare(query.sql).get() }, { member: "Member", boss: "Manager" });
    const chained = compiled({
      ...state(), joins: [join("INNER"), { id: "self-order", type: "INNER", table: { id: "other-order", name: "orders", alias: "oo" }, conditions: [{ id: "shared-user", left: ref("orders", "user_id"), operator: "=", right: ref("other-order", "user_id") }] }],
      selections: [selection("total", null, null, "COUNT", "pairs")],
    });
    assert.equal(db.prepare(chained.sql).get().pairs, 5);
  } finally { db.close(); }
});

test("SQL injection payloads stay in bound values and quoted metadata identifiers", () => {
  const db = database();
  try {
    const payload = "O'Reilly' OR 1=1; DROP TABLE users;--";
    db.prepare("INSERT INTO users VALUES (?, ?, ?)").run(4, payload, 1);
    const query = compiled({ ...state(), filters: [{ id: "exact-name", column: ref("users", "name"), operator: "=", parameters: [parameter(payload)] }] });
    assert.equal(query.sql.includes(payload), false);
    assert.equal(query.parameters[0].value, payload);
    assert.deepEqual(db.prepare(query.sql).all(...values(query)).map(row => row.id), [4]);
    assert.equal(db.prepare("SELECT count(*) AS count FROM users").get().count, 4);

    const table = 'odd.table"; DROP TABLE users;--';
    const field = 'select";--';
    db.exec(`CREATE TABLE ${quoteIdentifier("sqlite", table)} (${quoteIdentifier("sqlite", field)} TEXT)`);
    db.prepare(`INSERT INTO ${quoteIdentifier("sqlite", table)} VALUES (?)`).run("needle");
    const escaped = compiled({ ...createEmptyQuery(), source: { id: "odd", name: table, alias: 'x";--' }, filters: [{ id: "value", column: ref("odd", field), operator: "=", parameters: [parameter("needle")] }] }, "sqlite", { [table]: [column(field)] });
    assert.equal(db.prepare(escaped.sql).all(...values(escaped)).length, 1);
    assert.equal(db.prepare("SELECT count(*) AS count FROM users").get().count, 4);
  } finally { db.close(); }
});

test("IN, BETWEEN, LIKE, NULL checks and OR filters keep parameter order and boolean grouping", () => {
  const db = database();
  try {
    const query = compiled({
      ...state(),
      filters: [
        { id: "range", column: ref("users", "id"), operator: "BETWEEN", parameters: [parameter("1", "integer"), parameter("2", "integer")] },
        { id: "names", column: ref("users", "name"), operator: "IN", parameters: [parameter("Carol"), parameter("Nonexistent")] },
      ],
      filterMode: "OR",
      orderBy: [{ id: "by-name", column: ref("users", "name"), direction: "DESC" }],
    });
    assert.match(query.sql, /WHERE \("u"\."id" BETWEEN \? AND \?\) OR \("u"\."name" IN \(\?, \?\)\)/);
    assert.deepEqual(query.parameters.map(value => value.value), ["1", "2", "Carol", "Nonexistent"]);
    assert.deepEqual(db.prepare(query.sql).all(...values(query)).map(row => row.name), ["Carol", "Bob", "Alice"]);
    const like = compiled({ ...state(), filters: [{ id: "like", column: ref("users", "name"), operator: "LIKE", parameters: [parameter("A%")] }] });
    assert.deepEqual(db.prepare(like.sql).all(...values(like)).map(row => row.name), ["Alice"]);
    db.exec("UPDATE users SET name=NULL WHERE id=3");
    const missing = compiled({ ...state(), filters: [{ id: "missing", column: ref("users", "name"), operator: "IS NULL", parameters: [] }] });
    assert.equal(missing.parameters.length, 0);
    assert.deepEqual(db.prepare(missing.sql).all().map(row => row.id), [3]);
  } finally { db.close(); }
});

test("each dialect emits native bind placeholders, quoting, limits, and supported join types", () => {
  const definition = { ...state(), filters: [{ id: "range", column: ref("users", "id"), operator: "BETWEEN", parameters: [parameter("1", "integer"), parameter("2", "integer")] }], limit: 37 };
  for (const engine of ["sqlite", "mysql", "postgres", "mssql", "oracle"]) {
    const query = compiled(definition, engine);
    assert.deepEqual(query.parameters.map(value => value.value), ["1", "2"]);
    if (engine === "postgres") assert.match(query.sql, /BETWEEN \$1 AND \$2/);
    else if (engine === "mssql") assert.match(query.sql, /BETWEEN @P1 AND @P2/);
    else if (engine === "oracle") assert.match(query.sql, /BETWEEN :1 AND :2/);
    else assert.match(query.sql, /BETWEEN \? AND \?/);
    if (engine === "mssql") { assert.match(query.sql, /^SELECT TOP \(37\)/); assert.doesNotMatch(query.sql, /LIMIT|FETCH FIRST/); }
    else if (engine === "oracle") assert.match(query.sql, /FETCH FIRST 37 ROWS ONLY$/);
    else assert.match(query.sql, /LIMIT 37$/);
  }
  assert.equal(quoteIdentifier("mysql", "has`quote"), "`has``quote`");
  assert.equal(quoteIdentifier("mssql", "has]quote"), "[has]]quote]");
  assert.equal(availableJoinTypes("mysql").includes("FULL"), false);
  assert.match(compileQuery("mysql", { ...state(), joins: [join("FULL")] }, schema).error, /FULL OUTER JOIN/);
});

test("missing metadata, unknown identifiers, duplicate aliases and disconnected joins are refused", () => {
  const fail = (definition, pattern, metadata = schema) => {
    const result = compileQuery("sqlite", definition, metadata);
    assert.match(result.error, pattern);
    assert.equal(result.sql, "");
    assert.deepEqual(result.parameters, []);
  };
  fail(createEmptyQuery(), /source table/);
  fail(state(), /Load columns/, {});
  fail({ ...state(), selections: [selection("fake", "users", 'id; DROP TABLE users')] }, /existing column/);
  fail({ ...state(), joins: [{ ...join(), table: { ...join().table, alias: "U" } }] }, /aliases must be unique/);
  fail({ ...state(), joins: [{ ...join(), conditions: [] }] }, /at least one condition/);
  fail({ ...state(), joins: [{ ...join(), conditions: [{ id: "self", left: ref("orders", "id"), operator: "=", right: ref("orders", "id") }] }] }, /connect the new table/);
  fail({ ...state(), joins: [{ ...join(), conditions: [{ id: "future", left: ref("future", "id"), operator: "=", right: ref("orders", "id") }] }] }, /no longer in the query/);
  fail({ ...state(), joins: [{ ...join(), conditions: [{ ...join().conditions[0], operator: "= 1; DROP TABLE users;--" }] }] }, /supported comparison/);
  fail({ ...state(), filters: [{ id: "operator", column: ref("users", "id"), operator: "= 1 OR 1=1", parameters: [] }] }, /supported filter/);
});

test("grouping rules prevent ambiguous rows while allowing aggregate-only queries and aggregate sorting", () => {
  const grouped = { ...state(), selections: [selection("name", "users", "name"), selection("count", null, null, "COUNT", "people")] };
  assert.match(compileQuery("sqlite", grouped, schema).error, /non-aggregated output column/);
  assert.match(compileQuery("sqlite", { ...state(), groupBy: [ref("users", "active")] }, schema).error, /Choose output columns/);
  const valid = { ...grouped, groupBy: [ref("users", "name")] };
  assert.equal(compileQuery("sqlite", valid, schema).error, null);
  assert.match(compileQuery("sqlite", { ...valid, orderBy: [{ id: "invalid-sort", column: ref("users", "id"), direction: "ASC" }] }, schema).error, /ORDER BY must use a grouped column/);
  const sorted = compiled({ ...valid, orderBy: [{ id: "aggregate-sort", column: null, selectionId: "count", direction: "DESC" }] });
  assert.match(sorted.sql, /ORDER BY COUNT\(\*\) DESC/);
  assert.match(compileQuery("sqlite", { ...valid, orderBy: [{ id: "stale", column: null, selectionId: "removed-selection", direction: "DESC" }] }, schema).error, /existing output column/);
  const onlyAggregate = compiled({ ...state(), selections: [selection("count", null, null, "COUNT", "people")] });
  const db = database();
  try { assert.equal(db.prepare(onlyAggregate.sql).get().people, 3); } finally { db.close(); }
});

test("invalid values, unsafe limits, incomplete filters and oversized parameter lists stop before execution", () => {
  const errorFor = (value, type) => compileQuery("sqlite", { ...state(), filters: [{ id: "filter", column: ref("users", "id"), operator: "=", parameters: [parameter(value, type)] }] }, schema).error;
  assert.match(errorFor("1 OR 1=1", "integer"), /whole number/);
  assert.match(errorFor("9223372036854775808", "integer"), /64-bit/);
  assert.equal(errorFor("9223372036854775807", "integer"), null);
  assert.match(errorFor("NaN", "decimal"), /finite number/);
  assert.match(errorFor("1e999", "decimal"), /finite number/);
  assert.match(errorFor("yes", "boolean"), /true or false/);
  for (const limit of [0, -1, 2.5, Infinity, 10001, "100; DROP TABLE users"]) {
    assert.match(compileQuery("sqlite", { ...state(), limit }, schema).error, /row limit/);
  }
  assert.match(compileQuery("sqlite", { ...state(), filters: [{ id: "between", column: ref("users", "id"), operator: "BETWEEN", parameters: [parameter("1", "integer")] }] }, schema).error, /two parameters/);
  assert.match(compileQuery("sqlite", { ...state(), filters: [{ id: "empty", column: ref("users", "id"), operator: "IN", parameters: [] }] }, schema).error, /at least one parameter/);
  const many = { ...state(), filters: [{ id: "too-many", column: ref("users", "id"), operator: "IN", parameters: Array.from({ length: 2001 }, () => parameter("1", "integer")) }] };
  assert.match(compileQuery("mssql", many, schema).error, /2000 parameters/);
  assert.match(compileQuery("oracle", many, schema).error, /1000 values/);
});
