import { NextRequest, NextResponse } from "next/server";
import {
  isAuditExport168Enabled,
  verifyAuditExportAuth,
  getAuditExport,
  formatEventsToCsv,
  formatEventsToNdjson,
  ModerationAuditExportError,
} from "@/lib/moderation-audit-export";
import type {
  AuditExportFormat,
  AuditExportRole,
} from "@/lib/types/moderation-export";
import type { ModerationAction } from "@/lib/moderation-audit";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isAuditExport168Enabled()) {
    return NextResponse.json(
      { error: "Moderation audit export is disabled (set NEXT_PUBLIC_FEATURE_PHASE_168=1)" },
      { status: 404 },
    );
  }

  const { searchParams } = request.nextUrl;
  const roleParam = searchParams.get("role")?.toLowerCase() ?? "moderator";
  const formatParam = searchParams.get("format")?.toLowerCase() ?? "json";

  const role: AuditExportRole = roleParam === "regulator" ? "regulator" : "moderator";
  const format: AuditExportFormat =
    formatParam === "csv" ? "csv" : formatParam === "ndjson" ? "ndjson" : "json";

  // Role authentication check
  const auth = verifyAuditExportAuth(request.headers, role);
  if (!auth.authorized) {
    return NextResponse.json(
      { error: "Unauthorized", reason: auth.reason },
      { status: 401 },
    );
  }

  // Parse filters
  const from = searchParams.get("from") ? Number(searchParams.get("from")) : undefined;
  const to = searchParams.get("to") ? Number(searchParams.get("to")) : undefined;
  const action = searchParams.get("action") as ModerationAction | undefined;
  const signal_id = searchParams.get("signal_id") || undefined;
  const limit = searchParams.get("limit") ? Number(searchParams.get("limit")) : undefined;
  const cursor = searchParams.get("cursor") || undefined;

  try {
    const result = await getAuditExport({
      role,
      format,
      from,
      to,
      action,
      signal_id,
      limit,
      cursor,
    });

    const filename = `moderation-audit-${role}-${Date.now()}.${format}`;

    if (format === "csv") {
      const csv = formatEventsToCsv(result.events);
      return new NextResponse(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      });
    }

    if (format === "ndjson") {
      const ndjson = formatEventsToNdjson(result.events);
      return new NextResponse(ndjson, {
        status: 200,
        headers: {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      });
    }

    // Default JSON
    return new NextResponse(JSON.stringify(result, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    if (err instanceof ModerationAuditExportError) {
      const status =
        err.code === "FLAG_DISABLED" ? 404 : err.code === "UNAUTHORIZED" ? 401 : 400;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    return NextResponse.json(
      { error: "Internal server error", detail: String(err) },
      { status: 500 },
    );
  }
}
