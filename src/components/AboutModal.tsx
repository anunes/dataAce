import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-shell";
import { X } from "lucide-react";

interface Props {
  onClose: () => void;
}

export default function AboutModal({ onClose }: Props) {
  const [version, setVersion] = useState("");

  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion("1.0.0"));
  }, []);

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-8 w-72 shadow-2xl flex flex-col items-center text-center gap-3"
        onClick={e => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute top-3 right-3 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
          style={{ position: "absolute" }}
        >
          <X size={14} />
        </button>

        <img
          src="/icon.png"
          alt="DataAce icon"
          className="w-20 h-20 rounded-2xl"
          draggable={false}
        />

        <div>
          <div className="font-bold text-lg text-gray-800 dark:text-gray-100 tracking-tight">DataAce</div>
          <div className="text-xs text-gray-400 mt-0.5">Version {version}</div>
        </div>

        <div className="text-xs text-gray-400">
          &copy; 2006&ndash;{new Date().getFullYear()} anunes.net
        </div>

        <button
          onClick={() => open("https://anunes.net")}
          className="text-xs text-blue-500 hover:underline cursor-pointer"
        >
          Go to my website
        </button>
      </div>
    </div>
  );
}
