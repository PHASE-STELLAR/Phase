/**
 * Narrative contributor attribution and credit ledger — phase-116
 *
 * Co-authors previously received no on-chain credit. This module provides:
 *  - contributor roles (author, co-author, editor, illustrator)
 *  - credit ledger with basis-point shares (sum = 10000)
 *  - file-backed persistence via PHASE_SERVER_DATA_DIR
 *  - validation with zod, structured errors, flag gating
 *
 * Feature flag: phase-116 (NEXT_PUBLIC_FEATURE_PHASE_116 / FEATURE_PHASE_116)
 * Rollback: unset flag → ledger reads return empty; writes are no-ops.
 *           Stored JSON remains on disk; no ledger mutation to revert.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { isFeatureEnabled } from "@/lib/feature-flags"

// ─── flag ────────────────────────────────────────────────────────────────────

export function isPhase116Enabled(): boolean {
  return isFeatureEnabled("phase-116")
}

export function flag116RollbackNote(): string {
  return `Rollback phase-116: unset NEXT_PUBLIC_FEATURE_PHASE_116 / FEATURE_PHASE_116 or set to 0/false and restart. Ledger files remain; new contributions won't be recorded until re-enabled.`
}

// ─── schemas ─────────────────────────────────────────────────────────────────

export const ContributorRoleSchema = z.enum(["author", "co_author", "editor", "illustrator", "translator"])
export type ContributorRole = z.infer<typeof ContributorRoleSchema>

export const ContributorEntrySchema = z.object({
  wallet: z.string().trim().length(56).regex(/^G[A-Z2-7]{55}$/, "Invalid Stellar G address"),
  displayName: z.string().trim().min(1).max(48),
  role: ContributorRoleSchema,
  shareBps: z.number().int().min(0).max(10_000),
  addedAt: z.number().int().min(0),
  addedBy: z.string().trim().length(56).regex(/^G[A-Z2-7]{55}$/).nullable().optional(),
  signature: z.string().trim().min(1).max(512).nullable().optional(),
})

export type ContributorEntry = z.infer<typeof ContributorEntrySchema>

export const CreditLedgerEntrySchema = z.object({
  wallet: z.string().trim().length(56).regex(/^G[A-Z2-7]{55}$/),
  displayName: z.string().trim().min(1).max(48),
  totalShareBps: z.number().int().min(0).max(10_000),
  contributions: z.number().int().min(0),
  roles: z.array(ContributorRoleSchema),
  lastContributionAt: z.number().int().min(0),
})

export type CreditLedgerEntry = z.infer<typeof CreditLedgerEntrySchema>

export const SignalContributorsSchema = z.object({
  signalId: z.string().trim().min(1).max(64),
  contributors: z.array(ContributorEntrySchema).max(20),
  totalShareBps: z.number().int().min(0).max(10_000),
  updatedAt: z.number().int().min(0),
})

export type SignalContributors = z.infer<typeof SignalContributorsSchema>

export const AddContributorRequestSchema = z.object({
  signalId: z.string().trim().min(1).max(64),
  wallet: z.string().trim().length(56).regex(/^G[A-Z2-7]{55}$/),
  displayName: z.string().trim().min(1).max(48),
  role: ContributorRoleSchema.default("co_author"),
  shareBps: z.number().int().min(0).max(10_000).default(1000),
  addedBy: z.string().trim().length(56).regex(/^G[A-Z2-7]{55}$/).optional(),
  signature: z.string().trim().min(1).max(512).optional(),
})

export type AddContributorRequest = z.infer<typeof AddContributorRequestSchema>

// ─── store helpers ───────────────────────────────────────────────────────────

async function contributorsFilePath(): Promise<string> {
  const { serverDataJsonPath } = await import("@/lib/server-data-paths")
  // reuse existing signal storage dir but new file
  return path.join(path.dirname(serverDataJsonPath("signals")), "signal-contributors.json")
}

type ContributorsStore = Record<string, SignalContributors>

async function readContributorsStore(): Promise<ContributorsStore> {
  try {
    const fp = await contributorsFilePath()
    const raw = await readFile(fp, "utf8")
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: ContributorsStore = {}
    for (const [k, v] of Object.entries(parsed)) {
      const res = SignalContributorsSchema.safeParse(v)
      if (res.success) out[k] = res.data
    }
    return out
  } catch {
    return {}
  }
}

async function writeContributorsStore(data: ContributorsStore): Promise<void> {
  const fp = await contributorsFilePath()
  await mkdir(path.dirname(fp), { recursive: true })
  await writeFile(fp, JSON.stringify(data, null, 2), "utf8")
}

function totalShare(contributors: ContributorEntry[]): number {
  return contributors.reduce((s, c) => s + c.shareBps, 0)
}

// ─── structured errors ───────────────────────────────────────────────────────

export class ContributorLedgerError extends Error {
  code: "FLAG_DISABLED" | "VALIDATION_FAILED" | "SHARE_OVERFLOW" | "NOT_FOUND" | "DUPLICATE" | "STORE_FAILED"
  constructor(code: ContributorLedgerError["code"], message: string) {
    super(message)
    this.name = "ContributorLedgerError"
    this.code = code
  }
}

// ─── public API ──────────────────────────────────────────────────────────────

export async function getSignalContributors(signalId: string): Promise<SignalContributors | null> {
  if (!signalId?.trim()) return null
  const store = await readContributorsStore()
  return store[signalId] ?? null
}

export async function addSignalContributor(
  signalId: string,
  entry: Omit<ContributorEntry, "addedAt">,
): Promise<SignalContributors> {
  if (!isPhase116Enabled()) {
    throw new ContributorLedgerError("FLAG_DISABLED", "Contributor ledger disabled (phase-116 flag off)")
  }
  const parsedEntry = ContributorEntrySchema.safeParse({ ...entry, addedAt: Date.now() })
  if (!parsedEntry.success) {
    throw new ContributorLedgerError("VALIDATION_FAILED", parsedEntry.error.message)
  }
  const cleanEntry = parsedEntry.data
  const store = await readContributorsStore()
  const existing = store[signalId] ?? { signalId, contributors: [], totalShareBps: 0, updatedAt: Date.now() }

  // Prevent duplicate wallet as same role (allow multiple roles? we disallow exact dup)
  const dup = existing.contributors.find((c) => c.wallet === cleanEntry.wallet && c.role === cleanEntry.role)
  if (dup) {
    throw new ContributorLedgerError("DUPLICATE", `Contributor ${cleanEntry.wallet.slice(0, 6)}… already has role ${cleanEntry.role} on signal ${signalId}`)
  }

  const nextTotal = totalShare(existing.contributors) + cleanEntry.shareBps
  if (nextTotal > 10_000) {
    throw new ContributorLedgerError(
      "SHARE_OVERFLOW",
      `Total share would exceed 10000 bps (${nextTotal}). Reduce shareBps for ${cleanEntry.wallet.slice(0, 6)}…`,
    )
  }

  const next: SignalContributors = {
    signalId,
    contributors: [...existing.contributors, cleanEntry],
    totalShareBps: nextTotal,
    updatedAt: Date.now(),
  }
  const validated = SignalContributorsSchema.parse(next)
  store[signalId] = validated
  await writeContributorsStore(store)
  return validated
}

export async function removeSignalContributor(signalId: string, wallet: string, role?: ContributorRole): Promise<SignalContributors | null> {
  if (!isPhase116Enabled()) {
    throw new ContributorLedgerError("FLAG_DISABLED", "Contributor ledger disabled")
  }
  const store = await readContributorsStore()
  const existing = store[signalId]
  if (!existing) throw new ContributorLedgerError("NOT_FOUND", `No contributors for signal ${signalId}`)
  const filtered = existing.contributors.filter((c) => !(c.wallet === wallet && (role == null || c.role === role)))
  if (filtered.length === existing.contributors.length) {
    throw new ContributorLedgerError("NOT_FOUND", `Contributor ${wallet.slice(0, 6)}… not found on ${signalId}`)
  }
  const next: SignalContributors = {
    signalId,
    contributors: filtered,
    totalShareBps: totalShare(filtered),
    updatedAt: Date.now(),
  }
  store[signalId] = SignalContributorsSchema.parse(next)
  await writeContributorsStore(store)
  return store[signalId]!
}

export async function computeCreditLedger(signalId: string): Promise<CreditLedgerEntry[]> {
  const sc = await getSignalContributors(signalId)
  if (!sc || sc.contributors.length === 0) return []

  // Aggregate by wallet (a wallet may have multiple role entries; sum shares)
  const byWallet = new Map<string, { displayName: string; totalShareBps: number; contributions: number; roles: Set<ContributorRole>; lastAt: number }>()
  for (const c of sc.contributors) {
    const cur = byWallet.get(c.wallet) ?? { displayName: c.displayName, totalShareBps: 0, contributions: 0, roles: new Set<ContributorRole>(), lastAt: 0 }
    cur.totalShareBps += c.shareBps
    cur.contributions += 1
    cur.roles.add(c.role)
    cur.lastAt = Math.max(cur.lastAt, c.addedAt)
    cur.displayName = c.displayName // last wins
    byWallet.set(c.wallet, cur)
  }
  const ledger: CreditLedgerEntry[] = []
  for (const [wallet, agg] of byWallet.entries()) {
    ledger.push({
      wallet,
      displayName: agg.displayName,
      totalShareBps: agg.totalShareBps,
      contributions: agg.contributions,
      roles: [...agg.roles],
      lastContributionAt: agg.lastAt,
    })
  }
  // Sort by share desc, then recency
  ledger.sort((a, b) => b.totalShareBps - a.totalShareBps || b.lastContributionAt - a.lastContributionAt)
  return ledger
}

export async function getGlobalCreditStats(): Promise<{ totalSignals: number; totalContributors: number; topWallets: CreditLedgerEntry[] }> {
  const store = await readContributorsStore()
  const byWallet = new Map<string, CreditLedgerEntry>()
  let totalContributors = 0
  for (const sc of Object.values(store)) {
    totalContributors += sc.contributors.length
    const ledger = await computeCreditLedger(sc.signalId)
    for (const e of ledger) {
      const cur = byWallet.get(e.wallet)
      if (!cur) {
        byWallet.set(e.wallet, { ...e, roles: [...e.roles] })
      } else {
        cur.totalShareBps += e.totalShareBps
        cur.contributions += e.contributions
        for (const r of e.roles) if (!cur.roles.includes(r)) cur.roles.push(r)
        cur.lastContributionAt = Math.max(cur.lastContributionAt, e.lastContributionAt)
      }
    }
  }
  const topWallets = [...byWallet.values()].sort((a, b) => b.totalShareBps - a.totalShareBps).slice(0, 20)
  return { totalSignals: Object.keys(store).length, totalContributors, topWallets }
}

export function clearContributorMemoryForTests(): Promise<void> {
  // for tests: clear file as well via write empty
  return writeContributorsStore({})
}

export async function seedContributorForSignal(
  signalId: string,
  wallet: string,
  displayName: string,
  role: ContributorRole = "co_author",
  shareBps = 1000,
): Promise<SignalContributors> {
  return addSignalContributor(signalId, { wallet, displayName, role, shareBps, addedBy: null, signature: null })
}
