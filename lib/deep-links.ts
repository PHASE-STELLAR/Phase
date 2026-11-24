import { StrKey } from "@stellar/stellar-sdk"

export type PhaseIntent = {
  version: 1
  kind: "collection" | "offer" | "quest"
  id: string
  offerId?: string
  ref?: string
  recipient?: string
  capturedAt: number
}
export const INTENT_KEY = "phase:inbound-intent:v1"
export const INTENT_TTL_MS = 15 * 60 * 1000
const identifier = /^[a-zA-Z0-9_-]{1,128}$/

export function parsePhaseLink(raw: string, origin: string, now = Date.now()): PhaseIntent {
  if (raw.length > 2048) throw new Error("INVALID_LINK")
  const url = new URL(raw, origin)
  let parts: string[]
  if (url.protocol === "phase:") parts = [url.hostname, ...url.pathname.split("/").filter(Boolean)]
  else if (url.protocol === "stellar:" && url.hostname === "phase") parts = url.pathname.split("/").filter(Boolean)
  else if ((url.protocol === "https:" || url.protocol === "http:") && url.origin === new URL(origin).origin) {
    parts = url.pathname.split("/").filter(Boolean)
    if (parts.shift() !== "link") throw new Error("INVALID_LINK")
  } else throw new Error("INVALID_LINK")
  if (url.username || url.password || url.hash) throw new Error("INVALID_LINK")
  const [kind, id, offerId] = parts
  if (!id || !identifier.test(id) || !["collection", "offer", "quest"].includes(kind)) throw new Error("INVALID_LINK")
  if (parts.length !== (kind === "offer" ? 3 : 2)) throw new Error("INVALID_LINK")
  if (kind === "collection" && (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))) throw new Error("INVALID_LINK")
  if (kind === "offer" && (!offerId || !identifier.test(offerId))) throw new Error("INVALID_LINK")
  for (const [key] of url.searchParams) {
    if (!["ref", "recipient"].includes(key) || url.searchParams.getAll(key).length !== 1) throw new Error("INVALID_LINK")
  }
  const ref = url.searchParams.get("ref") ?? undefined
  const recipient = url.searchParams.get("recipient") ?? undefined
  if (ref && !/^[A-Z2-9]{8}$/.test(ref)) throw new Error("INVALID_LINK")
  if (recipient && !StrKey.isValidEd25519PublicKey(recipient)) throw new Error("INVALID_LINK")
  return { version: 1, kind: kind as PhaseIntent["kind"], id, offerId, ref, recipient, capturedAt: now }
}

export function intentPath(intent: PhaseIntent): string {
  const query = new URLSearchParams()
  if (intent.ref) query.set("ref", intent.ref)
  if (intent.recipient) query.set("recipient", intent.recipient)
  return `/link/${intent.kind}/${encodeURIComponent(intent.id)}${intent.offerId ? `/${encodeURIComponent(intent.offerId)}` : ""}${query.size ? `?${query}` : ""}`
}

export function restoreIntent(raw: string | null, origin: string, now = Date.now()): PhaseIntent | null {
  try {
    const value = JSON.parse(raw ?? "null") as PhaseIntent | null
    if (!value || value.version !== 1 || !Number.isSafeInteger(value.capturedAt) || value.capturedAt > now || now - value.capturedAt >= INTENT_TTL_MS) return null
    return parsePhaseLink(intentPath(value), origin, value.capturedAt)
  } catch { return null }
}
