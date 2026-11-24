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
export const ALLOWED_NATIVE_PHASE_HOSTS = ["collection", "offer", "quest"] as const
export const ALLOWED_STELLAR_HOSTS = ["phase"] as const
const identifier = /^[a-zA-Z0-9_-]{1,128}$/

export function isAllowedCustomSchemeHost(url: URL): boolean {
  if (url.port) return false
  if (url.protocol === "phase:") {
    return (ALLOWED_NATIVE_PHASE_HOSTS as readonly string[]).includes(url.hostname)
  }
  if (url.protocol === "stellar:") {
    return (ALLOWED_STELLAR_HOSTS as readonly string[]).includes(url.hostname)
  }
  return false
}

export function parsePhaseLink(raw: string, origin: string, now = Date.now()): PhaseIntent {
  if (raw.length > 2048) throw new Error("INVALID_LINK")
  const url = new URL(raw, origin)
  let parts: string[]
  if (url.protocol === "phase:") {
    if (!isAllowedCustomSchemeHost(url)) throw new Error("INVALID_LINK")
    parts = [url.hostname, ...url.pathname.split("/").filter(Boolean)]
  } else if (url.protocol === "stellar:") {
    if (!isAllowedCustomSchemeHost(url)) throw new Error("INVALID_LINK")
    parts = url.pathname.split("/").filter(Boolean)
  } else if ((url.protocol === "https:" || url.protocol === "http:") && url.origin === new URL(origin).origin) {
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

export function hasIntentExpired(intent: Pick<PhaseIntent, "capturedAt">, now = Date.now()): boolean {
  return !Number.isSafeInteger(intent.capturedAt) || intent.capturedAt > now || now - intent.capturedAt >= INTENT_TTL_MS
}

/**
 * Suggested recipients in inbound links are untrusted display context only
 * and never carry signing or transfer authorization authority.
 */
export function canRecipientAuthorizeTransfer(_intent: PhaseIntent): false {
  return false
}

export function buildChamberCollectionHref(intent: PhaseIntent): string {
  const query = new URLSearchParams()
  query.set("collection", intent.id)
  if (intent.ref) query.set("ref", intent.ref)
  if (intent.recipient) query.set("recipient", intent.recipient)
  return `/chamber?${query.toString()}`
}

export function restoreIntent(raw: string | null, origin: string, now = Date.now()): PhaseIntent | null {
  try {
    const value = JSON.parse(raw ?? "null") as PhaseIntent | null
    if (!value || value.version !== 1 || hasIntentExpired(value, now)) return null
    return parsePhaseLink(intentPath(value), origin, value.capturedAt)
  } catch { return null }
}
