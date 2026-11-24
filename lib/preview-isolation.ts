/**
 * Vercel preview-environment isolation — partial slice of spike 603 (issue #467).
 *
 * The only staging lane was `deploy-staging` on push to main. A preview that
 * simply inherits project env would share the data root, the issuer, the cron
 * secret and the contract IDs with production: it could mint real liability,
 * and N previews running the hourly refill cron would drain one issuer.
 *
 * This module turns "is this deploy a preview, and which one" into a pure
 * function of env, namespaces the data root per preview, and fails validation
 * when a preview points at production credentials or contracts.
 *
 * Production identity is declared by public/hashed fingerprints only, so the
 * check never needs a production secret in a preview environment:
 * - `PHASE_PROD_ISSUER`                 public key (G...) of the production issuer
 * - `PHASE_PROD_CRON_SECRET_SHA256`     sha256 hex of the production `CRON_SECRET`
 * - `PHASE_PROD_CONTRACT_IDS`           comma-separated production contract IDs
 *
 * Scope: id resolution, data-root namespacing, isolation checks, cron gating.
 * Per-PR contract deploy, a preview deploy CI job and branch-database seeding
 * are spike 603 follow-ups (see docs/spikes/603-preview-isolation-findings.md).
 * `/tmp` on Vercel is still ephemeral per instance, so a namespaced root
 * prevents cross-preview bleed, not loss between instances.
 *
 * Feature flag: phase-173. Rollback: unset → data root, cron auth and env
 * validation behave exactly as before; per-preview directories stay inert.
 */

import { Keypair, StrKey, hash } from "@stellar/stellar-sdk"
import { isFeatureEnabled } from "@/lib/feature-flags"

type Env = Record<string, string | undefined>

export type PreviewIsolationViolation = {
  variable: string
  code:
    | "issuer_matches_production"
    | "cron_secret_matches_production"
    | "contract_matches_production"
    | "mainnet_in_preview"
  message: string
  hint: string
}

export function isPreviewIsolationEnabled(): boolean {
  return isFeatureEnabled("phase-173")
}

export function previewIsolationRollbackNote(): string {
  return "Rollback phase-173: unset NEXT_PUBLIC_FEATURE_PHASE_173 / FEATURE_PHASE_173 or set to 0/false and restart. Per-preview data directories stay on disk, inert."
}

export function isPreviewDeployment(env: Env = process.env): boolean {
  return env.VERCEL_ENV?.trim().toLowerCase() === "preview"
}

// `lib/env-validation.ts` reaches client bundles through `phase-protocol.ts`, so
// this module must stay free of `node:*` imports; the SDK's sha256 is isomorphic.
function sha256Hex(input: string): string {
  return hash(Buffer.from(input, "utf8")).toString("hex")
}

function slug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
}

/**
 * Stable per-preview id: `pr-<number>` when Vercel provides the PR id, else a
 * slug of the branch plus a short hash (so `feat/a-b` and `feat/a/b` differ).
 * `null` outside previews. Always a safe single path segment.
 */
export function resolvePreviewId(env: Env = process.env): string | null {
  if (!isPreviewDeployment(env)) return null
  const pr = env.VERCEL_GIT_PULL_REQUEST_ID?.trim()
  if (pr && /^\d{1,9}$/.test(pr)) return `pr-${pr}`
  const ref = env.VERCEL_GIT_COMMIT_REF?.trim()
  if (ref) {
    return `br-${slug(ref) || "branch"}-${sha256Hex(ref).slice(0, 8)}`
  }
  return "preview-unknown"
}

/** Subpath appended to the data root, or `null` when isolation does not apply. */
export function previewDataSubdir(env: Env = process.env): string | null {
  if (!isPreviewIsolationEnabled()) return null
  const id = resolvePreviewId(env)
  return id ? `previews/${id}` : null
}

function listFrom(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
}

function issuerFromEnv(env: Env): string | null {
  const publicKey = (env.NEXT_PUBLIC_CLASSIC_LIQ_ISSUER ?? "").trim()
  if (publicKey && StrKey.isValidEd25519PublicKey(publicKey)) return publicKey
  const secret = (env.CLASSIC_LIQ_ISSUER_SECRET ?? "").trim()
  if (secret && StrKey.isValidEd25519SecretSeed(secret)) {
    try {
      return Keypair.fromSecret(secret).publicKey()
    } catch {
      return null
    }
  }
  return null
}

/**
 * Violations that make a preview unsafe. Empty outside previews and when the
 * flag is off. Never includes a secret value in a message.
 */
export function checkPreviewIsolation(env: Env = process.env): PreviewIsolationViolation[] {
  if (!isPreviewIsolationEnabled() || !isPreviewDeployment(env)) return []
  const violations: PreviewIsolationViolation[] = []

  const prodIssuer = env.PHASE_PROD_ISSUER?.trim()
  const issuer = issuerFromEnv(env)
  if (prodIssuer && issuer && issuer === prodIssuer) {
    violations.push({
      variable: "CLASSIC_LIQ_ISSUER_SECRET",
      code: "issuer_matches_production",
      message: "Preview resolves to the production issuer account.",
      hint: "Give previews a dedicated testnet issuer; a preview minting from the production issuer creates real liability.",
    })
  }

  const prodCronHash = env.PHASE_PROD_CRON_SECRET_SHA256?.trim().toLowerCase()
  const cronSecret = env.CRON_SECRET?.trim()
  if (prodCronHash && cronSecret && sha256Hex(cronSecret) === prodCronHash) {
    violations.push({
      variable: "CRON_SECRET",
      code: "cron_secret_matches_production",
      message: "Preview CRON_SECRET equals the production cron secret.",
      hint: "Use a preview-scoped CRON_SECRET so a preview cannot be driven with the production credential.",
    })
  }

  const prodContracts = new Set(listFrom(env.PHASE_PROD_CONTRACT_IDS))
  if (prodContracts.size > 0) {
    for (const [variable, value] of Object.entries(env)) {
      if (variable.startsWith("PHASE_PROD_") || !/CONTRACT|PROTOCOL_ID|TOKEN_ID/.test(variable) || !value) continue
      if (prodContracts.has(value.trim())) {
        violations.push({
          variable,
          code: "contract_matches_production",
          message: `${variable} points at a production contract.`,
          hint: "Deploy a per-preview contract (scripts/deploy-phase-sep50.ts) and set the ID for this preview only.",
        })
      }
    }
  }

  if (env.STELLAR_NETWORK?.trim().toLowerCase() === "mainnet") {
    violations.push({
      variable: "STELLAR_NETWORK",
      code: "mainnet_in_preview",
      message: "Previews must run on testnet.",
      hint: "Unset STELLAR_NETWORK or set it to testnet for the preview environment.",
    })
  }

  return violations
}

/**
 * Previews do not run scheduled jobs unless explicitly enabled, so N previews
 * cannot each run the hourly refill against one issuer.
 */
export function isCronBlockedInPreview(env: Env = process.env): boolean {
  if (!isPreviewIsolationEnabled() || !isPreviewDeployment(env)) return false
  return env.PHASE_PREVIEW_CRON_ENABLED?.trim() !== "1"
}

/**
 * `x-vercel-cron` is a plain header any caller can send. In a preview, a bearer
 * `CRON_SECRET` is always required.
 */
export function previewTrustsVercelCronHeader(env: Env = process.env): boolean {
  return !(isPreviewIsolationEnabled() && isPreviewDeployment(env))
}
