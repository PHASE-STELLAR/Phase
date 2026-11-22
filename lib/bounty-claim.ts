/**
 * phase-254: Bounty claim and quest reward integration (issue #705).
 *
 * Binds each bounty claim to:
 * 1. The signed session wallet (`resolveSessionWallet` from SEP-10).
 * 2. A versioned, hash-verified quest snapshot (`lib/quest-snapshot.ts`),
 *    verifying eligibility exclusively from the server-side snapshot.
 * 3. A version-guarded, serialized claim ledger (`bountyClaimLedger`) that
 *    enforces one claim per wallet per bounty and serializes concurrent claims
 *    into one winner and ordered 409 rejections.
 *
 * Flag: NEXT_PUBLIC_FEATURE_PHASE_254 / FEATURE_PHASE_254 (default off).
 * Rollback: unset flag -> `/api/claim-bounty` returns 404, snapshot/ledger rows inert.
 */

import { StrKey } from "@stellar/stellar-sdk"
import { z } from "zod"
import { isFeatureEnabled, flagRollbackNote } from "@/lib/feature-flags"
import { readStore, updateStoreWithReader } from "@/lib/json-store"
import { getQuestById } from "@/lib/quest-registry"
import {
  loadVersionedQuestSnapshot,
  verifySnapshotIntegrity,
  type QuestId,
} from "@/lib/quest-snapshot"
import { incSecurityCounter } from "@/lib/security-counters"

export const BOUNTY_CLAIM_FLAG = "phase-254" as const

export function isBountyClaimEnabled(wallet?: string): boolean {
  return isFeatureEnabled(BOUNTY_CLAIM_FLAG, wallet ? { wallet } : undefined)
}

export function bountyClaimRollbackNote(): string {
  return flagRollbackNote(BOUNTY_CLAIM_FLAG)
}

export type BountyClaimErrorCode =
  | "FLAG_DISABLED"
  | "UNAUTHORIZED"
  | "WALLET_MISMATCH"
  | "VALIDATION_FAILED"
  | "SNAPSHOT_MISSING"
  | "STALE_SNAPSHOT"
  | "NOT_ELIGIBLE"
  | "ALREADY_CLAIMED"
  | "VERSION_CONFLICT"

export class BountyClaimError extends Error {
  readonly code: BountyClaimErrorCode
  readonly status: number
  readonly details?: unknown

  constructor(code: BountyClaimErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = "BountyClaimError"
    this.code = code
    this.details = details
    switch (code) {
      case "FLAG_DISABLED":
        this.status = 404
        break
      case "UNAUTHORIZED":
        this.status = 401
        break
      case "WALLET_MISMATCH":
      case "NOT_ELIGIBLE":
        this.status = 403
        break
      case "VALIDATION_FAILED":
        this.status = 400
        break
      case "SNAPSHOT_MISSING":
      case "STALE_SNAPSHOT":
      case "ALREADY_CLAIMED":
      case "VERSION_CONFLICT":
        this.status = 409
        break
    }
  }
}

export const BountyClaimRequestSchema = z.object({
  bountyId: z.enum([
    "quest_connect_wallet",
    "quest_first_collection",
    "quest_first_settle",
    "quest_first_world",
    "quest_three_collections",
  ]),
  snapshotVersion: z.number().int().positive(),
  snapshotHash: z.string().trim().min(16).max(128).optional(),
  expectedStoreVersion: z.number().int().nonnegative().optional(),
  walletAddress: z.string().trim().optional(),
  userAddress: z.string().trim().optional(),
})

export type BountyClaimInput = {
  sessionWallet: string | null
  bountyId: QuestId
  snapshotVersion: number
  snapshotHash?: string
  expectedStoreVersion?: number
  claimedWallet?: string
  now?: number
}

export type BountyClaimRecord = {
  claimKey: string
  wallet: string
  bountyId: QuestId
  snapshotVersion: number
  snapshotHash: string
  rewardStroops: string
  storeVersion: number
  claimedAt: number
}

type BountyClaimLedgerStore = {
  version: number
  claims: Record<string, BountyClaimRecord>
}

function emptyLedger(): BountyClaimLedgerStore {
  return { version: 1, claims: {} }
}

function normalizeLedger(raw: unknown): BountyClaimLedgerStore {
  const s = raw as Partial<BountyClaimLedgerStore> | null | undefined
  if (!s || typeof s !== "object" || !s.claims || typeof s.claims !== "object") {
    return emptyLedger()
  }
  return {
    version: typeof s.version === "number" && s.version > 0 ? s.version : 1,
    claims: s.claims,
  }
}

export function makeBountyClaimKey(wallet: string, bountyId: string): string {
  return `${wallet.trim().toUpperCase()}:${bountyId.trim()}`
}

export async function getBountyClaimRecord(
  wallet: string,
  bountyId: QuestId,
): Promise<BountyClaimRecord | null> {
  if (!isBountyClaimEnabled(wallet)) return null
  const store = normalizeLedger(
    await readStore<BountyClaimLedgerStore>("bountyClaimLedger", emptyLedger),
  )
  return store.claims[makeBountyClaimKey(wallet, bountyId)] ?? null
}

/**
 * Execute a snapshot-bound, idempotent, version-guarded bounty claim.
 * Concurrent calls for the same (wallet, bountyId) are serialized by
 * `updateStoreWithReader`: one succeeds and the rest fail with ordered 409s.
 */
export async function claimBountyWithSnapshot(
  input: BountyClaimInput,
): Promise<BountyClaimRecord> {
  if (!isBountyClaimEnabled(input.sessionWallet ?? undefined)) {
    throw new BountyClaimError("FLAG_DISABLED", "Bounty claim disabled (phase-254 flag off)")
  }

  const sessionWallet = input.sessionWallet?.trim() ?? ""
  if (!sessionWallet || !StrKey.isValidEd25519PublicKey(sessionWallet)) {
    incSecurityCounter("bounty_claim_rejected")
    throw new BountyClaimError("UNAUTHORIZED", "Valid signed session wallet is required")
  }

  if (
    input.claimedWallet &&
    input.claimedWallet.trim().toUpperCase() !== sessionWallet.toUpperCase()
  ) {
    incSecurityCounter("bounty_claim_rejected")
    throw new BountyClaimError(
      "WALLET_MISMATCH",
      "Claim wallet does not match signed session wallet",
    )
  }

  const snapshot = await loadVersionedQuestSnapshot(sessionWallet)
  if (!snapshot) {
    incSecurityCounter("bounty_claim_rejected")
    throw new BountyClaimError(
      "SNAPSHOT_MISSING",
      "No active quest snapshot found for session wallet",
    )
  }

  const integrity = verifySnapshotIntegrity(snapshot, snapshot.snapshotHash)
  if (!integrity.ok) {
    incSecurityCounter("bounty_claim_stale_snapshot")
    incSecurityCounter("bounty_claim_rejected")
    throw new BountyClaimError(
      "STALE_SNAPSHOT",
      "Quest snapshot failed integrity verification",
    )
  }

  if (input.snapshotVersion !== snapshot.version) {
    incSecurityCounter("bounty_claim_stale_snapshot")
    incSecurityCounter("bounty_claim_rejected")
    throw new BountyClaimError(
      "STALE_SNAPSHOT",
      `Stale quest snapshot version: expected ${snapshot.version}, got ${input.snapshotVersion}`,
      { expectedVersion: snapshot.version, providedVersion: input.snapshotVersion },
    )
  }

  if (input.snapshotHash && input.snapshotHash !== snapshot.snapshotHash) {
    incSecurityCounter("bounty_claim_stale_snapshot")
    incSecurityCounter("bounty_claim_rejected")
    throw new BountyClaimError(
      "STALE_SNAPSHOT",
      "Quest snapshot hash mismatch",
    )
  }

  // Verify eligibility strictly from the server-side snapshot, never client input
  const questProgress = snapshot.progress?.[input.bountyId]
  if (!questProgress || questProgress.completed !== true) {
    incSecurityCounter("bounty_claim_rejected")
    throw new BountyClaimError(
      "NOT_ELIGIBLE",
      `Quest "${input.bountyId}" is not completed in snapshot v${snapshot.version}`,
    )
  }

  const questDef = await getQuestById(input.bountyId).catch(() => null)
  if (questDef && !questDef.enabled) {
    incSecurityCounter("bounty_claim_rejected")
    throw new BountyClaimError("NOT_ELIGIBLE", `Quest "${input.bountyId}" is currently disabled`)
  }
  const rewardStroops = questDef?.rewardStroops ?? "30000000"

  const claimKey = makeBountyClaimKey(sessionWallet, input.bountyId)
  const now = input.now ?? Date.now()

  return updateStoreWithReader<BountyClaimLedgerStore, BountyClaimRecord>(
    "bountyClaimLedger",
    normalizeLedger,
    (store) => {
      if (
        typeof input.expectedStoreVersion === "number" &&
        input.expectedStoreVersion !== store.version
      ) {
        incSecurityCounter("bounty_claim_rejected")
        throw new BountyClaimError(
          "VERSION_CONFLICT",
          `Store version conflict: expected ${store.version}, got ${input.expectedStoreVersion}`,
          { currentStoreVersion: store.version },
        )
      }

      if (store.claims[claimKey]) {
        incSecurityCounter("bounty_claim_duplicate")
        incSecurityCounter("bounty_claim_rejected")
        throw new BountyClaimError(
          "ALREADY_CLAIMED",
          `Bounty "${input.bountyId}" already claimed for this wallet`,
          { existingClaimedAt: store.claims[claimKey]!.claimedAt },
        )
      }

      const nextVersion = store.version + 1
      const record: BountyClaimRecord = {
        claimKey,
        wallet: sessionWallet,
        bountyId: input.bountyId,
        snapshotVersion: snapshot.version,
        snapshotHash: snapshot.snapshotHash,
        rewardStroops,
        storeVersion: nextVersion,
        claimedAt: now,
      }
      store.claims[claimKey] = record
      store.version = nextVersion
      incSecurityCounter("bounty_claim_succeeded")
      return record
    },
  )
}
