import { useState, useRef, useEffect, ReactNode } from "react";
import { ConnectionProfile } from "../types";
import { Plus, Loader2, Circle, FolderOpen, ArrowRightLeft, Info, Users } from "lucide-react";

const COLOR_MAP: Record<string, string> = {
  blue: "#3b82f6", green: "#22c55e", red: "#ef4444",
  orange: "#f97316", purple: "#a855f7", gray: "#6b7280",
};

interface Props {
  profiles: ConnectionProfile[];
  activeSessions: Set<string>;
  selectedId: string | null;
  connectingId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onEdit: (profile: ConnectionProfile) => void;
  onDelete: (id: string) => void;
  onDuplicate: (profile: ConnectionProfile) => void;
  onDisconnect: (id: string) => void;
  onOpenSqlite: () => void;
  themeIcon: ReactNode;
  onCycleTheme: () => void;
  onMigrate: () => void;
  onAbout: () => void;
  onManageUsers: () => void;
  hasMysqlSession: boolean;
}

interface ContextMenu {
  x: number;
  y: number;
  profile: ConnectionProfile;
}

export default function ConnectionsPanel({
  profiles, activeSessions, selectedId, connectingId,
  onSelect, onAdd, onEdit, onDelete, onDuplicate, onDisconnect, onOpenSqlite,
  themeIcon, onCycleTheme, onMigrate, onAbout, onManageUsers, hasMysqlSession,
}: Props) {
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = () => setContextMenu(null);
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, []);

  const sqliteProfiles  = profiles.filter(p => p.type === "sqlite");
  const mysqlProfiles   = profiles.filter(p => p.type === "mysql");
  const pgProfiles      = profiles.filter(p => p.type === "postgres");
  const oracleProfiles  = profiles.filter(p => p.type === "oracle");
  const mssqlProfiles   = profiles.filter(p => p.type === "mssql");

  function subtitle(p: ConnectionProfile) {
    if (p.type === "sqlite") {
      if (!p.filePath || p.filePath === ":memory:") return "in-memory";
      return p.filePath.split("/").pop() ?? p.filePath;
    }
    return `${p.username}@${p.host}:${p.port}`;
  }

  const TYPE_BG: Record<string, string> = {
    sqlite:   "bg-green-50 dark:bg-green-950/30 hover:bg-green-100 dark:hover:bg-green-900/40",
    mysql:    "bg-blue-50 dark:bg-blue-950/30 hover:bg-blue-100 dark:hover:bg-blue-900/40",
    postgres: "bg-orange-50 dark:bg-orange-950/30 hover:bg-orange-100 dark:hover:bg-orange-900/40",
    oracle:   "bg-red-50 dark:bg-red-950/30 hover:bg-red-100 dark:hover:bg-red-900/40",
    mssql:    "bg-yellow-50 dark:bg-yellow-950/30 hover:bg-yellow-100 dark:hover:bg-yellow-900/40",
  };

  function renderProfile(p: ConnectionProfile) {
    const isConnected  = activeSessions.has(p.id);
    const isConnecting = connectingId === p.id;
    const isSelected   = selectedId === p.id;
    const typeBg = TYPE_BG[p.type] ?? "hover:bg-gray-100 dark:hover:bg-gray-800";

    return (
      <div
        key={p.id}
        className={`flex items-center gap-2 px-3 py-2 cursor-pointer select-none rounded mx-1 ${isSelected ? "bg-gray-200 dark:bg-gray-700" : typeBg}`}
        onClick={() => onSelect(p.id)}
        onContextMenu={e => {
          e.preventDefault();
          setContextMenu({ x: e.clientX, y: e.clientY, profile: p });
        }}
      >
        <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: COLOR_MAP[p.color] ?? "#6b7280" }} />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate text-gray-800 dark:text-gray-200">{p.name}</div>
          <div className="text-xs text-gray-500 truncate">{subtitle(p)}</div>
        </div>
        <div className="flex-shrink-0">
          {isConnecting ? (
            <Loader2 size={12} className="animate-spin text-gray-400" />
          ) : isConnected ? (
            <Circle size={8} fill="#22c55e" className="text-green-400" />
          ) : null}
        </div>
      </div>
    );
  }

  function Section({ label, items }: { label: string; items: ConnectionProfile[] }) {
    if (items.length === 0) return null;
    return (
      <div className="mt-2">
        <div className="px-3 py-1 text-xs font-semibold text-gray-400 uppercase tracking-wider">{label}</div>
        {items.map(renderProfile)}
      </div>
    );
  }

  return (
    <div className="w-full flex-shrink-0 bg-gray-100 dark:bg-gray-950 flex flex-col">
      <div className="flex items-center justify-between px-3 py-3 border-b border-gray-200 dark:border-gray-800">
        <span className="font-bold text-sm text-gray-800 dark:text-gray-200">DataAce</span>
        <div className="flex items-center gap-1">
          <button
            onClick={onOpenSqlite}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-100"
            title="Open SQLite file"
          >
            <FolderOpen size={14} />
          </button>
          <button
            onClick={onAdd}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-100"
            title="New connection"
          >
            <Plus size={14} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        <Section label="SQLite"      items={sqliteProfiles} />
        <Section label="MySQL"       items={mysqlProfiles} />
        <Section label="PostgreSQL"  items={pgProfiles} />
        <Section label="Oracle"      items={oracleProfiles} />
        <Section label="SQL Server"  items={mssqlProfiles} />
        {profiles.length === 0 && (
          <div className="px-3 py-4 text-xs text-gray-400 text-center">
            No connections yet.<br />
            <button onClick={onAdd} className="text-blue-500 hover:underline mt-1">Add one</button>
          </div>
        )}
      </div>

      <div className="flex items-center justify-around px-3 py-2 border-t border-gray-200 dark:border-gray-800">
        <button
          onClick={onCycleTheme}
          className="w-7 h-7 flex items-center justify-center rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-100"
          title="Toggle theme"
        >
          {themeIcon}
        </button>
        <button
          onClick={onMigrate}
          className="w-7 h-7 flex items-center justify-center rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 hover:text-purple-500"
          title="Migrate data"
        >
          <ArrowRightLeft size={14} />
        </button>
        <button
          onClick={onManageUsers}
          disabled={!hasMysqlSession}
          className="w-7 h-7 flex items-center justify-center rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 hover:text-blue-500 disabled:opacity-30 disabled:cursor-not-allowed"
          title={hasMysqlSession ? "Manage MySQL users" : "Connect to a MySQL server to manage users"}
        >
          <Users size={14} />
        </button>
        <button
          onClick={onAbout}
          className="w-7 h-7 flex items-center justify-center rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-100"
          title="About DataAce"
        >
          <Info size={14} />
        </button>
      </div>

      {contextMenu && (
        <div
          ref={menuRef}
          className="fixed z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded shadow-lg py-1 min-w-40"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={e => e.stopPropagation()}
        >
          {activeSessions.has(contextMenu.profile.id) ? (
            <MenuItem label="Disconnect" onClick={() => { onDisconnect(contextMenu.profile.id); setContextMenu(null); }} />
          ) : (
            <MenuItem label="Connect" onClick={() => { onSelect(contextMenu.profile.id); setContextMenu(null); }} />
          )}
          <MenuItem label="Edit"      onClick={() => { onEdit(contextMenu.profile); setContextMenu(null); }} />
          <MenuItem label="Duplicate" onClick={() => { onDuplicate(contextMenu.profile); setContextMenu(null); }} />
          <div className="border-t border-gray-200 dark:border-gray-700 my-1" />
          <MenuItem label="Delete" danger onClick={() => { onDelete(contextMenu.profile.id); setContextMenu(null); }} />
        </div>
      )}
    </div>
  );
}

function MenuItem({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      className={`w-full text-left px-3 py-1.5 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 ${danger ? "text-red-500" : "text-gray-700 dark:text-gray-200"}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
