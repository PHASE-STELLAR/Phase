import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  BackupError,
  RESTORE_MARKER_NAME,
  collectSecretsMap,
  createSnapshot,
  diffSecretsMap,
  isRestoreInProgress,
  openSecrets,
  restoreSnapshot,
  sealSecrets,
  verifySnapshot,
} from "@/lib/backup-snapshot"
import { getSecurityCounter, resetSecurityCounters } from "@/lib/security-counters"
import { serverDataJsonPath } from "@/lib/server-data-paths"
import { getDb, resetDbForTests } from "@/lib/sqlite-db"

const PASSPHRASE = "correct horse battery staple"
const SECRET = "SDQXX5YXNQJ6X4Y3MXBXL4SVGSJPBIEUT3LOEBJTAI7XTMSEFAPKKMEJ"

let dataDir: string
let snapDir: string
let restoreDir: string
let previousDataDir: string | undefined

function enable(on: boolean) {
  if (on) {
    process.env.NEXT_PUBLIC_FEATURE_PHASE_171 = "1"
    process.env.FEATURE_PHASE_171 = "1"
  } else {
    delete process.env.NEXT_PUBLIC_FEATURE_PHASE_171
    delete process.env.FEATURE_PHASE_171
  }
}

function seedSignal(id: string) {
  getDb()
    .prepare(
      "INSERT INTO signals (id, author_wallet, author_display, channel, title, body, created_at, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(id, "GAAA", "a", "general", `title ${id}`, "body", Date.now(), "sig")
}

beforeEach(async () => {
  enable(true)
  resetSecurityCounters()
  resetDbForTests()
  dataDir = await mkdtemp(path.join(tmpdir(), "phase-backup-data-"))
  snapDir = await mkdtemp(path.join(tmpdir(), "phase-backup-snap-"))
  restoreDir = await mkdtemp(path.join(tmpdir(), "phase-backup-restore-"))
  previousDataDir = process.env.PHASE_SERVER_DATA_DIR
  process.env.PHASE_SERVER_DATA_DIR = dataDir
})

afterEach(async () => {
  resetDbForTests()
  if (previousDataDir === undefined) delete process.env.PHASE_SERVER_DATA_DIR
  else process.env.PHASE_SERVER_DATA_DIR = previousDataDir
  enable(false)
  await Promise.all([dataDir, snapDir, restoreDir].map((d) => rm(d, { recursive: true, force: true })))
})

describe("phase-171 backup and DR snapshots", () => {
  it("throws FLAG_DISABLED when the flag is off", async () => {
    enable(false)
    await expect(createSnapshot(snapDir)).rejects.toMatchObject({ code: "FLAG_DISABLED" })
    expect(await isRestoreInProgress(dataDir)).toBe(false)
  })

  it("snapshots sidecars and sqlite, verifies, and restores with parity", async () => {
    seedSignal("s1")
    seedSignal("s2")
    await writeFile(serverDataJsonPath("profileFollows"), JSON.stringify({ a: ["b"] }))
    await writeFile(serverDataJsonPath("notifications"), JSON.stringify({ n: 1 }))

    const manifest = await createSnapshot(snapDir, () => new Date("2026-01-01T00:00:00Z"))
    expect(manifest.createdAt).toBe("2026-01-01T00:00:00.000Z")
    expect(manifest.files.map((f) => f.name).sort()).toEqual(["notifications.json", "profile-follows.json"])
    expect(manifest.sqlite?.tables.signals).toBe(2)

    const verification = await verifySnapshot(snapDir)
    expect(verification.problems).toEqual([])
    expect(verification.ok).toBe(true)

    await restoreSnapshot(snapDir, restoreDir)
    expect(JSON.parse(await readFile(path.join(restoreDir, "profile-follows.json"), "utf8"))).toEqual({ a: ["b"] })
    const restored = new DatabaseSync(path.join(restoreDir, "phase.sqlite3"), { readOnly: true })
    expect((restored.prepare("SELECT COUNT(*) AS n FROM signals").get() as { n: number }).n).toBe(2)
    restored.close()
    expect(getSecurityCounter("backup_restore_completed")).toBe(1)
    expect(await isRestoreInProgress(restoreDir)).toBe(false)
  })

  it("captures writes made while the snapshot runs only as a whole (no torn set)", async () => {
    await writeFile(serverDataJsonPath("profileFollows"), JSON.stringify({ v: 1 }))
    await writeFile(serverDataJsonPath("notifications"), JSON.stringify({ v: 1 }))
    const manifest = await createSnapshot(snapDir)
    for (const f of manifest.files) {
      expect(JSON.parse(await readFile(path.join(snapDir, f.name), "utf8"))).toEqual({ v: 1 })
    }
  })

  it("refuses to snapshot a corrupt sidecar", async () => {
    await writeFile(serverDataJsonPath("profileFollows"), "{ torn")
    await expect(createSnapshot(snapDir)).rejects.toThrow()
  })

  it("detects tampered and missing files and refuses to restore them", async () => {
    await writeFile(serverDataJsonPath("profileFollows"), JSON.stringify({ a: 1 }))
    await createSnapshot(snapDir)
    await writeFile(path.join(snapDir, "profile-follows.json"), JSON.stringify({ a: 2 }))
    const verification = await verifySnapshot(snapDir)
    expect(verification.ok).toBe(false)
    expect(verification.problems).toContain("profile-follows.json: checksum mismatch")
    await expect(restoreSnapshot(snapDir, restoreDir)).rejects.toMatchObject({ code: "SNAPSHOT_CORRUPT" })
    expect(getSecurityCounter("backup_snapshot_corrupt")).toBeGreaterThan(0)

    await rm(path.join(snapDir, "manifest.json"))
    expect((await verifySnapshot(snapDir)).problems).toContain("manifest missing or unreadable")
  })

  it("blocks a second restore while the marker is fresh and ignores a stale marker", async () => {
    await createSnapshot(snapDir)
    const marker = path.join(restoreDir, RESTORE_MARKER_NAME)
    await writeFile(marker, "{}")
    expect(await isRestoreInProgress(restoreDir)).toBe(true)
    await expect(restoreSnapshot(snapDir, restoreDir)).rejects.toMatchObject({ code: "RESTORE_IN_PROGRESS" })
    expect(getSecurityCounter("backup_restore_blocked")).toBe(1)

    const old = new Date(Date.now() - 60 * 60 * 1000)
    await utimes(marker, old, old)
    expect(await isRestoreInProgress(restoreDir)).toBe(false)
    await expect(restoreSnapshot(snapDir, restoreDir)).resolves.toBeDefined()
  })

  it("seals and opens secrets without leaking plaintext", async () => {
    const map = collectSecretsMap({ ADMIN_SECRET_KEY: SECRET, CRON_SECRET: "cron-1", UNRELATED: "x" })
    expect(Object.keys(map).sort()).toEqual(["ADMIN_SECRET_KEY", "CRON_SECRET"])
    const sealed = sealSecrets(map, PASSPHRASE)
    expect(JSON.stringify(sealed)).not.toContain(SECRET)
    expect(sealed.names).toEqual(["ADMIN_SECRET_KEY", "CRON_SECRET"])
    expect(openSecrets(sealed, PASSPHRASE)).toEqual(map)

    let thrown: unknown
    try {
      openSecrets(sealed, "wrong passphrase value")
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(BackupError)
    expect((thrown as BackupError).code).toBe("SECRETS_UNSEAL_FAILED")
    expect(String((thrown as BackupError).message)).not.toContain(SECRET)

    const tampered = { ...sealed, ct: Buffer.from("zzzz").toString("base64") }
    expect(() => openSecrets(tampered, PASSPHRASE)).toThrow(/could not be opened/)
    expect(() => sealSecrets(map, "short")).toThrow(/at least 16/)
  })

  it("reports drift by secret name only", () => {
    const diff = diffSecretsMap(
      { ADMIN_SECRET_KEY: "old", CRON_SECRET: "same", PINATA_JWT: "gone" },
      { ADMIN_SECRET_KEY: "new", CRON_SECRET: "same", PHASE_ADMIN_KEY: "extra" },
    )
    expect(diff).toEqual({ changed: ["ADMIN_SECRET_KEY"], missingInEnv: ["PINATA_JWT"], missingInBackup: ["PHASE_ADMIN_KEY"] })
  })
})
