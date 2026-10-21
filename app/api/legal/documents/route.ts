import { NextRequest, NextResponse } from "next/server";
import { getCanonicalDocuments, isConsent166Enabled } from "@/lib/legal-consent";
import { getLegalCopy } from "@/lib/copy/legal-copy";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isConsent166Enabled()) {
    return NextResponse.json(
      { error: "Legal consent feature is disabled (phase-166 off)" },
      { status: 404 },
    );
  }

  const lang = request.nextUrl.searchParams.get("lang") ?? "en";
  const docs = getCanonicalDocuments();
  const copy = getLegalCopy(lang);

  return NextResponse.json({
    documents: docs,
    copy,
    active_versions: {
      tos: docs.tos.version,
      privacy: docs.privacy.version,
    },
    hashes: {
      tos: docs.tos.content_sha256,
      privacy: docs.privacy.content_sha256,
    },
  });
}
