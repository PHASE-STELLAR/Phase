import { randomUUID } from "node:crypto"

export type ForgeJobStatus = "pending" | "verifying" | "generating_lore" | "generating_image" | "publishing" | "minting" | "completed" | "failed"

export type ForgeJob = {
  id: string
  status: ForgeJobStatus
  prompt: string
  payerAddress?: string
  settlementTxHash?: string
  result?: {
    imageUrl: string
    image_url: string
    lore: string
    metadataStandard: string
    image_source: string
    metadataUri?: string
    cid?: string | null
  }
  error?: string
  createdAt: number
  updatedAt: number
}

const store = new Map<string, ForgeJob>()
const TTL_MS = 30 * 60 * 1000

function pruneExpired(): void {
  const now = Date.now()
  for (const [k, v] of store) if (now - v.updatedAt > TTL_MS) store.delete(k)
}

export function createJob(input: { prompt: string; payerAddress?: string; settlementTxHash?: string }): ForgeJob {
  pruneExpired()
  const job: ForgeJob = {
    id: randomUUID(),
    status: "pending",
    prompt: input.prompt,
    payerAddress: input.payerAddress,
    settlementTxHash: input.settlementTxHash,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  store.set(job.id, job)
  return job
}

export function getJob(id: string): ForgeJob | undefined {
  pruneExpired()
  return store.get(id)
}

export function updateJob(id: string, patch: Partial<ForgeJob> & { status?: ForgeJobStatus }): ForgeJob | undefined {
  const cur = store.get(id)
  if (!cur) return undefined
  const next = { ...cur, ...patch, updatedAt: Date.now() }
  store.set(id, next)
  return next
}

export function listJobs(): ForgeJob[] {
  pruneExpired()
  return [...store.values()].sort((a, b) => b.createdAt - a.createdAt)
}

// test helper
export function _resetJobStore(): void { store.clear() }
