export type DbType = "sqlite" | "mysql" | "postgres" | "oracle" | "mssql";

export interface SshConfig {
  host: string;
  port: number;
  user: string;
  password: string;
}

export interface ConnectionProfile {
  id: string;
  name: string;
  type: DbType;
  color: string; // "blue"|"green"|"red"|"orange"|"purple"|"gray"
  // SQLite
  filePath: string;
  // MySQL / PostgreSQL / Oracle
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  // Oracle
  serviceName: string;
  // SSH tunnel (optional)
  ssh: SshConfig | null;
  // SSL
  requireSsl: boolean;
}

export interface ColumnDef {
  name: string;
  col_type: string;
  nullable: boolean;
  is_primary_key: boolean;
  default_value: string | null;
}

export interface QueryResult {
  columns: ColumnDef[];
  rows: (string | null)[][];
  affected_rows: number;
  last_insert_id: number;
  execution_time_ms: number;
  error: string | null;
}

export interface TableInfo {
  name: string;
  table_type: string; // "table" or "view"
}

export interface ColumnInfo {
  name: string;
  col_type: string;
  nullable: boolean;
  key_type: string; // "PRI", "UNI", "MUL", ""
  default_value: string | null;
  extra: string;
  charset: string;
  collation: string;
  comment: string;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  index_type: string;
}

export type ActiveTab = "browse" | "structure" | "query" | "relations" | "triggers" | "info";
export type Theme = "dark" | "light" | "system";

export interface ServerStatus {
  name: string;
  available: boolean;
}

export interface ForeignKeyInfo {
  constraint_name: string;
  column_name: string;
  referenced_table: string;
  referenced_column: string;
}

export interface TriggerInfo {
  name: string;
  event: string;
  timing: string;
  statement: string;
}

export interface TableInfoData {
  row_count: string;
  size: string;
  data_size: string;
  index_size: string;
  auto_increment: string | null;
  engine: string;
  collation: string;
  created: string;
  comment: string;
}
