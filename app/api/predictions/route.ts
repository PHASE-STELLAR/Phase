import { type NextRequest, NextResponse } from "next/server";
import { isFeatureEnabled } from "@/lib/feature-flags";
import {
  createPredictionMarket,
  buyPredictionShares,
  resolvePredictionMarket,
  claimPredictionPayout,
  listPredictionMarkets,
  getPositionsForWallet,
} from "@/lib/prediction-markets";

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

export async function GET(request: NextRequest) {
  if (!isFeatureEnabled("phase-149")) {
    return NextResponse.json(
      { error: "phase-149 flag disabled (set NEXT_PUBLIC_FEATURE_PHASE_149=1)" },
      { status: 404, headers: CORS },
    );
  }

  const { searchParams } = new URL(request.url);
  const wallet = searchParams.get("wallet")?.trim();
  const status = searchParams.get("status")?.trim();

  const markets = listPredictionMarkets(status);
  const positions = wallet ? getPositionsForWallet(wallet) : [];

  return NextResponse.json({ enabled: true, markets, positions }, { status: 200, headers: CORS });
}

export async function POST(request: NextRequest) {
  if (!isFeatureEnabled("phase-149")) {
    return NextResponse.json(
      { error: "phase-149 flag disabled (set NEXT_PUBLIC_FEATURE_PHASE_149=1)" },
      { status: 404, headers: CORS },
    );
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: CORS });
  }

  const action = body.action?.trim();

  if (action === "create") {
    const question = body.question?.trim();
    if (!question) return NextResponse.json({ error: "Missing question" }, { status: 400, headers: CORS });
    const category = body.category?.trim() ?? "drop_outcome";
    const closesAt = typeof body.closesAt === "number" ? body.closesAt : Date.now() + 7 * 24 * 60 * 60 * 1000;
    const collectionId = typeof body.collectionId === "number" ? body.collectionId : null;

    const market = createPredictionMarket(question, category, closesAt, collectionId);
    return NextResponse.json({ ok: true, market }, { status: 200, headers: CORS });
  }

  if (action === "buy") {
    const marketId = body.marketId?.trim();
    const wallet = body.wallet?.trim();
    const outcome = body.outcome?.trim().toUpperCase();
    const amountStroops = typeof body.amountStroops === "string" ? BigInt(body.amountStroops) : 0n;

    if (!marketId || !wallet || (outcome !== "YES" && outcome !== "NO")) {
      return NextResponse.json({ error: "Invalid marketId, wallet, or outcome (must be YES or NO)" }, { status: 400, headers: CORS });
    }

    const res = buyPredictionShares(marketId, wallet, outcome, amountStroops);
    if (!res.ok) {
      return NextResponse.json({ error: res.error }, { status: 400, headers: CORS });
    }

    return NextResponse.json({ ok: true, position: res.position }, { status: 200, headers: CORS });
  }

  if (action === "resolve") {
    const marketId = body.marketId?.trim();
    const outcome = body.outcome?.trim().toUpperCase();
    if (!marketId || (outcome !== "YES" && outcome !== "NO")) {
      return NextResponse.json({ error: "Invalid marketId or outcome (must be YES or NO)" }, { status: 400, headers: CORS });
    }

    const res = resolvePredictionMarket(marketId, outcome);
    if (!res.ok) {
      return NextResponse.json({ error: res.error }, { status: 400, headers: CORS });
    }

    return NextResponse.json({ ok: true, marketId, resolvedOutcome: outcome }, { status: 200, headers: CORS });
  }

  if (action === "claim") {
    const positionId = body.positionId?.trim();
    const wallet = body.wallet?.trim();
    if (!positionId || !wallet) {
      return NextResponse.json({ error: "Missing positionId or wallet" }, { status: 400, headers: CORS });
    }

    const res = claimPredictionPayout(positionId, wallet);
    if (!res.ok) {
      return NextResponse.json({ error: res.error }, { status: 400, headers: CORS });
    }

    return NextResponse.json({ ok: true, payoutStroops: res.payoutStroops }, { status: 200, headers: CORS });
  }

  return NextResponse.json({ error: "Unknown action. Expected 'create', 'buy', 'resolve', or 'claim'" }, { status: 400, headers: CORS });
}
