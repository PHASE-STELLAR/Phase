"use client";

import React, { useState } from "react";

interface DataPortabilityExportButtonProps {
  wallet: string;
  className?: string;
}

export function DataPortabilityExportButton({
  wallet,
  className = "",
}: DataPortabilityExportButtonProps) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleExport = async () => {
    if (!wallet) return;
    setDownloading(true);
    setError(null);

    try {
      const response = await fetch(`/api/user/export?wallet=${encodeURIComponent(wallet)}`);
      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        throw new Error(errJson.error || `Export failed with status ${response.status}`);
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `phase-data-export-${wallet.slice(0, 8)}-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={handleExport}
        disabled={downloading || !wallet}
        className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-zinc-700 bg-zinc-800/80 hover:bg-zinc-700/80 text-xs font-medium text-zinc-200 transition ${
          downloading ? "opacity-60 cursor-not-allowed" : ""
        } ${className}`}
      >
        <svg
          className="w-3.5 h-3.5 text-cyan-400"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
          />
        </svg>
        <span>
          {downloading ? "Preparing GDPR Bundle..." : "Export My Data (GDPR Art. 20)"}
        </span>
      </button>

      {error && <span className="text-[11px] text-red-400">{error}</span>}
    </div>
  );
}
