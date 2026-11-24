"use client";

import React from "react";
import type { LegalHold } from "@/lib/types/legal-hold";

interface LegalHoldBadgeProps {
  hold?: LegalHold | null;
  className?: string;
}

export function LegalHoldBadge({ hold, className = "" }: LegalHoldBadgeProps) {
  if (!hold || !hold.active) return null;

  return (
    <div
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-amber-950/60 border border-amber-600/60 text-amber-300 text-xs font-medium select-none ${className}`}
      title={`Matter: ${hold.matter_id} - ${hold.reason}`}
    >
      <svg
        className="w-3.5 h-3.5 text-amber-400"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M12 15v2m0 0v2m0-2h2m-2 0H10m7-7V7a5 5 0 00-10 0v3m-2 0h14a2 2 0 012 2v7a2 2 0 01-2 2H5a2 2 0 01-2-2v-7a2 2 0 012-2z"
        />
      </svg>
      <span>LEGAL HOLD</span>
      {hold.immutable_worm && (
        <span className="text-[10px] uppercase font-mono px-1 py-0.5 rounded bg-amber-900/80 text-amber-200">
          WORM
        </span>
      )}
    </div>
  );
}
