import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { ArrowRight, CheckCircle, Loader2, X } from "lucide-react";
import { ConnectionProfile, DatabaseTransferResult } from "../types";

interface PreparedConnection {
  connId: string;
  databases: string[];
}

interface Props {
  profiles: ConnectionProfile[];
  sourceProfileId: string;
  initialTargetProfileId?: string;
  onPrepareConnection: (profileId: string) => Promise<PreparedConnection>;
  onTransferred: (targetProfileId: string, targetConnId: string, result: DatabaseTransferResult) => Promise<string[]>;
  onClose: () => void;
}

const inputCls = "w-full bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500 text-gray-800 dark:text-gray-200 disabled:opacity-50";
const systemDatabases: Record<string, string[]> = {
  mysql: ["information_schema", "mysql", "performance_schema", "sys"],
  postgres: ["template0", "template1"],
};

export default function MoveDatabaseModal({ profiles, sourceProfileId, initialTargetProfileId, onPrepareConnection, onTransferred, onClose }: Props) {
  const source = profiles.find(profile => profile.id === sourceProfileId);
  const targets = profiles.filter(profile => profile.id !== sourceProfileId && profile.type === source?.type);
  const [targetId, setTargetId] = useState(initialTargetProfileId ?? "");
  const target = targets.find(profile => profile.id === targetId);
  const [sourceConnection, setSourceConnection] = useState<PreparedConnection | null>(null);
  const [targetConnection, setTargetConnection] = useState<PreparedConnection | null>(null);
  const [sourceDatabase, setSourceDatabase] = useState("");
  const [targetDatabase, setTargetDatabase] = useState("");
  const [sourceLoading, setSourceLoading] = useState(true);
  const [targetLoading, setTargetLoading] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [targetError, setTargetError] = useState<string | null>(null);
  const [transferError, setTransferError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [transferring, setTransferring] = useState(false);
  const [result, setResult] = useState<DatabaseTransferResult | null>(null);
  const prepare = useRef(onPrepareConnection);
  prepare.current = onPrepareConnection;

  useEffect(() => {
    let cancelled = false;
    setSourceLoading(true);
    setSourceError(null);
    setSourceConnection(null);
    setSourceDatabase("");
    if (!source) { setSourceError("The source connection is no longer available."); setSourceLoading(false); return; }
    prepare.current(source.id).then(connection => {
      if (cancelled) return;
      const names = connection.databases.filter(name => !(systemDatabases[source.type] ?? []).includes(name.toLowerCase()));
      const name = source.type === "sqlite" ? connection.databases[0] : source.database.trim() ? source.database : (names.length === 1 ? names[0] : "");
      if (!name) throw new Error("Choose a connection associated with a single database.");
      if ((systemDatabases[source.type] ?? []).includes(name.toLowerCase())) throw new Error("System databases cannot be moved.");
      setSourceConnection(connection);
      setSourceDatabase(name);
    }).catch(error => {
      if (!cancelled) setSourceError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (!cancelled) setSourceLoading(false);
    });
    return () => { cancelled = true; };
  }, [sourceProfileId, source?.id, attempt]);

  useEffect(() => {
    let cancelled = false;
    setTargetConnection(null);
    setTargetError(null);
    setTransferError(null);
    setTargetDatabase("");
    if (!target) { setTargetLoading(false); return; }
    setTargetLoading(true);
    prepare.current(target.id).then(connection => {
      if (cancelled) return;
      setTargetConnection(connection);
      setTargetDatabase(target.type === "sqlite" ? connection.databases[0] ?? "main" : sourceDatabase);
    }).catch(error => {
      if (!cancelled) setTargetError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (!cancelled) setTargetLoading(false);
    });
    return () => { cancelled = true; };
  }, [targetId, target?.id, sourceDatabase, attempt]);

  const destinationName = target?.type === "postgres" ? targetDatabase.trim() : targetDatabase;
  const destinationExists = target?.type !== "sqlite" && !!destinationName && targetConnection?.databases.includes(destinationName);
  const ready = !!source && !!target && !!sourceConnection && !!targetConnection && !!sourceDatabase && !!targetDatabase.trim()
    && !sourceLoading && !targetLoading && !sourceError && !targetError && !destinationExists;

  async function transfer() {
    if (!ready || transferring || result) return;
    setTransferring(true);
    setTransferError(null);
    try {
      const transferred = await invoke<DatabaseTransferResult>("transfer_database", {
        source,
        target,
        sourceDatabase,
        targetDatabase: destinationName,
        sourceConnId: sourceConnection!.connId,
        targetConnId: targetConnection!.connId,
      });
      // A refresh failure must not turn a completed transfer into a retry.
      setResult(transferred);
      try {
        const warnings = await onTransferred(targetId, targetConnection!.connId, transferred);
        if (warnings.length) setResult({ ...transferred, warnings: [...transferred.warnings, ...warnings] });
      } catch (error) {
        setResult({ ...transferred, warnings: [...transferred.warnings, `The transfer completed. Refresh the destination connection to view it: ${String(error)}`] });
      }
    } catch (error) {
      setTransferError(error instanceof Error ? error.message : String(error));
    } finally {
      setTransferring(false);
    }
  }

  return createPortal(
    <div className="table-modal-backdrop">
      <form role="dialog" aria-modal="true" aria-labelledby="move-database-title" className="table-modal-dialog bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-2xl"
        onSubmit={event => { event.preventDefault(); void transfer(); }}
        onKeyDown={event => { if (event.key === "Escape" && !transferring) onClose(); }}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700">
          <h3 id="move-database-title" className="font-semibold text-gray-800 dark:text-gray-100">Move Database</h3>
          <button type="button" aria-label="Close database transfer" onClick={onClose} disabled={transferring} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 disabled:opacity-50"><X size={16} /></button>
        </div>
        <div className="table-modal-body p-5 space-y-4">
          {result ? (
            <div role="status" className="space-y-3">
              <p className="flex items-center gap-2 font-medium text-green-700 dark:text-green-400"><CheckCircle size={18} /> Database transferred</p>
              <p className="text-sm text-gray-700 dark:text-gray-200"><strong>{result.targetDatabase}</strong> is now available through <strong>{target?.name}</strong>.</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">The original database and connection remain available as a backup.</p>
              {result.warnings.map((warning, index) => <p key={index} className="text-xs text-amber-700 dark:text-amber-400">{warning}</p>)}
            </div>
          ) : (
            <fieldset disabled={transferring} className="space-y-4 min-w-0">
              <div className="rounded-lg bg-gray-100 dark:bg-gray-800 p-3">
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Source connection</p>
                <p className="text-sm text-gray-800 dark:text-gray-100 font-medium break-words">{source?.name}</p>
                {sourceDatabase && <p className="text-xs font-mono text-gray-500 dark:text-gray-400 mt-1 break-all">{sourceDatabase}</p>}
                {sourceLoading && <p role="status" className="flex items-center gap-1.5 text-xs text-gray-400 mt-1"><Loader2 size={12} className="animate-spin" /> Loading source database...</p>}
              </div>
              <div>
                <label htmlFor="move-database-connection" className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Destination Connection</label>
                <select id="move-database-connection" className={inputCls} value={targetId} onChange={event => setTargetId(event.target.value)}>
                  <option value="" disabled>Select a destination connection</option>
                  {targets.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                </select>
                {targetLoading && <p role="status" className="flex items-center gap-1.5 text-xs text-gray-400 mt-2"><Loader2 size={12} className="animate-spin" /> Checking destination...</p>}
              </div>
              {targetConnection && (
                <div>
                  <label htmlFor="move-database-name" className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Destination Database</label>
                  <input id="move-database-name" className={inputCls} value={targetDatabase} readOnly={target?.type !== "postgres"} onChange={event => { setTargetDatabase(event.target.value); setTransferError(null); }} />
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">{target?.type === "sqlite" ? "The destination SQLite database must be empty." : target?.type === "mysql" ? "The database keeps its name on the destination server. Choose a server where this database does not already exist." : "A new database will be created on the destination server."}</p>
                </div>
              )}
              {destinationExists && <p role="alert" className="text-sm text-red-600 dark:text-red-400">A database with this name already exists on the destination. Choose another {target?.type === "postgres" ? "database name" : "connection"}.</p>}
              <p className="text-xs text-gray-500 dark:text-gray-400">Transfers the complete database to a compatible connection. The original database and connection are kept as a backup.</p>
              {source?.type === "mysql" && <p className="text-xs text-gray-500 dark:text-gray-400">MySQL blocks writes on the source server while exporting a consistent copy.</p>}
              {transferring && <p role="status" className="flex items-center gap-2 text-sm text-blue-600 dark:text-blue-400"><Loader2 size={15} className="animate-spin" /> Transferring database...</p>}
              {(sourceError || targetError) && <p role="alert" className="text-sm text-red-600 dark:text-red-400 break-words">{sourceError ?? targetError} <button type="button" className="underline" onClick={() => setAttempt(value => value + 1)}>Retry</button></p>}
              {transferError && <p role="alert" className="text-sm text-red-600 dark:text-red-400 break-words">{transferError}</p>}
            </fieldset>
          )}
        </div>
        <div className="table-modal-footer p-4 border-t border-gray-200 dark:border-gray-700">
          <button type="button" onClick={onClose} disabled={transferring} className="px-3 py-1.5 text-sm bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg text-gray-700 dark:text-gray-200 disabled:opacity-50">{result ? "Done" : "Cancel"}</button>
          {!result && <button type="submit" disabled={!ready || transferring} className="flex items-center gap-2 px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg disabled:opacity-50">{transferring ? "Transferring..." : "Transfer Database"}<ArrowRight size={14} /></button>}
        </div>
      </form>
    </div>,
    document.body,
  );
}
