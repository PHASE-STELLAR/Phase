"use client";

/**
 * Wallet History Timeline — Spike 629 (#492, phase-173).
 *
 * Client wrapper over `GET /api/history`, which serves the merged
 * `WalletTimelinePage` (effects-first merge, settle ↔ forge correlation,
 * stale-on-error cache) built by `lib/wallet-history.ts`.
 *
 * This component is a SPIKE: the pure pipeline is unit-tested in
 * `lib/__tests__/wallet-history*.test.ts`; the component itself is
 * intentionally thin so the live Horizon fetch surface can be validated
 * manually before any hardening work.
 *
 * Rollback: with phase-173 off, the route 404s and this component renders
 * nothing.
 */

import { useCallback, useEffect, useState } from "react";

import { isFeatureEnabled } from "@/lib/feature-flags";
import type { TimelineEvent, WalletTimelinePage } from "@/lib/types/wallet-history";

type WalletHistoryTimelineProps = {
  address: string;
  className?: string;
};

/** Human label for a timeline event (thin presentation helper). */
function formatEventLabel(e: TimelineEvent): string {
  const amount = e.amount ? ` ${e.amount}` : "";
  const asset = e.asset ? ` ${e.asset}` : "";
  switch (e.kind) {
    case "payment":
      return `${e.direction === "out" ? "Sent" : "Received"}${amount}${asset}`;
    case "trade":
      return `Trade${amount}${asset}`;
    case "trustline":
      return `Trustline ${e.type.replace(/^trustline_/, "")}`;
    case "account":
      return `Account ${e.type.replace(/^account_/, "")}`;
    case "settle":
      return `Settlement${e.correlation?.settled ? " ✓" : ""}`;
    case "forge":
      return `Forge invoice${e.correlation?.forge_job_status ? ` (${e.correlation.forge_job_status})` : ""}`;
    case "tx":
      return e.failed ? "Failed transaction" : "Transaction";
    default:
      return e.type.replace(/_/g, " ");
  }
}

export function WalletHistoryTimeline({ address, className }: WalletHistoryTimelineProps) {
  const [page, setPage] = useState<WalletTimelinePage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ address, flags: "phase-173" });
      const res = await fetch(`/api/history?${params.toString()}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? `History unavailable (${res.status})`);
        setPage(null);
        return;
      }
      setPage((await res.json()) as WalletTimelinePage);
    } catch {
      setError("History unavailable");
      setPage(null);
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!isFeatureEnabled("phase-173")) return null;
  if (!address) return null;

  return (
    <section data-testid="wallet-history-timeline" className={className ?? "space-y-2"}>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">History</h3>
        {page?.cache === "stale" && (
          <span className="text-[10px] uppercase tracking-widest text-amber-400/80">
            cached
          </span>
        )}
        <button
          type="button"
          onClick={() => void load()}
          className="text-[10px] uppercase tracking-widest text-cyan-300/80 hover:text-cyan-200"
        >
          {loading ? "…" : "refresh"}
        </button>
      </div>

      {error && <p className="text-sm text-amber-300/90">{error}</p>}
      {!error && loading && !page && <p className="text-sm text-muted-foreground">Loading…</p>}
      {!error && !loading && (page?.events.length ?? 0) === 0 && (
        <p className="text-sm text-muted-foreground">No activity yet.</p>
      )}

      {page && page.events.length > 0 && (
        <ul className="space-y-1" data-testid="wallet-history-items">
          {page.events.map((event) => (
            <li key={event.id} className="flex items-baseline justify-between text-sm">
              <span className="font-medium">{formatEventLabel(event)}</span>
              <span className="ml-2 text-xs text-muted-foreground">
                {new Date(event.occurred_at).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      )}

      {page?.next_cursor && (
        <p className="text-xs text-muted-foreground">
          Older activity is available via cursor {page.next_cursor}.
        </p>
      )}
    </section>
  );
}
