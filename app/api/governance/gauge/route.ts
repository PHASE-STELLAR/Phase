import { type NextRequest, NextResponse } from "next/server";
import { isFeatureEnabled } from "@/lib/feature-flags";
import {
  castGaugeVote,
  readWalletGaugeVotes,
  readEpochAggregates,
  distributeEpochEmissions,
  getCollectionQuestBudget,
  getGaugeEpochId,
} from "@/lib/gauge-voting";

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
  if (!isFeatureEnabled("phase-145")) {
    return NextResponse.json(
      { error: "phase-145 flag disabled (set NEXT_PUBLIC_FEATURE_PHASE_145=1)" },
      { status: 404, headers: CORS },
    );
  }

  const { searchParams } = new URL(request.url);
  const epochParam = searchParams.get("epoch");
  const epoch = epochParam ? parseInt(epochParam, 10) : getGaugeEpochId();

  const wallet = searchParams.get("wallet")?.trim();
  const collectionIdParam = searchParams.get("collection_id");

  const aggregates = readEpochAggregates(epoch);
  const walletVotes = wallet ? readWalletGaugeVotes(wallet, epoch) : [];

  let collectionBudget = null;
  if (collectionIdParam) {
    const colId = parseInt(collectionIdParam, 10);
    const b = getCollectionQuestBudget(colId, epoch);
    collectionBudget = {
      collectionId: colId,
      allocatedBudgetStroops: b.totalBudgetStroops.toString(),
      veWeight: b.veWeight,
    };
  }

  return NextResponse.json(
    {
      enabled: true,
      epoch,
      currentEpoch: getGaugeEpochId(),
      aggregates,
      walletVotes,
      collectionBudget,
    },
    { status: 200, headers: CORS },
  );
}

export async function POST(request: NextRequest) {
  if (!isFeatureEnabled("phase-145")) {
    return NextResponse.json(
      { error: "phase-145 flag disabled (set NEXT_PUBLIC_FEATURE_PHASE_145=1)" },
      { status: 404, headers: CORS },
    );
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: CORS });
  }

  const action = body.action?.trim() ?? "vote";

  if (action === "distribute_emissions") {
    const epoch = typeof body.epoch === "number" ? body.epoch : getGaugeEpochId();
    const totalStroops = typeof body.totalEmissionStroops === "string" ? BigInt(body.totalEmissionStroops) : 0n;
    if (totalStroops <= 0n) {
      return NextResponse.json({ error: "totalEmissionStroops must be positive" }, { status: 400, headers: CORS });
    }
    const dist = distributeEpochEmissions(epoch, totalStroops);
    return NextResponse.json({ ok: true, distribution: dist }, { status: 200, headers: CORS });
  }

  if (action === "vote") {
    const wallet = body.wallet?.trim();
    if (!wallet) {
      return NextResponse.json({ error: "Missing wallet field in body" }, { status: 400, headers: CORS });
    }
    const votes = Array.isArray(body.votes) ? body.votes : [];
    const res = castGaugeVote(wallet, votes);
    if (!res.ok) {
      return NextResponse.json({ error: res.error }, { status: 400, headers: CORS });
    }
    return NextResponse.json({ ok: true, votes: res.records }, { status: 200, headers: CORS });
  }

  return NextResponse.json({ error: "Unknown action. Expected 'vote' or 'distribute_emissions'" }, { status: 400, headers: CORS });
}
