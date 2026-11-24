/**
 * phase-220 — Stellar Expert link builder + read-only enrichment.
 *
 * Design rules (Spike 648, tightened for production):
 * - Default network is testnet. Mainnet links are fenced: they are never built
 *   unless the operator explicitly opts in with PHASE_EXPLORER_ALLOW_MAINNET=1.
 * - Only public identifiers cross the network boundary: a 64-hex tx hash, a
 *   C… contract id, a G… account id, or CODE-ISSUER. Wallets, emails and memo
 *   text are rejected by the request sanitizer — no PII in requests.
 * - Enrichment is read-only and bounded by a timeout. Any failure degrades to
 *   the raw hash; it never blocks signing or display.
 */

import { StrKey } from "@stellar/stellar-sdk"
import { HORIZON_URL } from "@/lib/phase-protocol"
import { flagRollbackNote, isFeatureEnabled } from "@/lib/feature-flags"
import { incSecurityCounter } from "@/lib/security-counters"

export type PhaseNetwork = "testnet" | "mainnet"
export type ExplorerEntity = "tx" | "contract" | "account" | "asset"

export const EXPLORER_BASE: Record<PhaseNetwork, string> = {
  testnet: "https://stellar.expert/explorer/testnet",
  mainnet: "https://stellar.expert/explorer/public",
}

export const ENRICHMENT_TIMEOUT_MS = 3_000

export function isExplorerEnabled(): boolean {
  return isFeatureEnabled("phase-220")
}

export function explorerRollbackNote(): string {
  return flagRollbackNote("phase-220")
}

export function isMainnetLinksAllowed(
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
): boolean {
  const raw = env.PHASE_EXPLORER_ALLOW_MAINNET?.trim().toLowerCase() ?? ""
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on"
}

export function isValidTxHash(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value.trim())
}

export function isValidAssetId(value: string): boolean {
  const match = /^([A-Z0-9]{1,12})-(G[A-Z2-7]{55})$/.exec(value.trim())
  return Boolean(match && StrKey.isValidEd25519PublicKey(match[2]!))
}

export function isValidExplorerId(entity: ExplorerEntity, value: string): boolean {
  switch (entity) {
    case "tx":
      return isValidTxHash(value)
    case "contract":
      return StrKey.isValidContract(value.trim())
    case "account":
      return StrKey.isValidEd25519PublicKey(value.trim())
    case "asset":
      return isValidAssetId(value)
  }
}

export type ExplorerLinkResult =
  | { ok: true; url: string; network: PhaseNetwork; entity: ExplorerEntity }
  | { ok: false; reason: "mainnet-fenced" | "invalid-id" | "invalid-network" | "invalid-entity" }

/**
 * Builds a link to a known Stellar Expert path. The returned URL is always
 * re-checkable with `isSafeExplorerUrl` before it reaches an anchor element.
 */
export function buildExplorerUrl(opts: {
  entity: ExplorerEntity
  id: string
  network?: PhaseNetwork
  allowMainnet?: boolean
}): ExplorerLinkResult {
  const network = opts.network ?? "testnet"
  if (network !== "testnet" && network !== "mainnet") return { ok: false, reason: "invalid-network" }
  if (!["tx", "contract", "account", "asset"].includes(opts.entity)) {
    return { ok: false, reason: "invalid-entity" }
  }
  if (network === "mainnet" && !(opts.allowMainnet ?? isMainnetLinksAllowed())) {
    incSecurityCounter("explorer_mainnet_link_blocked")
    return { ok: false, reason: "mainnet-fenced" }
  }
  if (!isValidExplorerId(opts.entity, opts.id)) return { ok: false, reason: "invalid-id" }
  const url = `${EXPLORER_BASE[network]}/${opts.entity}/${encodeURIComponent(opts.id.trim())}`
  if (!isSafeExplorerUrl(url, { allowMainnet: opts.allowMainnet })) return { ok: false, reason: "invalid-id" }
  return { ok: true, url, network, entity: opts.entity }
}

/** Allow-list check: https only, stellar.expert only, known network path only. */
export function isSafeExplorerUrl(raw: string, opts: { allowMainnet?: boolean } = {}): boolean {
  try {
    const u = new URL(raw)
    if (u.protocol !== "https:" || u.hostname !== "stellar.expert" || u.port) return false
    if (u.username || u.password) return false
    if (u.pathname.startsWith("/explorer/testnet/")) return true
    if (u.pathname.startsWith("/explorer/public/")) return opts.allowMainnet ?? isMainnetLinksAllowed()
    return false
  } catch {
    return false
  }
}

export type EnrichmentKind = "tx" | "asset"

export type EnrichmentRequest =
  | { ok: true; kind: EnrichmentKind; id: string }
  | { ok: false; reason: "invalid-kind" | "invalid-id" | "unexpected-field" | "not-a-string" }

/**
 * Strict request sanitizer. Only `kind` and `id` may be present; every other
 * field (wallet, email, memo, headers copied from the browser) is rejected.
 */
export function sanitizeEnrichmentRequest(input: unknown): EnrichmentRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, reason: "invalid-kind" }
  const raw = input as Record<string, unknown>
  const keys = Object.keys(raw)
  if (keys.some((k) => k !== "kind" && k !== "id")) return { ok: false, reason: "unexpected-field" }
  const kind = raw.kind
  const id = raw.id
  if (typeof kind !== "string" || typeof id !== "string") return { ok: false, reason: "not-a-string" }
  if (kind !== "tx" && kind !== "asset") return { ok: false, reason: "invalid-kind" }
  if (!isValidExplorerId(kind, id)) return { ok: false, reason: "invalid-id" }
  return { ok: true, kind, id: id.trim() }
}

export type TxEnrichment = {
  hash: string
  ledger: number
  createdAt: string
  successful: boolean
  feeCharged: string
  explorerUrl: string
}

export type AssetEnrichment = {
  code: string
  issuer: string
  accounts: number
  amount: string
  explorerUrl: string
}

export type EnrichmentResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: "timeout" | "network" | "not-found" | "invalid-response" | "disabled" }

export async function fetchWithTimeout(
  input: string,
  init: RequestInit = {},
  timeoutMs = ENRICHMENT_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal, cache: "no-store" })
  } finally {
    clearTimeout(timer)
  }
}

type HorizonTxJson = {
  hash?: string
  ledger?: number
  created_at?: string
  successful?: boolean
  fee_charged?: string
}

/** Read-only Horizon enrichment; strips account/memo fields entirely. */
export async function fetchTxEnrichment(
  hash: string,
  opts: {
    timeoutMs?: number
    fetchImpl?: typeof fetch
    horizonUrl?: string
  } = {},
): Promise<EnrichmentResult<TxEnrichment>> {
  if (!isExplorerEnabled()) return { ok: false, reason: "disabled" }
  if (!isValidTxHash(hash)) return { ok: false, reason: "invalid-response" }
  const link = buildExplorerUrl({ entity: "tx", id: hash })
  if (!link.ok) return { ok: false, reason: "invalid-response" }
  const base = (opts.horizonUrl ?? HORIZON_URL).replace(/\/$/, "")
  const url = `${base}/transactions/${encodeURIComponent(hash.trim())}`
  try {
    const res = await fetchWithTimeout(
      url,
      { headers: { Accept: "application/json" } },
      opts.timeoutMs ?? ENRICHMENT_TIMEOUT_MS,
      opts.fetchImpl ?? fetch,
    )
    if (res.status === 404) return { ok: false, reason: "not-found" }
    if (!res.ok) return { ok: false, reason: "network" }
    const json = (await res.json()) as HorizonTxJson
    if (typeof json.hash !== "string" || typeof json.ledger !== "number") {
      return { ok: false, reason: "invalid-response" }
    }
    return {
      ok: true,
      data: {
        hash: json.hash,
        ledger: json.ledger,
        createdAt: typeof json.created_at === "string" ? json.created_at : "",
        successful: Boolean(json.successful),
        feeCharged: typeof json.fee_charged === "string" ? json.fee_charged : "0",
        explorerUrl: link.url,
      },
    }
  } catch {
    return { ok: false, reason: "timeout" }
  }
}

type HorizonAssetJson = {
  asset_code?: string
  asset_issuer?: string
  num_accounts?: number
  amount?: string
}

export async function fetchAssetEnrichment(
  assetId: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch; horizonUrl?: string } = {},
): Promise<EnrichmentResult<AssetEnrichment>> {
  if (!isExplorerEnabled()) return { ok: false, reason: "disabled" }
  if (!isValidAssetId(assetId)) return { ok: false, reason: "invalid-response" }
  const link = buildExplorerUrl({ entity: "asset", id: assetId })
  if (!link.ok) return { ok: false, reason: "invalid-response" }
  const [code, issuer] = assetId.trim().split("-") as [string, string]
  const base = (opts.horizonUrl ?? HORIZON_URL).replace(/\/$/, "")
  const url = `${base}/assets?asset_code=${encodeURIComponent(code)}&asset_issuer=${encodeURIComponent(issuer)}`
  try {
    const res = await fetchWithTimeout(
      url,
      { headers: { Accept: "application/json" } },
      opts.timeoutMs ?? ENRICHMENT_TIMEOUT_MS,
      opts.fetchImpl ?? fetch,
    )
    if (res.status === 404) return { ok: false, reason: "not-found" }
    if (!res.ok) return { ok: false, reason: "network" }
    const json = (await res.json()) as HorizonAssetJson & { _embedded?: { records?: HorizonAssetJson[] } }
    const record = json._embedded?.records?.[0] ?? json
    if (typeof record.amount !== "string") return { ok: false, reason: "invalid-response" }
    return {
      ok: true,
      data: {
        code,
        issuer,
        accounts: typeof record.num_accounts === "number" ? record.num_accounts : 0,
        amount: record.amount,
        explorerUrl: link.url,
      },
    }
  } catch {
    return { ok: false, reason: "timeout" }
  }
}

/** Records the outcome counter at the API edge (closed label set). */
export function recordEnrichmentOutcome(ok: boolean): void {
  incSecurityCounter(ok ? "explorer_enrichment_ok" : "explorer_enrichment_failed")
}
