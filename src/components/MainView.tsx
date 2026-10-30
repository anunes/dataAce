import { useEffect, useState } from "react";
import { ConnectionProfile, ActiveTab } from "../types";
import TableBrowser from "./TableBrowser";
import QueryEditor from "./QueryEditor";
import VisualQueryBuilder from "./VisualQueryBuilder";
import StructureView from "./StructureView";
import RelationsView from "./RelationsView";
import TriggersView from "./TriggersView";
import TableInfoView from "./TableInfoView";
import DatabaseInfoView from "./DatabaseInfoView";

interface Props {
  connId: string;
  profile: ConnectionProfile;
  selectedDb: string | null;
  selectedTable: string | null;
  activeTab: ActiveTab;
  onTabChange: (tab: ActiveTab) => void;
  isDark: boolean;
  triggerExport?: boolean;
  onExportDone?: () => void;
}

const TABS: { id: ActiveTab; label: string }[] = [
  { id: "browse", label: "Browse" },
  { id: "structure", label: "Structure" },
  { id: "query", label: "Query" },
  { id: "builder", label: "Query Builder" },
  { id: "relations", label: "Relations" },
  { id: "triggers", label: "Triggers" },
  { id: "info", label: "Info" },
];

export default function MainView({ connId, profile, selectedDb, selectedTable, activeTab, onTabChange, isDark, triggerExport, onExportDone }: Props) {
  const [builderOpened, setBuilderOpened] = useState(activeTab === "builder");
  useEffect(() => { if (activeTab === "builder") setBuilderOpened(true); }, [activeTab]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-white dark:bg-gray-900">
      {/* Breadcrumb bar */}
      <div className="flex items-center justify-center px-4 py-0.5 border-b border-gray-200 dark:border-gray-800 bg-gray-100 dark:bg-gray-950 min-h-[22px]">
        {selectedDb ? (
          <span className="text-xs text-gray-400 dark:text-gray-500 select-none truncate">
            {selectedTable ? (
              <><span className="text-gray-500 dark:text-gray-400">{selectedDb}</span><span className="mx-1.5">›</span><span className="text-gray-700 dark:text-gray-300 font-medium">{selectedTable}</span></>
            ) : (
              <span className="text-gray-500 dark:text-gray-400">{selectedDb}</span>
            )}
          </span>
        ) : null}
      </div>

      {/* Tab bar */}
      <div className="flex items-center border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-950 px-2 min-w-0">
        <div className="flex items-center gap-0 overflow-x-auto flex-shrink-0" style={{ scrollbarWidth: "none" }}>
          {TABS.map(tab => (
            <button
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              className={`px-3 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap flex-shrink-0 ${
                activeTab === tab.id
                  ? "border-blue-500 text-blue-500 dark:text-blue-400"
                  : "border-transparent text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === "browse" && (
          selectedTable && selectedDb ? (
            <TableBrowser
              connId={connId}
              table={selectedTable}
              database={selectedDb}
              dbType={profile.type}
              triggerExport={triggerExport}
              onExportDone={onExportDone}
            />
          ) : (
            <EmptyState message="Select a table from the sidebar to browse data" />
          )
        )}
        {activeTab === "structure" && (
          selectedTable && selectedDb ? (
            <StructureView connId={connId} table={selectedTable} database={selectedDb} dbType={profile.type} />
          ) : (
            <EmptyState message="Select a table from the sidebar to view its structure" />
          )
        )}
        {activeTab === "query" && (
          <QueryEditor connId={connId} selectedTable={selectedTable} selectedDb={selectedDb} isDark={isDark} dbType={profile.type} />
        )}
        {(builderOpened || activeTab === "builder") && (
          <div className={activeTab === "builder" ? "h-full" : "hidden"}>
            <VisualQueryBuilder connId={connId} selectedTable={selectedTable} selectedDb={selectedDb} isDark={isDark} dbType={profile.type} />
          </div>
        )}
        {activeTab === "relations" && (
          selectedTable && selectedDb ? (
            <RelationsView connId={connId} table={selectedTable} database={selectedDb} dbType={profile.type} />
          ) : (
            <EmptyState message="Select a table from the sidebar" />
          )
        )}
        {activeTab === "triggers" && (
          selectedTable && selectedDb ? (
            <TriggersView connId={connId} table={selectedTable} database={selectedDb} dbType={profile.type} />
          ) : (
            <EmptyState message="Select a table from the sidebar" />
          )
        )}
        {activeTab === "info" && (
          selectedTable && selectedDb ? (
            <TableInfoView connId={connId} table={selectedTable} database={selectedDb} dbType={profile.type} />
          ) : selectedDb ? (
            <DatabaseInfoView connId={connId} database={selectedDb} dbType={profile.type} />
          ) : (
            <EmptyState message="Select a database from the sidebar" />
          )
        )}
      </div>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center h-full">
      <p className="text-gray-500 text-sm">{message}</p>
    </div>
  );
}
