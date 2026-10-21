import { NextRequest, NextResponse } from "next/server";
import {
  isLegalHold169Enabled,
  releaseLegalHold,
  LegalHoldError,
} from "@/lib/legal-hold";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isLegalHold169Enabled()) {
    return NextResponse.json(
      { error: "Legal-hold preservation is disabled (set NEXT_PUBLIC_FEATURE_PHASE_169=1)" },
      { status: 404 },
    );
  }

  const adminKey = process.env.PHASE_ADMIN_KEY?.trim();
  const provided = request.headers.get("x-admin-key")?.trim();
  if (adminKey && provided !== adminKey) {
    return NextResponse.json({ error: "Unauthorized: admin key required to release legal holds" }, { status: 401 });
  }

  const { id } = await params;

  let body: { released_by?: string; release_reason?: string };
  try {
    body = (await request.json()) as { released_by?: string; release_reason?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.released_by || !body.release_reason) {
    return NextResponse.json(
      { error: "released_by and release_reason required to release a legal hold" },
      { status: 400 },
    );
  }

  try {
    const hold = await releaseLegalHold({
      id,
      released_by: body.released_by,
      release_reason: body.release_reason,
    });

    return NextResponse.json({ ok: true, hold });
  } catch (err) {
    if (err instanceof LegalHoldError) {
      const status =
        err.code === "HOLD_NOT_FOUND"
          ? 404
          : err.code === "WORM_LOCKED"
            ? 423 // Locked
            : 400;
      return NextResponse.json({ error: err.message, code: err.code, hold: err.hold }, { status });
    }
    return NextResponse.json({ error: "Internal server error", detail: String(err) }, { status: 500 });
  }
}
