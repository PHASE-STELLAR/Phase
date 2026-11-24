import { type NextRequest, NextResponse } from "next/server";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { executeBuybackAndBurn, getBuybackStats, listBuybackEvents } from "@/lib/buyback-burn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
} as const;

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET() {
  if (!isFeatureEnabled("phase-146")) {
    return NextResponse.json(
      { error: "phase-146 flag disabled (set NEXT_PUBLIC_FEATURE_PHASE_146=1)" },
      { status: 404, headers: CORS },
    );
  }

  const stats = getBuybackStats();
  const recent = listBuybackEvents(20);

  return NextResponse.json({ enabled: true, stats, recent }, { status: 200, headers: CORS });
}

export async function POST(request: NextRequest) {
  if (!isFeatureEnabled("phase-146")) {
    return NextResponse.json(
      { error: "phase-146 flag disabled (set NEXT_PUBLIC_FEATURE_PHASE_146=1)" },
      { status: 404, headers: CORS },
    );
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: CORS });
  }

  const amountStroops = typeof body.amountSpentStroops === "string" ? BigInt(body.amountSpentStroops) : 0n;
  const source = body.source?.trim() ?? "protocol_treasury";
  const txHash = body.txHash?.trim() ?? null;

  const res = executeBuybackAndBurn(amountStroops, source, txHash);
  if (!res.ok) {
    return NextResponse.json({ error: res.error }, { status: 400, headers: CORS });
  }

  return NextResponse.json({ ok: true, event: res.event }, { status: 200, headers: CORS });
}
