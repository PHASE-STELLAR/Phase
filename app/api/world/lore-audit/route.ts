import { NextRequest, NextResponse } from "next/server";
import { isFeatureEnabled } from "@/lib/feature-flags";
import {
  auditLorePassages,
  listLoreAuditReports,
  getLoreAuditReport,
  LorePassage,
} from "@/lib/lore-auditor";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!isFeatureEnabled("phase-153")) {
    return NextResponse.json({ error: "Feature phase-153 disabled" }, { status: 404 });
  }

  const { searchParams } = new URL(req.url);
  const reportId = searchParams.get("report_id");

  if (reportId) {
    const report = getLoreAuditReport(reportId);
    if (!report) {
      return NextResponse.json({ error: "Audit report not found" }, { status: 404 });
    }
    return NextResponse.json({ report });
  }

  const colId = searchParams.get("collection_id")
    ? parseInt(searchParams.get("collection_id")!, 10)
    : undefined;

  const reports = listLoreAuditReports(colId);
  return NextResponse.json({ reports });
}

export async function POST(req: NextRequest) {
  if (!isFeatureEnabled("phase-153")) {
    return NextResponse.json({ error: "Feature phase-153 disabled" }, { status: 404 });
  }

  try {
    const body = await req.json();
    if (!body || !Array.isArray(body.passages) || body.passages.length === 0) {
      return NextResponse.json({ error: "Missing or empty passages array" }, { status: 400 });
    }

    const colId = body.collection_id !== undefined ? Number(body.collection_id) : null;
    const report = auditLorePassages(body.passages as LorePassage[], colId);

    return NextResponse.json({ ok: true, report }, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Audit failed" }, { status: 500 });
  }
}
