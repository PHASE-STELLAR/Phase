"use client";

import React, { useState } from "react";
import type { AuditExportFormat, AuditExportRole } from "@/lib/types/moderation-export";

interface AuditExportPanelProps {
  className?: string;
}

export function AuditExportPanel({ className = "" }: AuditExportPanelProps) {
  const [role, setRole] = useState<AuditExportRole>("regulator");
  const [format, setFormat] = useState<AuditExportFormat>("csv");
  const [action, setAction] = useState<string>("all");
  const [adminKey, setAdminKey] = useState<string>("");
  const [regulatorToken, setRegulatorToken] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDownload = async () => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      params.set("role", role);
      params.set("format", format);
      if (action !== "all") params.set("action", action);

      const headers: Record<string, string> = {};
      if (role === "moderator" && adminKey) {
        headers["x-admin-key"] = adminKey;
      } else if (role === "regulator" && regulatorToken) {
        headers["x-regulator-token"] = regulatorToken;
      }

      const res = await fetch(`/api/moderation/export?${params.toString()}`, {
        headers,
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || `Download failed: HTTP ${res.status}`);
      }

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `moderation-audit-${role}-${Date.now()}.${format}`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={`p-6 bg-zinc-900 border border-zinc-800 rounded-xl max-w-xl text-zinc-100 ${className}`}>
      <div className="flex items-center justify-between border-b border-zinc-800 pb-3 mb-4">
        <div>
          <h3 className="text-base font-semibold">Moderation & Regulatory Audit Export</h3>
          <p className="text-xs text-zinc-400">Download redacted compliance audit trails</p>
        </div>
        <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-cyan-950 text-cyan-400 border border-cyan-800">
          phase-168
        </span>
      </div>

      <div className="space-y-4 text-xs">
        {/* Role toggle */}
        <div>
          <label className="block text-zinc-400 mb-1">Audit Role</label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setRole("regulator")}
              className={`py-2 px-3 rounded border text-left transition ${
                role === "regulator"
                  ? "border-cyan-500 bg-cyan-950/40 text-cyan-300"
                  : "border-zinc-800 bg-zinc-950 text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <div className="font-medium">Regulator (External)</div>
              <div className="text-[10px] text-zinc-500">Pseudonymized wallets, stripped keys</div>
            </button>
            <button
              type="button"
              onClick={() => setRole("moderator")}
              className={`py-2 px-3 rounded border text-left transition ${
                role === "moderator"
                  ? "border-cyan-500 bg-cyan-950/40 text-cyan-300"
                  : "border-zinc-800 bg-zinc-950 text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <div className="font-medium">Moderator (Internal)</div>
              <div className="text-[10px] text-zinc-500">Full audit trail & signatures</div>
            </button>
          </div>
        </div>

        {/* Format select */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-zinc-400 mb-1">Export Format</label>
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value as AuditExportFormat)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 text-zinc-200 focus:outline-none focus:border-cyan-500"
            >
              <option value="csv">CSV (RFC 4180 Table)</option>
              <option value="ndjson">NDJSON (Stream Line-delimited)</option>
              <option value="json">JSON (Full Envelope)</option>
            </select>
          </div>

          <div>
            <label className="block text-zinc-400 mb-1">Action Filter</label>
            <select
              value={action}
              onChange={(e) => setAction(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 text-zinc-200 focus:outline-none focus:border-cyan-500"
            >
              <option value="all">All Actions</option>
              <option value="takedown">Takedowns Only</option>
              <option value="restore">Restores Only</option>
            </select>
          </div>
        </div>

        {/* Auth credential input */}
        {role === "moderator" ? (
          <div>
            <label className="block text-zinc-400 mb-1">Admin / Moderator Key</label>
            <input
              type="password"
              placeholder="x-admin-key"
              value={adminKey}
              onChange={(e) => setAdminKey(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 text-zinc-200 font-mono text-[11px]"
            />
          </div>
        ) : (
          <div>
            <label className="block text-zinc-400 mb-1">Regulator Token</label>
            <input
              type="password"
              placeholder="x-regulator-token"
              value={regulatorToken}
              onChange={(e) => setRegulatorToken(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 text-zinc-200 font-mono text-[11px]"
            />
          </div>
        )}

        {error && (
          <div className="p-2.5 bg-red-950/40 border border-red-800/80 rounded text-red-300 text-[11px]">
            {error}
          </div>
        )}

        <button
          type="button"
          onClick={handleDownload}
          disabled={loading}
          className="w-full mt-2 py-2 px-4 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-black font-semibold transition disabled:opacity-50"
        >
          {loading ? "Exporting..." : `Download ${format.toUpperCase()} Audit Bundle`}
        </button>
      </div>
    </div>
  );
}
