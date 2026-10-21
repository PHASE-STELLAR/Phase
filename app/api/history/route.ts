import { NextRequest, NextResponse } from "next/server";
import {
  getWalletTimeline,
  isValidStellarAddress,
  isWalletHistory173Enabled,
  WalletHistoryError,
} from "@/lib/wallet-history";

export const dynamic = "force-dynamic";

/**
 * Spike 629 / issue #492 — per-wallet Horizon timeline.
 *
 * GET /api/history?address=G...&cursor=...&limit=...
 * Serves the merged transactions + effects timeline with settle ↔ forge
 * correlation, backed by the per-wallet index-cache (stale-on-error).
 */
export async function GET(request: NextRequest) {
  if (!isWalletHistory173Enabled()) {
    return NextResponse.json(
      { error: "Wallet history is disabled (set NEXT_PUBLIC_FEATURE_PHASE_173=1)" },
      { status: 404 },
    );
  }

  const { searchParams } = request.nextUrl;
  const address = searchParams.get("address")?.trim() ?? "";
  if (!address) {
    return NextResponse.json(
      { error: "address query param is required" },
      { status: 400 },
    );
  }
  if (!isValidStellarAddress(address)) {
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
      if (err.code === "HORIZON_RATE_LIMITED") {
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
