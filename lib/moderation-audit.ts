import { nanoid } from "nanoid"
import { z } from "zod"
import { readStore, updateStore } from "@/lib/json-store"

export const MODERATION_ACTIONS = ["takedown", "restore"] as const
export type ModerationAction = (typeof MODERATION_ACTIONS)[number]

export const ModeratorIdentitySchema = z.object({
  moderator_wallet: z.string().trim().regex(/^G[A-Z2-7]{55}$/, "Invalid moderator wallet"),
  moderator_signature: z.string().trim().min(1, "Moderator signature required").max(512),
})

export type ModerationAuditEvent = {
  id: string
  signal_id: string
  action: ModerationAction
  moderator_wallet: string
  moderator_signature: string
  reason: string | null
  created_at: number
  /**
   * phase-146: the AI decision this human action answered, so the audit trail
   * shows what the model decided (and on what evidence) next to what a person
   * did about it. Absent for actions with no AI pre-screen behind them.
   */
  ai?: {
    queue_id: string
    decision: string | null
    confidence: number | null
    model_id: string | null
    prompt_hash: string | null
    scores: Record<string, number> | null
    agreed: boolean | null
  }
}

type ModerationAuditStore = Record<string, ModerationAuditEvent>

async function readAuditStore(): Promise<ModerationAuditStore> {
  return readStore<ModerationAuditStore>("signalModerationAudit", () => ({}))
}

/** Locked append: concurrent moderators (and the phase-146 queue) cannot drop each other's events. */
export async function appendModerationAuditEvent(
  event: Omit<ModerationAuditEvent, "id" | "created_at">,
): Promise<ModerationAuditEvent> {
  const record: ModerationAuditEvent = { ...event, id: nanoid(12), created_at: Date.now() }
  await updateStore<ModerationAuditStore>("signalModerationAudit", (store) => {
    store[record.id] = record
  })
  return record
}

export async function getModerationAuditEvents(signalId: string): Promise<ModerationAuditEvent[]> {
  const store = await readAuditStore()
  return Object.values(store)
    .filter((event) => event.signal_id === signalId)
    .sort((a, b) => a.created_at - b.created_at)
}

/**
 * Retrieve all moderation audit events across signals, with optional filtering.
 */
export async function getAllModerationAuditEvents(filter?: {
  from?: number;
  to?: number;
  action?: ModerationAction;
}): Promise<ModerationAuditEvent[]> {
  const store = await readAuditStore();
  let events = Object.values(store);

  if (filter?.from !== undefined) {
    events = events.filter((e) => e.created_at >= filter.from!);
  }
  if (filter?.to !== undefined) {
    events = events.filter((e) => e.created_at <= filter.to!);
  }
  if (filter?.action) {
    events = events.filter((e) => e.action === filter.action);
  }

  return events.sort((a, b) => a.created_at - b.created_at);
}

