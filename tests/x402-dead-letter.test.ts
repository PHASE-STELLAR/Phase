/**
 * Module #44 (Issue #68) — x402 malformed-invoice dead-letter quarantine.
 * Run: npx tsx tests/x402-dead-letter.test.ts
 */
import { describe, it } from "node:test"
import * as assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"

process.env.PHASE_SERVER_DATA_DIR = path.join(
  os.tmpdir(),
  `phase-x402dl-${Date.now()}-${Math.random().toString(36).slice(2)}`,
)

import {
  X402InvoiceSchema,
  classifyInvoice,
  zodIssuesToReasons,
  redactSecrets,
  fingerprintPayload,
  quarantineInvoice,
  listDeadLetterQueue,
  getDeadLetterEntry,
  resolveDeadLetterEntry,
  getDeadLetterStats,
  clearDeadLetterForTests,
  isX402DeadLetterEnabled,
  X402DeadLetterError,
} from "@/lib/x402-dead-letter"

const VALID_G = "GA" + "A".repeat(54)

function validInvoice(over: Record<string, unknown> = {}): unknown {
  return {
    invoiceId: "inv_123",
    amount: "10.5000000",
    asset: "USDC",
    payTo: VALID_G,
    network: "testnet",
    ...over,
  }
}

describe("x402 invoice schema + pure classification", () => {
  it("accepts a well-formed invoice envelope", () => {
    const res = classifyInvoice(validInvoice())
    assert.equal(res.ok, true)
    if (res.ok) assert.equal(res.invoice.invoiceId, "inv_123")
  })

  it("defaults network to testnet", () => {
    const parsed = X402InvoiceSchema.parse(validInvoice({ network: undefined }))
    assert.equal(parsed.network, "testnet")
  })

  it("rejects bad amount / bad payTo with typed reasons", () => {
    const res = classifyInvoice(validInvoice({ amount: "-1", payTo: "not-an-address" }))
    assert.equal(res.ok, false)
    if (!res.ok) {
      const paths = [...new Set(res.reasons.map((r) => r.path))].sort()
      assert.deepEqual(paths, ["amount", "payTo"])
      assert.ok(res.reasons.every((r) => typeof r.message === "string" && r.message.length > 0))
    }
  })

  it("rejects a non-object payload without throwing", () => {
    const res = classifyInvoice("garbage")
    assert.equal(res.ok, false)
  })

  it("zodIssuesToReasons flattens nested paths", () => {
    const parsed = X402InvoiceSchema.safeParse(validInvoice({ invoiceId: "" }))
    assert.equal(parsed.success, false)
    if (!parsed.success) {
      const reasons = zodIssuesToReasons(parsed.error.issues)
      assert.equal(reasons[0].path, "invoiceId")
    }
  })
})

describe("redaction + fingerprinting", () => {
  it("redacts secret-looking keys at any depth", () => {
    const out = redactSecrets({
      signedXdr: "AAAA",
      wallet: { secretSeed: "SXXX", apiKey: "k", nested: { jwt: "j" } },
      list: [{ password: "p" }],
    }) as any
    assert.equal(out.wallet.secretSeed, "[redacted]")
    assert.equal(out.wallet.apiKey, "[redacted]")
    assert.equal(out.wallet.nested.jwt, "[redacted]")
    assert.equal(out.list[0].password, "[redacted]")
    assert.equal(out.signedXdr, "AAAA")
  })

  it("clamps very long strings", () => {
    const out = redactSecrets({ blob: "x".repeat(9000) }) as any
    assert.ok(out.blob.length < 5000)
    assert.ok(out.blob.endsWith("…[truncated]"))
  })

  it("fingerprint is stable and deterministic", () => {
    const a = fingerprintPayload({ a: 1, b: 2 })
    const b = fingerprintPayload({ a: 1, b: 2 })
    assert.equal(a, b)
    assert.notEqual(a, fingerprintPayload({ a: 1, b: 3 }))
  })
})

describe("dead-letter store (flag on)", () => {
  process.env.NEXT_PUBLIC_FEATURE_PHASE_144 = "1"
  process.env.FEATURE_PHASE_144 = "1"

  it("flag helper reflects env", () => {
    assert.equal(isX402DeadLetterEnabled(), true)
  })

  it("quarantines a malformed payload with reasons and redacted body", async () => {
    await clearDeadLetterForTests()
    const bad = validInvoice({ amount: "nope", secretSeed: "SABC" })
    const parsed = X402InvoiceSchema.safeParse(bad)
    assert.equal(parsed.success, false)
    const result = await quarantineInvoice({
      source: "unit-test",
      raw: bad,
      reasons: parsed.success ? [] : parsed.error.issues,
    })
    assert.equal(result.quarantined, true)
    if (result.quarantined) {
      const entry = await getDeadLetterEntry(result.id)
      assert.ok(entry)
      assert.equal(entry!.status, "open")
      assert.equal(entry!.source, "unit-test")
      assert.ok(entry!.reasons.length >= 1)
      assert.equal((entry!.raw_payload as any).secretSeed, "[redacted]")
    }
  })

  it("flags a repeat of the same payload as duplicateOf", async () => {
    await clearDeadLetterForTests()
    const bad = validInvoice({ amount: "nope" })
    const first = await quarantineInvoice({ source: "t", raw: bad })
    const second = await quarantineInvoice({ source: "t", raw: bad })
    assert.equal(first.quarantined && second.quarantined, true)
    if (first.quarantined && second.quarantined) {
      assert.equal(second.duplicateOf, first.id)
    }
  })

  it("lists queue newest-first and filters by status; resolve updates stats", async () => {
    await clearDeadLetterForTests()
    const a = await quarantineInvoice({ source: "t", raw: validInvoice({ amount: "x1" }) })
    const b = await quarantineInvoice({ source: "t", raw: validInvoice({ amount: "x2" }) })
    assert.ok(a.quarantined && b.quarantined)

    const open = await listDeadLetterQueue({ status: "open" })
    assert.equal(open.length, 2)
    assert.ok(open[0].received_at >= open[1].received_at)

    if (a.quarantined) {
      const resolved = await resolveDeadLetterEntry(a.id, { status: "resolved", by: "op1", note: "fixed client" })
      assert.equal(resolved.status, "resolved")
      assert.equal(resolved.resolved_by, "op1")
    }
    const stats = await getDeadLetterStats()
    assert.equal(stats.total, 2)
    assert.equal(stats.open, 1)
    assert.equal(stats.resolved, 1)
  })

  it("resolveDeadLetterEntry throws a typed error for an unknown id", async () => {
    await assert.rejects(
      () => resolveDeadLetterEntry("does-not-exist"),
      (e: unknown) => e instanceof X402DeadLetterError && e.code === "NOT_FOUND",
    )
  })
})

describe("dead-letter store (flag off)", () => {
  it("quarantineInvoice is a no-op when phase-144 is disabled", async () => {
    delete process.env.NEXT_PUBLIC_FEATURE_PHASE_144
    delete process.env.FEATURE_PHASE_144
    assert.equal(isX402DeadLetterEnabled(), false)
    const result = await quarantineInvoice({ source: "t", raw: validInvoice({ amount: "bad" }) })
    assert.deepEqual(result, { quarantined: false, reason: "flag-disabled" })
  })
})
