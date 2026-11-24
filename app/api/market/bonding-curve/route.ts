import { type NextRequest, NextResponse } from "next/server";
import { isFeatureEnabled } from "@/lib/feature-flags";
import {
  getBondingCurveParams,
  quoteMint,
  quoteBurn,
  recordBondingCurveMint,
  recordBondingCurveBurn,
  setBondingCurveParams,
} from "@/lib/bonding-curve";

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
  if (!isFeatureEnabled("phase-148")) {
    return NextResponse.json(
      { error: "phase-148 flag disabled (set NEXT_PUBLIC_FEATURE_PHASE_148=1)" },
      { status: 404, headers: CORS },
    );
  }

  const { searchParams } = new URL(request.url);
  const collectionIdParam = searchParams.get("collection_id");
  if (!collectionIdParam) {
    return NextResponse.json({ error: "Missing collection_id" }, { status: 400, headers: CORS });
  }

  const collectionId = parseInt(collectionIdParam, 10);
  const quantity = parseInt(searchParams.get("quantity") ?? "1", 10);
  const action = searchParams.get("action") ?? "mint";

  let params = getBondingCurveParams(collectionId);
  if (!params) {
    params = {
      collectionId,
      basePriceStroops: 10_000_000n, // 1 PHASELQ
      slopeStroops: 100_000n,        // 0.01 PHASELQ
      currentSupply: 0,
      maxSupply: 1000,
      reserveStroops: 0n,
    };
  }

  try {
    if (action === "burn") {
      const quote = quoteBurn(params, quantity);
      return NextResponse.json(
        {
          enabled: true,
          collectionId,
          action: "burn",
          quote,
          curve: {
            basePriceStroops: params.basePriceStroops.toString(),
            slopeStroops: params.slopeStroops.toString(),
            currentSupply: params.currentSupply,
            maxSupply: params.maxSupply,
            reserveStroops: params.reserveStroops.toString(),
          },
        },
        { status: 200, headers: CORS },
      );
    }

    const quote = quoteMint(params, quantity);
    return NextResponse.json(
      {
        enabled: true,
        collectionId,
        action: "mint",
        quote,
        curve: {
          basePriceStroops: params.basePriceStroops.toString(),
          slopeStroops: params.slopeStroops.toString(),
          currentSupply: params.currentSupply,
          maxSupply: params.maxSupply,
          reserveStroops: params.reserveStroops.toString(),
        },
      },
      { status: 200, headers: CORS },
    );
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400, headers: CORS });
  }
}

export async function POST(request: NextRequest) {
  if (!isFeatureEnabled("phase-148")) {
    return NextResponse.json(
      { error: "phase-148 flag disabled (set NEXT_PUBLIC_FEATURE_PHASE_148=1)" },
      { status: 404, headers: CORS },
    );
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: CORS });
  }

  const collectionId = typeof body.collectionId === "number" ? body.collectionId : null;
  if (!collectionId) {
    return NextResponse.json({ error: "Missing collectionId" }, { status: 400, headers: CORS });
  }

  const action = body.action?.trim() ?? "mint";
  const quantity = typeof body.quantity === "number" ? body.quantity : 1;

  try {
    if (action === "init_curve") {
      const basePrice = typeof body.basePriceStroops === "string" ? BigInt(body.basePriceStroops) : 10_000_000n;
      const slope = typeof body.slopeStroops === "string" ? BigInt(body.slopeStroops) : 100_000n;
      const maxSupply = typeof body.maxSupply === "number" ? body.maxSupply : 1000;

      setBondingCurveParams({
        collectionId,
        basePriceStroops: basePrice,
        slopeStroops: slope,
        currentSupply: 0,
        maxSupply,
        reserveStroops: 0n,
      });

      return NextResponse.json({ ok: true, collectionId, initialized: true }, { status: 200, headers: CORS });
    }

    if (action === "burn") {
      const quote = recordBondingCurveBurn(collectionId, quantity);
      return NextResponse.json({ ok: true, quote }, { status: 200, headers: CORS });
    }

    const quote = recordBondingCurveMint(collectionId, quantity);
    return NextResponse.json({ ok: true, quote }, { status: 200, headers: CORS });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400, headers: CORS });
  }
}
