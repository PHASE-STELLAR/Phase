// @ts-nocheck
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { serverDataJsonPath } from "@/lib/server-data-paths"

export type NarratorTone = "enigmatic" | "epic" | "scientific" | "folkloric"

export type WorldCollectionData = {
  world_name: string
  world_prompt: string
  created_at: number
  narrator_tone?: NarratorTone
  creator_wallet?: string
  version?: number
}

export type WorldNarrativeData = {
  narrative: string
  collection_id: number
  lore_input: string
  generated_at: number
}

type WorldCollectionsStore = Record<string, WorldCollectionData>
type WorldNarrativesStore = Record<string, WorldNarrativeData>

async function readJsonStore<T extends object>(filePath: string): Promise<T> {
  try {
    const raw = await readFile(filePath, "utf8")
    return JSON.parse(raw) as T
  } catch {
    return {} as T
  }
}

async function writeJsonStore<T extends object>(filePath: string, data: T): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf8")
}

export async function getWorldForCollection(collectionId: number): Promise<WorldCollectionData | null> {
  const store = await readJsonStore<WorldCollectionsStore>(
    serverDataJsonPath("worldCollections"),
  )
  return store[String(collectionId)] ?? null
}

export async function saveWorldForCollection(
  collectionId: number,
  data: Pick<WorldCollectionData, "world_name" | "world_prompt" | "narrator_tone"> & {
    creator_wallet?: string
  },
): Promise<void> {
  const filePath = serverDataJsonPath("worldCollections")
  const store = await readJsonStore<WorldCollectionsStore>(filePath)
  const existing = store[String(collectionId)]
  store[String(collectionId)] = {
    ...existing,
    world_name: data.world_name,
    world_prompt: data.world_prompt,
    ...(data.narrator_tone !== undefined ? { narrator_tone: data.narrator_tone } : {}),
    ...(data.creator_wallet !== undefined ? { creator_wallet: data.creator_wallet } : {}),
    created_at: existing?.created_at ?? Date.now(),
    version: (existing?.version ?? 0) + 1,
  }
  await writeJsonStore(filePath, store)
}

export async function getAllWorldCollections(): Promise<WorldCollectionsStore> {
  return readJsonStore<WorldCollectionsStore>(serverDataJsonPath("worldCollections"))
}

export async function getNarrativeForToken(tokenId: number): Promise<WorldNarrativeData | null> {
  const store = await readJsonStore<WorldNarrativesStore>(
    serverDataJsonPath("worldNarratives"),
  )
  return store[String(tokenId)] ?? null
}

export async function saveNarrativeForToken(
  tokenId: number,
  data: Omit<WorldNarrativeData, "generated_at">,
): Promise<void> {
  const filePath = serverDataJsonPath("worldNarratives")
  const store = await readJsonStore<WorldNarrativesStore>(filePath)
  store[String(tokenId)] = { ...data, generated_at: Date.now() }
  await writeJsonStore(filePath, store)
  invalidateLocalizedNarrativeCache(tokenId)
}

/** Returns the total count of distinct token narratives across all world collections. */
export async function getAllNarrativesCount(): Promise<number> {
  const store = await readJsonStore<WorldNarrativesStore>(serverDataJsonPath("worldNarratives"))
  return Object.keys(store).length
}

type NftListingsFile = {
  listings?: Array<{ tokenId?: number; seller?: string }>
}

/**
 * Counts unique wallets (sellers) that own tokens with narratives in the given
 * active-world collection IDs. Falls back to unique-token count when no listing
 * data is available for a token.
 */
export async function countCollectorsInWorlds(worldCollectionIds: number[]): Promise<number> {
  if (worldCollectionIds.length === 0) return 0
  const activeSet = new Set(worldCollectionIds)

  const narratives = await readJsonStore<WorldNarrativesStore>(serverDataJsonPath("worldNarratives"))
  const tokenIdsWithNarratives = new Set<number>()
  for (const [tokenId, data] of Object.entries(narratives)) {
    if (activeSet.has(data.collection_id)) tokenIdsWithNarratives.add(Number(tokenId))
  }
  if (tokenIdsWithNarratives.size === 0) return 0

  // Cross-reference with nft-listings to resolve wallets
  const listingsFile = await readJsonStore<NftListingsFile>(serverDataJsonPath("nftListings"))
  const tokenToWallet = new Map<number, string>()
  for (const listing of listingsFile.listings ?? []) {
    if (typeof listing.tokenId === "number" && typeof listing.seller === "string") {
      tokenToWallet.set(listing.tokenId, listing.seller)
    }
  }

  const uniqueWallets = new Set<string>()
  let unknownCount = 0
  for (const tokenId of tokenIdsWithNarratives) {
    const wallet = tokenToWallet.get(tokenId)
    if (wallet) uniqueWallets.add(wallet)
    else unknownCount++
  }

  // If some tokens have no listing data, count them as 1 additional wallet each
  return uniqueWallets.size + unknownCount
}

/** Returns narratives for a collection sorted newest-first, up to `limit`. */
export async function getRecentNarrativesForCollection(
  collectionId: number,
  limit: number,
): Promise<WorldNarrativeData[]> {
  const store = await readJsonStore<WorldNarrativesStore>(serverDataJsonPath("worldNarratives"))
  return Object.values(store)
    .filter((v) => v.collection_id === collectionId)
    .sort((a, b) => b.generated_at - a.generated_at)
    .slice(0, limit)
}

// â”€â”€â”€ phase-111: localized narrative caching per language pack â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Isolated, flag-gated. Every locale re-fetched the same lore from disk on
// every request. When enabled, reads are cached per (tokenId, lang) with a
// short TTL, avoiding redundant JSON-store reads across language packs.
// When flag off, callers fall back to getNarrativeForToken() directly
// (zero regression). Rollback: unset NEXT_PUBLIC_FEATURE_PHASE_111 / FEATURE_PHASE_111.

export function isLocalizedCacheEnabled(): boolean {
  const v = (process.env.NEXT_PUBLIC_FEATURE_PHASE_111 ?? process.env.FEATURE_PHASE_111 ?? "").trim().toLowerCase()
  return v === "1" || v === "true" || v === "yes" || v === "on"
}

const LOCALIZED_CACHE_TTL_MS = 5 * 60_000

type LocalizedCacheEntry = {
  value: WorldNarrativeData | null
  expiresAt: number
}

const localizedNarrativeCache = new Map<string, LocalizedCacheEntry>()

function localizedCacheKey(tokenId: number, lang: string): string {
  return `${tokenId}:${lang}`
}

/** Drops all cached entries for a token (called after the narrative changes). */
export function invalidateLocalizedNarrativeCache(tokenId: number): void {
  for (const key of localizedNarrativeCache.keys()) {
    if (key.startsWith(`${tokenId}:`)) localizedNarrativeCache.delete(key)
  }
}

/**
 * Reads a token's narrative through a per-(tokenId, lang) cache with a short TTL.
 * The underlying narrative text is not translated by this cache â€” it only avoids
 * redundant store reads when the same locale re-fetches the same lore.
 * When phase-111 is disabled, bypasses the cache entirely.
 */
export async function getNarrativeForTokenCached(
  tokenId: number,
  lang: string,
): Promise<WorldNarrativeData | null> {
  if (!isLocalizedCacheEnabled()) return getNarrativeForToken(tokenId)

  const key = localizedCacheKey(tokenId, lang)
  const cached = localizedNarrativeCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.value

  const value = await getNarrativeForToken(tokenId)
  localizedNarrativeCache.set(key, { value, expiresAt: Date.now() + LOCALIZED_CACHE_TTL_MS })
  return value
}

// â”€â”€â”€ phase-108: reader progression tracking â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

type ReaderProgressEntry = {
  wallet: string
  collection_id: number
  read_token_ids: number[]
  last_read_at: number
}

type ReaderProgressStore = Record<string, ReaderProgressEntry>

function readerProgressKey(wallet: string, collectionId: number): string {
  return `${wallet}:${collectionId}`
}

export async function getReaderProgress(wallet: string, collectionId: number): Promise<number[]> {
  const store = await readJsonStore<ReaderProgressStore>(serverDataJsonPath("readerProgress"))
  const key = readerProgressKey(wallet, collectionId)
  return store[key]?.read_token_ids ?? []
}

export async function markNarrativeRead(wallet: string, collectionId: number, tokenId: number): Promise<void> {
  const filePath = serverDataJsonPath("readerProgress")
  const store = await readJsonStore<ReaderProgressStore>(filePath)
  const key = readerProgressKey(wallet, collectionId)
  const existing = store[key] ?? { wallet, collection_id: collectionId, read_token_ids: [], last_read_at: 0 }
  if (!existing.read_token_ids.includes(tokenId)) {
    existing.read_token_ids.push(tokenId)
  }
  existing.last_read_at = Date.now()
  store[key] = existing
  await writeJsonStore(filePath, store)
}

// â”€â”€â”€ phase-109: collaborative world permissions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export type WorldRole = "editor" | "viewer"

type WorldRolesEntry = {
  collection_id: number
  owner: string
  roles: Record<string, WorldRole>
}

type WorldRolesStore = Record<string, WorldRolesEntry>

export async function getWorldRoles(collectionId: number): Promise<Record<string, WorldRole>> {
  const store = await readJsonStore<WorldRolesStore>(serverDataJsonPath("worldRoles"))
  return store[String(collectionId)]?.roles ?? {}
}

export async function ensureWorldOwner(collectionId: number, ownerWallet: string): Promise<void> {
  const filePath = serverDataJsonPath("worldRoles")
  const store = await readJsonStore<WorldRolesStore>(filePath)
  const key = String(collectionId)
  if (!store[key]) {
    store[key] = { collection_id: collectionId, owner: ownerWallet, roles: {} }
    await writeJsonStore(filePath, store)
  }
}

export async function setWorldRole(
  collectionId: number,
  actingWallet: string,
  targetWallet: string,
  role: WorldRole,
): Promise<Record<string, WorldRole>> {
  const filePath = serverDataJsonPath("worldRoles")
  const store = await readJsonStore<WorldRolesStore>(filePath)
  const key = String(collectionId)
  const entry = store[key]
  if (!entry || entry.owner !== actingWallet) {
    throw new Error("Solo el propietario del mundo puede asignar roles")
  }
  entry.roles[targetWallet] = role
  await writeJsonStore(filePath, store)
  return entry.roles
}

// â”€â”€â”€ phase-112: world export to portable markdown/JSON â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export type WorldExportSnapshot = {
  collection_id: number
  world_name: string
  world_prompt: string
  narrator_tone?: NarratorTone
  created_at: number
  narratives: Array<{
    token_id: number
    narrative: string
    lore_input: string
    generated_at: number
  }>
}

export async function buildWorldExportSnapshot(collectionId: number): Promise<WorldExportSnapshot | null> {
  const world = await getWorldForCollection(collectionId)
  if (!world) return null

  const narrativesStore = await readJsonStore<WorldNarrativesStore>(serverDataJsonPath("worldNarratives"))
  const narratives = Object.entries(narrativesStore)
    .filter(([_, data]) => data.collection_id === collectionId)
    .map(([tokenId, data]) => ({
      token_id: Number(tokenId),
      narrative: data.narrative,
      lore_input: data.lore_input,
      generated_at: data.generated_at,
    }))
    .sort((a, b) => a.token_id - b.token_id)

  return {
    collection_id: collectionId,
    world_name: world.world_name,
    world_prompt: world.world_prompt,
    narrator_tone: world.narrator_tone,
    created_at: world.created_at,
    narratives,
  }
}

export type WorldExportNarrative = {
  token_id: number
  narrative: string
  lore_input: string
  generated_at: number
}

/** Narratives per cursor page during export — keeps each batch bounded (#239). */
export const WORLD_EXPORT_PAGE_SIZE = 50

export type WorldExportNarrativePage = {
  items: WorldExportNarrative[]
  /** token_id to resume from, or null when the collection is exhausted. */
  nextCursor: number | null
}

/**
 * Cursor-paginated narratives for a collection, ordered by token_id.
 * `cursor` is the last token_id already emitted, so each page holds at most
 * `limit` records instead of materialising every narrative at once (#239).
 */
export async function getWorldNarrativesPage(
  collectionId: number,
  opts: { cursor?: number | null; limit?: number } = {},
): Promise<WorldExportNarrativePage> {
  const store = await readJsonStore<WorldNarrativesStore>(serverDataJsonPath("worldNarratives"))
  const limit = Math.min(Math.max(opts.limit ?? WORLD_EXPORT_PAGE_SIZE, 1), WORLD_EXPORT_PAGE_SIZE)
  const cursor = typeof opts.cursor === "number" && Number.isFinite(opts.cursor) ? opts.cursor : null

  const matching = Object.entries(store)
    .filter(([, data]) => data.collection_id === collectionId)
    .map(([tokenId, data]) => ({
      token_id: Number(tokenId),
      narrative: data.narrative,
      lore_input: data.lore_input,
      generated_at: data.generated_at,
    }))
    .filter((n) => cursor === null || n.token_id > cursor)
    .sort((a, b) => a.token_id - b.token_id)

  const items = matching.slice(0, limit)
  const last = items[items.length - 1]
  return { items, nextCursor: matching.length > items.length && last ? last.token_id : null }
}

/** Total narratives in a collection — counted without holding them in memory. */
export async function countWorldNarratives(collectionId: number): Promise<number> {
  const store = await readJsonStore<WorldNarrativesStore>(serverDataJsonPath("worldNarratives"))
  let total = 0
  for (const data of Object.values(store)) {
    if (data.collection_id === collectionId) total++
  }
  return total
}

/**
 * Streams a world export as NDJSON in cursor pages of `pageSize` records, so a
 * large world never has to be serialised into a single in-memory string.
 * First line is the metadata header, then one narrative record per line.
 * The caller sets Content-Type: application/x-ndjson.
 */
export async function* streamWorldExportNdjson(
  collectionId: number,
  opts: { cursor?: number | null; pageSize?: number } = {},
): AsyncGenerator<string, void, undefined> {
  const world = await getWorldForCollection(collectionId)
  if (!world) return

  const header = {
    collection_id: collectionId,
    world_name: world.world_name,
    world_prompt: world.world_prompt,
    narrator_tone: world.narrator_tone ?? null,
    created_at: world.created_at,
    narrative_count: await countWorldNarratives(collectionId),
  }
  yield `${JSON.stringify(header)}\n`

  let cursor = opts.cursor ?? null
  for (;;) {
    const page = await getWorldNarrativesPage(collectionId, {
      cursor,
      limit: opts.pageSize ?? WORLD_EXPORT_PAGE_SIZE,
    })
    for (const narrative of page.items) yield `${JSON.stringify(narrative)}\n`
    if (page.nextCursor === null) return
    cursor = page.nextCursor
  }
}

export function renderWorldExportMarkdown(snapshot: WorldExportSnapshot): string {
  let md = `# ${snapshot.world_name}\n\n`
  md += `**Mundo ID:** ${snapshot.collection_id}\n\n`
  md += `**Prompt del Mundo:**\n${snapshot.world_prompt}\n\n`
  if (snapshot.narrator_tone) md += `**Tono del Narrador:** ${snapshot.narrator_tone}\n\n`
  md += `**Creado:** ${new Date(snapshot.created_at).toISOString()}\n\n`
  md += `---\n\n## Narrativas (${snapshot.narratives.length})\n\n`
  for (const n of snapshot.narratives) {
    md += `### Artefacto #${n.token_id}\n\n`
    md += `**Entrada de Lore:** ${n.lore_input}\n\n`
    md += `**Narrativa:**\n${n.narrative}\n\n`
    md += `*Generado: ${new Date(n.generated_at).toISOString()}*\n\n`
    md += `---\n\n`
  }
  return md
}

/**
 * Serialises a world export snapshot as Newline-Delimited JSON (NDJSON).
 *
 * One JSON object per line â€” the metadata header on the first line, then one
 * narrative record per subsequent line. Consumers can stream the response and
 * process records incrementally without buffering the whole file.
 *
 * The caller is responsible for setting Content-Type: application/x-ndjson.
 */
export function renderWorldExportNdjson(snapshot: WorldExportSnapshot): string {
  const header = {
    collection_id: snapshot.collection_id,
    world_name: snapshot.world_name,
    world_prompt: snapshot.world_prompt,
    narrator_tone: snapshot.narrator_tone ?? null,
    created_at: snapshot.created_at,
    narrative_count: snapshot.narratives.length,
  }
  const lines = [JSON.stringify(header)]
  for (const n of snapshot.narratives) {
    lines.push(JSON.stringify(n))
  }
  return lines.join("\n") + "\n"
}

// â”€â”€â”€ phase-115: cross-artifact lore linking â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export type LoreLink = {
  from_token_id: number
  to_token_id: number
  note?: string
  created_at: number
}

type LoreLinkStore = LoreLink[]

export async function getLoreLinksForToken(tokenId: number): Promise<{ outgoing: LoreLink[]; incoming: LoreLink[] }> {
  const store = await readJsonStore<LoreLinkStore>(serverDataJsonPath("loreLinks"))
  const outgoing = store.filter((link) => link.from_token_id === tokenId)
  const incoming = store.filter((link) => link.to_token_id === tokenId)
  return { outgoing, incoming }
}

export async function addLoreLink(fromTokenId: number, toTokenId: number, note?: string): Promise<LoreLink> {
  const filePath = serverDataJsonPath("loreLinks")
  const store = await readJsonStore<LoreLinkStore>(filePath)
  const existingIndex = store.findIndex((l) => l.from_token_id === fromTokenId && l.to_token_id === toTokenId)
  const link: LoreLink = {
    from_token_id: fromTokenId,
    to_token_id: toTokenId,
    note,
    created_at: Date.now(),
  }
  if (existingIndex >= 0) {
    store[existingIndex] = link
  } else {
    store.push(link)
  }
  await writeJsonStore(filePath, store)
  return link
}

// â”€â”€â”€ phase-110: narrative search helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function getAllNarrativesWithTokenIds(): Promise<
  Array<{ tokenId: number; narrative: string; collection_id: number; generated_at: number }>
> {
  const store = await readJsonStore<WorldNarrativesStore>(serverDataJsonPath("worldNarratives"))
  return Object.entries(store).map(([tokenId, data]) => ({
    tokenId: Number(tokenId),
    narrative: data.narrative,
    collection_id: data.collection_id,
    generated_at: data.generated_at,
  }))
}

