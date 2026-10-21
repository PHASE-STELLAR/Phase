import { NextRequest, NextResponse } from "next/server"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { taxExportSchema, verifyTaxExport, taxCsv, taxExportRateLimited } from "@/lib/tax-report"
import { resolveStellarNetwork } from "@/lib/stellar-network"
import { getDb } from "@/lib/sqlite-db"
import { incSecurityCounter } from "@/lib/security-counters"
import { readBoundedBody } from "@/lib/bounded-body"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60
export async function POST(request: NextRequest) {
  const headers = { "Cache-Control": "private, no-store" }
  if (!isFeatureEnabled("phase-177")) return NextResponse.json({ code: "DISABLED" }, { status: 404, headers })
  if (resolveStellarNetwork().network !== "testnet") return NextResponse.json({ code: "TESTNET_ONLY" }, { status: 503, headers })
  let raw: { claims?: unknown; signature?: string }
  try { raw = JSON.parse(await readBoundedBody(request, 4096)) } catch { return NextResponse.json({ code: "INVALID_JSON" }, { status: 400, headers }) }
  if (!raw || typeof raw !== "object" || typeof raw.signature !== "string") return NextResponse.json({ code: "INVALID_REQUEST" }, { status: 400, headers })
  const parsed = taxExportSchema.safeParse(raw.claims)
  if (!parsed.success) return NextResponse.json({ code: "INVALID_REQUEST" }, { status: 400, headers })
  const claims = parsed.data
  if (!verifyTaxExport(claims, resolveStellarNetwork().passphrase, raw.signature ?? "")) return NextResponse.json({ code: "INVALID_SIGNATURE" }, { status: 401, headers })
  if (taxExportRateLimited(claims.wallet)) return NextResponse.json({ code: "RATE_LIMITED" }, { status: 429, headers: { ...headers, "Retry-After": String(60 - Math.floor(Date.now() / 1000) % 60) } })
  const db = getDb()
  db.prepare("DELETE FROM tax_export_nonces WHERE expires_at<?").run(Date.now())
  const consumed = db.prepare("INSERT INTO tax_export_nonces(nonce,expires_at) VALUES (?,?) ON CONFLICT DO NOTHING").run(claims.nonce, claims.exp * 1000)
  if (!consumed.changes) return NextResponse.json({ code: "REPLAY" }, { status: 409, headers })
  const snapshot = (db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM tax_events").get() as { seq: number }).seq
  const iterator = taxCsv(claims, snapshot)
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      try { const next = iterator.next(); if (next.done) controller.close(); else controller.enqueue(encoder.encode(next.value)) }
      catch (error) { controller.error(error) }
    }, cancel() { iterator.return(undefined) },
  })
  incSecurityCounter("tax_exported")
  return new Response(stream, { headers: { ...headers, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="phase-testnet-${claims.wallet}-${claims.from.slice(0,10)}-${claims.policy}.csv"`, "X-Tax-Snapshot": String(snapshot), "X-Content-Type-Options": "nosniff" } })
}
