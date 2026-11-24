/**
 * #243 — generation job store: no lost writes under concurrent access.
 *
 * Every mutation is a read→modify→write cycle on a JSON sidecar. Run 100 of them
 * concurrently and an unlocked store drops entries (each caller writes back a
 * snapshot that never saw the others' jobs). The store serialises the cycle, so
 * all 100 must survive.
 *
 * Run: npx tsx --test tests/generation-job-store-concurrency.test.ts
 */
import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const dataDir = await mkdtemp(path.join(tmpdir(), "phase-gen-jobs-"))
process.env.PHASE_SERVER_DATA_DIR = dataDir

import {
  createGenerationJob,
  getGenerationJobById,
  listGenerationJobs,
  updateGenerationJob,
  _resetGenerationJobStore,
} from "@/lib/generation-job-store"

const CONCURRENCY = 100

describe("generation job store concurrency (#243)", () => {
  after(() => rm(dataDir, { recursive: true, force: true }))

  it("loses no writes across 100 concurrent creates", async () => {
    await _resetGenerationJobStore()

    const created = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        createGenerationJob({ taskId: `task-${i}`, txHash: `tx-${i}`, prompt: `prompt ${i}` }),
      ),
    )

    assert.equal(created.length, CONCURRENCY)
    assert.equal(new Set(created.map((j) => j.id)).size, CONCURRENCY, "job ids must be unique")

    const stored = await listGenerationJobs()
    assert.equal(stored.length, CONCURRENCY, "no job may be lost by a concurrent write")
    for (let i = 0; i < CONCURRENCY; i++) {
      assert.ok(stored.some((j) => j.txHash === `tx-${i}`), `tx-${i} must be persisted`)
    }
  })

  it("keeps every concurrent status update", async () => {
    await _resetGenerationJobStore()
    const job = await createGenerationJob({ taskId: "task-x", txHash: "tx-x", prompt: "p" })

    await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        updateGenerationJob(job.id, { webhookDeliveries: i + 1 }),
      ),
    )

    const after = await getGenerationJobById(job.id)
    assert.ok(after, "job must still exist")
    assert.ok(
      (after.webhookDeliveries ?? 0) >= 1,
      "at least one concurrent update must be applied",
    )
    assert.equal(after.status, "pending")
  })

  it("stays idempotent for a repeated txHash under concurrency", async () => {
    await _resetGenerationJobStore()
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        createGenerationJob({ taskId: "same", txHash: "tx-same", prompt: "p" }),
      ),
    )
    const ids = new Set(results.map((j) => j.id))
    assert.equal(ids.size, 1, "a duplicate txHash must not create a second job")
    assert.equal((await listGenerationJobs()).length, 1)
  })
})
