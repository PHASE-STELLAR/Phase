/**
 * phase-216 — append-only audit trail for gating and license decisions.
 *
 * Every allow/deny produced by the age gate and every license revocation is
 * recorded here. Records are never updated or deleted; the sidecar is bounded
 * by dropping only the oldest entries when it grows past the cap.
 *
 * Rollback: unset phase-216; nothing new is written and existing rows are inert.
 */

import { randomUUID } from "node:crypto"
import { readStore, updateStoreWithReader } from "@/lib/json-store"

export type GatingAction =
  | "age_gate.viewer"
  | "age_gate.claim"
  | "license.revocation"
  | "license.cascade"
  | "license.surface"

export interface GatingDecision {
  id: string
  action: GatingAction
  subject: string
  wallet: string | null
  decision: "allowed" | "denied"
  reason: string
  at: number
}

type AuditStore = { decisions: GatingDecision[] }
const MAX_DECISIONS = 5_000

function emptyStore(): AuditStore {
  return { decisions: [] }
}

export async function appendGatingDecision(
  input: Omit<GatingDecision, "id" | "at">,
): Promise<void> {
  await updateStoreWithReader<AuditStore, void>(
    "licenseAudit",
    (raw) => {
      const store = (raw ?? {}) as Partial<AuditStore>
      return { decisions: Array.isArray(store.decisions) ? store.decisions : [] }
    },
    (store) => {
      store.decisions.push({ ...input, id: randomUUID(), at: Date.now() })
      if (store.decisions.length > MAX_DECISIONS) {
        store.decisions.splice(0, store.decisions.length - MAX_DECISIONS)
      }
    },
  )
}

export async function listGatingDecisions(action?: GatingAction): Promise<GatingDecision[]> {
  try {
    const store = await readStore<AuditStore>("licenseAudit", emptyStore)
    const decisions = action
      ? store.decisions.filter((d) => d.action === action)
      : store.decisions
    return [...decisions].reverse()
  } catch {
    return []
  }
}
