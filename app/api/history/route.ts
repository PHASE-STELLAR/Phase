import { NextRequest, NextResponse } from "next/server";
import { getHorizonBulkheadMetrics } from "@/lib/horizon-bulkhead";
import {
  countWalletHistoryOutcome,
  getWalletHistoryCounters,
  getWalletTimeline,
  isValidStellarAddress,
  isWalletHistoryEnabled,
  WalletHistoryError,
} from "@/lib/wallet-history";

export const dynamic = "force-dynamic";

/**
 * Spike 629 / issue #492 — per-wallet Horizon timeline.
 *
 * GET /api/history?address=G...&cursor=...&limit=...
 * Serves the merged transactions + effects timeline with settle ↔ forge
 * correlation, backed by the per-wallet index-cache (stale-on-error).
 *
 * GET /api/history?stats=1 returns the closed outcome counters and the
 * history bulkhead partition's load (#650).
 *
 * Flag phase-226 off → 404, and the cache is neither read nor written.
 */
export async function GET(request: NextRequest) {
  if (!isWalletHistoryEnabled()) {
    countWalletHistoryOutcome("flag_off");
    return NextResponse.json(
      { error: "Wallet history is disabled (set NEXT_PUBLIC_FEATURE_PHASE_226=1)" },
      { status: 404 },
    );
  }

  const { searchParams } = request.nextUrl;
  if (searchParams.get("stats") === "1") {
    return NextResponse.json({
      counters: getWalletHistoryCounters(),
      bulkhead: getHorizonBulkheadMetrics("history"),
    });
  }
  const address = searchParams.get("address")?.trim() ?? "";
  if (!address) {
    return NextResponse.json(
      { error: "address query param is required" },
      { status: 400 },
    );
  }
  if (!isValidStellarAddress(address)) {
    countWalletHistoryOutcome("invalid");
    return NextResponse.json(
      { error: "Invalid Stellar address (expected G… base32, 56 chars)" },
      { status: 400 },
    );
  }

  const cursor = searchParams.get("cursor")?.trim() || null;
  const limitRaw = searchParams.get("limit");
  let limit: number | undefined;
  if (limitRaw) {
    const parsed = Number(limitRaw);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return NextResponse.json(
        { error: "limit must be a positive integer" },
        { status: 400 },
      );
    }
    limit = parsed;
  }

  try {
    const page = await getWalletTimeline(address, { cursor, limit });
    return NextResponse.json(page);
  } catch (err) {
    if (err instanceof WalletHistoryError) {
      if (err.code === "FLAG_DISABLED") {
        return NextResponse.json({ error: err.message }, { status: 404 });
      }
      if (err.code === "INVALID_ADDRESS") {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      if (err.code === "HORIZON_RATE_LIMITED" || err.code === "HORIZON_BUSY") {
        return NextResponse.json({ error: err.message, code: err.code }, { status: 503 });
      }
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { error: "Internal server error", detail: String(err) },
      { status: 500 },
    );
  }
}
