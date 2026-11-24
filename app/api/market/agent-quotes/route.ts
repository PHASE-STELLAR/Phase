import { NextRequest, NextResponse } from "next/server";
import { isFeatureEnabled } from "@/lib/feature-flags";
import {
  publishAgentQuote,
  getAgentQuotes,
  cancelAgentQuote,
  calculateAgentQuotes,
} from "@/lib/agent-market-maker";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!isFeatureEnabled("phase-151")) {
    return NextResponse.json({ error: "Feature phase-151 disabled" }, { status: 404 });
  }

  const { searchParams } = new URL(req.url);
  const collectionId = searchParams.get("collection_id")
    ? parseInt(searchParams.get("collection_id")!, 10)
    : undefined;
  const agentWallet = searchParams.get("agent_wallet") || undefined;

  // Optional preview mode for quote calculations without committing
  if (searchParams.get("preview") === "true") {
    const mid = searchParams.get("mid_price_stroops") || "10000000";
    const spread = searchParams.get("spread_bps") ? parseInt(searchParams.get("spread_bps")!, 10) : 400;
    const inv = searchParams.get("inventory_units") ? parseInt(searchParams.get("inventory_units")!, 10) : 0;
    const maxInv = searchParams.get("max_inventory") ? parseInt(searchParams.get("max_inventory")!, 10) : 10;
    const preview = calculateAgentQuotes(BigInt(mid), spread, inv, maxInv);
    return NextResponse.json({ preview });
  }

  const quotes = getAgentQuotes(collectionId, agentWallet);
  return NextResponse.json({ quotes });
}

export async function POST(req: NextRequest) {
  if (!isFeatureEnabled("phase-151")) {
    return NextResponse.json({ error: "Feature phase-151 disabled" }, { status: 404 });
  }

  try {
    const body = await req.json();

    if (body.action === "cancel") {
      if (!body.quote_id || !body.agent_wallet) {
        return NextResponse.json({ error: "Missing quote_id or agent_wallet" }, { status: 400 });
      }
      const ok = cancelAgentQuote(body.quote_id, body.agent_wallet);
      return NextResponse.json({ ok });
    }

    if (!body.agent_wallet || body.collection_id === undefined || !body.mid_price_stroops) {
      return NextResponse.json({ error: "Missing required quote fields" }, { status: 400 });
    }

    const res = publishAgentQuote({
      agentWallet: body.agent_wallet,
      collectionId: Number(body.collection_id),
      midPriceStroops: BigInt(body.mid_price_stroops),
      bidSize: Number(body.bid_size || 1),
      askSize: Number(body.ask_size || 1),
      inventoryUnits: Number(body.inventory_units || 0),
      maxInventoryUnits: Number(body.max_inventory_units || 10),
      baseSpreadBps: body.base_spread_bps ? Number(body.base_spread_bps) : 400,
    });

    if (!res.ok) {
      return NextResponse.json({ error: res.error }, { status: 400 });
    }

    return NextResponse.json({ ok: true, quote: res.quote }, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Failed to process quote" }, { status: 500 });
  }
}
