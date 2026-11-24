import { NextRequest, NextResponse } from "next/server"
import {
  MAX_WAREHOUSE_EXPORT_ROWS,
  WAREHOUSE_SCHEMA_VERSION,
  WarehouseExportError,
  appendWarehouseExportAuditEvent,
  collectWarehouseRows,
  consumeWarehouseExportGrant,
  formatWarehouseNdjson,
  isWarehouseExportEnabled,
  isWarehouseIntegrationExportEnabled,
  issueWarehouseExportGrant,
  redactWarehouseRows,
  rowsToParquetBuffer,
  sanitizeWarehouseRowsClosed,
  streamWarehouseNdjson,
} from "@/lib/analytics-warehouse"
import { checkAdminKey } from "@/lib/admin-key"
import { incSecurityCounter } from "@/lib/security-counters"

export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  if (!isWarehouseIntegrationExportEnabled()) {
    return NextResponse.json(
      { error: "Analytics warehouse export integration is disabled (phase-253)" },
      { status: 404 },
    )
  }
  if (checkAdminKey(request) !== "ok") {
    return NextResponse.json(
      { error: "Unauthorized: valid x-admin-key required" },
      { status: 401 },
    )
  }

  let body: { ttlMs?: number; maxRows?: number } = {}
  try {
    body = (await request.json()) as typeof body
  } catch {
    body = {}
  }

  const grant = issueWarehouseExportGrant({
    ttlMs: typeof body.ttlMs === "number" ? body.ttlMs : undefined,
    maxRows: typeof body.maxRows === "number" ? body.maxRows : undefined,
  })
  return NextResponse.json(grant, { status: 201, headers: { "Cache-Control": "no-store" } })
}

export async function GET(request: NextRequest) {
  const legacyEnabled = isWarehouseExportEnabled()
  const integrationEnabled = isWarehouseIntegrationExportEnabled()

  if (!legacyEnabled && !integrationEnabled) {
    return NextResponse.json(
      { error: "Analytics warehouse export is disabled" },
      { status: 404 },
    )
  }

  const formatParam = request.nextUrl.searchParams.get("format")?.toLowerCase() ?? "ndjson"
  if (formatParam !== "ndjson" && formatParam !== "parquet") {
    return NextResponse.json({ error: "format must be ndjson or parquet" }, { status: 400 })
  }

  let grantId: string | null = null
  let rowCap = MAX_WAREHOUSE_EXPORT_ROWS

  if (integrationEnabled) {
    const grantToken =
      request.headers.get("x-export-grant")?.trim() ??
      request.nextUrl.searchParams.get("grant")?.trim() ??
      ""

    if (grantToken) {
      const consumed = consumeWarehouseExportGrant(grantToken)
      if (!consumed.ok) {
        appendWarehouseExportAuditEvent({
          format: formatParam,
          rowCount: 0,
          truncated: false,
          status: "rejected",
          reason: consumed.code,
        })
        return NextResponse.json({ error: consumed.code, code: consumed.code }, { status: 403 })
      }
      grantId = consumed.grantId
      rowCap = consumed.maxRows
    } else if (checkAdminKey(request) !== "ok") {
      return NextResponse.json(
        { error: "Unauthorized: valid export grant or x-admin-key required" },
        { status: 401 },
      )
    }

    const requestedCap = Number(request.nextUrl.searchParams.get("limit") ?? rowCap)
    if (Number.isFinite(requestedCap) && requestedCap > 0) {
      rowCap = Math.min(rowCap, Math.floor(requestedCap), MAX_WAREHOUSE_EXPORT_ROWS)
    }
  } else if (checkAdminKey(request) !== "ok") {
    return NextResponse.json(
      { error: "Unauthorized: valid x-admin-key required" },
      { status: 401 },
    )
  }

  try {
    const collected = await collectWarehouseRows()
    const generatedAt = Date.now()

    if (integrationEnabled) {
      const sanitized = sanitizeWarehouseRowsClosed(collected)
      incSecurityCounter("warehouse_records_redacted", sanitized.length)
      incSecurityCounter("warehouse_export_runs")

      if (formatParam === "parquet") {
        const capped = sanitized.slice(0, rowCap)
        const truncated = sanitized.length > rowCap
        const { manifest, buffer } = rowsToParquetBuffer(capped, { generatedAt })
        appendWarehouseExportAuditEvent({
          grantId,
          format: "parquet",
          rowCount: capped.length,
          truncated,
          status: "success",
        })
        return new NextResponse(Buffer.from(buffer), {
          status: 200,
          headers: {
            "Content-Type": "application/vnd.apache.parquet",
            "Content-Disposition": `attachment; filename="phase-warehouse-${generatedAt}.parquet"`,
            "X-Warehouse-Schema-Version": WAREHOUSE_SCHEMA_VERSION,
            "X-Warehouse-Checksum": manifest.checksum,
            "X-Warehouse-Row-Cap": String(rowCap),
            "X-Warehouse-Truncated": String(truncated),
          },
        })
      }

      const pageSizeParam = Number(request.nextUrl.searchParams.get("pageSize") ?? 100)
      const { manifest, stream, truncated } = streamWarehouseNdjson(sanitized, {
        rowCap,
        pageSize: Number.isFinite(pageSizeParam) && pageSizeParam > 0 ? pageSizeParam : 100,
        generatedAt,
      })
      appendWarehouseExportAuditEvent({
        grantId,
        format: "ndjson",
        rowCount: manifest.row_count,
        truncated,
        status: "success",
      })
      return new NextResponse(stream, {
        status: 200,
        headers: {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Content-Disposition": `attachment; filename="phase-warehouse-${generatedAt}.ndjson"`,
          "X-Warehouse-Schema-Version": WAREHOUSE_SCHEMA_VERSION,
          "X-Warehouse-Checksum": manifest.checksum,
          "X-Warehouse-Row-Cap": String(rowCap),
          "X-Warehouse-Truncated": String(truncated),
        },
      })
    }

    const rows = redactWarehouseRows(collected)
    incSecurityCounter("warehouse_records_redacted", rows.length)
    incSecurityCounter("warehouse_export_runs")

    if (formatParam === "parquet") {
      const { manifest, buffer } = rowsToParquetBuffer(rows, { generatedAt })
      return new NextResponse(Buffer.from(buffer), {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.apache.parquet",
          "Content-Disposition": `attachment; filename="phase-warehouse-${generatedAt}.parquet"`,
          "X-Warehouse-Schema-Version": WAREHOUSE_SCHEMA_VERSION,
          "X-Warehouse-Checksum": manifest.checksum,
        },
      })
    }

    const { manifest, body } = formatWarehouseNdjson(rows, { generatedAt })
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Content-Disposition": `attachment; filename="phase-warehouse-${generatedAt}.ndjson"`,
        "X-Warehouse-Schema-Version": WAREHOUSE_SCHEMA_VERSION,
        "X-Warehouse-Checksum": manifest.checksum,
      },
    })
  } catch (error) {
    incSecurityCounter("warehouse_export_failed")
    if (error instanceof WarehouseExportError) {
      const status = error.code === "FLAG_DISABLED" ? 404 : error.code === "UNAUTHORIZED" ? 401 : 500
      return NextResponse.json({ error: error.message, code: error.code }, { status })
    }
    throw error
  }
}
