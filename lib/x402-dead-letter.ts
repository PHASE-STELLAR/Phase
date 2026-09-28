/**
 * Module #44 (Issue #68) — Quarantine malformed x402 invoices in a dead-letter review queue.
 *
 * AUDIT NOTE (execution flow, app/api/classic-liq/trustline/route.ts):
 * The trustline POST handler parses the request body with a zod schema and, on
 * failure, returned a bare 400 carrying `parsed.error.flatten()`. The malformed
 * payload itself was dropped — no persistence, no audit trail, no operator
 * visibility into WHAT the caller sent or how often a bad shape recurs. The
 * x402 settlement-invoice envelope attached to that call had the same hole: a
 * bad `cid` / `expectedSha256` / `cidPath` combination produced a 400/409 and
 * vanished.
 *
 * This module is the isolated domain for malformed-invoice quarantine:
 *   - X402InvoiceSchema  — type-safe schema for the x402 invoice envelope
 *   - classifyInvoice()  — pure validation → typed reasons, zero I/O
 *   - quarantineInvoice() — appends the rejected payload + reasons to a
 *     dead-letter JSON sidecar, redacting obviously-secret fields first
 *   - listDeadLetterQueue() / getDeadLetterEntry() / resolveDeadLetterEntry()
 *     — operator review surface
 *
 * Flag: phase-144 (NEXT_PUBLIC_FEATURE_PHASE_144 / FEATURE_PHASE_144).
 * When the flag is off, quarantineInvoice() is a no-op returning
 * { quarantined: false, reason: "flag-disabled" } and the route keeps its
 * legacy bare-400 behaviour (zero regression). The pure helpers stay callable
 * so they can be unit-tested in isolation with `npx tsx`.
 *
 * Rollback: unset the flag. The x402-dead-letter.json sidecar can be deleted;
 * nothing else references it.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"
import { serverDataJsonPath } from "@/lib/server-data-paths"

export function isX402DeadLetterEnabled(): boolean {
  const v = (
    process.env.NEXT_PUBLIC_FEATURE_PHASE_144 ??
    process.env.FEATURE_PHASE_144 ??
    ""
  )
    .trim()
    .toLowerCase()
  return v === "1" || v === "true" || v === "yes" || v === "on"
}

export function flag144RollbackNote(): string {
  return "Rollback phase-144: unset NEXT_PUBLIC_FEATURE_PHASE_144 / FEATURE_PHASE_144 or set 0/false and restart. The x402-dead-letter.json sidecar can be deleted; nothing else reads it."
}

// ─── x402 invoice envelope schema ───────────────────────────────────────────

export const X402InvoiceSchema = z.object({
  invoiceId: z.string().trim().min(1).max(128),
  amount: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,7})?$/, "amount must be a non-negative decimal with <= 7 dp"),
  asset: z.string().trim().min(1).max(64),
  payTo: z
    .string()
    .trim()
    .length(56)
    .regex(/^G[A-Z2-7]{55}$/, "payTo must be a Stellar public (G...) address"),
  network: z.enum(["testnet", "mainnet", "pubnet"]).default("testnet"),
  nonce: z.string().trim().min(1).max(128).optional(),
  expiresAt: z.number().int().positive().optional(),
  memo: z.string().trim().max(256).optional(),
})

export type X402Invoice = z.infer<typeof X402InvoiceSchema>

export type DeadLetterReason = { path: string; code: string; message: string }

export type DeadLetterStatus = "open" | "resolved" | "discarded"

export type X402DeadLetterEntry = {
  id: string
  source: string
  received_at: number
  status: DeadLetterStatus
  fingerprint: string
  reasons: DeadLetterReason[]
  raw_payload: unknown
  resolved_at?: number
  resolved_by?: string
  resolution_note?: string
}

export class X402DeadLetterError extends Error {
  readonly code: "FLAG_DISABLED" | "STORE_WRITE_FAILED" | "NOT_FOUND"
  constructor(code: X402DeadLetterError["code"], message: string) {
    super(message)
    this.name = "X402DeadLetterError"
    this.code = code
  }
}

// ─── Pure classification ────────────────────────────────────────────────────

export type InvoiceClassification =
  | { ok: true; invoice: X402Invoice }
  | { ok: false; reasons: DeadLetterReason[] }

export function zodIssuesToReasons(issues: z.ZodIssue[]): DeadLetterReason[] {
  return issues.map((issue) => ({
    path: issue.path.join(".") || "(root)",
    code: issue.code,
    message: issue.message,
  }))
}

/** Pure — validates an x402 invoice envelope and returns typed rejection reasons. */
export function classifyInvoice(raw: unknown): InvoiceClassification {
  const parsed = X402InvoiceSchema.safeParse(raw)
  if (parsed.success) return { ok: true, invoice: parsed.data }
  return { ok: false, reasons: zodIssuesToReasons(parsed.error.issues) }
}

function normalizeReasons(
  reasons: DeadLetterReason[] | z.ZodIssue[] | undefined,
): DeadLetterReason[] {
  if (!reasons || reasons.length === 0) {
    return [{ path: "(root)", code: "unknown", message: "unspecified validation failure" }]
  }
  return reasons.map((reason) => {
    if (Array.isArray((reason as z.ZodIssue).path)) {
      const issue = reason as z.ZodIssue
      return { path: issue.path.join(".") || "(root)", code: issue.code, message: issue.message }
    }
    const dr = reason as DeadLetterReason
    return {
      path: dr.path ?? "(root)",
      code: dr.code ?? "invalid",
      message: dr.message ?? "invalid",
    }
  })
}

const SECRET_KEY_RE = /(secret|seed|priv|passphrase|password|token|jwt|mnemonic|api[_-]?key)/i
const MAX_STRING_LEN = 4096
const MAX_DEPTH = 6

/** Deep-copies `value`, replacing secret-looking keys with "[redacted]" and clamping huge strings. */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[truncated:max-depth]"
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((entry) => redactSecrets(entry, depth + 1))
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_RE.test(key) ? "[redacted]" : redactSecrets(entry, depth + 1)
    }
    return out
  }
  if (typeof value === "string" && value.length > MAX_STRING_LEN) {
    return `${value.slice(0, MAX_STRING_LEN)}…[truncated]`
  }
  return value
}

export function fingerprintPayload(raw: unknown): string {
  let serialized: string
  try {
    serialized = JSON.stringify(raw) ?? "null"
  } catch {
    serialized = String(raw)
  }
  return createHash("sha256").update(serialized).digest("hex").slice(0, 32)
}

// ─── Dead-letter store ──────────────────────────────────────────────────────

type DeadLetterStore = Record<string, X402DeadLetterEntry>

async function readStore(): Promise<DeadLetterStore> {
  try {
    const raw = await readFile(serverDataJsonPath("x402DeadLetter"), "utf8")
    const parsed = JSON.parse(raw) as DeadLetterStore
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

async function writeStore(data: DeadLetterStore): Promise<void> {
  const filePath = serverDataJsonPath("x402DeadLetter")
  try {
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, JSON.stringify(data, null, 2), "utf8")
  } catch (e) {
    throw new X402DeadLetterError(
      "STORE_WRITE_FAILED",
      e instanceof Error ? e.message : String(e),
    )
  }
}

export type QuarantineInput = {
  source: string
  raw: unknown
  reasons?: DeadLetterReason[] | z.ZodIssue[]
}

export type QuarantineResult =
  | { quarantined: true; id: string; fingerprint: string; duplicateOf?: string }
  | { quarantined: false; reason: "flag-disabled" }

/**
 * Persists a rejected payload into the dead-letter review queue. No-op (returns
 * flag-disabled) when phase-144 is off. Never throws for the caller's benefit —
 * a store-write failure is surfaced as a rejected promise the route can swallow.
 */
export async function quarantineInvoice(input: QuarantineInput): Promise<QuarantineResult> {
  if (!isX402DeadLetterEnabled()) return { quarantined: false, reason: "flag-disabled" }

  const reasons = normalizeReasons(input.reasons).slice(0, 50)
  const fingerprint = fingerprintPayload(input.raw)
  const store = await readStore()
  const priorOpen = Object.values(store).find(
    (entry) => entry.fingerprint === fingerprint && entry.status === "open",
  )

  const id = randomUUID()
  store[id] = {
    id,
    source: String(input.source).slice(0, 128),
    received_at: Date.now(),
    status: "open",
    fingerprint,
    reasons,
    raw_payload: redactSecrets(input.raw),
  }
  await writeStore(store)

  return priorOpen
    ? { quarantined: true, id, fingerprint, duplicateOf: priorOpen.id }
    : { quarantined: true, id, fingerprint }
}

export async function listDeadLetterQueue(
  opts: { status?: DeadLetterStatus; limit?: number } = {},
): Promise<X402DeadLetterEntry[]> {
  const store = await readStore()
  let items = Object.values(store)
  if (opts.status) items = items.filter((entry) => entry.status === opts.status)
  items.sort((a, b) => b.received_at - a.received_at)
  return typeof opts.limit === "number" ? items.slice(0, Math.max(0, opts.limit)) : items
}

export async function getDeadLetterEntry(id: string): Promise<X402DeadLetterEntry | null> {
  const store = await readStore()
  return store[id] ?? null
}

export async function resolveDeadLetterEntry(
  id: string,
  opts: { status?: "resolved" | "discarded"; by?: string; note?: string } = {},
): Promise<X402DeadLetterEntry> {
  const store = await readStore()
  const entry = store[id]
  if (!entry) throw new X402DeadLetterError("NOT_FOUND", `Dead-letter entry ${id} not found`)
  entry.status = opts.status ?? "resolved"
  entry.resolved_at = Date.now()
  if (opts.by) entry.resolved_by = opts.by.slice(0, 64)
  if (opts.note) entry.resolution_note = opts.note.slice(0, 512)
  await writeStore(store)
  return entry
}

export async function getDeadLetterStats(): Promise<{
  total: number
  open: number
  resolved: number
  discarded: number
}> {
  const items = Object.values(await readStore())
  return {
    total: items.length,
    open: items.filter((e) => e.status === "open").length,
    resolved: items.filter((e) => e.status === "resolved").length,
    discarded: items.filter((e) => e.status === "discarded").length,
  }
}

/** Test helper — empties the sidecar. */
export async function clearDeadLetterForTests(): Promise<void> {
  await writeStore({})
}
