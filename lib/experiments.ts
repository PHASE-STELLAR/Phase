import { createHash } from "node:crypto"
import { z } from "zod"
import { flagRollbackNote, isFeatureEnabled } from "@/lib/feature-flags"
import { readStore, updateStoreWithReader } from "@/lib/json-store"
import { REQUIRED_AMOUNT } from "@/lib/phase-protocol"

// ── Spike 612 (phase-174): A/B experimentation for forge/chamber copy + pricing ──
//
// Pricing and copy used to be code, not config: changing either meant editing
// the 402 challenge builder, the on-chain verifier floor, the dead-letter
// classifier and the i18n copy at the same time, with no way to measure the
// change. This module assigns a subject (wallet or anonymous session) to a
// weighted variant of an experiment deterministically, sticks that assignment
// across salt rotation and config weight changes, and resolves the forge price
// for the assigned variant. Copy variants are served through a public route so
// client components never touch the sticky store.
//
// Feature flag: phase-174 (NEXT_PUBLIC_FEATURE_PHASE_174 / FEATURE_PHASE_174)
// Rollback: unset the flag → every resolver returns the control value
//           (REQUIRED_AMOUNT price, control copy); the assignment sidecar
//           stays inert on disk. No migration to undo.
//
// Privacy: subjects are stored as sha256(subject) hex only — a raw wallet or
// session id never reaches the sidecar.

export function isExperimentationEnabled(): boolean {
  return isFeatureEnabled("phase-174")
}

export function experimentRollbackNote(): string {
  return flagRollbackNote("phase-174")
}

export const FORGE_PRICE_EXPERIMENT_ID = "forge_price_v1"
export const EXPERIMENT_CONTROL_VARIANT_ID = "control"

const EXPERIMENT_ID_REGEX = /^[a-z0-9][a-z0-9._-]{0,62}[a-z0-9]$/

export const ExperimentVariantSchema = z.object({
  id: z.string().trim().regex(EXPERIMENT_ID_REGEX, "variant id must be 2-64 chars, alphanumeric plus . _ -"),
  weight: z.number().finite().gt(0).max(1_000_000),
  /** Variant price in stroops; null/absent = control price (REQUIRED_AMOUNT). */
  priceStroops: z.string().trim().regex(/^\d{1,19}$/).nullable().optional(),
  /** Copy variant key consumed by pickForgeExperimentCopy; defaults to id. */
  copyKey: z.string().trim().min(1).max(32).optional(),
})

export type ExperimentVariant = z.infer<typeof ExperimentVariantSchema>

export const ExperimentConfigSchema = z
  .object({
    experimentId: z.string().trim().regex(EXPERIMENT_ID_REGEX),
    enabled: z.boolean().default(true),
    salt: z.string().trim().min(1).max(64).optional(),
    holdoutPercent: z.number().finite().min(0).max(90).default(0),
    variants: z.array(ExperimentVariantSchema).min(2).max(8),
  })
  .refine((cfg) => new Set(cfg.variants.map((v) => v.id)).size === cfg.variants.length, {
    message: "Variant ids must be unique within an experiment",
    path: ["variants"],
  })

export type ExperimentConfig = z.infer<typeof ExperimentConfigSchema>

export class ExperimentError extends Error {
  code: "FLAG_DISABLED" | "VALIDATION_FAILED" | "EXPERIMENT_DISABLED"
  details?: unknown
  constructor(code: ExperimentError["code"], message: string, details?: unknown) {
    super(message)
    this.name = "ExperimentError"
    this.code = code
    this.details = details
  }
}

/** Subjects are hashed before storage; bucketing uses the raw subject string. */
export function experimentSubjectKey(subject: string): string {
  return createHash("sha256").update(subject.trim().toUpperCase(), "utf8").digest("hex")
}

/** Deterministic 0..9999 bucket for (salt, experimentId, subject) — FNV-1a, no PRNG state. */
export function experimentBucket(salt: string, experimentId: string, subject: string): number {
  const payload = `${salt}|${experimentId.trim().toLowerCase()}|${subject.trim().toUpperCase()}`
  let h = 0x811c9dc5
  for (let i = 0; i < payload.length; i++) {
    h = Math.imul(h ^ payload.charCodeAt(i), 0x01000193)
  }
  return (h >>> 0) % 10_000
}

function defaultSalt(): string {
  // Env override supports salt rotation without a deploy; sticky assignments
  // in the sidecar keep existing subjects on their original variant.
  return process.env.PHASE_EXPERIMENT_SALT?.trim() || "phase-exp-salt-v1"
}

/** Parses a raw experiment config; throws ExperimentError on bad input. */
export function parseExperimentConfig(raw: unknown): ExperimentConfig {
  const parsed = ExperimentConfigSchema.safeParse(raw)
  if (!parsed.success) {
    throw new ExperimentError("VALIDATION_FAILED", "Invalid experiment config", parsed.error.flatten())
  }
  return parsed.data
}

/**
 * Loads the forge price experiment config from PHASE_EXPERIMENT_CONFIG (JSON).
 * Returns null when unset, unparseable, or the requested experiment is absent —
 * every caller fails safe to control.
 */
export function loadForgeExperimentConfig(): ExperimentConfig | null {
  const raw = process.env.PHASE_EXPERIMENT_CONFIG?.trim()
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const list = Array.isArray(parsed) ? parsed : [parsed]
  for (const entry of list) {
    const safe = ExperimentConfigSchema.safeParse(entry)
    if (safe.success && safe.data.experimentId === FORGE_PRICE_EXPERIMENT_ID) return safe.data
  }
  return null
}

export type ExperimentAssignment = {
  experimentId: string
  subjectKey: string
  bucket: number
  holdout: boolean
  variantId: string
  copyKey: string
  priceStroops: string | null
  sticky: boolean
}

type StoredSubjectAssignment = {
  bucket: number
  holdout: boolean
  variantId: string
  copyKey: string
  priceStroops: string | null
  assignedAt: number
}

type ExperimentAssignmentsStore = {
  version: number
  experiments: Record<string, { salt: string; subjects: Record<string, StoredSubjectAssignment> }>
}

function emptyStore(): ExperimentAssignmentsStore {
  return { version: 1, experiments: {} }
}

function normalizeStore(raw: unknown): ExperimentAssignmentsStore {
  const s = raw as ExperimentAssignmentsStore | undefined
  if (!s || typeof s !== "object" || !s.experiments || typeof s.experiments !== "object") return emptyStore()
  return { version: typeof s.version === "number" && s.version > 0 ? s.version : 1, experiments: s.experiments }
}

function assignmentFromStored(experimentId: string, subjectKey: string, stored: StoredSubjectAssignment): ExperimentAssignment {
  return {
    experimentId,
    subjectKey,
    bucket: stored.bucket,
    holdout: stored.holdout,
    variantId: stored.variantId,
    copyKey: stored.copyKey,
    priceStroops: stored.priceStroops,
    sticky: true,
  }
}

function computeFreshAssignment(
  config: ExperimentConfig,
  salt: string,
  subject: string,
  subjectKey: string,
): ExperimentAssignment {
  const bucket = experimentBucket(salt, config.experimentId, subject)
  const holdoutCutoff = Math.round(config.holdoutPercent * 100)
  if (bucket < holdoutCutoff) {
    return {
      experimentId: config.experimentId,
      subjectKey,
      bucket,
      holdout: true,
      variantId: EXPERIMENT_CONTROL_VARIANT_ID,
      copyKey: EXPERIMENT_CONTROL_VARIANT_ID,
      priceStroops: null,
      sticky: false,
    }
  }
  const totalWeight = config.variants.reduce((sum, v) => sum + v.weight, 0)
  const span = 10_000 - holdoutCutoff
  const scaled = ((bucket - holdoutCutoff) / span) * totalWeight
  let cursor = 0
  let chosen: ExperimentVariant = config.variants[config.variants.length - 1]!
  for (const variant of config.variants) {
    cursor += variant.weight
    if (scaled < cursor) {
      chosen = variant
      break
    }
  }
  return {
    experimentId: config.experimentId,
    subjectKey,
    bucket,
    holdout: false,
    variantId: chosen.id,
    copyKey: chosen.copyKey ?? chosen.id,
    priceStroops: chosen.priceStroops ?? null,
    sticky: false,
  }
}

/**
 * Assigns a subject to a weighted variant (or holdout) of the experiment and
 * persists the assignment so it stays sticky across salt rotation, weight
 * changes and the anonymous→authed upgrade. Flag off → control, no store I/O.
 */
export async function assignExperimentVariant(
  config: ExperimentConfig,
  subject: string,
  opts: { force?: boolean; now?: number } = {},
): Promise<ExperimentAssignment> {
  const cleanSubject = subject.trim()
  if (!cleanSubject) {
    throw new ExperimentError("VALIDATION_FAILED", "subject is required for variant assignment")
  }
  if (!opts.force && !isExperimentationEnabled()) {
    throw new ExperimentError("FLAG_DISABLED", "Experimentation disabled (phase-174 flag off)", {
      rollback: experimentRollbackNote(),
    })
  }
  if (!config.enabled) {
    throw new ExperimentError("EXPERIMENT_DISABLED", `Experiment "${config.experimentId}" is disabled`)
  }
  const subjectKey = experimentSubjectKey(cleanSubject)
  const now = opts.now ?? Date.now()
  const currentSalt = config.salt?.trim() || defaultSalt()

  return updateStoreWithReader<ExperimentAssignmentsStore, ExperimentAssignment>(
    "experimentAssignments",
    normalizeStore,
    (store) => {
      const entry = store.experiments[config.experimentId] ?? { salt: currentSalt, subjects: {} }
      const existing = entry.subjects[subjectKey]
      if (existing) {
        store.experiments[config.experimentId] = entry
        store.version += 1
        return assignmentFromStored(config.experimentId, subjectKey, existing)
      }
      const fresh = computeFreshAssignment(config, currentSalt, cleanSubject, subjectKey)
      entry.salt = currentSalt
      entry.subjects[subjectKey] = {
        bucket: fresh.bucket,
        holdout: fresh.holdout,
        variantId: fresh.variantId,
        copyKey: fresh.copyKey,
        priceStroops: fresh.priceStroops,
        assignedAt: now,
      }
      store.experiments[config.experimentId] = entry
      store.version += 1
      return fresh
    },
  )
}

/** Per-variant assignment counts for a persisted experiment — no subject data. */
export async function getExperimentSummary(experimentId: string): Promise<{
  experimentId: string
  totalAssignments: number
  byVariant: Record<string, number>
  holdout: number
}> {
  const store = await readStore<ExperimentAssignmentsStore>("experimentAssignments", emptyStore)
  const normalized = normalizeStore(store)
  const entry = normalized.experiments[experimentId]
  const byVariant: Record<string, number> = {}
  let holdout = 0
  let totalAssignments = 0
  if (entry) {
    for (const subject of Object.values(entry.subjects)) {
      totalAssignments += 1
      if (subject.holdout) holdout += 1
      else byVariant[subject.variantId] = (byVariant[subject.variantId] ?? 0) + 1
    }
  }
  return { experimentId, totalAssignments, byVariant, holdout }
}

export type ForgePriceResolution = {
  experimentId: string
  variantId: string
  amountStroops: string
  holdout: boolean
}

/**
 * Resolves the forge price for a subject. Flag off, no config, no subject,
 * holdout, or control variant → REQUIRED_AMOUNT. Everything else fails safe to
 * control on any error path: a pricing experiment must never make the forge
 * unpayable or accidentally free.
 */
export async function resolveForgeRequiredAmountStroops(subject?: string): Promise<ForgePriceResolution> {
  const control = (): ForgePriceResolution => ({
    experimentId: FORGE_PRICE_EXPERIMENT_ID,
    variantId: EXPERIMENT_CONTROL_VARIANT_ID,
    amountStroops: REQUIRED_AMOUNT,
    holdout: false,
  })
  if (!isExperimentationEnabled()) return control()
  const config = loadForgeExperimentConfig()
  if (!config || !config.enabled) return control()
  const cleanSubject = subject?.trim()
  if (!cleanSubject) return control()
  try {
    const assignment = await assignExperimentVariant(config, cleanSubject)
    if (assignment.holdout) return { ...control(), holdout: true }
    if (assignment.variantId === EXPERIMENT_CONTROL_VARIANT_ID) return control()
    const price = assignment.priceStroops
    if (!price || !/^\d{1,19}$/.test(price) || BigInt(price) <= 0n) return control()
    return {
      experimentId: config.experimentId,
      variantId: assignment.variantId,
      amountStroops: price,
      holdout: assignment.holdout,
    }
  } catch {
    return control()
  }
}

/** Copy variant id for a subject; control when flag off or unassigned. */
export async function resolveForgeExperimentCopyKey(subject?: string): Promise<string> {
  if (!isExperimentationEnabled()) return EXPERIMENT_CONTROL_VARIANT_ID
  const config = loadForgeExperimentConfig()
  if (!config || !config.enabled) return EXPERIMENT_CONTROL_VARIANT_ID
  const cleanSubject = subject?.trim()
  if (!cleanSubject) return EXPERIMENT_CONTROL_VARIANT_ID
  try {
    const assignment = await assignExperimentVariant(config, cleanSubject)
    return assignment.holdout ? EXPERIMENT_CONTROL_VARIANT_ID : assignment.copyKey
  } catch {
    return EXPERIMENT_CONTROL_VARIANT_ID
  }
}
