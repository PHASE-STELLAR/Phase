import { createHmac, timingSafeEqual } from "node:crypto"
import { StrKey } from "@stellar/stellar-sdk"
import { NextResponse } from "next/server"
import { z } from "zod"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { getDb } from "@/lib/sqlite-db"
import { resolveStellarNetwork } from "@/lib/stellar-network"
import { incSecurityCounter } from "@/lib/security-counters"
import { readBoundedBody } from "@/lib/bounded-body"

export type ComplianceOperation = "faucet" | "bounty" | "bootstrap" | "trustline" | "x402"
export type ComplianceCode = "KYC_REQUIRED" | "SANCTIONS_BLOCKED" | "SCREENING_UNAVAILABLE" | "INVALID_AMOUNT" | "INVALID_WALLET"
export class ComplianceError extends Error {
  constructor(public code: ComplianceCode, public status: number) { super(code) }
}
const providerResult = z.object({ sanctions: z.enum(["clear", "blocked"]), checkedAt: z.number().int(), expiresAt: z.number().int() }).strict()
export const verificationEvent = z.object({
  eventId: z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/),
  wallet: z.string().refine(StrKey.isValidEd25519PublicKey),
  subject: z.string().min(1).max(256),
  status: z.enum(["verified", "revoked"]),
  expiresAt: z.number().int().positive(),
  expectedVersion: z.number().int().nonnegative(),
}).strict()

function config() {
  const mode = process.env.PHASE_KYC_MODE ?? "off"
  if (!["off", "mock", "live"].includes(mode)) throw new ComplianceError("SCREENING_UNAVAILABLE", 503)
  if (mode === "mock" && resolveStellarNetwork().network !== "testnet") throw new ComplianceError("SCREENING_UNAVAILABLE", 503)
  return mode
}
function identityKey(value: string) {
  const secret = process.env.PHASE_KYC_HASH_KEY
  if (!secret || secret.length < 32) throw new ComplianceError("SCREENING_UNAVAILABLE", 503)
  return createHmac("sha256", secret).update(value).digest("hex")
}

export function applyVerificationEvent(raw: unknown): { replay: boolean; version: number } {
  if (!isFeatureEnabled("phase-176") || config() === "off") throw new Error("DISABLED")
  const event = verificationEvent.parse(raw)
  const now = Date.now()
  if (event.expiresAt <= now || event.expiresAt > now + 366 * 86400_000) throw new Error("INVALID_EXPIRY")
  const walletHash = identityKey(`wallet:${event.wallet}`)
  const subjectHash = identityKey(`subject:${event.subject}`)
  const db = getDb()
  db.exec("BEGIN IMMEDIATE")
  try {
    const current = db.prepare("SELECT version FROM compliance_credentials WHERE wallet_hash = ?").get(walletHash) as { version: number } | undefined
    const version = current?.version ?? 0
    if (db.prepare("SELECT 1 FROM compliance_webhooks WHERE id = ?").get(event.eventId)) {
      db.exec("COMMIT")
      incSecurityCounter("compliance_webhook_replay")
      return { replay: true, version }
    }
    if (event.expectedVersion !== version) {
      throw Object.assign(new Error("VERSION_CONFLICT"), { current_version: version })
    }
    db.prepare(`INSERT INTO compliance_credentials(wallet_hash, subject_hash, status, expires_at, version)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(wallet_hash) DO UPDATE SET subject_hash=excluded.subject_hash,
      status=excluded.status, expires_at=excluded.expires_at, version=excluded.version`)
      .run(walletHash, subjectHash, event.status, event.expiresAt, version + 1)
    db.prepare("INSERT INTO compliance_webhooks(id, received_at) VALUES (?, ?)").run(event.eventId, now)
    db.exec("COMMIT")
    return { replay: false, version: version + 1 }
  } catch (error) { db.exec("ROLLBACK"); throw error }
}

export function verifyComplianceWebhook(body: string, timestamp: string, signature: string): boolean {
  const secret = process.env.PHASE_KYC_WEBHOOK_SECRET
  if (!secret || secret.length < 32 || !/^\d{13}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 300_000 || !/^[a-f0-9]{64}$/.test(signature)) return false
  const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest()
  return timingSafeEqual(expected, Buffer.from(signature, "hex"))
}

export async function screenCompliance(wallet: string, amountStroops: string, operation: ComplianceOperation): Promise<void> {
  if (!isFeatureEnabled("phase-176")) return
  const mode = config()
  if (mode === "off") return
  if (!StrKey.isValidEd25519PublicKey(wallet)) throw new ComplianceError("INVALID_WALLET", 400)
  if (!/^\d{1,38}$/.test(amountStroops)) throw new ComplianceError("INVALID_AMOUNT", 400)
  let screening: z.infer<typeof providerResult>
  const now = Date.now()
  try {
    if (mode === "mock") {
      const blocked = (process.env.PHASE_KYC_MOCK_BLOCKED_WALLETS ?? "").split(",").includes(wallet)
      screening = { sanctions: blocked ? "blocked" : "clear", checkedAt: now, expiresAt: now + 60_000 }
    } else {
      const endpoint = new URL(process.env.PHASE_SANCTIONS_URL ?? "")
      if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || !process.env.PHASE_SANCTIONS_API_KEY) throw new Error("CONFIG")
      const response = await fetch(endpoint, {
        method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(3000),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.PHASE_SANCTIONS_API_KEY}` },
        body: JSON.stringify({ wallet, operation, network: resolveStellarNetwork().network }),
      })
      if (!response.ok) throw new Error("PROVIDER_UNAVAILABLE")
      screening = providerResult.parse(JSON.parse(await readBoundedBody(response, 4096)))
    }
    // No stale-on-error for sanctions: every instance asks the same provider.
    if (screening.checkedAt > now + 30_000 || screening.checkedAt < now - 3600_000 || screening.expiresAt <= now || screening.expiresAt <= screening.checkedAt) throw new Error("STALE_SCREENING")
  } catch {
    incSecurityCounter("compliance_unavailable")
    throw new ComplianceError("SCREENING_UNAVAILABLE", 503)
  }
  if (screening.sanctions === "blocked") {
    incSecurityCounter("compliance_denied")
    throw new ComplianceError("SANCTIONS_BLOCKED", 451)
  }
  const threshold = process.env.PHASE_KYC_THRESHOLD_STROOPS ?? "10000000000"
  if (!/^\d{1,38}$/.test(threshold) || BigInt(threshold) === 0n) throw new ComplianceError("SCREENING_UNAVAILABLE", 503)
  if (BigInt(amountStroops) >= BigInt(threshold)) {
    const credential = getDb().prepare("SELECT status, expires_at FROM compliance_credentials WHERE wallet_hash = ?").get(identityKey(`wallet:${wallet}`)) as { status: string; expires_at: number } | undefined
    if (!credential || credential.status !== "verified" || credential.expires_at <= now) {
      incSecurityCounter("compliance_denied")
      throw new ComplianceError("KYC_REQUIRED", 403)
    }
  }
  incSecurityCounter("compliance_allowed")
}

export async function complianceGate(wallet: string, amount: string, operation: ComplianceOperation): Promise<NextResponse | null> {
  try { await screenCompliance(wallet, amount, operation); return null }
  catch (error) {
    const failure = error instanceof ComplianceError ? error : new ComplianceError("SCREENING_UNAVAILABLE", 503)
    return NextResponse.json({ error: failure.code, code: failure.code }, { status: failure.status, headers: { "Cache-Control": "private, no-store", ...(failure.status === 503 ? { "Retry-After": "60" } : {}) } })
  }
}
