import { describe, it, beforeEach, afterEach, vi } from "vitest"
import * as assert from "node:assert/strict"
import { mkdtempSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ERASURE_TARGETS,
  RETENTION_TTL_MS,
  eraseWalletAuthSessions,
  eraseWalletKeyedRecord,
  executeWalletErasure,
  isRetentionErasureEnabled,
  retention179RollbackNote,
  runRetentionSweeps,
  sweepAuthSessions,
  sweepByTimestamp,
  sweepNotificationStore,
  RetentionErasureError,
} from "@/lib/retention-erasure"
import { createLegalHold } from "@/lib/legal-hold"
import { readStore, writeJsonFileAtomic } from "@/lib/json-store"
import { serverDataJsonPath } from "@/lib/server-data-paths"
import { getSecurityCounter, resetSecurityCounters } from "@/lib/security-counters"

const WALLET = `G${"A".repeat(55)}`
const OTHER = `G${"B".repeat(55)}`
const NOW = Date.parse("2026-06-01T00:00:00.000Z")
const DAY = 24 * 60 * 60 * 1000

function enable(on: boolean) {
  if (on) {
    process.env.NEXT_PUBLIC_FEATURE_PHASE_179 = "1"
    process.env.FEATURE_PHASE_179 = "1"
  } else {
    delete process.env.NEXT_PUBLIC_FEATURE_PHASE_179
    delete process.env.FEATURE_PHASE_179
  }
}

function enableLegalHold(on: boolean) {
  if (on) {
    process.env.NEXT_PUBLIC_FEATURE_PHASE_169 = "1"
    process.env.FEATURE_PHASE_169 = "1"
  } else {
    delete process.env.NEXT_PUBLIC_FEATURE_PHASE_169
    delete process.env.FEATURE_PHASE_169
  }
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "phase-retention-"))
  vi.stubEnv("PHASE_SERVER_DATA_DIR", dir)
  enable(true)
  enableLegalHold(false)
  resetSecurityCounters()
})

afterEach(() => {
  enable(false)
  enableLegalHold(false)
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

describe("phase-179 TTL sweeps", () => {
  it("gates on the feature flag and ships a rollback note", () => {
    assert.equal(isRetentionErasureEnabled(), true)
    enable(false)
    assert.equal(isRetentionErasureEnabled(), false)
    assert.match(retention179RollbackNote(), /phase-179/)
  })

  it("sweeps by timestamp and fails safe on missing timestamps", () => {
    const { kept, removed } = sweepByTimestamp(
      [
        { at: NOW - RETENTION_TTL_MS.notification - 1 },
        { at: NOW - 1000 },
        { at: null as unknown as number },
        { at: NaN },
      ],
      { now: NOW, ttlMs: RETENTION_TTL_MS.notification, timestampOf: (r) => r.at },
    )
    assert.equal(removed.length, 1)
    assert.equal(kept.length, 3)
  })

  it("drops expired SEP-10 sessions (seconds) and stale consumed challenges", () => {
    const store = {
      sessions: {
        expired: { wallet: WALLET, expires_at: Math.floor(NOW / 1000) - 60 },
        fresh: { wallet: OTHER, expires_at: Math.floor(NOW / 1000) + 3600 },
        expired_ms: { wallet: WALLET, expires_at: NOW - 60_000 },
      },
      consumed_challenges: {
        old: NOW / 1000 - 48 * 3600,
        new: NOW / 1000 - 60,
      },
    }
    const removed = sweepAuthSessions(store, NOW)
    assert.equal(removed, 3)
    assert.deepEqual(Object.keys(store.sessions), ["fresh"])
    assert.deepEqual(Object.keys(store.consumed_challenges), ["new"])
  })

  it("prunes expired notifications and empties dry wallet buckets", () => {
    const store: Record<string, Array<{ created_at: number }>> = {
      [WALLET]: [{ created_at: NOW - RETENTION_TTL_MS.notification - 1 }, { created_at: NOW - DAY }],
      [OTHER]: [{ created_at: NOW - RETENTION_TTL_MS.notification - 1 }],
      untouched: [{ created_at: NOW - DAY }],
    }
    const removed = sweepNotificationStore(store, NOW)
    assert.equal(removed, 2)
    assert.deepEqual(store[WALLET], [{ created_at: NOW - DAY }])
    assert.equal(OTHER in store, false)
    assert.equal("untouched" in store, true)
  })

  it("runs both sweeps through runRetentionSweeps and counts the removals", async () => {
    await writeJsonFileAtomic(serverDataJsonPath("authSessions"), {
      sessions: { a: { wallet: WALLET, expires_at: Math.floor(NOW / 1000) - 10 } },
      consumed_challenges: {},
    })
    await writeJsonFileAtomic(serverDataJsonPath("notifications"), {
      [WALLET]: [{ created_at: NOW - RETENTION_TTL_MS.notification - 1 }],
    })

    const result = await runRetentionSweeps(NOW)
    assert.equal(result.ok, true)
    assert.equal(result.total_removed, 2)
    assert.deepEqual(
      result.sweeps.map((s) => s.store),
      ["authSessions", "notifications"],
    )
    assert.equal(getSecurityCounter("retention_sweep_runs"), 1)
    assert.equal(getSecurityCounter("retention_records_expired"), 2)

    const auth = await readStore<{ sessions: Record<string, unknown> }>("authSessions", () => ({ sessions: {} }))
    assert.deepEqual(auth.sessions, {})
    const notifs = await readStore<Record<string, unknown[]>>("notifications", () => ({}))
    assert.deepEqual(notifs, {})

    enable(false)
    await assert.rejects(
      () => runRetentionSweeps(NOW),
      (err: unknown) => err instanceof RetentionErasureError && err.code === "FLAG_DISABLED",
    )
  })
})

describe("phase-179 wallet erasure", () => {
  it("removes only the target wallet from wallet-keyed stores", () => {
    const store: Record<string, unknown> = {
      [WALLET]: [{ id: 1 }, { id: 2 }],
      [OTHER]: [{ id: 3 }],
    }
    assert.equal(eraseWalletKeyedRecord(store, WALLET), 2)
    assert.equal(WALLET in store, false)
    assert.equal(OTHER in store, true)
    assert.equal(eraseWalletKeyedRecord(store, "GNOPE"), 0)
  })

  it("removes only the target wallet's SEP-10 sessions", () => {
    const store = {
      sessions: {
        t1: { wallet: WALLET },
        t2: { wallet: OTHER },
        t3: { wallet: WALLET },
      },
    }
    assert.equal(eraseWalletAuthSessions(store, WALLET), 2)
    assert.deepEqual(Object.keys(store.sessions), ["t2"])
  })

  it("erases across every registered domain and writes a fingerprinted receipt", async () => {
    await writeJsonFileAtomic(serverDataJsonPath("notifications"), {
      [WALLET]: [{ id: "n1" }, { id: "n2" }],
      [OTHER]: [{ id: "n3" }],
    })
    await writeJsonFileAtomic(serverDataJsonPath("ageDeclarations"), {
      [WALLET]: { band: "18+", declared_at: 1 },
      [OTHER]: { band: "21+", declared_at: 2 },
    })
    await writeJsonFileAtomic(serverDataJsonPath("profileFollows"), {
      [WALLET]: { following: [] },
      [OTHER]: { following: [] },
    })
    await writeJsonFileAtomic(serverDataJsonPath("pushSubscriptions"), {
      [WALLET]: [{ endpoint: "https://push.example/1" }],
      [OTHER]: [{ endpoint: "https://push.example/2" }],
    })
    await writeJsonFileAtomic(serverDataJsonPath("authSessions"), {
      sessions: { mine: { wallet: WALLET }, theirs: { wallet: OTHER } },
      consumed_challenges: {},
    })

    const receipt = await executeWalletErasure(WALLET, { initiatedBy: "wallet", now: NOW })

    assert.equal(receipt.schema, "phase-gdpr-article-17-erasure")
    assert.equal(receipt.version, "1.0.0")
    assert.equal(receipt.total_removed, 6)
    assert.equal(receipt.initiated_by, "wallet")
    assert.ok(!receipt.wallet_fingerprint.includes(WALLET), "receipt must not contain the raw wallet")
    assert.match(receipt.wallet_fingerprint, /fp: [0-9a-f]{8}/)
    assert.deepEqual(
      receipt.domains.map((d) => d.domain).sort(),
      ERASURE_TARGETS.map((t) => t.domain).sort(),
    )

    const notifications = await readStore<Record<string, unknown[]>>("notifications", () => ({}))
    assert.deepEqual(Object.keys(notifications), [OTHER])
    const auth = await readStore<{ sessions: Record<string, unknown> }>("authSessions", () => ({ sessions: {} }))
    assert.deepEqual(Object.keys(auth.sessions), ["theirs"])
    const age = await readStore<Record<string, unknown>>("ageDeclarations", () => ({}))
    assert.deepEqual(Object.keys(age), [OTHER])

    const logRaw = readFileSync(serverDataJsonPath("gdprErasureLog"), "utf8")
    const log = JSON.parse(logRaw) as { receipts: Array<{ wallet_fingerprint: string }> }
    assert.equal(log.receipts.length, 1)
    assert.ok(!logRaw.includes(WALLET))

    assert.equal(getSecurityCounter("gdpr_erasure_completed"), 1)
    assert.equal(getSecurityCounter("gdpr_erasure_records"), 6)

    enable(false)
    await assert.rejects(
      () => executeWalletErasure(WALLET),
      (err: unknown) => err instanceof RetentionErasureError && err.code === "FLAG_DISABLED",
    )
  })

  it("rejects a malformed wallet before touching any store", async () => {
    await assert.rejects(
      () => executeWalletErasure("not-a-wallet"),
      (err: unknown) => err instanceof RetentionErasureError && err.code === "VALIDATION_FAILED",
    )
    assert.equal(getSecurityCounter("gdpr_erasure_completed"), 0)
  })

  it("blocks erasure behind an active legal hold and records the denial", async () => {
    await writeJsonFileAtomic(serverDataJsonPath("notifications"), {
      [WALLET]: [{ id: "n1" }],
    })
    enableLegalHold(true)
    await createLegalHold({
      target_type: "wallet",
      target_id: WALLET,
      matter_id: "M-1",
      reason: "fraud investigation",
      custodian: "ops@phase.example",
    })

    await assert.rejects(
      () => executeWalletErasure(WALLET),
      (err: unknown) => err instanceof RetentionErasureError && err.code === "LEGAL_HOLD_ACTIVE",
    )
    assert.equal(getSecurityCounter("gdpr_erasure_blocked"), 1)
    assert.equal(getSecurityCounter("gdpr_erasure_completed"), 0)

    const notifications = await readStore<Record<string, unknown[]>>("notifications", () => ({}))
    assert.ok(WALLET in notifications, "held data must survive the erasure attempt")
  })
})
