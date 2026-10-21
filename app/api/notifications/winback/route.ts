import { type NextRequest, NextResponse } from "next/server";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { evaluateWinbackCampaign, recordWinbackDispatch, getWinbackStore } from "@/lib/churn-winback";
import { createNotification } from "@/lib/notification-store";

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
  if (!isFeatureEnabled("phase-143")) {
    return NextResponse.json(
      { error: "phase-143 flag disabled (set NEXT_PUBLIC_FEATURE_PHASE_143=1)" },
      { status: 404, headers: CORS },
    );
  }

  const { searchParams } = new URL(request.url);
  const wallet = searchParams.get("wallet")?.trim();
  if (!wallet) {
    return NextResponse.json({ error: "Missing wallet parameter" }, { status: 400, headers: CORS });
  }

  const lastActiveStr = searchParams.get("last_active");
  const lastActiveMs = lastActiveStr ? parseInt(lastActiveStr, 10) : Date.now() - 20 * 24 * 60 * 60 * 1000;
  const experimentId = searchParams.get("experiment_id")?.trim() ?? "winback_v1";

  const store = await getWinbackStore();
  const prior = store.entries[wallet.toLowerCase()];

  const evaluation = evaluateWinbackCampaign(
    wallet,
    {
      lastActiveMs,
      lastNotifiedMs: prior?.dispatchedAt,
    },
    experimentId,
  );

  return NextResponse.json({ enabled: true, evaluation, priorDispatch: prior ?? null }, { status: 200, headers: CORS });
}

export async function POST(request: NextRequest) {
  if (!isFeatureEnabled("phase-143")) {
    return NextResponse.json(
      { error: "phase-143 flag disabled (set NEXT_PUBLIC_FEATURE_PHASE_143=1)" },
      { status: 404, headers: CORS },
    );
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: CORS });
  }

  const wallet = body.wallet?.trim();
  if (!wallet) {
    return NextResponse.json({ error: "Missing wallet field in body" }, { status: 400, headers: CORS });
  }

  const lastActiveMs = typeof body.lastActiveMs === "number" ? body.lastActiveMs : Date.now() - 20 * 24 * 60 * 60 * 1000;
  const experimentId = body.experimentId?.trim() ?? "winback_v1";
  const store = await getWinbackStore();
  const prior = store.entries[wallet.toLowerCase()];

  const evaluation = evaluateWinbackCampaign(
    wallet,
    {
      lastActiveMs,
      lastNotifiedMs: prior?.dispatchedAt,
      activity: body.activity,
    },
    experimentId,
  );

  let dispatched = false;
  if (body.dispatch && evaluation.eligible && evaluation.cohort !== "control") {
    await recordWinbackDispatch(wallet, evaluation.cohort, evaluation.hook, experimentId);
    try {
      await createNotification(wallet, "winback_reactivation", {
        title: evaluation.title,
        body: evaluation.body,
        cohort: evaluation.cohort,
        hook: evaluation.hook,
        experimentId,
      });
      dispatched = true;
    } catch {
      // In-app notification creation non-blocking
    }
  }

  return NextResponse.json({ ok: true, evaluation, dispatched }, { status: 200, headers: CORS });
}
