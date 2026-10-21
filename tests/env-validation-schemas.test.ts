import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { Keypair } from "@stellar/stellar-sdk"
import {
  validateClientEnv,
  validateServerEnv,
} from "../lib/env-validation.js"

describe("lib/env-validation - Zod serverSchema & clientSchema (Issue #165)", () => {
  it("validates valid client environment variables", () => {
    const validClientEnv = {
      NEXT_PUBLIC_PHASER_TOKEN_ID: "CDOAXHWC6YJB7U3ELV67HKJY6HEMJFBNRGJK6WZGUAELBWP3WP77RLFD",
      NEXT_PUBLIC_CLASSIC_LIQ_ASSET_CODE: "PHASELQ",
    }
    const res = validateClientEnv(validClientEnv)
    assert.equal(res.valid, true)
    assert.equal(res.errors.length, 0)
  })

  it("catches invalid contract format in client variables", () => {
    const invalidClientEnv = {
      NEXT_PUBLIC_PHASER_TOKEN_ID: "invalid-contract-id",
    }
    const res = validateClientEnv(invalidClientEnv)
    assert.equal(res.valid, false)
    assert.ok(res.errors.some((e) => e.variable === "NEXT_PUBLIC_PHASER_TOKEN_ID"))
  })

  it("flags security error if secret key 'S...' is placed in NEXT_PUBLIC_ variable", () => {
    const randomSecret = Keypair.random().secret()
    const leakedSecretEnv = {
      NEXT_PUBLIC_SECRET_EXPOSED: randomSecret,
    }
    const res = validateClientEnv(leakedSecretEnv)
    assert.equal(res.valid, false)
    assert.ok(res.errors.some((e) => e.issue === "wrong_key_type" && e.variable === "NEXT_PUBLIC_SECRET_EXPOSED"))
  })

  it("validates server environment variables", () => {
    const validServerEnv = {
      STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
      SOROBAN_PROXY_FETCH_TIMEOUT_MS: "45000",
    }
    const res = validateServerEnv(validServerEnv)
    assert.equal(res.valid, true)
  })

  it("catches invalid server RPC URL format", () => {
    const invalidServerEnv = {
      STELLAR_RPC_URL: "not-a-url",
    }
    const res = validateServerEnv(invalidServerEnv)
    assert.equal(res.valid, false)
    assert.ok(res.errors.some((e) => e.variable === "STELLAR_RPC_URL"))
  })
})
