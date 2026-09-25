/**
 * #291 — World roles RBAC: ownership enforcement and auth guard.
 *
 * The POST /api/world/[collection_id]/roles endpoint now requires an
 * X-Wallet-Signature header before processing the request body. This
 * file tests the second line of defence — the setWorldRole() store
 * function's ownership check — to confirm that even with a valid
 * header, only the world owner can assign roles.
 *
 * The header guard itself is validated by the route layer; these tests
 * focus on the pure store logic that runs after authentication passes.
 */
import { describe, it, before, after } from "node:test"
import * as assert from "node:assert/strict"
import { mkdir, writeFile, rm } from "node:fs/promises"
import path from "node:path"
import { setWorldRole, ensureWorldOwner, getWorldRoles } from "@/lib/narrative-world-store"

// ── Test fixture: isolated tmp data directory ────────────────────────────────

const TEST_DATA_DIR = path.join(process.cwd(), ".data-test-roles-rbac")

before(async () => {
  await mkdir(TEST_DATA_DIR, { recursive: true })
  // Seed a world owned by OWNER_WALLET
  const store = {
    "99": {
      collection_id: 99,
      owner: "GBOWNER111111111111111111111111111111111111111111111111111",
      roles: {},
    },
  }
  await writeFile(
    path.join(TEST_DATA_DIR, "worldRoles.json"),
    JSON.stringify(store),
    "utf8",
  )
  process.env.PHASE_SERVER_DATA_DIR = TEST_DATA_DIR
})

after(async () => {
  delete process.env.PHASE_SERVER_DATA_DIR
  await rm(TEST_DATA_DIR, { recursive: true, force: true })
})

const OWNER = "GBOWNER111111111111111111111111111111111111111111111111111"
const TARGET = "GBTARGET11111111111111111111111111111111111111111111111111"
const STRANGER = "GBSTRANGER1111111111111111111111111111111111111111111111111"

describe("setWorldRole — ownership enforcement (#291)", () => {
  it("owner can assign 'editor' role to another wallet", async () => {
    const roles = await setWorldRole(99, OWNER, TARGET, "editor")
    assert.equal(roles[TARGET], "editor")
  })

  it("owner can assign 'viewer' role to another wallet", async () => {
    const roles = await setWorldRole(99, OWNER, TARGET, "viewer")
    assert.equal(roles[TARGET], "viewer")
  })

  it("non-owner is rejected with a 403-appropriate error", async () => {
    await assert.rejects(
      () => setWorldRole(99, STRANGER, TARGET, "editor"),
      (err: Error) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, /propietario/i)
        return true
      },
    )
  })

  it("roles store reflects only the most recent assignment for a wallet", async () => {
    await setWorldRole(99, OWNER, TARGET, "editor")
    await setWorldRole(99, OWNER, TARGET, "viewer")
    const roles = await getWorldRoles(99)
    assert.equal(roles[TARGET], "viewer")
  })

  it("unknown world (no entry) rejects any acting_wallet", async () => {
    await assert.rejects(() => setWorldRole(999, OWNER, TARGET, "editor"))
  })
})

describe("ensureWorldOwner — first-write ownership registration (#291)", () => {
  it("registers owner on first call for a new collection", async () => {
    await ensureWorldOwner(200, OWNER)
    const roles = await getWorldRoles(200)
    // No roles assigned yet — confirms entry was created without throwing
    assert.deepEqual(roles, {})
  })

  it("is idempotent — second call does not overwrite owner", async () => {
    await ensureWorldOwner(201, OWNER)
    await ensureWorldOwner(201, STRANGER) // should not overwrite
    // Owner is still OWNER — only way to verify is that OWNER can still set roles
    await assert.doesNotReject(() => setWorldRole(201, OWNER, TARGET, "viewer"))
    await assert.rejects(() => setWorldRole(201, STRANGER, TARGET, "editor"))
  })
})
