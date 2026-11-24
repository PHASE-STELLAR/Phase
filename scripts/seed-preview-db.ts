/**
 * Seeds a branch-scoped database for a Vercel preview environment (phase-228).
 *
 * Uses `resolvePreviewId` from lib/preview-isolation to derive the same
 * per-PR subdirectory that the running preview app will use, then writes
 * the preview contract ID and a "preview" Stellar network marker so the
 * preview starts with consistent initial state rather than an empty DB.
 *
 * Required env:
 *   NEXT_PUBLIC_PHASE_PREVIEW_CONTRACT_ID — the contract deployed by deploy-preview-contract.ts
 *   PR_NUMBER or GIT_BRANCH              — used by resolvePreviewId
 *
 * Optional:
 *   PREVIEW_DB_PATH   — override the SQLite path (useful in local testing)
 */

import { config } from "dotenv"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"
import { mkdirSync } from "fs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, "..")

config({ path: resolve(ROOT, ".env.local") })

// Simulate Vercel env for resolvePreviewId
process.env.VERCEL_ENV = "preview"
if (process.env.PR_NUMBER) {
  process.env.VERCEL_GIT_PULL_REQUEST_ID = process.env.PR_NUMBER
} else if (process.env.GIT_BRANCH) {
  process.env.VERCEL_GIT_COMMIT_REF = process.env.GIT_BRANCH
}

const { resolvePreviewId } = await import("../lib/preview-isolation.js")

const previewId = resolvePreviewId()
const contractId = process.env.NEXT_PUBLIC_PHASE_PREVIEW_CONTRACT_ID?.trim()

if (!contractId) {
  console.error("[seed-preview-db] NEXT_PUBLIC_PHASE_PREVIEW_CONTRACT_ID is required")
  process.exit(1)
}

if (!previewId) {
  console.warn("[seed-preview-db] No preview ID resolved — skipping DB seed")
  process.exit(0)
}

const dataRoot = process.env.PREVIEW_DB_PATH || resolve(ROOT, ".preview-data")
const dbDir = resolve(dataRoot, "previews", previewId)
mkdirSync(dbDir, { recursive: true })

// Write a JSON seed file so the preview app can bootstrap its DB without
// needing to query the chain on cold start.
const seedPath = resolve(dbDir, "seed.json")
const seed = {
  schemaVersion: 1,
  previewId,
  contractId,
  network: "testnet",
  seededAt: new Date().toISOString(),
}

import { writeFileSync } from "fs"
writeFileSync(seedPath, JSON.stringify(seed, null, 2))
console.log(`[seed-preview-db] wrote ${seedPath}`)
console.log(`[seed-preview-db] preview_id=${previewId} contract_id=${contractId}`)
