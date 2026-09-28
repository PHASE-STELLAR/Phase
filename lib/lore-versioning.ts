// @ts-nocheck
/**
 * SPIKE: lore versioning with word-level diffing â€” phase-106
*
 * Proof-of-concept only, scoped to this SPIKE's acceptance criteria. Today
 * `saveNarrativeForToken` overwrites the prior narrative with no history â€”
 * edits to a token's lore are destructive. This module adds an additive
 * version-history sidecar and a lightweight word-level diff so authors can
 * see what changed between two narrative versions.
*
 * "Semantic diffing" here means diffing at the token/word level (so the
 * output reads as meaningful phrase-level changes) rather than a raw
 * character diff â€” it is not NLP\/embedding-based meaning comparison. A
 * fuller semantic-embedding diff would need its own design doc and is out
 * of scope for this spike.
 *
 * Feature flag: phase-106 (NEXT_PUBLIC_FEATURE_PHASE_106 / FEATURE_PHASE_106)
 * Rollback: disable flag â†’ version recording stops (no-op); existing version
 *           history files remain on disk untouched; narrator route unaffected.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { serverDataJsonPath } from "@/lib/server-data-paths"
import { isFeatureEnabled } from "@/lib/feature-flags"

export type LoreVersionEntry = {
  version: number
  narrative: string
  lore_input: string
  recorded_at: number
}

type LoreVersionsStore = Record<string, LoreVersionEntry[]>

export function isLoreVersioningEnabled(): boolean {
  return isFeatureEnabled("phase-106")
}

async function readStore(): Promise<LoreVersionsStore> {
  try {
    const raw = await readFile(serverDataJsonPath("loreVersions"), "utf8")
    return JSON.parse(raw) as LoreVersionsStore
  } catch {
    return {}
  }
}

async function writeStore(store: LoreVersionsStore): Promise<void> {
  const filePath = serverDataJsonPath("loreVersions")
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(store, null, 2), "utf8")
}

/** Appends a new version for a token's narrative. No-op (returns null) when the flag is off. */
export async function recordLoreVersion(
  tokenId: number,
  data: { narrative: string; lore_input: string },
): Promise<LoreVersionEntry | null> {
  if (!isLoreVersioningEnabled()) return null
  const store = await readStore()
  const key = String(tokenId)
  const existing = store[key] ?? []
  const entry: LoreVersionEntry = {
    version: existing.length + 1,
    narrative: data.narrative,
    lore_input: data.lore_input,
    recorded_at: Date.now(),
  }
  store[key] = [...existing, entry]
  await writeStore(store)
  return entry
}

export async function getLoreVersions(tokenId: number): Promise<LoreVersionEntry[]> {
  const store = await readStore()
  return store[String(tokenId)] ?? []
}

export type WordDiffOp = { op: "equal" | "add" | "remove"; words: string[] }

/**
 * Word-level diff between two narrative strings (LCS-based). PoC-grade
 * "semantic diffing": operates on word tokens rather than characters so the
 * output reads as meaningful phrase-level changes.
 */
export function diffNarrativeText(from: string, to: string): WordDiffOp[] {
  const a = from.split(/\s+/).filter(Boolean)
  const b = to.split(/\s+/).filter(Boolean)
  return diffWords(a, b)
}

/**
 * Returns the most recent narrative arcs for a collection, newest last.
 * If `limit` provided, returns at most that many entries (from the tail).
 */
export async function getNarrativeArc(
  collectionId: string,
  limit?: number,
): Promise<NarrativeArcEntry[]> {
  const store = await readArcStore()
  const arcs = store[String(collectionId)] ?? []
  return limit ? arcs.slice(-limit) : arcs
}
