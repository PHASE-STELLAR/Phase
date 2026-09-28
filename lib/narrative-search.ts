/**
 * Narrative search indexed by entity and location — phase-110
 *
 * "Entity" = a forged artifact/token (its narrative). "Location" = the
 * world/collection the artifact belongs to (`world_name`). Finding lore
 * about a specific artifact today requires manually scanning collections
 * one by one; this module builds a simple query over the existing
 * narrative + world data so both dimensions can be searched directly,
 * plus a free-text match against the narrative body.
 *
 * Feature flag: phase-110 (NEXT_PUBLIC_FEATURE_PHASE_110 / FEATURE_PHASE_110)
 * Rollback: disable flag → GET /api/world/search returns 404, no data migration.
 */
import { isFeatureEnabled } from "@/lib/feature-flags"
import { getAllNarrativesWithTokenIds, getAllWorldCollections } from "@/lib/narrative-world-store"

export type NarrativeSearchResult = {
  tokenId: number
  narrative: string
  collectionId: number
  worldName: string
  generatedAt: number
}

export type NarrativeSearchQuery = {
  /** Entity id — the artifact/token this narrative belongs to. */
  entity?: number
  /** Location — matched against the world/collection name (substring, case-insensitive). */
  location?: string
  /** Free-text match against the narrative body (substring, case-insensitive). */
  text?: string
}

export function isNarrativeSearchEnabled(): boolean {
  return isFeatureEnabled("phase-110")
}

export async function searchNarratives(query: NarrativeSearchQuery): Promise<NarrativeSearchResult[]> {
  const [narratives, worlds] = await Promise.all([getAllNarrativesWithTokenIds(), getAllWorldCollections()])

  const locationQuery = query.location?.trim().toLowerCase()
  const textQuery = query.text?.trim().toLowerCase()

  const results: NarrativeSearchResult[] = []
  for (const n of narratives) {
    if (query.entity !== undefined && n.tokenId !== query.entity) continue

    const world = worlds[String(n.collection_id)]
    const worldName = world?.world_name ?? ""
    if (locationQuery && !worldName.toLowerCase().includes(locationQuery)) continue
    if (textQuery && !n.narrative.toLowerCase().includes(textQuery)) continue

    results.push({
      tokenId: n.tokenId,
      narrative: n.narrative,
      collectionId: n.collection_id,
      worldName,
      generatedAt: n.generated_at,
    })
  }

  results.sort((a, b) => b.generatedAt - a.generatedAt)
  return results
}
