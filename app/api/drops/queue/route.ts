import { NextRequest, NextResponse } from "next/server";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { issueDropTicket, redeemDropTicket } from "@/lib/market-store";

// Spike 672 (phase-timed-drops): server-authoritative anti-bot queue lobby.
// POST { collection_id, wallet } → 201 { ticket_id, position } (idempotent per wallet).
// POST { collection_id, wallet, redeem: true } → 200 { redeemed } at mint time.
// Rollback: unset flag → 404; tickets table inert. 429 on sybil-suspect handled by caller.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!isFeatureEnabled("phase-timed-drops")) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  let body: { collection_id?: unknown; wallet?: unknown; redeem?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const collection_id = Number(body.collection_id);
  const wallet = typeof body.wallet === "string" ? body.wallet.trim() : "";
  if (!Number.isInteger(collection_id) || collection_id < 0) {
    return NextResponse.json({ error: "invalid collection_id" }, { status: 400 });
  }
  if (!/^G[A-Z2-7]{55}$/.test(wallet)) {
    return NextResponse.json({ error: "valid wallet required" }, { status: 400 });
  }
  if (body.redeem === true) {
    const redeemed = await redeemDropTicket(collection_id, wallet);
    if (!redeemed) return NextResponse.json({ error: "TICKET_NOT_FOUND_OR_REDEEMED" }, { status: 409 });
    return NextResponse.json({ redeemed: true });
  }
  const ticket = await issueDropTicket(collection_id, wallet);
  return NextResponse.json({ ticket_id: ticket.id, position: ticket.position }, { status: 201 });
}
