const CACHE_TTL_MS = 30_000
const MAX_CACHED_ALIASES = 500
const MAX_CONCURRENT_REQUESTS = 8

type CacheEntry = { alias: string | null; expiresAt: number }
const aliasCache = new Map<string, CacheEntry>()
const inFlight = new Map<string, Promise<string | null>>()
const waiters: Array<() => void> = []
let activeRequests = 0

async function withRequestSlot<T>(run: () => Promise<T>): Promise<T> {
  if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
    await new Promise<void>((resolve) => waiters.push(resolve))
  } else {
    activeRequests++
  }
  try {
    return await run()
  } finally {
    const next = waiters.shift()
    if (next) next()
    else activeRequests--
  }
}

export async function fetchArtistAlias(walletAddress: string): Promise<string | null> {
  if (!walletAddress) return null

  const cached = aliasCache.get(walletAddress)
  if (cached && cached.expiresAt > Date.now()) {
    aliasCache.delete(walletAddress)
    aliasCache.set(walletAddress, cached)
    return cached.alias
  }

  const pending = inFlight.get(walletAddress)
  if (pending) return pending

  const request = withRequestSlot(async () => {
    try {
      const res = await fetch(`/api/artist-profile?walletAddress=${encodeURIComponent(walletAddress)}`, {
        cache: "no-store",
      })
      if (!res.ok) return null
      const data = (await res.json().catch(() => ({}))) as { alias?: string | null }
      const alias = typeof data.alias === "string" ? data.alias.trim() || null : null
      aliasCache.delete(walletAddress)
      aliasCache.set(walletAddress, { alias, expiresAt: Date.now() + CACHE_TTL_MS })
      while (aliasCache.size > MAX_CACHED_ALIASES) {
        const oldest = aliasCache.keys().next().value
        if (oldest === undefined) break
        aliasCache.delete(oldest)
      }
      return alias
    } catch {
      // Network and 429 failures remain retryable; never cache them.
      return null
    }
  }).finally(() => inFlight.delete(walletAddress))
  inFlight.set(walletAddress, request)
  return request
}

export type ArtistAliasDetails = {
  alias: string | null
  version: number
  attested: boolean
  updatedAt: number | null
  audit?: Array<{
    id: string
    action: "created" | "updated" | "attested"
    alias: string
    version: number
    createdAt: number
  }>
}

export function invalidateArtistAliasCache(walletAddress?: string): void {
  if (walletAddress) aliasCache.delete(walletAddress)
  else aliasCache.clear()
}

export async function fetchArtistAliasDetails(
  walletAddress: string,
  includeAudit = false,
): Promise<ArtistAliasDetails | null> {
  if (!walletAddress) return null
  try {
    const qs = new URLSearchParams({ walletAddress })
    if (includeAudit) qs.set("audit", "1")
    const res = await fetch(`/api/artist-profile?${qs.toString()}`, { cache: "no-store" })
    if (!res.ok) return null
    const data = (await res.json().catch(() => ({}))) as Partial<ArtistAliasDetails>
    return {
      alias: typeof data.alias === "string" ? data.alias.trim() || null : null,
      version: typeof data.version === "number" ? data.version : 0,
      attested: Boolean(data.attested),
      updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : null,
      audit: Array.isArray(data.audit) ? data.audit : undefined,
    }
  } catch {
    return null
  }
}
