import { type NextRequest, NextResponse } from "next/server";
import { isFeatureEnabled } from "@/lib/feature-flags";
import {
  readVeLock,
  createOrUpdateVeLock,
  calculateClaimableFees,
  claimFees,
  withdrawVeLock,
  distributeTreasuryFees,
  MIN_LOCK_WEEKS,
  MAX_LOCK_WEEKS,
} from "@/lib/ve-phaselq";

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
  if (!isFeatureEnabled("phase-144")) {
    return NextResponse.json(
      { error: "phase-144 flag disabled (set NEXT_PUBLIC_FEATURE_PHASE_144=1)" },
      { status: 404, headers: CORS },
    );
  }

  const { searchParams } = new URL(request.url);
  const wallet = searchParams.get("wallet")?.trim();
  if (!wallet) {
    return NextResponse.json({ error: "Missing wallet parameter" }, { status: 400, headers: CORS });
  }

  const lock = readVeLock(wallet);
  const claimable = calculateClaimableFees(wallet);

  return NextResponse.json(
    {
      enabled: true,
      wallet,
      lock: lock ?? null,
      claimableFeesStroops: claimable.claimableStroops.toString(),
      epochsCount: claimable.epochsCount,
      minLockWeeks: MIN_LOCK_WEEKS,
      maxLockWeeks: MAX_LOCK_WEEKS,
    },
    { status: 200, headers: CORS },
  );
}

export async function POST(request: NextRequest) {
  if (!isFeatureEnabled("phase-144")) {
    return NextResponse.json(
      { error: "phase-144 flag disabled (set NEXT_PUBLIC_FEATURE_PHASE_144=1)" },
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
  const wallet = body.wallet?.trim();

  if (action === "distribute_fees") {
    const epochId = typeof body.epochId === "number" ? body.epochId : 0;
    const feeStroops = typeof body.feeStroops === "string" ? BigInt(body.feeStroops) : 0n;
    if (feeStroops <= 0n) {
      return NextResponse.json({ error: "feeStroops must be positive" }, { status: 400, headers: CORS });
    }
    const dist = distributeTreasuryFees(epochId, feeStroops);
    return NextResponse.json({ ok: true, distribution: dist }, { status: 200, headers: CORS });
  }

  if (!wallet) {
    return NextResponse.json({ error: "Missing wallet parameter" }, { status: 400, headers: CORS });
  }

  if (action === "claim") {
    const claimRes = claimFees(wallet);
    if (!claimRes.ok) {
      return NextResponse.json({ error: claimRes.error }, { status: 400, headers: CORS });
    }
    return NextResponse.json({ ...claimRes }, { status: 200, headers: CORS });
  }

  if (action === "withdraw") {
    const withdrawRes = withdrawVeLock(wallet);
    if (!withdrawRes.ok) {
      return NextResponse.json({ error: withdrawRes.error }, { status: 400, headers: CORS });
    }
    return NextResponse.json({ ...withdrawRes }, { status: 200, headers: CORS });
  }

  if (action === "lock") {
    const amountStroops = typeof body.amountStroops === "string" ? BigInt(body.amountStroops) : 0n;
    const lockWeeks = typeof body.lockWeeks === "number" ? body.lockWeeks : 0;

    const lockRes = createOrUpdateVeLock(wallet, amountStroops, lockWeeks);
    if (!lockRes.ok) {
      return NextResponse.json({ error: lockRes.error }, { status: 400, headers: CORS });
    }
    return NextResponse.json({ ok: true, lock: lockRes.lock }, { status: 200, headers: CORS });
  }

  return NextResponse.json(
    { error: "Unknown action. Expected 'lock', 'claim', 'withdraw', or 'distribute_fees'" },
    { status: 400, headers: CORS },
  );
}
