import { NextRequest, NextResponse } from "next/server";
import {
  isConsent166Enabled,
  hasAcceptedCurrentLegal,
  recordConsent,
  LegalConsentError,
} from "@/lib/legal-consent";
import type { ConsentSubmitInput } from "@/lib/types/legal-consent";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isConsent166Enabled()) {
    return NextResponse.json(
      { error: "Legal consent feature is disabled (phase-166 off)" },
      { status: 404 },
    );
  }

  const wallet = request.nextUrl.searchParams.get("wallet")?.trim();
  if (!wallet || wallet.length < 10) {
    return NextResponse.json(
      { error: "wallet query parameter is required" },
      { status: 400 },
    );
  }

  const status = await hasAcceptedCurrentLegal(wallet);
  return NextResponse.json(status);
}

export async function POST(request: NextRequest) {
  if (!isConsent166Enabled()) {
    return NextResponse.json(
      { error: "Legal consent feature is disabled (phase-166 off)" },
      { status: 404 },
    );
  }

  let body: Partial<ConsentSubmitInput>;
  try {
    body = (await request.json()) as Partial<ConsentSubmitInput>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const wallet = typeof body.wallet === "string" ? body.wallet.trim() : "";
  const tos_version =
    typeof body.tos_version === "string" ? body.tos_version.trim() : "";
  const tos_hash =
    typeof body.tos_hash === "string" ? body.tos_hash.trim() : "";
  const privacy_version =
    typeof body.privacy_version === "string" ? body.privacy_version.trim() : "";
  const privacy_hash =
    typeof body.privacy_hash === "string" ? body.privacy_hash.trim() : "";

  if (!wallet || !tos_version || !tos_hash || !privacy_version || !privacy_hash) {
    return NextResponse.json(
      {
        error:
          "Missing required fields: wallet, tos_version, tos_hash, privacy_version, privacy_hash",
      },
      { status: 400 },
    );
  }

  try {
    const userAgent = request.headers.get("user-agent") ?? undefined;
    const record = await recordConsent({
      wallet,
      tos_version,
      tos_hash,
      privacy_version,
      privacy_hash,
      signature: typeof body.signature === "string" ? body.signature : undefined,
      user_agent: userAgent,
    });

    return NextResponse.json({
      ok: true,
      message: "Consent recorded successfully",
      record,
    });
  } catch (err) {
    if (err instanceof LegalConsentError) {
      const statusCode =
        err.code === "HASH_MISMATCH" || err.code === "INVALID_DOCUMENT_VERSION"
          ? 422
          : err.code === "FLAG_DISABLED"
            ? 404
            : 400;

      return NextResponse.json(
        {
          error: err.message,
          code: err.code,
          pending: err.pendingDocuments,
        },
        { status: statusCode },
      );
    }
    return NextResponse.json(
      { error: "Internal server error", detail: String(err) },
      { status: 500 },
    );
  }
}
