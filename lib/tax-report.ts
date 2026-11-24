import { createHash } from "node:crypto"
import { Keypair, StrKey } from "@stellar/stellar-sdk"
import { taxExportMessage, type TaxExportRequest } from "@/lib/tax-export-proof"
export { taxExportSchema } from "@/lib/tax-export-proof"
import { getDb } from "@/lib/sqlite-db"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { incSecurityCounter } from "@/lib/security-counters"
import { formatStroops } from "@/lib/decimal-amount"

export type TaxEvent = {
  eventKey: string; wallet: string; kind: "acquisition" | "disposal" | "royalty" | "reward"
  asset: string; amountStroops: string; basisStroops?: string | null; txHash?: string
  occurredAt: number; verified: boolean; washFlagged?: boolean
}
type TaxRow = { seq: number; event_key: string; wallet: string; kind: TaxEvent["kind"]; asset: string; amount_stroops: string; basis_stroops: string | null; tx_hash: string | null; occurred_at: number; verified: number; wash_flagged: number }

export function recordTaxEvent(event: TaxEvent, count = true): boolean {
  if (!isFeatureEnabled("phase-177")) return false
  if (!StrKey.isValidEd25519PublicKey(event.wallet) || !/^\d{1,38}$/.test(event.amountStroops) || (event.basisStroops != null && !/^\d{1,38}$/.test(event.basisStroops)) || !Number.isSafeInteger(event.occurredAt) || event.occurredAt <= 0 || event.eventKey.length > 256 || !event.eventKey || event.asset.length > 256) throw new Error("INVALID_TAX_EVENT")
  if (event.verified && !/^[a-f0-9]{64}$/.test(event.txHash ?? "")) throw new Error("VERIFIED_RECEIPT_REQUIRED")
  const db = getDb()
  const values = [event.eventKey, event.wallet, event.kind, event.asset, BigInt(event.amountStroops).toString(), event.basisStroops != null ? BigInt(event.basisStroops).toString() : null, event.txHash ?? null, event.occurredAt, event.verified ? 1 : 0, event.washFlagged ? 1 : 0] as const
  const result = db.prepare(`INSERT INTO tax_events(event_key,wallet,kind,asset,amount_stroops,basis_stroops,tx_hash,occurred_at,verified,wash_flagged)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(event_key) DO NOTHING`).run(...values)
  if (result.changes) {
    if (count) incSecurityCounter("tax_event_recorded")
    return true
  }
  else {
    const row = db.prepare("SELECT * FROM tax_events WHERE event_key=?").get(event.eventKey) as TaxRow
    const previous = [row.event_key,row.wallet,row.kind,row.asset,row.amount_stroops,row.basis_stroops,row.tx_hash,row.occurred_at,row.verified,row.wash_flagged]
    if (JSON.stringify(previous) !== JSON.stringify(values)) throw new Error("TAX_EVENT_CONFLICT")
  }
  return false
}

export function verifyTaxExport(input: TaxExportRequest, network: string, signature: string, now = Date.now()): boolean {
  if (input.exp * 1000 <= now || input.exp * 1000 > now + 300_000 || signature.length > 256) return false
  try { return Keypair.fromPublicKey(input.wallet).verify(Buffer.from(`Stellar Signed Message:\n${taxExportMessage(input, network)}`), Buffer.from(signature, "base64")) }
  catch { return false }
}

export function taxExportRateLimited(wallet: string, now = Date.now()): boolean {
  const db = getDb(), minute = Math.floor(now / 60_000)
  db.prepare("DELETE FROM tax_export_rate WHERE minute < ?").run(minute - 1)
  const row = db.prepare(`INSERT INTO tax_export_rate(wallet,minute,count) VALUES (?,?,1)
    ON CONFLICT(wallet,minute) DO UPDATE SET count=count+1 RETURNING count`).get(wallet, minute) as { count: number }
  return row.count > 60
}

/** RFC 4180 quoting plus spreadsheet formula neutralization. Numeric fields are generated separately. */
export function csvCell(value: string): string {
  const safe = /^[\s]*[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return `"${safe.replace(/"/g, '""')}"`
}

export function* taxCsv(input: TaxExportRequest, snapshot: number): Generator<string> {
  const db = getDb()
  const from = Date.parse(input.from), to = Date.parse(input.to)
  let cursorTime = from, cursorSeq = 0
  let hash = createHash("sha256").update(JSON.stringify({ version: 1, wallet: input.wallet, from: input.from, to: input.to, policy: input.policy, snapshot })).digest("hex")
  yield "event_id,date_utc,type,asset,amount_phaselq,basis_phaselq,proceeds_phaselq,gain_phaselq,royalty_income_phaselq,tx_hash,flags,lot_policy,recomputation_hash\r\n"
  while (true) {
    const rows = db.prepare(`SELECT * FROM tax_events WHERE wallet=? AND seq<=? AND occurred_at>=? AND occurred_at<?
      AND (occurred_at>? OR (occurred_at=? AND seq>?)) ORDER BY occurred_at,seq LIMIT 50`)
      .all(input.wallet, snapshot, from, to, cursorTime, cursorTime, cursorSeq) as TaxRow[]
    if (!rows.length) break
    for (const row of rows) {
      const flags: string[] = []
      if (!row.verified) flags.push("unverified")
      if (row.wash_flagged) flags.push("wash_excluded")
      let basis: string | null = row.basis_stroops
      if (row.kind === "disposal") {
        // NFTs are indivisible lots. Latest prior disposal fences the holding cycle;
        // both policies coincide for a single token but rank multiple acquisition evidence deterministically.
        const previous = db.prepare(`SELECT occurred_at,seq FROM tax_events WHERE wallet=? AND asset=? AND kind='disposal'
          AND verified=1 AND wash_flagged=0 AND seq<=? AND (occurred_at<? OR (occurred_at=? AND seq<?))
          ORDER BY occurred_at DESC,seq DESC LIMIT 1`).get(input.wallet, row.asset, snapshot, row.occurred_at, row.occurred_at, row.seq) as { occurred_at: number; seq: number } | undefined
        const order = input.policy === "HIFO" ? "length(basis_stroops) DESC,basis_stroops DESC,occurred_at,seq" : "occurred_at,seq"
        const lot = db.prepare(`SELECT basis_stroops FROM tax_events WHERE wallet=? AND asset=? AND kind='acquisition'
          AND verified=1 AND wash_flagged=0 AND basis_stroops IS NOT NULL AND seq<=?
          AND (occurred_at>? OR (occurred_at=? AND seq>?))
          AND (occurred_at<? OR (occurred_at=? AND seq<?)) ORDER BY ${order} LIMIT 1`)
          .get(input.wallet, row.asset, snapshot, previous?.occurred_at ?? 0, previous?.occurred_at ?? 0, previous?.seq ?? 0, row.occurred_at, row.occurred_at, row.seq) as { basis_stroops: string } | undefined
        basis = lot?.basis_stroops ?? null
        if (!basis) flags.push("missing_basis")
      }
      if (row.kind === "reward") flags.push("fmv_unavailable")
      flags.push("testnet", "fx_unavailable")
      const eligible = !!row.verified && !row.wash_flagged
      const proceeds = row.kind === "disposal" && eligible ? row.amount_stroops : null
      const gain = proceeds != null && basis != null ? (BigInt(proceeds) - BigInt(basis)).toString() : null
      hash = createHash("sha256").update(hash).update(JSON.stringify({ row, basis, flags, policy: input.policy })).digest("hex")
      yield [row.event_key, new Date(row.occurred_at).toISOString(), row.kind, row.asset,
        formatStroops(row.amount_stroops), basis != null && eligible ? formatStroops(basis) : "",
        proceeds != null ? formatStroops(proceeds) : "", gain != null ? formatStroops(gain) : "",
        row.kind === "royalty" && eligible ? formatStroops(row.amount_stroops) : "", row.tx_hash ?? "", flags.join(";"), input.policy, hash].map((value, index) => index >= 4 && index <= 8 ? `"${value}"` : csvCell(value)).join(",") + "\r\n"
      cursorTime = row.occurred_at; cursorSeq = row.seq
    }
  }
}
