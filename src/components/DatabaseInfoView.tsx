import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DbType, QueryResult } from "../types";
import { Database, Loader2 } from "lucide-react";

interface Props {
  connId: string;
  database: string;
  dbType: DbType;
}

interface DbInfo {
  tableCount: number;
  viewCount: number;
  charset?: string;
  collation?: string;
  size?: string;
  version?: string;
}

export default function DatabaseInfoView({ connId, database, dbType }: Props) {
  const [info, setInfo] = useState<DbInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    loadInfo();
  }, [connId, database, dbType]);

  async function query(sql: string): Promise<QueryResult> {
    return invoke<QueryResult>("execute_query", { connId, sql });
  }

  async function loadInfo() {
    try {
      const result: DbInfo = { tableCount: 0, viewCount: 0 };

      if (dbType === "mysql") {
        const schema = await query(
          `SELECT DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = '${database.replace(/'/g, "''")}'`
        );
        if (schema.rows?.[0]) {
          result.charset = schema.rows[0][0] ?? undefined;
          result.collation = schema.rows[0][1] ?? undefined;
        }
        const sizeRes = await query(
          `SELECT ROUND(SUM(data_length + index_length) / 1024 / 1024, 2) FROM information_schema.TABLES WHERE table_schema = '${database.replace(/'/g, "''")}'`
        );
        if (sizeRes.rows?.[0]?.[0]) result.size = `${sizeRes.rows[0][0]} MB`;

        const tables = await query(
          `SELECT table_type, COUNT(*) FROM information_schema.TABLES WHERE table_schema = '${database.replace(/'/g, "''")}' GROUP BY table_type`
        );
        for (const row of tables.rows ?? []) {
          if (row[0] === "BASE TABLE") result.tableCount = parseInt(row[1] ?? "0");
          if (row[0] === "VIEW") result.viewCount = parseInt(row[1] ?? "0");
        }
        const ver = await query("SELECT VERSION()");
        result.version = ver.rows?.[0]?.[0] ?? undefined;

      } else if (dbType === "postgres") {
        const sizeRes = await query(`SELECT pg_size_pretty(pg_database_size('${database.replace(/'/g, "''")}'))`);
        result.size = sizeRes.rows?.[0]?.[0] ?? undefined;

        const collRes = await query(`SELECT datcollate FROM pg_database WHERE datname = '${database.replace(/'/g, "''")}'`);
        result.collation = collRes.rows?.[0]?.[0] ?? undefined;

        const tabRes = await query(
          `SELECT table_type, COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' GROUP BY table_type`
        );
        for (const row of tabRes.rows ?? []) {
          if (row[0] === "BASE TABLE") result.tableCount = parseInt(row[1] ?? "0");
          if (row[0] === "VIEW") result.viewCount = parseInt(row[1] ?? "0");
        }
        const ver = await query("SELECT version()");
        result.version = ver.rows?.[0]?.[0]?.split(" ").slice(0, 2).join(" ") ?? undefined;

      } else if (dbType === "sqlite") {
        const pages = await query("PRAGMA page_count");
        const pageSize = await query("PRAGMA page_size");
        const pc = parseInt(pages.rows?.[0]?.[0] ?? "0");
        const ps = parseInt(pageSize.rows?.[0]?.[0] ?? "4096");
        result.size = `${((pc * ps) / 1024).toFixed(1)} KB`;

        const tables = await query("SELECT COUNT(*) FROM sqlite_master WHERE type='table'");
        result.tableCount = parseInt(tables.rows?.[0]?.[0] ?? "0");
        const views = await query("SELECT COUNT(*) FROM sqlite_master WHERE type='view'");
        result.viewCount = parseInt(views.rows?.[0]?.[0] ?? "0");

        const ver = await query("SELECT sqlite_version()");
        result.version = ver.rows?.[0]?.[0] ?? undefined;

      } else if (dbType === "mssql") {
        const tables = await query(
          `SELECT type_desc, COUNT(*) FROM sys.objects WHERE type IN ('U','V') GROUP BY type_desc`
        );
        for (const row of tables.rows ?? []) {
          if (row[0] === "USER_TABLE") result.tableCount = parseInt(row[1] ?? "0");
          if (row[0] === "VIEW") result.viewCount = parseInt(row[1] ?? "0");
        }
        const ver = await query("SELECT @@VERSION");
        result.version = ver.rows?.[0]?.[0]?.split("\n")[0] ?? undefined;
      }

      setInfo(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full gap-2 text-gray-400">
        <Loader2 size={16} className="animate-spin" /> Loading database info…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-red-400 text-sm">{error}</p>
      </div>
    );
  }

  const rows: { label: string; value: string | undefined }[] = [
    { label: "Database", value: database },
    { label: "Type", value: dbType.toUpperCase() },
    { label: "Tables", value: String(info?.tableCount ?? 0) },
    { label: "Views", value: String(info?.viewCount ?? 0) },
    { label: "Size", value: info?.size },
    { label: "Character Set", value: info?.charset },
    { label: "Collation", value: info?.collation },
    { label: "Version", value: info?.version },
  ].filter(r => r.value !== undefined && r.value !== "");

  return (
    <div className="p-6 max-w-lg">
      <div className="flex items-center gap-2 mb-5">
        <Database size={16} className="text-blue-500" />
        <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">Database Info</h2>
      </div>
      <table className="w-full text-sm border-collapse">
        <tbody>
          {rows.map(r => (
            <tr key={r.label} className="border-b border-gray-100 dark:border-gray-800">
              <td className="py-2 pr-4 text-xs font-medium text-gray-400 uppercase tracking-wider w-36">{r.label}</td>
              <td className="py-2 text-gray-700 dark:text-gray-300 font-mono text-xs break-all">{r.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
