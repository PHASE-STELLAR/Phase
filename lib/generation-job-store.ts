/**
 * Persistent generation job store for async Nano Banana image generation.
 *
 * Jobs are keyed by settlement transaction hash (txHash) so the client can poll
 * by the payment proof it already holds. Each job records the full pipeline
 * state from submission through to webhook completion or failure.
 *
 * Dead-letter queue (DLQ): failed webhook callbacks and generation errors are
 * appended to a separate sidecar for operator review and retry.
 *
 * Storage: .data/generation-jobs.json and .data/generation-dlq.json
 * (falls back to /tmp on Vercel where project dir is read-only).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { serverDataJsonPath } from "@/lib/server-data-paths"

// ─── Types ────────────────────────────────────────────────────────────────────

export type GenerationJobStatus =
  | "pending"          // job created, NanoBanana task submitted
  | "processing"       // NanoBanana is working (webhook not yet received)
  | "webhook_received" // webhook delivered — pipeline continuing (IPFS, mint)
  | "completed"        // full pipeline succeeded
  | "failed"           // terminal failure

export type GenerationJob = {
  /** Unique job id (UUID) */
  id: string
  /** NanoBanana taskId returned at submission */
  taskId: string
  /** Settlement tx hash — primary lookup key */
  txHash: string
  /** Payer wallet address */
  payerAddress?: string
  /** User prompt */
  prompt: string
  /** Image style mode forwarded from forge UI */
  imageStyleMode?: string
  /** Collection id (optional) */
  collectionId?: number
  /** Output language */
  lang?: string
  status: GenerationJobStatus
  /** Resolved image URL (NanoBanana CDN URL) */
  imageUrl?: string
  /** Full pipeline result (available when status === 'completed') */
  result?: {
    imageUrl: string
    image_url: string
    lore: string
    metadataStandard: string
    image_source: string
    metadataUri?: string
    cid?: string | null
  }
  /** Human-readable error detail */
  error?: string
  /** ISO timestamp of last webhook delivery attempt */
  lastWebhookAt?: number
  /** Number of webhook callback deliveries received */
  webhookDeliveries: number
  createdAt: number
  updatedAt: number
}

export type GenerationDlqEntry = {
  id: string
  jobId?: string
  txHash?: string
  taskId?: string
  source: string
  receivedAt: number
  errorType: "webhook_sig_invalid" | "webhook_parse_error" | "pipeline_failed" | "unknown"
  errorMessage: string
  rawPayload?: unknown
}

// ─── Store I/O ────────────────────────────────────────────────────────────────

type JobStore = Record<string, GenerationJob>
type DlqStore = Record<string, GenerationDlqEntry>

/**
 * Serialises every read→modify→write cycle on the JSON sidecars.
 *
 * Without it, two overlapping `createGenerationJob` calls each read the same
 * snapshot and the second write drops the first job's entry — the read→push→write
 * TOCTOU that loses jobs under concurrent webhook/traffic bursts (#243). The
 * queue is drained in FIFO order, so callers still observe the stored value.
 */
let writeQueue: Promise<unknown> = Promise.resolve()

function withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(fn, fn)
  writeQueue = run.catch(() => {})
  return run
}

async function readJobStore(): Promise<JobStore> {
  try {
    const raw = await readFile(serverDataJsonPath("generationJobs"), "utf8")
    const parsed = JSON.parse(raw) as JobStore
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

async function writeJobStore(data: JobStore): Promise<void> {
  const filePath = serverDataJsonPath("generationJobs")
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf8")
}

async function readDlqStore(): Promise<DlqStore> {
  try {
    const raw = await readFile(serverDataJsonPath("generationDlq"), "utf8")
    const parsed = JSON.parse(raw) as DlqStore
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

async function writeDlqStore(data: DlqStore): Promise<void> {
  const filePath = serverDataJsonPath("generationDlq")
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf8")
}

// ─── Pruning ──────────────────────────────────────────────────────────────────

/** TTL for completed/failed jobs: 4 hours. Pending jobs kept longer (24h). */
const COMPLETED_TTL_MS = 4 * 60 * 60 * 1000
const PENDING_TTL_MS = 24 * 60 * 60 * 1000
const DLQ_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

function pruneJobs(store: JobStore): JobStore {
  const now = Date.now()
  const out: JobStore = {}
  for (const [k, job] of Object.entries(store)) {
    const ttl =
      job.status === "completed" || job.status === "failed"
        ? COMPLETED_TTL_MS
        : PENDING_TTL_MS
    if (now - job.updatedAt < ttl) out[k] = job
  }
  return out
}

function pruneDlq(store: DlqStore): DlqStore {
  const now = Date.now()
  const out: DlqStore = {}
  for (const [k, entry] of Object.entries(store)) {
    if (now - entry.receivedAt < DLQ_TTL_MS) out[k] = entry
  }
  return out
}

// ─── Job CRUD ─────────────────────────────────────────────────────────────────

export type CreateJobInput = {
  taskId: string
  txHash: string
  prompt: string
  payerAddress?: string
  imageStyleMode?: string
  collectionId?: number
  lang?: string
}

/**
 * Creates a new generation job keyed by txHash.
 * If a job for txHash already exists, returns it without creating a duplicate.
 */
export async function createGenerationJob(input: CreateJobInput): Promise<GenerationJob> {
  return withStoreLock(async () => {
    const store = pruneJobs(await readJobStore())

    // Idempotent: if already tracked, return existing
    const existing = Object.values(store).find((j) => j.txHash === input.txHash)
    if (existing) return existing

    const job: GenerationJob = {
      id: randomUUID(),
      taskId: input.taskId,
      txHash: input.txHash,
      prompt: input.prompt,
      payerAddress: input.payerAddress,
      imageStyleMode: input.imageStyleMode,
      collectionId: input.collectionId,
      lang: input.lang,
      status: "pending",
      webhookDeliveries: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    store[job.id] = job
    await writeJobStore(store)
    return job
  })
}

/**
 * Returns the generation job for a given txHash, or null if not found.
 */
export async function getGenerationJobByTxHash(txHash: string): Promise<GenerationJob | null> {
  const store = pruneJobs(await readJobStore())
  return Object.values(store).find((j) => j.txHash === txHash) ?? null
}

/**
 * Returns the generation job for a given NanoBanana taskId, or null.
 */
export async function getGenerationJobByTaskId(taskId: string): Promise<GenerationJob | null> {
  const store = pruneJobs(await readJobStore())
  return Object.values(store).find((j) => j.taskId === taskId) ?? null
}

/**
 * Returns a job by its UUID id.
 */
export async function getGenerationJobById(id: string): Promise<GenerationJob | null> {
  const store = pruneJobs(await readJobStore())
  return store[id] ?? null
}

export type UpdateJobInput = Partial<
  Pick<
    GenerationJob,
    | "status"
    | "imageUrl"
    | "result"
    | "error"
    | "lastWebhookAt"
    | "webhookDeliveries"
    | "taskId"
  >
>

/**
 * Applies a partial update to a job (found by UUID id). Returns the updated job.
 */
export async function updateGenerationJob(
  id: string,
  patch: UpdateJobInput,
): Promise<GenerationJob | null> {
  return withStoreLock(async () => {
    const store = pruneJobs(await readJobStore())
    const job = store[id]
    if (!job) return null
    const updated: GenerationJob = { ...job, ...patch, updatedAt: Date.now() }
    store[id] = updated
    await writeJobStore(store)
    return updated
  })
}

/**
 * Applies a partial update finding the job by txHash.
 */
export async function updateGenerationJobByTxHash(
  txHash: string,
  patch: UpdateJobInput,
): Promise<GenerationJob | null> {
  return withStoreLock(async () => {
    const store = pruneJobs(await readJobStore())
    const entry = Object.entries(store).find(([, j]) => j.txHash === txHash)
    if (!entry) return null
    const [id, job] = entry
    const updated: GenerationJob = { ...job, ...patch, updatedAt: Date.now() }
    store[id] = updated
    await writeJobStore(store)
    return updated
  })
}

/**
 * Applies a partial update finding the job by NanoBanana taskId.
 */
export async function updateGenerationJobByTaskId(
  taskId: string,
  patch: UpdateJobInput,
): Promise<GenerationJob | null> {
  return withStoreLock(async () => {
    const store = pruneJobs(await readJobStore())
    const entry = Object.entries(store).find(([, j]) => j.taskId === taskId)
    if (!entry) return null
    const [id, job] = entry
    const updated: GenerationJob = { ...job, ...patch, updatedAt: Date.now() }
    store[id] = updated
    await writeJobStore(store)
    return updated
  })
}

/**
 * Lists all active generation jobs, sorted newest first.
 */
export async function listGenerationJobs(opts: { limit?: number } = {}): Promise<GenerationJob[]> {
  const store = pruneJobs(await readJobStore())
  const items = Object.values(store).sort((a, b) => b.createdAt - a.createdAt)
  return typeof opts.limit === "number" ? items.slice(0, opts.limit) : items
}

// ─── Dead-Letter Queue ────────────────────────────────────────────────────────

export type AppendDlqInput = {
  jobId?: string
  txHash?: string
  taskId?: string
  source: string
  errorType: GenerationDlqEntry["errorType"]
  errorMessage: string
  rawPayload?: unknown
}

/**
 * Appends a failed callback or pipeline error to the dead-letter queue.
 * Never throws — caller can fire-and-forget.
 */
export async function appendGenerationDlq(input: AppendDlqInput): Promise<GenerationDlqEntry> {
  let store: DlqStore
  try {
    store = pruneDlq(await readDlqStore())
  } catch {
    store = {}
  }

  const entry: GenerationDlqEntry = {
    id: randomUUID(),
    jobId: input.jobId,
    txHash: input.txHash,
    taskId: input.taskId,
    source: input.source,
    receivedAt: Date.now(),
    errorType: input.errorType,
    errorMessage: String(input.errorMessage).slice(0, 2000),
    rawPayload: sanitizeDlqPayload(input.rawPayload),
  }
  store[entry.id] = entry

  try {
    await writeDlqStore(store)
  } catch {
    // best-effort — do not propagate write errors to callers
  }
  return entry
}

/**
 * Returns all DLQ entries sorted newest first.
 */
export async function listGenerationDlq(opts: { limit?: number } = {}): Promise<GenerationDlqEntry[]> {
  const store = pruneDlq(await readDlqStore())
  const items = Object.values(store).sort((a, b) => b.receivedAt - a.receivedAt)
  return typeof opts.limit === "number" ? items.slice(0, opts.limit) : items
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SECRET_KEY_RE = /(secret|seed|priv|passphrase|password|token|jwt|mnemonic|api[_-]?key)/i

function sanitizeDlqPayload(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[truncated]"
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitizeDlqPayload(v, depth + 1))
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? "[redacted]" : sanitizeDlqPayload(v, depth + 1)
    }
    return out
  }
  if (typeof value === "string" && value.length > 1024) return `${value.slice(0, 1024)}…[truncated]`
  return value
}

/** Test helper */
export async function _resetGenerationJobStore(): Promise<void> {
  await writeJobStore({})
  await writeDlqStore({})
}
