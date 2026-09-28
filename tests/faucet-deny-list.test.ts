/**
 * Module #56 (Issue #78) — Faucet deny-list with on-chain governance veto.
 * Run: npx tsx tests/faucet-deny-list.test.ts
 */
import { describe, it, beforeEach } from "node:test"
import * as assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"

process.env.PHASE_SERVER_DATA_DIR = path.join(
  os.tmpdir(),
  `phase-denylist-${Date.now()}-${Math.random().toString(36).slice(2)}`,
)

const base32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
function makeG(seed: number): string {
  let s = "G"
  for (let i = 0; i < 55; i++) s += base32[(seed * 7 + i * 13) % 32]
  return s
}

const BAD_WALLET = makeG(1)
const GOV_A = makeG(10)
const GOV_B = makeG(11)
const GOV_C = makeG(12)
const NON_GOV = makeG(99)

process.env.NEXT_PUBLIC_FEATURE_PHASE_156 = "1"
process.env.FEATURE_PHASE_156 = "1"
process.env.PHASE_GOVERNANCE_SIGNERS = [GOV_A, GOV_B, GOV_C].join(",")

import {
  isFaucetDenyListEnabled,
  proposeDenyListEntry,
  castGovernanceVeto,
  liftDenyListEntry,
  isWalletDenied,
  getWalletDenyEntry,
  listDenyList,
  deriveDenyStatus,
  governanceSigners,
  isGovernanceSigner,
  clearDenyListForTests,
  FaucetDenyListError,
  AddDenyRequestSchema,
} from "@/lib/faucet-deny-list"

beforeEach(async () => {
  await clearDenyListForTests()
})

describe("schema + pure helpers", () => {
  it("validates an add request", () => {
    const ok = AddDenyRequestSchema.safeParse({ wallet: BAD_WALLET, reason: "spam farm", proposedBy: "mod1" })
    assert.equal(ok.success, true)
    const bad = AddDenyRequestSchema.safeParse({ wallet: "nope", reason: "abuse", proposedBy: "" })
    assert.equal(bad.success, false)
  })

  it("reads governance signers from env", () => {
    assert.deepEqual(governanceSigners().sort(), [GOV_A, GOV_B, GOV_C].sort())
    assert.equal(isGovernanceSigner(GOV_A), true)
    assert.equal(isGovernanceSigner(NON_GOV), false)
  })

  it("deriveDenyStatus flips to vetoed at quorum", () => {
    assert.equal(
      deriveDenyStatus({ status: "active", veto_quorum: 2, vetoes: [{ signer: GOV_A, cast_at: 1 }] }),
      "active",
    )
    assert.equal(
      deriveDenyStatus({
        status: "active",
        veto_quorum: 2,
        vetoes: [
          { signer: GOV_A, cast_at: 1 },
          { signer: GOV_B, cast_at: 2 },
        ],
      }),
      "vetoed",
    )
  })
})

describe("propose + isWalletDenied", () => {
  it("denies a wallet immediately on propose (deny-first)", async () => {
    assert.equal(isFaucetDenyListEnabled(), true)
    assert.equal(await isWalletDenied(BAD_WALLET), false)
    const entry = await proposeDenyListEntry({ wallet: BAD_WALLET, reason: "sybil farm", proposedBy: "mod1" })
    assert.equal(entry.status, "active")
    assert.equal(await isWalletDenied(BAD_WALLET), true)
    const active = await getWalletDenyEntry(BAD_WALLET)
    assert.equal(active?.id, entry.id)
  })

  it("rejects a duplicate active proposal", async () => {
    await proposeDenyListEntry({ wallet: BAD_WALLET, reason: "sybil farm", proposedBy: "mod1" })
    await assert.rejects(
      () => proposeDenyListEntry({ wallet: BAD_WALLET, reason: "again", proposedBy: "mod2" }),
      (e: unknown) => e instanceof FaucetDenyListError && e.code === "ALREADY_EXISTS",
    )
  })

  it("throws VALIDATION_FAILED on a malformed proposal", async () => {
    await assert.rejects(
      () => proposeDenyListEntry({ wallet: "bad", reason: "abuse", proposedBy: "" }),
      (e: unknown) => e instanceof FaucetDenyListError && e.code === "VALIDATION_FAILED",
    )
  })
})

describe("governance veto", () => {
  it("lifts the deny once a quorum of distinct governance signers veto", async () => {
    const entry = await proposeDenyListEntry({
      wallet: BAD_WALLET,
      reason: "disputed",
      proposedBy: "mod1",
      vetoQuorum: 3,
    })
    await castGovernanceVeto(entry.id, { signer: GOV_A, note: "false positive" })
    await castGovernanceVeto(entry.id, { signer: GOV_B })
    assert.equal(await isWalletDenied(BAD_WALLET), true)
    const final = await castGovernanceVeto(entry.id, { signer: GOV_C })
    assert.equal(final.status, "vetoed")
    assert.equal(await isWalletDenied(BAD_WALLET), false)
  })

  it("rejects a veto from a non-governance signer", async () => {
    const entry = await proposeDenyListEntry({ wallet: BAD_WALLET, reason: "abuse", proposedBy: "mod1" })
    await assert.rejects(
      () => castGovernanceVeto(entry.id, { signer: NON_GOV }),
      (e: unknown) => e instanceof FaucetDenyListError && e.code === "NOT_GOVERNANCE_SIGNER",
    )
  })

  it("rejects a duplicate veto from the same signer", async () => {
    const entry = await proposeDenyListEntry({ wallet: BAD_WALLET, reason: "abuse", proposedBy: "mod1" })
    await castGovernanceVeto(entry.id, { signer: GOV_A })
    await assert.rejects(
      () => castGovernanceVeto(entry.id, { signer: GOV_A }),
      (e: unknown) => e instanceof FaucetDenyListError && e.code === "DUPLICATE_VETO",
    )
  })

  it("throws NOT_FOUND for an unknown entry", async () => {
    await assert.rejects(
      () => castGovernanceVeto("missing", { signer: GOV_A }),
      (e: unknown) => e instanceof FaucetDenyListError && e.code === "NOT_FOUND",
    )
  })
})

describe("lift + listing", () => {
  it("manual lift removes the deny and is reflected in listings", async () => {
    const entry = await proposeDenyListEntry({ wallet: BAD_WALLET, reason: "abuse", proposedBy: "mod1" })
    await liftDenyListEntry(entry.id, "admin1")
    assert.equal(await isWalletDenied(BAD_WALLET), false)
    const lifted = await listDenyList({ status: "lifted" })
    assert.equal(lifted.length, 1)
    assert.equal(lifted[0].lifted_by, "admin1")
  })
})

describe("flag off", () => {
  it("isWalletDenied returns false and propose throws FLAG_DISABLED", async () => {
    delete process.env.NEXT_PUBLIC_FEATURE_PHASE_156
    delete process.env.FEATURE_PHASE_156
    assert.equal(isFaucetDenyListEnabled(), false)
    assert.equal(await isWalletDenied(BAD_WALLET), false)
    await assert.rejects(
      () => proposeDenyListEntry({ wallet: BAD_WALLET, reason: "abuse", proposedBy: "mod1" }),
      (e: unknown) => e instanceof FaucetDenyListError && e.code === "FLAG_DISABLED",
    )
    process.env.NEXT_PUBLIC_FEATURE_PHASE_156 = "1"
    process.env.FEATURE_PHASE_156 = "1"
  })
})
