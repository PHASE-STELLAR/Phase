import { afterAll, describe, expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const dataDir = await mkdtemp(path.join(tmpdir(), "phase-profile-completeness-"))
const savedDataDir = process.env.PHASE_SERVER_DATA_DIR
const savedFlag = process.env.FEATURE_PHASE_262
process.env.PHASE_SERVER_DATA_DIR = dataDir
process.env.FEATURE_PHASE_262 = "1"

import {
  computeProfileCompleteness,
  getProfile,
  ProfileVersionConflictError,
  saveProfile,
} from "@/lib/profile-store"

describe("phase-262 profile completeness and versioning", () => {
  it("uses a fixed field list and changes the score only when profile fields change", async () => {
    expect(computeProfileCompleteness({}).score).toBe(0)
    const first = await saveProfile(
      "GPROFILE",
      { display_name: "Ada" },
      { expectedVersion: 0 },
    )
    expect(first.version).toBe(1)
    expect(first.completeness).toEqual({ score: 20, completedFields: 1, totalFields: 5 })

    const unchanged = await saveProfile(
      "GPROFILE",
      { display_name: "Ada" },
      { expectedVersion: 1 },
    )
    expect(unchanged.version).toBe(1)
    expect(unchanged.updated_at).toBe(first.updated_at)

    const changed = await saveProfile(
      "GPROFILE",
      { display_name: "Ada", twitter: "ada" },
      { expectedVersion: 1 },
    )
    expect(changed.version).toBe(2)
    expect(changed.completeness?.score).toBe(40)
  })

  it("rejects stale versions without modifying the saved profile", async () => {
    const before = await getProfile("GPROFILE")
    await expect(saveProfile(
      "GPROFILE",
      { display_name: "Stale" },
      { expectedVersion: 1 },
    )).rejects.toBeInstanceOf(ProfileVersionConflictError)
    expect(await getProfile("GPROFILE")).toEqual(before)
  })
})

afterAll(async () => {
  if (savedDataDir === undefined) delete process.env.PHASE_SERVER_DATA_DIR
  else process.env.PHASE_SERVER_DATA_DIR = savedDataDir
  if (savedFlag === undefined) delete process.env.FEATURE_PHASE_262
  else process.env.FEATURE_PHASE_262 = savedFlag
  await rm(dataDir, { recursive: true, force: true })
})
