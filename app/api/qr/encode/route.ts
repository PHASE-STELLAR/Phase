import { NextRequest, NextResponse } from "next/server"
import { isQrFlowsEnabled, generateQrSvg } from "@/lib/qr-code"
import { recordSecurityCounter } from "@/lib/security-counters"

/**
 * GET /api/qr/encode?data=...&size=240&format=svg
 *
 * Generates an SVG representation of a QR code payload.
 * Flag-gated behind phase-166.
 */
export async function GET(req: NextRequest) {
  if (!isQrFlowsEnabled()) {
    return NextResponse.json({ error: "QR flows disabled (phase-166 off)" }, { status: 404 })
  }

  const { searchParams } = new URL(req.url)
  const data = searchParams.get("data")
  if (!data || data.trim().length === 0) {
    return NextResponse.json({ error: "Missing required query parameter: data" }, { status: 400 })
  }

  const size = Math.min(Math.max(Number(searchParams.get("size")) || 240, 64), 1024)
  const darkColor = searchParams.get("dark") || "#ffffff"
  const lightColor = searchParams.get("light") || "#0d0d14"
  const format = searchParams.get("format") || "svg"

  try {
    const svg = generateQrSvg(data, {
      size,
      darkColor,
      lightColor,
      margin: 2,
    })

    if (data.startsWith("web+stellar:pay") || data.startsWith("stellar:pay") || data.startsWith("G")) {
      recordSecurityCounter("qr_generated_receive")
    } else if (data.includes("ref=")) {
      recordSecurityCounter("qr_generated_referral")
    }

    if (format === "json") {
      return NextResponse.json({ ok: true, data, svg })
    }

    return new NextResponse(svg, {
      status: 200,
      headers: {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=86400, stale-while-revalidate=3600",
        "X-Content-Type-Options": "nosniff",
      },
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: "Failed to generate QR code", message }, { status: 500 })
  }
}
