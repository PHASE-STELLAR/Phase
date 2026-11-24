import { type NextRequest, NextResponse } from "next/server";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { calculateDiscountedForgeFee, getStakedFeeTier, FORGE_FEE_TIERS } from "@/lib/staked-forge-discounts";

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
  if (!isFeatureEnabled("phase-147")) {
    return NextResponse.json(
      { error: "phase-147 flag disabled (set NEXT_PUBLIC_FEATURE_PHASE_147=1)" },
      { status: 404, headers: CORS },
    );
  }

  const { searchParams } = new URL(request.url);
  const stakedStr = searchParams.get("staked_stroops") ?? "0";
  const baseFeeStr = searchParams.get("base_fee_stroops") ?? "1000000000"; // default 100 PHASELQ

  const staked = BigInt(stakedStr);
  const baseFee = BigInt(baseFeeStr);

  const tier = getStakedFeeTier(staked);
  const calc = calculateDiscountedForgeFee(baseFee, staked);

  return NextResponse.json(
    {
      enabled: true,
      tier,
      calculation: calc,
      availableTiers: FORGE_FEE_TIERS.map((t) => ({
        ...t,
        minStakedStroops: t.minStakedStroops.toString(),
      })),
    },
    { status: 200, headers: CORS },
  );
}

export async function POST(request: NextRequest) {
  if (!isFeatureEnabled("phase-147")) {
    return NextResponse.json(
      { error: "phase-147 flag disabled (set NEXT_PUBLIC_FEATURE_PHASE_147=1)" },
      { status: 404, headers: CORS },
    );
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: CORS });
  }

  const staked = typeof body.stakedStroops === "string" ? BigInt(body.stakedStroops) : 0n;
  const baseFee = typeof body.baseFeeStroops === "string" ? BigInt(body.baseFeeStroops) : 1_000_000_000n;

  const calc = calculateDiscountedForgeFee(baseFee, staked);
  return NextResponse.json({ ok: true, ...calc }, { status: 200, headers: CORS });
}
