import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, it, beforeEach } from "node:test"
import * as assert from "node:assert/strict"
import { rotateIpfsGatewayAuth } from "@/lib/notification-store"

describe("phase-128 IPFS gateway auth rotation", () => {
  beforeEach(async () => {
    process.env.PHASE_SERVER_DATA_DIR = await mkdtemp(path.join(os.tmpdir(), "phase-gateway-auth-"))
  })

  it("rotates active token while preserving a temporary previous token hash", async () => {
    const first = await rotateIpfsGatewayAuth(
      {
        gateway: "pinata",
        private_tier: "pro",
        next_token: "token-one-with-safe-length",
        rotated_by: "security",
        overlap_ms: 1000,
      },
      { force: true, now: 1_000 },
    )
    const second = await rotateIpfsGatewayAuth(
      {
        gateway: "pinata",
        private_tier: "pro",
        next_token: "token-two-with-safe-length",
        rotated_by: "security",
        overlap_ms: 1000,
      },
      { force: true, now: 2_000 },
    )

    assert.match(first.active_token_hash, /^[a-f0-9]{64}$/)
    assert.match(second.active_token_hash, /^[a-f0-9]{64}$/)
    assert.notEqual(first.active_token_hash, second.active_token_hash)
    assert.equal(second.previous_token_hash, first.active_token_hash)
    assert.equal(second.previous_expires_at, 3_000)
  })

  it("rejects malformed rotation payloads", async () => {
    await assert.rejects(
      () => rotateIpfsGatewayAuth({ gateway: "pinata", private_tier: "pro", next_token: "short", rotated_by: "" }, { force: true }),
      /valid gateway rotation payload required/,
    )
  })
})
