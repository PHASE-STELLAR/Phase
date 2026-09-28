/**
 * Module #56 (Issue #78) — Faucet / participation deny-list with on-chain
 * governance veto.
 *
 * AUDIT NOTE (execution flow, app/api/signals/[id]/replies/route.ts):
 * Abusive wallets could not be cleanly excluded. The replies route validated
 * wallet format and signature presence but had no notion of a wallet being
 * barred from participation, and there was no governed way to add or remove
 * such a bar — an operator edit to a JSON file with no checks and no appeal.
 *
 * This module is the isolated domain for that:
 *   - AddDenyRequestSchema / GovernanceVetoSchema — type-safe inputs
 *   - proposeDenyListEntry() — records a wallet as denied (deny-first posture:
 *     the entry is active immediately)
 *   - castGovernanceVeto()   — a governance signer vetoes an entry; once a
 *     quorum of distinct governance signers have vetoed, the entry flips to
 *     "vetoed" and the wallet is no longer denied
 *   - isWalletDenied()       — the predicate the routes call
 *   - liftDenyListEntry() / listDenyList() / getDenyListEntry()
 *
 * Governance signers come from PHASE_GOVERNANCE_SIGNERS (comma-separated G
 * addresses). A veto from an address outside that set is rejected.
 *
 * Flag: phase-156 (NEXT_PUBLIC_FEATURE_PHASE_156 / FEATURE_PHASE_156).
 * When the flag is off, isWalletDenied() always returns false and the routes
 * keep their legacy behaviour (zero regression).
 *
 * Rollback: unset the flag. The faucet-deny-list.json sidecar can be deleted.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { serverDataJsonPath } from "@/lib/server-data-paths"

export function isFaucetDenyListEnabled(): boolean {
  const v = (
    process.env.NEXT_PUBLIC_FEATURE_PHASE_156 ??
    process.env.FEATURE_PHASE_156 ??
    ""
  )
    .trim()
    .toLowerCase()
  return v === "1" || v === "true" || v === "yes" || v === "on"
}

export function flag156RollbackNote(): string {
  return "Rollback phase-156: unset NEXT_PUBLIC_FEATURE_PHASE_156 / FEATURE_PHASE_156 or set 0/false and restart. The faucet-deny-list.json sidecar can be deleted."
}

const G_ADDRESS_RE = /^G[A-Z2-7]{55}$/
export const DEFAULT_VETO_QUORUM = 3

export const AddDenyRequestSchema = z.object({
  wallet: z.string().trim().length(56).regex(G_ADDRESS_RE, "wallet must be a Stellar public (G...) address"),
  reason: z.string().trim().min(3).max(500),
  proposedBy: z.string().trim().min(1).max(64),
  vetoQuorum: z.number().int().min(1).max(21).optional(),
  evidenceUrl: z.string().trim().url().max(1024).optional(),
})

export type AddDenyRequest = z.infer<typeof AddDenyRequestSchema>

export const GovernanceVetoSchema = z.object({
  signer: z.string().trim().length(56).regex(G_ADDRESS_RE, "signer must be a Stellar public (G...) address"),
  signature: z.string().trim().min(1).max(512).optional(),
  note: z.string().trim().max(500).optional(),
})

export type GovernanceVeto = z.infer<typeof GovernanceVetoSchema>

export type DenyListStatus = "active" | "vetoed" | "lifted"

export type DenyListEntry = {
  id: string
  wallet: string
  reason: string
  proposed_by: string
  proposed_at: number
  status: DenyListStatus
  veto_quorum: number
  vetoes: Array<{ signer: string; signature?: string; note?: string; cast_at: number }>
  evidence_url?: string
  lifted_at?: number
  lifted_by?: string
}

export class FaucetDenyListError extends Error {
  readonly code:
    | "FLAG_DISABLED"
    | "NOT_FOUND"
    | "ALREADY_EXISTS"
    | "NOT_GOVERNANCE_SIGNER"
    | "DUPLICATE_VETO"
    | "VALIDATION_FAILED"
    | "STORE_WRITE_FAILED"
  readonly details?: unknown
  constructor(code: FaucetDenyListError["code"], message: string, details?: unknown) {
    super(message)
    this.name = "FaucetDenyListError"
    this.code = code
    this.details = details
  }
}

/** Governance signer allowlist from env. Pure — exported for tests. */
export function governanceSigners(): string[] {
  return (process.env.PHASE_GOVERNANCE_SIGNERS ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => G_ADDRESS_RE.test(s))
}

export function isGovernanceSigner(address: string): boolean {
  return governanceSigners().includes(address.trim())
}

/** Pure — given an entry's vetoes and quorum, what status should it hold? */
export function deriveDenyStatus(
  entry: Pick<DenyListEntry, "status" | "vetoes" | "veto_quorum">,
): DenyListStatus {
  if (entry.status === "lifted") return "lifted"
  const distinctVetoers = new Set(entry.vetoes.map((v) => v.signer)).size
  return distinctVetoers >= entry.veto_quorum ? "vetoed" : "active"
}

// ─── Store ──────────────────────────────────────────────────────────────────

type DenyListStore = Record<string, DenyListEntry>

async function readStore(): Promise<DenyListStore> {
  try {
    const raw = await readFile(serverDataJsonPath("faucetDenyList"), "utf8")
    const parsed = JSON.parse(raw) as DenyListStore
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

async function writeStore(data: DenyListStore): Promise<void> {
  const filePath = serverDataJsonPath("faucetDenyList")
  try {
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, JSON.stringify(data, null, 2), "utf8")
  } catch (e) {
    throw new FaucetDenyListError("STORE_WRITE_FAILED", e instanceof Error ? e.message : String(e))
  }
}

export async function proposeDenyListEntry(rawInput: unknown): Promise<DenyListEntry> {
  if (!isFaucetDenyListEnabled()) {
    throw new FaucetDenyListError("FLAG_DISABLED", "Faucet deny-list disabled (phase-156 flag off)")
  }
  const parsed = AddDenyRequestSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new FaucetDenyListError(
      "VALIDATION_FAILED",
      "Deny-list request failed schema validation",
      parsed.error.flatten(),
    )
  }
  const req = parsed.data
  const store = await readStore()
  const existing = Object.values(store).find(
    (e) => e.wallet === req.wallet && deriveDenyStatus(e) === "active",
  )
  if (existing) {
    throw new FaucetDenyListError(
      "ALREADY_EXISTS",
      `Wallet ${req.wallet.slice(0, 6)}… already has an active deny-list entry (${existing.id})`,
    )
  }
  const id = randomUUID()
  const entry: DenyListEntry = {
    id,
    wallet: req.wallet,
    reason: req.reason,
    proposed_by: req.proposedBy,
    proposed_at: Date.now(),
    status: "active",
    veto_quorum: req.vetoQuorum ?? DEFAULT_VETO_QUORUM,
    vetoes: [],
    ...(req.evidenceUrl ? { evidence_url: req.evidenceUrl } : {}),
  }
  store[id] = entry
  await writeStore(store)
  return entry
}

export async function castGovernanceVeto(entryId: string, rawVeto: unknown): Promise<DenyListEntry> {
  if (!isFaucetDenyListEnabled()) {
    throw new FaucetDenyListError("FLAG_DISABLED", "Faucet deny-list disabled (phase-156 flag off)")
  }
  const parsed = GovernanceVetoSchema.safeParse(rawVeto)
  if (!parsed.success) {
    throw new FaucetDenyListError(
      "VALIDATION_FAILED",
      "Governance veto failed schema validation",
      parsed.error.flatten(),
    )
  }
  const veto = parsed.data
  if (!isGovernanceSigner(veto.signer)) {
    throw new FaucetDenyListError(
      "NOT_GOVERNANCE_SIGNER",
      `${veto.signer.slice(0, 6)}… is not in PHASE_GOVERNANCE_SIGNERS`,
    )
  }
  const store = await readStore()
  const entry = store[entryId]
  if (!entry) throw new FaucetDenyListError("NOT_FOUND", `Deny-list entry ${entryId} not found`)
  if (entry.vetoes.some((v) => v.signer === veto.signer)) {
    throw new FaucetDenyListError("DUPLICATE_VETO", `${veto.signer.slice(0, 6)}… has already vetoed this entry`)
  }
  entry.vetoes.push({
    signer: veto.signer,
    ...(veto.signature ? { signature: veto.signature } : {}),
    ...(veto.note ? { note: veto.note } : {}),
    cast_at: Date.now(),
  })
  entry.status = deriveDenyStatus(entry)
  await writeStore(store)
  return entry
}

export async function liftDenyListEntry(entryId: string, liftedBy: string): Promise<DenyListEntry> {
  const store = await readStore()
  const entry = store[entryId]
  if (!entry) throw new FaucetDenyListError("NOT_FOUND", `Deny-list entry ${entryId} not found`)
  entry.status = "lifted"
  entry.lifted_at = Date.now()
  entry.lifted_by = liftedBy.slice(0, 64)
  await writeStore(store)
  return entry
}

export async function isWalletDenied(wallet: string): Promise<boolean> {
  if (!isFaucetDenyListEnabled()) return false
  if (!G_ADDRESS_RE.test(wallet.trim())) return false
  const store = await readStore()
  return Object.values(store).some(
    (e) => e.wallet === wallet.trim() && deriveDenyStatus(e) === "active",
  )
}

export async function getWalletDenyEntry(wallet: string): Promise<DenyListEntry | null> {
  const store = await readStore()
  return (
    Object.values(store).find(
      (e) => e.wallet === wallet.trim() && deriveDenyStatus(e) === "active",
    ) ?? null
  )
}

export async function listDenyList(
  opts: { status?: DenyListStatus; limit?: number } = {},
): Promise<DenyListEntry[]> {
  const store = await readStore()
  let items = Object.values(store).map((e) => ({ ...e, status: deriveDenyStatus(e) }))
  if (opts.status) items = items.filter((e) => e.status === opts.status)
  items.sort((a, b) => b.proposed_at - a.proposed_at)
  return typeof opts.limit === "number" ? items.slice(0, Math.max(0, opts.limit)) : items
}

export async function getDenyListEntry(entryId: string): Promise<DenyListEntry | null> {
  const store = await readStore()
  const entry = store[entryId]
  return entry ? { ...entry, status: deriveDenyStatus(entry) } : null
}

/** Test helper — empties the sidecar. */
export async function clearDenyListForTests(): Promise<void> {
  await writeStore({})
}
