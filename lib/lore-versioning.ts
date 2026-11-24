/**
 * Lore versioning with word-level diffing (phase-106) and explicit append-only
 * rollback + If-Match concurrency guard (phase-257, issue #710).
 *
 * Feature flags:
 * - phase-106: spike word-level diff & additive version sidecar
 * - phase-257: snapshot on every committed edit with version & author proof,
 *   read-only history, explicit append-only rollback, and If-Match 409 guard.
 *
 * Rollback: unset flag → history route 404; snapshots inert; legacy overwrite.
 */
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { serverDataJsonPath } from "@/lib/server-data-paths"
import { isFeatureEnabled } from "@/lib/feature-flags"

export type LoreVersionEntry = {
  version: number
  narrative: string
  lore_input: string
  recorded_at: number
  author_hash?: string
  author_proof?: string
  etag?: string
  rolled_back_from?: number
}

type LoreVersionsStore = Record<string, LoreVersionEntry[]>

export class LoreVersionConflictError extends Error {
  status = 409 as const
  currentVersion: number
  currentEtag: string
  constructor(currentVersion: number, currentEtag: string) {
    super(`Lore version conflict: current version is ${currentVersion}`)
    this.name = "LoreVersionConflictError"
    this.currentVersion = currentVersion
    this.currentEtag = currentEtag
  }
}

export class LoreVersionNotFoundError extends Error {
  status = 404 as const
  constructor(tokenId: number, version: number) {
    super(`Lore version ${version} not found for token ${tokenId}`)
    this.name = "LoreVersionNotFoundError"
  }
}

export function isLoreVersioningEnabled(): boolean {
  return isFeatureEnabled("phase-106") || isFeatureEnabled("phase-257")
}

export function isLoreRollbackVersioningEnabled(): boolean {
  return isFeatureEnabled("phase-257")
}

function hashSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

export function computeLoreEtag(tokenId: number, version: number, narrative: string): string {
  const digest = hashSha256(`${tokenId}:${version}:${narrative}`).slice(0, 16)
  return `"v${version}-${digest}"`
}

export function computeAuthorProof(
  tokenId: number,
  version: number,
  narrative: string,
  author?: string,
): { author_hash?: string; author_proof: string } {
  const authorHash = author?.trim() ? hashSha256(author.trim().toLowerCase()) : undefined
  const author_proof = hashSha256(`${tokenId}:${version}:${authorHash ?? "anonymous"}:${narrative}`)
  return { author_hash: authorHash, author_proof }
}

function normalizeIfMatch(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.startsWith("W/")) return trimmed.slice(2).trim()
  return trimmed
}

function matchesIfMatch(ifMatch: string, latest: LoreVersionEntry | undefined, tokenId: number): boolean {
  const normalized = normalizeIfMatch(ifMatch)
  if (!latest) {
    return normalized === "0" || normalized === '"0"' || normalized === "v0" || normalized === '"v0"'
  }
  const latestEtag = latest.etag ?? computeLoreEtag(tokenId, latest.version, latest.narrative)
  const unquoted = normalized.replace(/^"|"$/g, "")
  const etagUnquoted = latestEtag.replace(/^"|"$/g, "")
  return (
    normalized === latestEtag ||
    unquoted === etagUnquoted ||
    unquoted === String(latest.version) ||
    unquoted === `v${latest.version}`
  )
}

let writeQueue: Promise<unknown> = Promise.resolve()

function withSerializedStore<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(fn, fn)
  writeQueue = next.catch(() => {})
  return next
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
  data: { narrative: string; lore_input: string; author?: string; author_proof?: string },
): Promise<LoreVersionEntry | null> {
  if (!isLoreVersioningEnabled()) return null
  return withSerializedStore(async () => {
    const store = await readStore()
    const key = String(tokenId)
    const existing = store[key] ?? []
    const version = existing.length + 1
    const proof = computeAuthorProof(tokenId, version, data.narrative, data.author)
    const entry: LoreVersionEntry = {
      version,
      narrative: data.narrative,
      lore_input: data.lore_input,
      recorded_at: Date.now(),
      author_hash: proof.author_hash,
      author_proof: data.author_proof ?? proof.author_proof,
      etag: computeLoreEtag(tokenId, version, data.narrative),
    }
    store[key] = [...existing, entry]
    await writeStore(store)
    return entry
  })
}

export type CommitLoreResult =
  | { legacyOverwrite: true; entry: null }
  | { legacyOverwrite: false; entry: LoreVersionEntry }

/**
 * Commits a lore edit with optimistic concurrency (`If-Match`) and author proof.
 * When `phase-257` is off, falls back to legacy overwrite (or phase-106 spike).
 */
export async function commitLoreEdit(
  tokenId: number,
  data: { narrative: string; lore_input: string; author?: string; author_proof?: string },
  opts: { ifMatch?: string | null } = {},
): Promise<CommitLoreResult> {
  if (!isLoreRollbackVersioningEnabled()) {
    if (isLoreVersioningEnabled()) {
      const entry = await recordLoreVersion(tokenId, data)
      if (entry) return { legacyOverwrite: false, entry }
    }
    return { legacyOverwrite: true, entry: null }
  }

  return withSerializedStore(async () => {
    const store = await readStore()
    const key = String(tokenId)
    const existing = store[key] ?? []
    const latest = existing[existing.length - 1]

    if (opts.ifMatch !== undefined && opts.ifMatch !== null && opts.ifMatch.trim() !== "") {
      if (!matchesIfMatch(opts.ifMatch, latest, tokenId)) {
        const currentVersion = latest?.version ?? 0
        const currentEtag = latest
          ? (latest.etag ?? computeLoreEtag(tokenId, latest.version, latest.narrative))
          : '"v0"'
        throw new LoreVersionConflictError(currentVersion, currentEtag)
      }
    }

    const version = existing.length + 1
    const proof = computeAuthorProof(tokenId, version, data.narrative, data.author)
    const entry: LoreVersionEntry = {
      version,
      narrative: data.narrative,
      lore_input: data.lore_input,
      recorded_at: Date.now(),
      author_hash: proof.author_hash,
      author_proof: data.author_proof ?? proof.author_proof,
      etag: computeLoreEtag(tokenId, version, data.narrative),
    }
    store[key] = [...existing, entry]
    await writeStore(store)
    return { legacyOverwrite: false, entry }
  })
}

/**
 * Explicit rollback: appends a new version copying `targetVersion` rather than
 * mutating or truncating history. Guarded by `If-Match`.
 */
export async function rollbackLoreVersion(
  tokenId: number,
  targetVersion: number,
  opts: { author?: string; author_proof?: string; ifMatch?: string | null } = {},
): Promise<LoreVersionEntry | null> {
  if (!isLoreRollbackVersioningEnabled()) return null

  return withSerializedStore(async () => {
    const store = await readStore()
    const key = String(tokenId)
    const existing = store[key] ?? []
    const target = existing.find((v) => v.version === targetVersion)
    if (!target) {
      throw new LoreVersionNotFoundError(tokenId, targetVersion)
    }

    const latest = existing[existing.length - 1]
    if (opts.ifMatch !== undefined && opts.ifMatch !== null && opts.ifMatch.trim() !== "") {
      if (!matchesIfMatch(opts.ifMatch, latest, tokenId)) {
        const currentVersion = latest?.version ?? 0
        const currentEtag = latest
          ? (latest.etag ?? computeLoreEtag(tokenId, latest.version, latest.narrative))
          : '"v0"'
        throw new LoreVersionConflictError(currentVersion, currentEtag)
      }
    }

    const version = existing.length + 1
    const proof = computeAuthorProof(tokenId, version, target.narrative, opts.author)
    const entry: LoreVersionEntry = {
      version,
      narrative: target.narrative,
      lore_input: target.lore_input,
      recorded_at: Date.now(),
      author_hash: proof.author_hash,
      author_proof: opts.author_proof ?? proof.author_proof,
      etag: computeLoreEtag(tokenId, version, target.narrative),
      rolled_back_from: targetVersion,
    }
    store[key] = [...existing, entry]
    await writeStore(store)
    return entry
  })
}

export async function getLoreVersions(tokenId: number): Promise<LoreVersionEntry[]> {
  const store = await readStore()
  const list = store[String(tokenId)] ?? []
  return list.map((entry) => ({
    ...entry,
    etag: entry.etag ?? computeLoreEtag(tokenId, entry.version, entry.narrative),
  }))
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
