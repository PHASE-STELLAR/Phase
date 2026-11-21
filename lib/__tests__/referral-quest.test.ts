import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it } from "vitest"
import { NextRequest } from "next/server"
import {
  enrollSignedReferral,
  getSignedReferralSummary,
  isSignedReferralQuestEnabled,
  issueOneUseReferralCode,
  readReferralStore,
} from "@/lib/referral-quest"
import { GET as referralGet, POST as referralPost } from "@/app/api/referral/route"
import { pickCopy } from "@/lib/phase-copy"
import { resetSecurityCounters, snapshotSecurityCounters } from "@/lib/security-counters"

const REFERRER = "GA" + "A".repeat(54)
const REFEREE_1 = "GB" + "B".repeat(54)
const REFEREE_2 = "GC" + "C".repeat(54)

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "phase-referral-quest-"))
  process.env.PHASE_SERVER_DATA_DIR = dir
  process.env.NEXT_PUBLIC_FEATURE_PHASE_261 = "1"
  process.env.FEATURE_PHASE_261 = "1"
  resetSecurityCounters()
})

afterEach(() => {
  delete process.env.PHASE_SERVER_DATA_DIR
  delete process.env.NEXT_PUBLIC_FEATURE_PHASE_261
  delete process.env.FEATURE_PHASE_261
  rmSync(dir, { recursive: true, force: true })
})

describe("phase-261 signed referral quest (#714)", () => {
  it("returns 404 on route and blocks enrollment when phase-261 flag is off", async () => {
    delete process.env.NEXT_PUBLIC_FEATURE_PHASE_261
    delete process.env.FEATURE_PHASE_261
    assert.equal(isSignedReferralQuestEnabled(), false)

    const getRes = await referralGet(new NextRequest("https://phase.example/api/referral"))
    assert.equal(getRes.status, 404)

    const postRes = await referralPost(
      new NextRequest("https://phase.example/api/referral", {
        method: "POST",
        body: JSON.stringify({ action: "issue_code" }),
      }),
    )
    assert.equal(postRes.status, 404)

    const issued = await issueOneUseReferralCode(REFERRER)
    assert.equal(issued.ok, false)
    if (!issued.ok) assert.equal(issued.code, "FLAG_DISABLED")
  })

  it("rejects self-referral", async () => {
    const issued = await issueOneUseReferralCode(REFERRER)
    assert.equal(issued.ok, true)
    if (!issued.ok) return

    const res = await enrollSignedReferral({
      sessionWallet: REFERRER,
      code: issued.code,
    })
    assert.equal(res.ok, false)
    if (!res.ok) {
      assert.equal(res.code, "SELF_REFERRAL")
      assert.equal(res.status, 400)
    }
  })

  it("enforces one enrollment per wallet and one-use codes", async () => {
    const codeA = await issueOneUseReferralCode(REFERRER)
    const codeB = await issueOneUseReferralCode(REFERRER)
    assert.equal(codeA.ok && codeB.ok, true)
    if (!codeA.ok || !codeB.ok) return

    const first = await enrollSignedReferral({ sessionWallet: REFEREE_1, code: codeA.code })
    assert.equal(first.ok, true)

    // Same wallet cannot enroll a second time even with a fresh code
    const secondSameWallet = await enrollSignedReferral({
      sessionWallet: REFEREE_1,
      code: codeB.code,
    })
    assert.equal(secondSameWallet.ok, false)
    if (!secondSameWallet.ok) {
      assert.equal(secondSameWallet.code, "ALREADY_ENROLLED")
      assert.equal(secondSameWallet.status, 409)
    }

    // Second wallet cannot reuse already-consumed one-use codeA
    const reuseCodeA = await enrollSignedReferral({
      sessionWallet: REFEREE_2,
      code: codeA.code,
    })
    assert.equal(reuseCodeA.ok, false)
    if (!reuseCodeA.ok) {
      assert.equal(reuseCodeA.code, "CODE_ALREADY_USED")
      assert.equal(reuseCodeA.status, 409)
    }
  })

  it("credits only once under concurrent enrollments and enforces version guard", async () => {
    const issued = await issueOneUseReferralCode(REFERRER)
    assert.equal(issued.ok, true)
    if (!issued.ok) return

    // Stale version returns 409
    const stale = await enrollSignedReferral({
      sessionWallet: REFEREE_1,
      code: issued.code,
      expectedVersion: issued.version - 1,
    })
    assert.equal(stale.ok, false)
    if (!stale.ok) {
      assert.equal(stale.code, "VERSION_CONFLICT")
      assert.equal(stale.status, 409)
    }

    // Concurrent enrollments for the same wallet / code
    const results = await Promise.all([
      enrollSignedReferral({ sessionWallet: REFEREE_1, code: issued.code }),
      enrollSignedReferral({ sessionWallet: REFEREE_1, code: issued.code }),
      enrollSignedReferral({ sessionWallet: REFEREE_1, code: issued.code }),
      enrollSignedReferral({ sessionWallet: REFEREE_2, code: issued.code }),
    ])

    const successes = results.filter((r) => r.ok)
    assert.equal(successes.length, 1)

    const summary = await getSignedReferralSummary(REFERRER)
    assert.equal(summary.totalReferredByMe, 1)

    const store = await readReferralStore()
    assert.equal(store.recordsByCode[issued.code]?.referred.length, 1)

    const counters = snapshotSecurityCounters()
    assert.ok((counters.referral_quest_code_issued ?? 0) >= 1)
    assert.ok((counters.referral_quest_enrollment ?? 0) >= 1)
    assert.ok(pickCopy("en").referralQuest.selfReferralError.length > 0)
    assert.ok(pickCopy("es").referralQuest.selfReferralError.length > 0)
  })
})
