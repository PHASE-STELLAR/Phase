import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { nanoid } from "nanoid"
import { z } from "zod"
import { serverDataJsonPath } from "@/lib/server-data-paths"

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
}

type ModerationAuditStore = Record<string, ModerationAuditEvent>

async function readAuditStore(): Promise<ModerationAuditStore> {
  try {
    return JSON.parse(await readFile(serverDataJsonPath("signalModerationAudit"), "utf8")) as ModerationAuditStore
  } catch {
    return {}
  }
}

export async function appendModerationAuditEvent(
  event: Omit<ModerationAuditEvent, "id" | "created_at">,
): Promise<ModerationAuditEvent> {
  const filePath = serverDataJsonPath("signalModerationAudit")
  const store = await readAuditStore()
  const record: ModerationAuditEvent = { ...event, id: nanoid(12), created_at: Date.now() }
  store[record.id] = record
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(store, null, 2), "utf8")
  return record
}

export async function getModerationAuditEvents(signalId: string): Promise<ModerationAuditEvent[]> {
  const store = await readAuditStore()
  return Object.values(store)
    .filter((event) => event.signal_id === signalId)
    .sort((a, b) => a.created_at - b.created_at)
}
