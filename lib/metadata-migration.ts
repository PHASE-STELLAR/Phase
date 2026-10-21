/**
 * Metadata version migration tool — phase-124
 *
 * Handles schema changes for off-chain JSON metadata kept in `.data/` and
 * public/static metadata. Old formats become incompatible on upgrade; this
 * module provides versioned schemas, validation, and safe migration.
 *
 * Feature flag: phase-124 (NEXT_PUBLIC_FEATURE_PHASE_124 / FEATURE_PHASE_124)
 * Rollback: disable flag and restart; v2 payloads remain readable by v1 consumers
 *           where fields are additive. No destructive rewrite without --apply.
 *
 * Usage (scripts):
 *   import { migrateMetadataPayload, CURRENT_METADATA_VERSION } from "@/lib/metadata-migration"
 *   const result = migrateMetadataPayload(raw, { dryRun: true })
 */

import { z } from "zod"
import { isFeatureEnabled } from "@/lib/feature-flags"

// ── Versioning ──────────────────────────────────────────────────────────

export const CURRENT_METADATA_VERSION = 2 as const
export type MetadataVersion = 1 | 2

export const MetadataVersionSchema = z.union([z.literal(1), z.literal(2)])

// ── Schemas ─────────────────────────────────────────────────────────────

export const NftMetadataV1Schema = z.object({
  version: z.literal(1).optional(),
  name: z.string().min(1).max(256),
  description: z.string().max(2048).optional().default(""),
  image: z.string().max(1024).optional().default(""),
  attributes: z
    .array(z.object({ trait_type: z.string(), value: z.union([z.string(), z.number()]) }))
    .optional()
    .default([]),
})

export const NftMetadataV2Schema = z.object({
  version: z.literal(2),
  name: z.string().min(1).max(256),
  description: z.string().max(2048),
  image: z.string().max(1024),
  external_url: z.string().url().or(z.string().length(0)).optional().default(""),
  attributes: z.array(
    z.object({
      trait_type: z.string().min(1).max(64),
      value: z.union([z.string(), z.number()]),
      display_type: z.enum(["number", "date", "boost_percentage"]).optional(),
    }),
  ),
  collectionId: z.number().int().min(0).nullable().default(null),
  migratedAt: z.string().datetime().optional(),
  migratedFrom: z.union([z.literal(1), z.literal(2)]).optional(),
})

export type NftMetadataV1 = z.infer<typeof NftMetadataV1Schema>
export type NftMetadataV2 = z.infer<typeof NftMetadataV2Schema>

// Alias for current
export const CurrentMetadataSchema = NftMetadataV2Schema
export type CurrentMetadata = NftMetadataV2

// ── Structured errors ───────────────────────────────────────────────────

export type MigrationErrorCode =
  | "VALIDATION_FAILED"
  | "UNSUPPORTED_VERSION"
  | "MIGRATION_FAILED"
  | "FLAG_DISABLED"

export class MetadataMigrationError extends Error {
  code: MigrationErrorCode
  details?: unknown
  constructor(code: MigrationErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = "MetadataMigrationError"
    this.code = code
    this.details = details
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function detectVersion(raw: unknown): MetadataVersion | null {
  if (raw && typeof raw === "object" && "version" in raw) {
    const v = (raw as { version?: unknown }).version
    if (v === 1 || v === 2) return v
    if (v === "1" || v === "2") return Number(v) as MetadataVersion
  }
  // No version field → treat as v1 (legacy)
  if (raw && typeof raw === "object" && "name" in raw) return 1
  return null
}

function migrateV1ToV2(v1: NftMetadataV1, opts?: { baseUrl?: string }): NftMetadataV2 {
  const normalizedAttrs = (v1.attributes ?? []).map((a) => ({
    trait_type: String(a.trait_type).trim().slice(0, 64) || "unknown",
    value: a.value,
  }))
  return {
    version: 2,
    name: v1.name.trim(),
    description: (v1.description ?? "").trim(),
    image: (v1.image ?? "").trim(),
    external_url: opts?.baseUrl ?? "",
    attributes: normalizedAttrs as NftMetadataV2["attributes"],
    collectionId: null,
    migratedAt: new Date().toISOString(),
    migratedFrom: 1,
  }
}

// ── Public API ──────────────────────────────────────────────────────────

export type MigrateOptions = {
  dryRun?: boolean
  baseUrl?: string
  strict?: boolean
  /** Override flag check (useful in tests / scripts with explicit opt-in) */
  force?: boolean
}

export type MigrateResult =
  | { ok: true; version: MetadataVersion; data: CurrentMetadata; migrated: boolean; fromVersion: MetadataVersion }
  | { ok: false; error: MetadataMigrationError }

export function migrateMetadataPayload(raw: unknown, opts: MigrateOptions = {}): MigrateResult {
  const flagEnabled = opts.force || isFeatureEnabled("phase-124")
  if (!flagEnabled) {
    return {
      ok: false,
      error: new MetadataMigrationError("FLAG_DISABLED", "Metadata migration is disabled (phase-124 flag off). Enable NEXT_PUBLIC_FEATURE_PHASE_124=1 to use."),
    }
  }

  const detected = detectVersion(raw)
  if (detected == null) {
    return {
      ok: false,
      error: new MetadataMigrationError("UNSUPPORTED_VERSION", "Cannot detect metadata version; payload missing `name` or `version`.", {
        raw: raw !== null && typeof raw === "object" ? Object.keys(raw as object) : typeof raw,
      }),
    }
  }

  try {
    if (detected === 2) {
      const parsed = NftMetadataV2Schema.safeParse(raw)
      if (!parsed.success) {
        if (opts.strict) {
          return { ok: false, error: new MetadataMigrationError("VALIDATION_FAILED", parsed.error.message, parsed.error.flatten()) }
        }
        // Attempt to recover by migrating through v1 shape
        const v1Fallback = NftMetadataV1Schema.safeParse(raw)
        if (!v1Fallback.success) {
          return { ok: false, error: new MetadataMigrationError("VALIDATION_FAILED", parsed.error.message, parsed.error.flatten()) }
        }
        const v2 = migrateV1ToV2(v1Fallback.data, { baseUrl: opts.baseUrl })
        return { ok: true, version: 2, data: v2, migrated: true, fromVersion: 1 }
      }
      return { ok: true, version: 2, data: parsed.data, migrated: false, fromVersion: 2 }
    }

    // v1 → v2
    const parsedV1 = NftMetadataV1Schema.safeParse(raw)
    if (!parsedV1.success) {
      return { ok: false, error: new MetadataMigrationError("VALIDATION_FAILED", parsedV1.error.message, parsedV1.error.flatten()) }
    }
    const migrated = migrateV1ToV2(parsedV1.data, { baseUrl: opts.baseUrl })
    const final = NftMetadataV2Schema.safeParse(migrated)
    if (!final.success) {
      return { ok: false, error: new MetadataMigrationError("MIGRATION_FAILED", final.error.message, final.error.flatten()) }
    }
    if (opts.dryRun) {
      // Do not mutate caller's storage; just report what would happen
      return { ok: true, version: 2, data: final.data, migrated: true, fromVersion: 1 }
    }
    return { ok: true, version: 2, data: final.data, migrated: true, fromVersion: 1 }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: new MetadataMigrationError("MIGRATION_FAILED", msg, e) }
  }
}

export function validateCurrentMetadata(raw: unknown): { ok: true; data: CurrentMetadata } | { ok: false; error: z.ZodError } {
  const parsed = CurrentMetadataSchema.safeParse(raw)
  if (parsed.success) return { ok: true, data: parsed.data }
  return { ok: false, error: parsed.error }
}

export function isCurrentVersion(raw: unknown): boolean {
  return detectVersion(raw) === CURRENT_METADATA_VERSION && validateCurrentMetadata(raw).ok
}

// ── Batch/file helpers (for scripts) ────────────────────────────────────

export type BatchMigrateReport = {
  total: number
  migrated: number
  alreadyCurrent: number
  failed: number
  failures: Array<{ index: number; error: string; code: MigrationErrorCode }>
  results: CurrentMetadata[]
}

export function batchMigrateMetadataPayloads(payloads: unknown[], opts: MigrateOptions = {}): BatchMigrateReport {
  const report: BatchMigrateReport = { total: payloads.length, migrated: 0, alreadyCurrent: 0, failed: 0, failures: [], results: [] }
  payloads.forEach((raw, i) => {
    const res = migrateMetadataPayload(raw, opts)
    if (!res.ok) {
      report.failed++
      report.failures.push({ index: i, error: res.error.message, code: res.error.code })
      return
    }
    report.results.push(res.data)
    if (res.migrated) report.migrated++
    else report.alreadyCurrent++
  })
  return report
}

/** Convenience for scripts: migrate a single JSON file's parsed content. */
export function migrateMetadataFileContent(fileContent: string, opts: MigrateOptions = {}): MigrateResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(fileContent)
  } catch (e) {
    return { ok: false, error: new MetadataMigrationError("VALIDATION_FAILED", `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`) }
  }
  if (Array.isArray(parsed)) {
    // If file is an array, migrate each element and return first as representative; callers should use batch helper.
    const report = batchMigrateMetadataPayloads(parsed, opts)
    if (report.failed > 0) {
      return { ok: false, error: new MetadataMigrationError("MIGRATION_FAILED", `${report.failed}/${report.total} items failed`, report.failures) }
    }
    // Return aggregate success: version 2 shape with embedded results
    const first = report.results[0]
    if (!first) return { ok: false, error: new MetadataMigrationError("VALIDATION_FAILED", "Empty array") }
    return { ok: true, version: 2, data: first, migrated: report.migrated > 0, fromVersion: report.migrated > 0 ? 1 : 2 }
  }
  return migrateMetadataPayload(parsed, opts)
}
