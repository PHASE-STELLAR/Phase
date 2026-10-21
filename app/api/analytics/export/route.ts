import { NextRequest, NextResponse } from "next/server"
import {
  isWarehouseExportEnabled,
  collectWarehouseRows,
  redactWarehouseRows,
  formatWarehouseNdjson,
  rowsToParquetBuffer,
  WarehouseExportError,
  WAREHOUSE_SCHEMA_VERSION,
} from "@/lib/analytics-warehouse"
import { checkAdminKey } from "@/lib/admin-key"
import { incSecurityCounter } from "@/lib/security-counters"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  if (!isWarehouseExportEnabled()) {
    return NextResponse.json(
      { error: "Analytics warehouse export is disabled (set NEXT_PUBLIC_FEATURE_PHASE_180=1)" },
      { status: 404 },
    )
  }

  if (checkAdminKey(request) !== "ok") {
    return NextResponse.json(
      { error: "Unauthorized: valid x-admin-key required" },
      { status: 401 },
    )
  }

  const formatParam = request.nextUrl.searchParams.get("format")?.toLowerCase() ?? "ndjson"
  if (formatParam !== "ndjson" && formatParam !== "parquet") {
    return NextResponse.json({ error: "format must be ndjson or parquet" }, { status: 400 })
  }

  try {
    const rows = redactWarehouseRows(await collectWarehouseRows())
    incSecurityCounter("warehouse_records_redacted", rows.length)
    incSecurityCounter("warehouse_export_runs")
    const generatedAt = Date.now()

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
