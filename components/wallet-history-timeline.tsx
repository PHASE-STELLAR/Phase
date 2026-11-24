"use client";

/**
 * Wallet History Timeline — dashboard integration of spike 629 (#650, phase-226).
 *
 * Client wrapper over `GET /api/history`, which serves the merged
 * `WalletTimelinePage` (effects-first merge, settle ↔ forge correlation,
 * stale-on-error cache, isolated Horizon bulkhead partition) built by
 * `lib/wallet-history.ts`. Older pages load through the gap-free
 * `next_cursor`.
 *
 * Rollback: with phase-226 off, the route 404s and this component renders
 * nothing (the timeline is empty and no request is made).
 */

import { useCallback, useEffect, useState } from "react";

import { isFeatureEnabled } from "@/lib/feature-flags";
import type { pickCopy } from "@/lib/phase-copy";
import type { TimelineEvent, WalletTimelinePage } from "@/lib/types/wallet-history";

type HistoryCopy = ReturnType<typeof pickCopy>["dashboard"]["wallet_history"];

type WalletHistoryTimelineProps = {
  address: string;
  copy: HistoryCopy;
  className?: string;
};

function formatEventLabel(e: TimelineEvent, c: HistoryCopy): string {
  const amount = e.amount ? ` ${e.amount}` : "";
  const asset = e.asset ? ` ${e.asset}` : "";
  switch (e.kind) {
    case "payment":
      return `${e.direction === "out" ? c.historySent : c.historyReceived}${amount}${asset}`;
    case "trade":
      return `${c.historyTrade}${amount}${asset}`;
    case "trustline":
      return `${c.historyTrustline} ${e.type.replace(/^trustline_/, "")}`;
    case "account":
      return `${c.historyAccount} ${e.type.replace(/^account_/, "")}`;
    case "settle":
      return `${c.historySettlement}${e.correlation?.settled ? " ✓" : ""}`;
    case "forge":
      return `${c.historyForge}${e.correlation?.forge_job_status ? ` (${e.correlation.forge_job_status})` : ""}`;
    case "tx":
      return e.failed ? c.historyTxFailed : c.historyTx;
    default:
      return e.type.replace(/_/g, " ");
  }
}

export function WalletHistoryTimeline({ address, copy, className }: WalletHistoryTimelineProps) {
  const enabled = isFeatureEnabled("phase-226");
  const [page, setPage] = useState<WalletTimelinePage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchPage = useCallback(
    async (cursor: string | null): Promise<WalletTimelinePage | null> => {
      const params = new URLSearchParams({ address });
      if (cursor) params.set("cursor", cursor);
      const res = await fetch(`/api/history?${params.toString()}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? `${copy.historyUnavailable} (${res.status})`);
        return null;
      }
      return (await res.json()) as WalletTimelinePage;
    },
    [address, copy.historyUnavailable],
  );

  const load = useCallback(async () => {
    if (!enabled || !address) return;
    setLoading(true);
    setError(null);
    try {
      setPage(await fetchPage(null));
    } catch {
      setError(copy.historyUnavailable);
      setPage(null);
    } finally {
      setLoading(false);
    }
  }, [enabled, address, fetchPage, copy.historyUnavailable]);

  const loadOlder = useCallback(async () => {
    if (!page?.next_cursor) return;
    setLoading(true);
    try {
      const older = await fetchPage(page.next_cursor);
      if (older) {
        const seen = new Set(page.events.map((e) => e.id));
        setPage({
          ...older,
          events: [...page.events, ...older.events.filter((e) => !seen.has(e.id))],
          cache: page.cache === "stale" || older.cache === "stale" ? "stale" : older.cache,
        });
      }
    } catch {
      setError(copy.historyUnavailable);
    } finally {
      setLoading(false);
    }
  }, [page, fetchPage, copy.historyUnavailable]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!enabled || !address) return null;

  return (
    <section data-testid="wallet-history-timeline" className={className ?? "space-y-2"}>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{copy.historyTitle}</h3>
        {page?.cache === "stale" && (
          <span className="text-[10px] uppercase tracking-widest text-amber-400/80">
            {copy.historyCached}
          </span>
        )}
        <button
          type="button"
          onClick={() => void load()}
          className="text-[10px] uppercase tracking-widest text-cyan-300/80 hover:text-cyan-200"
        >
          {loading ? "…" : copy.historyRefresh}
        </button>
      </div>

      {error && <p className="text-sm text-amber-300/90">{error}</p>}
      {!error && loading && !page && <p className="text-sm text-muted-foreground">{copy.historyLoading}</p>}
      {!error && !loading && (page?.events.length ?? 0) === 0 && (
        <p className="text-sm text-muted-foreground">{copy.historyEmpty}</p>
      )}

      {page && page.events.length > 0 && (
        <ul className="space-y-1" data-testid="wallet-history-items">
          {page.events.map((event) => (
            <li key={event.id} className="flex items-baseline justify-between text-sm">
              <span className="font-medium">{formatEventLabel(event, copy)}</span>
              <span className="ml-2 text-xs text-muted-foreground">
                {new Date(event.occurred_at).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      )}

      {page?.next_cursor && (
        <button
          type="button"
          onClick={() => void loadOlder()}
          disabled={loading}
          className="text-[10px] uppercase tracking-widest text-cyan-300/80 hover:text-cyan-200"
        >
          {loading ? "…" : copy.historyLoadOlder}
        </button>
      )}
    </section>
  );
}
