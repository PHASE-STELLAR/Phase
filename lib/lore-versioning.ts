/**
 * SPIKE: lore versioning with word-level diffing — phase-106
 *
 * Proof-of-concept only, scoped to this SPIKE's acceptance criteria. Today
 * `saveNarrativeForToken` overwrites the prior narrative with no history —
 * edits to a token's lore are destructive. This module adds an additive
 * version-history sidecar and a lightweight word-level diff so authors can
 * see what changed between two narrative versions.
 *
 * "Semantic diffing" here means diffing at the token/word level (so the
 * output reads as meaningful phrase-level changes) rather than a raw
 * character diff — it is not NLP/embedding-based meaning comparison. A
 * fuller semantic-embedding diff would need its own design doc and is out
 * of scope for this spike.
 *
 * This sidecar is unbounded: one JSON file holds every version of every
 * token. That is acceptable for the spike, and it is *not* the story for
 * signals — issue #207 moved signal edit history into indexed SQLite
 * (`signal_versions`) behind a compare-and-swap guard, which is where
 * concurrent lore editing is actually reconciled.
 *
 * Feature flag: phase-106 (NEXT_PUBLIC_FEATURE_PHASE_106 / FEATURE_PHASE_106)
 * Rollback: disable flag → version recording stops (no-op); existing version
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
 * Longest-common-subsequence diff over already-tokenized words. Adjacent
 * same-type operations are merged so the output reads as phrases rather than
 * one operation per word.
 */
function diffWords(a: string[], b: string[]): WordDiffOp[] {
  const n = a.length
  const m = b.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }

  const ops: WordDiffOp[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ op: "equal", words: [a[i]!] })
      i++
      j++
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push({ op: "remove", words: [a[i]!] })
      i++
    } else {
      ops.push({ op: "add", words: [b[j]!] })
      j++
    }
  }
  while (i < n) ops.push({ op: "remove", words: [a[i]!] }), i++
  while (j < m) ops.push({ op: "add", words: [b[j]!] }), j++

  const merged: WordDiffOp[] = []
  for (const op of ops) {
    const last = merged[merged.length - 1]
    if (last && last.op === op.op) last.words.push(...op.words)
    else merged.push({ op: op.op, words: [...op.words] })
  }
  return merged
}

/**
 * Word-level diff between two narrative strings (LCS-based). PoC-grade
 * "semantic diffing": operates on word tokens rather than characters so the
 * output reads as meaningful phrase-level changes.
 */
export function diffNarrativeText(from: string, to: string): WordDiffOp[] {
  return diffWords(
    from.split(/\s+/).filter(Boolean),
    to.split(/\s+/).filter(Boolean),
  )
}

/**
 * Diffs two recorded versions of a token's narrative.
 *
 * @returns null when either version is missing, so a caller can tell "no
 *   change" apart from "nothing to compare".
 */
export async function diffLoreVersions(
  tokenId: number,
  from: number,
  to: number,
): Promise<{ from: number; to: number; diff: WordDiffOp[] } | null> {
  const versions = await getLoreVersions(tokenId)
  const fromEntry = versions.find((v) => v.version === from)
  const toEntry = versions.find((v) => v.version === to)
  if (!fromEntry || !toEntry) return null
  return { from, to, diff: diffNarrativeText(fromEntry.narrative, toEntry.narrative) }
}
