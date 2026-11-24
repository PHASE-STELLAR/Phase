import { describe, it, beforeEach, afterEach } from "node:test"
import * as assert from "node:assert/strict"
import { Keypair } from "@stellar/stellar-sdk"
import {
  canonicalAliasChangeMessage,
  getArtistAliasAudit,
  getSignedArtistAlias,
  isArtistAttestationV2Enabled,
  pickArtistAliasCopy,
  resolveSignedArtistAlias,
  saveSignedArtistAlias,
} from "@/lib/artist-attestation"

function signAlias(kp: Keypair, alias: string, expectedVersion: number, nonce: string) {
  const wallet = kp.publicKey()
  const issuedAt = Date.now()
  const msg = canonicalAliasChangeMessage({ wallet, alias, expectedVersion, issuedAt, nonce })
  const signature = kp.sign(Buffer.from(msg, "utf8")).toString("base64")
  return { wallet, alias, expectedVersion, issuedAt, nonce, signature }
}

describe("phase-245 artist attestation and alias control (#696)", () => {
  beforeEach(() => {
    process.env.FEATURE_PHASE_245 = "1"
  })

  afterEach(() => {
    delete process.env.FEATURE_PHASE_245
    delete process.env.NEXT_PUBLIC_FEATURE_PHASE_245
  })

  it("gates on phase-245 flag", () => {
    assert.equal(isArtistAttestationV2Enabled(), true)
    delete process.env.FEATURE_PHASE_245
    assert.equal(isArtistAttestationV2Enabled(), false)
  })

  it("rejects forged attestation signatures", () => {
    const victim = Keypair.random()
    const attacker = Keypair.random()
    const issuedAt = Date.now()
    const nonce = "nonce-forged-001"
    const msg = canonicalAliasChangeMessage({
      wallet: victim.publicKey(),
      alias: "phase_artist",
      expectedVersion: 0,
      issuedAt,
      nonce,
    })
    const forgedSig = attacker.sign(Buffer.from(msg, "utf8")).toString("base64")

    const res = saveSignedArtistAlias({
      wallet: victim.publicKey(),
      alias: "phase_artist",
      expectedVersion: 0,
      issuedAt,
      nonce,
      signature: forgedSig,
    })
    assert.equal(res.ok, false)
    if (!res.ok) {
      assert.equal(res.code, "SIGNATURE_INVALID")
      assert.equal(res.status, 401)
    }
  })

  it("enforces version-guarded updates and records an audit trail", () => {
    const kp = Keypair.random()
    const alias1 = `artist_${kp.publicKey().slice(1, 8)}`
    const alias2 = `artist2_${kp.publicKey().slice(1, 8)}`

    const create = saveSignedArtistAlias(signAlias(kp, alias1, 0, "nonce-create-01"))
    assert.equal(create.ok, true)
    if (!create.ok) return
    assert.equal(create.record.version, 1)
    assert.equal(create.record.attested, true)

    // Stale expectedVersion = 0 must fail with VERSION_CONFLICT
    const stale = saveSignedArtistAlias(signAlias(kp, alias2, 0, "nonce-stale-01"))
    assert.equal(stale.ok, false)
    if (!stale.ok) {
      assert.equal(stale.code, "VERSION_CONFLICT")
      assert.equal(stale.status, 409)
      assert.equal(stale.currentVersion, 1)
    }

    // Correct expectedVersion = 1 succeeds and increments to 2
    const update = saveSignedArtistAlias(signAlias(kp, alias2, 1, "nonce-update-02"))
    assert.equal(update.ok, true)
    if (!update.ok) return
    assert.equal(update.record.version, 2)

    const current = getSignedArtistAlias(kp.publicKey())
    assert.equal(current?.alias, alias2)

    const audit = getArtistAliasAudit(kp.publicKey(), 10)
    assert.equal(audit.length, 2)
    assert.equal(audit[0]?.version, 2)
    assert.equal(audit[1]?.version, 1)
  })

  it("enforces one primary alias per wallet and uniqueness under concurrency", async () => {
    const kpA = Keypair.random()
    const kpB = Keypair.random()
    const sharedAlias = `unique_${Date.now().toString(36)}`

    const [resA, resB] = await Promise.all([
      Promise.resolve().then(() => saveSignedArtistAlias(signAlias(kpA, sharedAlias, 0, "nonce-conc-a"))),
      Promise.resolve().then(() => saveSignedArtistAlias(signAlias(kpB, sharedAlias.toUpperCase(), 0, "nonce-conc-b"))),
    ])

    const successes = [resA, resB].filter((r) => r.ok)
    const conflicts = [resA, resB].filter((r) => !r.ok)
    assert.equal(successes.length, 1)
    assert.equal(conflicts.length, 1)
    if (conflicts[0] && !conflicts[0].ok) {
      assert.equal(conflicts[0].code, "HANDLE_TAKEN")
      assert.equal(conflicts[0].status, 409)
    }

    const resolved = resolveSignedArtistAlias(sharedAlias)
    assert.ok(resolved)
  })

  it("provides EN and ES copy", () => {
    assert.notEqual(pickArtistAliasCopy("en").signatureInvalid, pickArtistAliasCopy("es").signatureInvalid)
    assert.notEqual(pickArtistAliasCopy("en").versionConflict, pickArtistAliasCopy("es").versionConflict)
  })
})
