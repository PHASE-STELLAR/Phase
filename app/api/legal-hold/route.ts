import { NextRequest, NextResponse } from "next/server";
import {
  isLegalHold169Enabled,
  createLegalHold,
  getActiveHoldsForTarget,
  LegalHoldError,
} from "@/lib/legal-hold";
import type { CreateLegalHoldInput, LegalHoldTargetType } from "@/lib/types/legal-hold";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isLegalHold169Enabled()) {
    return NextResponse.json(
      { error: "Legal-hold preservation is disabled (set NEXT_PUBLIC_FEATURE_PHASE_169=1)" },
      { status: 404 },
    );
  }

  const adminKey = process.env.PHASE_ADMIN_KEY?.trim();
  const provided = request.headers.get("x-admin-key")?.trim();
  if (adminKey && provided !== adminKey) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = request.nextUrl;
  const target_type = searchParams.get("target_type") as LegalHoldTargetType | null;
  const target_id = searchParams.get("target_id");

  if (target_type && target_id) {
    const holds = await getActiveHoldsForTarget(target_type, target_id);
    return NextResponse.json({ holds });
  }

  return NextResponse.json({
    error: "target_type and target_id query params required to inspect holds",
  }, { status: 400 });
}

export async function POST(request: NextRequest) {
  if (!isLegalHold169Enabled()) {
    return NextResponse.json(
      { error: "Legal-hold preservation is disabled (set NEXT_PUBLIC_FEATURE_PHASE_169=1)" },
      { status: 404 },
    );
  }

  const adminKey = process.env.PHASE_ADMIN_KEY?.trim();
  const provided = request.headers.get("x-admin-key")?.trim();
  if (adminKey && provided !== adminKey) {
    return NextResponse.json({ error: "Unauthorized: admin key required to place legal holds" }, { status: 401 });
  }

  let body: Partial<CreateLegalHoldInput>;
  try {
    body = (await request.json()) as Partial<CreateLegalHoldInput>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.target_type || !body.target_id || !body.matter_id || !body.reason || !body.custodian) {
    return NextResponse.json(
      { error: "Missing required fields: target_type, target_id, matter_id, reason, custodian" },
      { status: 400 },
    );
  }

  try {
    const hold = await createLegalHold({
      target_type: body.target_type,
      target_id: body.target_id,
      matter_id: body.matter_id,
      reason: body.reason,
      custodian: body.custodian,
      retention_days: body.retention_days,
      immutable_worm: body.immutable_worm,
    });

    return NextResponse.json({ ok: true, hold }, { status: 201 });
  } catch (err) {
    if (err instanceof LegalHoldError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
    }
    return NextResponse.json({ error: "Internal server error", detail: String(err) }, { status: 500 });
  }
}
