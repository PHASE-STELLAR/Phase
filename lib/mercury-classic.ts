/**
 * Mercury Classic REST client — Stellar/Soroban event indexer
 * https://mercurydata.app · https://docs.mercurydata.app/mercury-classic/introduction
 */
import { xdr, scValToNative, Address } from "@stellar/stellar-sdk"

export function mercuryRestBase(): string {
  return process.env.MERCURY_REST_URL?.trim() ?? "https://api.mercurydata.app/rest"
}

export function mercuryConfigured(): boolean {
  return !!process.env.MERCURY_JWT?.trim()
}

export type MercuryRawEvent = {
  id: number
  contract_id: string
  topic1: string
  topic2: string
  topic3: string
  topic4: string
  data: string
  tx: string
  ledger?: number
}

export type MintEvent = {
  type: "mint"
  tokenId: number
  recipient: string
  ledger: number | null
  txHash: string
  mercuryId: number
}

export type TransferEvent = {
  type: "transfer"
  tokenId: number
  from: string
  to: string
  ledger: number | null
  txHash: string
  mercuryId: number
}

export type NftEvent = MintEvent | TransferEvent

function decodeSymbol(b64: string): string | null {
  if (!b64) return null
  try {
    return scValToNative(xdr.ScVal.fromXDR(b64, "base64")) as string
  } catch {
    return null
  }
}

function decodeAddress(b64: string): string | null {
  if (!b64) return null
  try {
    return Address.fromScVal(xdr.ScVal.fromXDR(b64, "base64")).toString()
  } catch {
    return null
  }
}

function decodeU64(b64: string): number | null {
  if (!b64) return null
  try {
    return Number(scValToNative(xdr.ScVal.fromXDR(b64, "base64")))
  } catch {
    return null
  }
}

export async function fetchMercuryEvents(
  contractId: string,
  params: { limit?: number; offset?: number; from?: number; to?: number } = {},
): Promise<MercuryRawEvent[]> {
  const jwt = process.env.MERCURY_JWT?.trim()
  if (!jwt) throw new Error("MERCURY_JWT not configured")

  const url = new URL(`${mercuryRestBase()}/events/by-contract/${contractId}`)
  if (params.limit) url.searchParams.set("limit", String(params.limit))
  if (params.offset) url.searchParams.set("offset", String(params.offset))
  if (params.from) url.searchParams.set("from", String(params.from))
  if (params.to) url.searchParams.set("to", String(params.to))

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { Authorization: `Bearer ${jwt}` },
    cache: "no-store",
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Mercury HTTP ${res.status}: ${text.slice(0, 300)}`)
  }

  const json = await res.json()
  return Array.isArray(json) ? json : (json.events ?? json.data ?? [])
}

export function parseMintTransferEvents(events: MercuryRawEvent[]): NftEvent[] {
  const result: NftEvent[] = []
  for (const ev of events) {
    const eventType = decodeSymbol(ev.topic1)
    if (!eventType) continue
    const tokenId = decodeU64(ev.data)
    if (tokenId === null) continue
    const ledger = ev.ledger ?? null
    const txHash = ev.tx ?? ""

    if (eventType === "mint") {
      const recipient = decodeAddress(ev.topic2)
      if (!recipient) continue
      result.push({ type: "mint", tokenId, recipient, ledger, txHash, mercuryId: ev.id })
    } else if (eventType === "transfer") {
      const from = decodeAddress(ev.topic2)
      const to = decodeAddress(ev.topic3)
      if (!from || !to) continue
      result.push({ type: "transfer", tokenId, from, to, ledger, txHash, mercuryId: ev.id })
    }
  }
  return result
}

/**
 * Deriva el mapa de propiedad actual: tokenId → ownerAddress
 * procesando mints y transfers en orden cronológico (por mercuryId).
 */
export function deriveOwnershipMap(events: NftEvent[]): Map<number, string> {
  const ownership = new Map<number, string>()
  const sorted = [...events].sort((a, b) => a.mercuryId - b.mercuryId)

  for (const ev of sorted) {
    if (ev.type === "mint") {
      ownership.set(ev.tokenId, ev.recipient)
    } else if (ev.type === "transfer") {
      ownership.set(ev.tokenId, ev.to)
    }
  }
  return ownership
}

/**
 * Devuelve los token IDs que actualmente pertenecen a `ownerAddress`.
 */
export async function fetchTokenIdsOwnedByMercury(
  contractId: string,
  ownerAddress: string,
): Promise<number[]> {
  const rawEvents = await fetchMercuryEvents(contractId, { limit: 1000 })
  const events = parseMintTransferEvents(rawEvents)
  const ownership = deriveOwnershipMap(events)

  const upper = ownerAddress.toUpperCase()
  const ids: number[] = []
  for (const [tokenId, owner] of ownership) {
    if (owner.toUpperCase() === upper) ids.push(tokenId)
  }
  return ids.sort((a, b) => a - b)
}

import { isFeatureEnabled } from "@/lib/feature-flags"
import { incSecurityCounter } from "@/lib/security-counters"

export function isPhase236Enabled(): boolean {
  return isFeatureEnabled("phase-236")
}

export type ReadAdapterConfig = {
  mercuryTimeoutMs?: number
  failureThreshold?: number
  cooldownMs?: number
  sampleDisagreementRate?: number
}

export class MercuryCircuitBreaker {
  state: "closed" | "open" | "half-open" = "closed"
  failures = 0
  lastFailureTime = 0
  readonly threshold: number
  readonly cooldownMs: number

  constructor(threshold = 3, cooldownMs = 30000) {
    this.threshold = threshold
    this.cooldownMs = cooldownMs
  }

  recordSuccess(): void {
    this.failures = 0
    this.state = "closed"
  }

  recordFailure(): void {
    this.failures += 1
    this.lastFailureTime = Date.now()
    if (this.failures >= this.threshold) {
      this.state = "open"
      incSecurityCounter("mercury_circuit_breaker_tripped")
    }
  }

  canAttemptMercury(): boolean {
    if (this.state === "closed") return true
    if (this.state === "open") {
      if (Date.now() - this.lastFailureTime > this.cooldownMs) {
        this.state = "half-open"
        return true
      }
      return false
    }
    return true // half-open
  }

  reset(): void {
    this.state = "closed"
    this.failures = 0
    this.lastFailureTime = 0
  }
}

export const globalMercuryBreaker = new MercuryCircuitBreaker()

export async function fetchTokenIdsWithResilience(
  contractId: string,
  address: string,
  rpcFallbackFn: () => Promise<number[]>,
  config: ReadAdapterConfig = {},
): Promise<{ tokenIds: number[]; source: "mercury" | "soroban-rpc" | "soroban-rpc-fallback"; durationMs: number }> {
  const start = Date.now()

  // Flag phase-236 off = RPC only
  if (!isPhase236Enabled()) {
    const ids = await rpcFallbackFn()
    return { tokenIds: ids, source: "soroban-rpc", durationMs: Date.now() - start }
  }

  const timeoutMs = config.mercuryTimeoutMs ?? 2000
  const breaker = globalMercuryBreaker

  if (mercuryConfigured() && breaker.canAttemptMercury()) {
    try {
      const mercuryPromise = fetchTokenIdsOwnedByMercury(contractId, address)
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Mercury timeout")), timeoutMs),
      )
      const tokenIds = await Promise.race([mercuryPromise, timeoutPromise])
      breaker.recordSuccess()
      incSecurityCounter("mercury_read_success")

      // Sampled disagreement check
      if (config.sampleDisagreementRate && Math.random() < config.sampleDisagreementRate) {
        rpcFallbackFn()
          .then((rpcIds) => {
            const mSet = new Set(tokenIds)
            const rSet = new Set(rpcIds)
            const disagree = mSet.size !== rSet.size || tokenIds.some((id) => !rSet.has(id))
            if (disagree) {
              incSecurityCounter("mercury_rpc_disagreement")
              console.warn(`[phase-236] Mercury/RPC disagreement: mercury=${mSet.size} rpc=${rSet.size}`)
            }
          })
          .catch(() => {})
      }

      return { tokenIds, source: "mercury", durationMs: Date.now() - start }
    } catch (error) {
      breaker.recordFailure()
      const isTimeout = error instanceof Error && error.message.includes("timeout")
      if (isTimeout) incSecurityCounter("mercury_read_timeout")
      incSecurityCounter("mercury_read_fallback_rpc")
    }
  }

  // Fallback to RPC
  const ids = await rpcFallbackFn()
  return { tokenIds: ids, source: "soroban-rpc-fallback", durationMs: Date.now() - start }
}
