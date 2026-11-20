import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "vitest"
import {
  checkSecurityCounterLabel,
  getSecurityCounter,
  getSecurityCounterReason,
  incSecurityCounter,
  isPiiShapedLabel,
  recordPreviewVerifyFailure,
  resetSecurityCounters,
  SECURITY_COUNTER_REGISTRY,
  SECURITY_REASON_CODES,
  SECURITY_SURFACES,
  snapshotSecurityCounters,
  snapshotSecurityCountersBySurface,
  type SecurityCounterName,
} from "@/lib/security-counters"

const ROOT = process.cwd()

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "__tests__" || entry.name.startsWith(".")) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

beforeEach(() => {
  resetSecurityCounters()
})

afterEach(() => {
  delete process.env.FEATURE_PHASE_267
  resetSecurityCounters()
})

describe("phase-267 security counter registry", () => {
  it("assigns every counter a known surface and only known reason codes", () => {
    for (const [name, spec] of Object.entries(SECURITY_COUNTER_REGISTRY)) {
      assert.ok((SECURITY_SURFACES as readonly string[]).includes(spec.surface), `${name} surface`)
      for (const reason of spec.reasons) {
        assert.ok((SECURITY_REASON_CODES as readonly string[]).includes(reason), `${name} reason ${reason}`)
      }
    }
  })

  it("never uses a wallet, CID, hash or free text as a counter name or reason code", () => {
    for (const name of Object.keys(SECURITY_COUNTER_REGISTRY)) assert.equal(isPiiShapedLabel(name), false, name)
    for (const reason of SECURITY_REASON_CODES) assert.equal(isPiiShapedLabel(reason), false, reason)
  })

  it("recognises PII-shaped labels", () => {
    const pii = [
      "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7",
      "gaazi4tcr3ty5ojhctjc2a4qsy6cjwjh5iajtgkin2er7lbnvkoccwn7",
      "CDOAXHWC6YJB7U3ELV67HKJY6HEMJFBNRGJK6WZGUAELBWP3WP77RLFD",
      "SBK2VIYYSVG76E7VC3QHYARNFLY2EAQXDHRC7BMXBBGIFG74ARPRMNQM",
      "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
      "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
      "0x52908400098527886e0f7030069857d2e4169ee7",
      "5f2b8c8d9e0a1b2c3d4e5f60718293a4b5c6d7e8f9",
      "token_1234567",
      "make me a dragon",
      "user@example.com",
      "",
    ]
    for (const label of pii) assert.equal(isPiiShapedLabel(label), true, label)
  })

  it("registers every counter name the code base emits", () => {
    const emitted = new Set<string>()
    const call = /(?:incSecurityCounter|recordSecurityCounter|inc2)\(\s*["'`]([a-z0-9_]+)["'`]/g
    for (const file of [
      ...sourceFiles(path.join(ROOT, "app")),
      ...sourceFiles(path.join(ROOT, "lib")),
      path.join(ROOT, "middleware.ts"),
    ]) {
      const text = fs.readFileSync(file, "utf8")
      for (const match of text.matchAll(call)) emitted.add(match[1])
    }
    assert.ok(emitted.size > 100, `expected the scan to find the emitters, found ${emitted.size}`)
    const unknown = [...emitted].filter((name) => !(name in SECURITY_COUNTER_REGISTRY))
    assert.deepEqual(unknown, [])
  })
})

describe("phase-267 emit-time checks", () => {
  it("rejects unknown counters, unknown reasons, PII and bad increments", () => {
    assert.deepEqual(checkSecurityCounterLabel("cid_verified"), { ok: true })
    assert.deepEqual(checkSecurityCounterLabel("wash_trades_flagged", 1, "circular"), { ok: true })
    assert.deepEqual(checkSecurityCounterLabel("made_up_counter"), { ok: false, reason: "unknown_counter" })
    assert.deepEqual(checkSecurityCounterLabel("wash_trades_flagged", 1, "replay"), { ok: false, reason: "unknown_reason" })
    assert.deepEqual(checkSecurityCounterLabel("cid_verified", 1, "self_trade"), { ok: false, reason: "unknown_reason" })
    assert.deepEqual(
      checkSecurityCounterLabel("wash_trades_flagged", 1, "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7"),
      { ok: false, reason: "pii_label" },
    )
    assert.deepEqual(checkSecurityCounterLabel("QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"), { ok: false, reason: "pii_label" })
    assert.deepEqual(checkSecurityCounterLabel("cid_verified", -1), { ok: false, reason: "invalid_increment" })
    assert.deepEqual(checkSecurityCounterLabel("cid_verified", 1.5), { ok: false, reason: "invalid_increment" })
    assert.deepEqual(checkSecurityCounterLabel("cid_verified", Number.NaN), { ok: false, reason: "invalid_increment" })
  })

  it("drops a rejected sample and records why when the flag is on", () => {
    process.env.FEATURE_PHASE_267 = "1"
    const unsafe = incSecurityCounter as (name: string, by?: number, reason?: string) => boolean
    assert.equal(unsafe("made_up_counter"), false)
    assert.equal(unsafe("wash_trades_flagged", 1, "replay"), false)
    assert.equal(unsafe("wash_trades_flagged", 1, "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7"), false)
    assert.equal(unsafe("cid_verified", -3), false)
    assert.equal(getSecurityCounter("wash_trades_flagged"), 0)
    assert.equal(getSecurityCounter("cid_verified"), 0)
    assert.equal(getSecurityCounter("security_counter_label_rejected"), 4)
    assert.equal(getSecurityCounterReason("security_counter_label_rejected", "unknown_counter"), 1)
    assert.equal(getSecurityCounterReason("security_counter_label_rejected", "unknown_reason"), 1)
    assert.equal(getSecurityCounterReason("security_counter_label_rejected", "pii_label"), 1)
    assert.equal(getSecurityCounterReason("security_counter_label_rejected", "invalid_increment"), 1)
    const snapshot = snapshotSecurityCounters() as Record<string, number>
    assert.equal(snapshot.made_up_counter, undefined)
  })

  it("never puts a rejected label value into any snapshot", () => {
    process.env.FEATURE_PHASE_267 = "1"
    const wallet = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7"
    const unsafe = incSecurityCounter as (name: string, by?: number, reason?: string) => boolean
    unsafe(wallet)
    unsafe("wash_trades_flagged", 1, wallet)
    unsafe("cid_verified", 1, "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi")
    const serialized = JSON.stringify([snapshotSecurityCounters(), snapshotSecurityCountersBySurface()])
    assert.equal(serialized.includes(wallet), false)
    assert.equal(serialized.includes("bafy"), false)
  })

  it("records reason series that compare across surfaces", () => {
    process.env.FEATURE_PHASE_267 = "1"
    recordPreviewVerifyFailure("replay")
    recordPreviewVerifyFailure("network_mismatch")
    recordPreviewVerifyFailure("something_new")
    incSecurityCounter("wash_trades_flagged", 2, "circular")
    incSecurityCounter("moderation_scored", 1, "auto_hold")
    incSecurityCounter("cid_verified", 5)

    assert.equal(getSecurityCounter("preview_verify_total"), 3)
    assert.equal(getSecurityCounterReason("preview_verify_total", "replay"), 1)
    assert.equal(getSecurityCounterReason("preview_verify_total", "malformed"), 1)

    const bySurface = snapshotSecurityCountersBySurface()
    assert.deepEqual(Object.keys(bySurface).sort(), [...SECURITY_SURFACES].sort())
    assert.equal(bySurface.gated_preview.reasons.replay, 1)
    assert.equal(bySurface.gated_preview.reasons.network_mismatch, 1)
    assert.equal(bySurface.market.reasons.circular, 2)
    assert.equal(bySurface.market.total, 2)
    assert.equal(bySurface.moderation.reasons.auto_hold, 1)
    assert.equal(bySurface.ipfs.counters.cid_verified, 5)
    assert.equal(bySurface.governance.total, 0)
    assert.equal(getSecurityCounter("security_counter_label_rejected"), 0)
  })
})

describe("phase-267 flag off", () => {
  it("counts exactly as before and keeps no reason series", () => {
    const unsafe = incSecurityCounter as (name: string, by?: number, reason?: string) => boolean
    assert.equal(incSecurityCounter("wash_trades_flagged", 3, "circular"), true)
    assert.equal(unsafe("cid_verified", 1, "replay"), true)
    assert.equal(getSecurityCounter("wash_trades_flagged"), 3)
    assert.equal(getSecurityCounter("cid_verified"), 1)
    assert.equal(getSecurityCounterReason("wash_trades_flagged", "circular"), 0)
    assert.equal(getSecurityCounter("security_counter_label_rejected"), 0)
    const names = Object.keys(snapshotSecurityCounters()) as SecurityCounterName[]
    assert.deepEqual(names.sort(), ["cid_verified", "wash_trades_flagged"])
  })
})
