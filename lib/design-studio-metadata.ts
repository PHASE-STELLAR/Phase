/**
 * phase-258: Design Studio editor for artifact metadata (issue #711).
 *
 * Validates editor output against the exact same Zod schema used by the
 * metadata builder (`PhaseTokenMetadataJsonSchema`), provides deterministic
 * pre-commit previews, persists drafts with `If-Match` optimistic concurrency
 * (409 on stale edits), and routes committed metadata through `/api/metadata/[id]`.
 *
 * Flag: NEXT_PUBLIC_FEATURE_PHASE_258 / FEATURE_PHASE_258 (default off).
 * Rollback: unset flag -> editor hidden, drafts inert on disk.
 */

import { z } from "zod"
import { isFeatureEnabled, flagRollbackNote } from "@/lib/feature-flags"
import { readStore, updateStoreWithReader } from "@/lib/json-store"
import {
  PhaseTokenMetadataJsonSchema,
  type PhaseTokenMetadataJson,
} from "@/lib/phase-nft-metadata-build"
import { phaseProtocolContractIdForServer } from "@/lib/phase-protocol"

export const DESIGN_STUDIO_METADATA_FLAG = "phase-258" as const

export function isDesignStudioMetadataEnabled(wallet?: string): boolean {
  return isFeatureEnabled(DESIGN_STUDIO_METADATA_FLAG, wallet ? { wallet } : undefined)
}

export function designStudioMetadataRollbackNote(): string {
  return flagRollbackNote(DESIGN_STUDIO_METADATA_FLAG)
}

export class DesignStudioMetadataError extends Error {
  code: "FLAG_DISABLED" | "VALIDATION_FAILED" | "STALE_DRAFT" | "NOT_FOUND"
  status: number
  details?: unknown

  constructor(
    code: DesignStudioMetadataError["code"],
    message: string,
    details?: unknown,
  ) {
    super(message)
    this.name = "DesignStudioMetadataError"
    this.code = code
    this.status =
      code === "FLAG_DISABLED"
        ? 404
        : code === "VALIDATION_FAILED"
          ? 400
          : code === "STALE_DRAFT"
            ? 409
            : 404
    this.details = details
  }
}

export type ArtifactMetadataDraftRecord = {
  key: string
  contractId: string
  tokenId: number
  version: number
  etag: string
  status: "draft" | "committed"
  metadata: PhaseTokenMetadataJson
  updatedAt: number
  committedAt: number | null
  updatedBy: string | null
}

type ArtifactMetadataDraftStore = {
  version: number
  drafts: Record<string, ArtifactMetadataDraftRecord>
}

function emptyStore(): ArtifactMetadataDraftStore {
  return { version: 1, drafts: {} }
}

function normalizeStore(raw: unknown): ArtifactMetadataDraftStore {
  const s = raw as Partial<ArtifactMetadataDraftStore> | null | undefined
  if (!s || typeof s !== "object" || !s.drafts || typeof s.drafts !== "object") {
    return emptyStore()
  }
  return {
    version: typeof s.version === "number" && s.version > 0 ? s.version : 1,
    drafts: s.drafts,
  }
}

export function makeMetadataDraftKey(tokenId: number, contractId?: string): string {
  const c = (contractId?.trim() || phaseProtocolContractIdForServer()).toUpperCase()
  return `${c}:${tokenId}`
}

export function formatMetadataEtag(version: number): string {
  return `"v${version}"`
}

export function normalizeIfMatchHeader(raw?: string | null): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const withoutWeak = trimmed.replace(/^W\//i, "").trim()
  return withoutWeak.replace(/^"+|"+$/g, "").trim()
}

export const ArtifactMetadataWriteRequestSchema = z.object({
  contractId: z.string().trim().optional(),
  metadata: PhaseTokenMetadataJsonSchema,
  updatedBy: z.string().trim().max(128).optional(),
})

/**
 * Validates editor output against `PhaseTokenMetadataJsonSchema` — the exact
 * same Zod schema used by `buildPhaseTokenMetadataJson`.
 */
export function validateArtifactMetadata(
  raw: unknown,
):
  | { ok: true; data: PhaseTokenMetadataJson }
  | { ok: false; error: string; details: ReturnType<z.ZodError["flatten"]> } {
  const parsed = PhaseTokenMetadataJsonSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      error: "Invalid artifact metadata schema",
      details: parsed.error.flatten(),
    }
  }
  return { ok: true, data: parsed.data }
}

/**
 * Produces the exact canonical `PhaseTokenMetadataJson` preview that will be
 * committed when saved/published. Throws `VALIDATION_FAILED` on invalid input.
 */
export function previewArtifactMetadata(raw: unknown): PhaseTokenMetadataJson {
  const check = validateArtifactMetadata(raw)
  if (!check.ok) {
    throw new DesignStudioMetadataError(
      "VALIDATION_FAILED",
      check.error,
      check.details,
    )
  }
  return check.data
}

function assertIfMatchMatches(
  existing: ArtifactMetadataDraftRecord | undefined,
  ifMatchRaw?: string | null,
): void {
  const expected = normalizeIfMatchHeader(ifMatchRaw)
  if (!existing) {
    if (expected && expected !== "*" && expected !== "v0" && expected !== "0") {
      throw new DesignStudioMetadataError(
        "STALE_DRAFT",
        `Stale If-Match "${expected}": no existing draft version`,
        { currentVersion: 0, currentEtag: null, providedIfMatch: expected },
      )
    }
    return
  }

  const currentNormalized = normalizeIfMatchHeader(existing.etag)
  if (!expected || (expected !== "*" && expected !== currentNormalized && expected !== String(existing.version))) {
    throw new DesignStudioMetadataError(
      "STALE_DRAFT",
      `Stale draft version: expected ${existing.etag}, got ${expected ?? "(missing)"}`,
      {
        currentVersion: existing.version,
        currentEtag: existing.etag,
        providedIfMatch: expected,
      },
    )
  }
}

export async function getMetadataDraft(
  tokenId: number,
  contractId?: string,
): Promise<ArtifactMetadataDraftRecord | null> {
  if (!isDesignStudioMetadataEnabled()) return null
  const key = makeMetadataDraftKey(tokenId, contractId)
  const store = normalizeStore(
    await readStore<ArtifactMetadataDraftStore>("artifactMetadataDrafts", emptyStore),
  )
  return store.drafts[key] ?? null
}

export async function saveMetadataDraft(input: {
  tokenId: number
  contractId?: string
  metadata: unknown
  ifMatch?: string | null
  updatedBy?: string
  now?: number
}): Promise<ArtifactMetadataDraftRecord> {
  if (!isDesignStudioMetadataEnabled(input.updatedBy)) {
    throw new DesignStudioMetadataError(
      "FLAG_DISABLED",
      "Design Studio metadata editor disabled (phase-258 flag off)",
    )
  }
  const canonical = previewArtifactMetadata(input.metadata)
  const resolvedContract = (input.contractId?.trim() || phaseProtocolContractIdForServer()).toUpperCase()
  const key = makeMetadataDraftKey(input.tokenId, resolvedContract)
  const now = input.now ?? Date.now()

  return updateStoreWithReader<ArtifactMetadataDraftStore, ArtifactMetadataDraftRecord>(
    "artifactMetadataDrafts",
    normalizeStore,
    (store) => {
      const existing = store.drafts[key]
      assertIfMatchMatches(existing, input.ifMatch)
      const nextVersion = (existing?.version ?? 0) + 1
      const record: ArtifactMetadataDraftRecord = {
        key,
        contractId: resolvedContract,
        tokenId: input.tokenId,
        version: nextVersion,
        etag: formatMetadataEtag(nextVersion),
        status: "draft",
        metadata: canonical,
        updatedAt: now,
        committedAt: existing?.committedAt ?? null,
        updatedBy: input.updatedBy?.trim() || existing?.updatedBy || null,
      }
      store.drafts[key] = record
      store.version += 1
      return record
    },
  )
}

export async function commitMetadataDraft(input: {
  tokenId: number
  contractId?: string
  metadata?: unknown
  ifMatch?: string | null
  updatedBy?: string
  now?: number
}): Promise<{ draft: ArtifactMetadataDraftRecord; metadata: PhaseTokenMetadataJson }> {
  if (!isDesignStudioMetadataEnabled(input.updatedBy)) {
    throw new DesignStudioMetadataError(
      "FLAG_DISABLED",
      "Design Studio metadata editor disabled (phase-258 flag off)",
    )
  }
  const resolvedContract = (input.contractId?.trim() || phaseProtocolContractIdForServer()).toUpperCase()
  const key = makeMetadataDraftKey(input.tokenId, resolvedContract)
  const now = input.now ?? Date.now()

  const preValidated =
    input.metadata !== undefined ? previewArtifactMetadata(input.metadata) : null

  return updateStoreWithReader<
    ArtifactMetadataDraftStore,
    { draft: ArtifactMetadataDraftRecord; metadata: PhaseTokenMetadataJson }
  >("artifactMetadataDrafts", normalizeStore, (store) => {
    const existing = store.drafts[key]
    assertIfMatchMatches(existing, input.ifMatch)
    const candidate = preValidated ?? (existing ? previewArtifactMetadata(existing.metadata) : null)
    if (!candidate) {
      throw new DesignStudioMetadataError(
        "VALIDATION_FAILED",
        "Cannot commit empty metadata: provide metadata or save a valid draft first",
      )
    }
    const nextVersion = (existing?.version ?? 0) + 1
    const record: ArtifactMetadataDraftRecord = {
      key,
      contractId: resolvedContract,
      tokenId: input.tokenId,
      version: nextVersion,
      etag: formatMetadataEtag(nextVersion),
      status: "committed",
      metadata: candidate,
      updatedAt: now,
      committedAt: now,
      updatedBy: input.updatedBy?.trim() || existing?.updatedBy || null,
    }
    store.drafts[key] = record
    store.version += 1
    return { draft: record, metadata: candidate }
  })
}

/**
 * Returns committed Design Studio metadata when phase-258 is enabled, or null
 * when flag is off / no committed record exists (rollback = drafts inert).
 */
export async function getCommittedArtifactMetadata(
  tokenId: number,
  contractId?: string,
): Promise<{ metadata: PhaseTokenMetadataJson; etag: string; version: number } | null> {
  if (!isDesignStudioMetadataEnabled()) return null
  const draft = await getMetadataDraft(tokenId, contractId)
  if (!draft || draft.status !== "committed") return null
  const validated = validateArtifactMetadata(draft.metadata)
  if (!validated.ok) return null
  return { metadata: validated.data, etag: draft.etag, version: draft.version }
}
