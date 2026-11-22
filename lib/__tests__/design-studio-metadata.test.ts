import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import { after, beforeEach, describe, it } from "node:test"
import {
  DesignStudioMetadataError,
  commitMetadataDraft,
  getCommittedArtifactMetadata,
  getMetadataDraft,
  isDesignStudioMetadataEnabled,
  previewArtifactMetadata,
  saveMetadataDraft,
  validateArtifactMetadata,
} from "@/lib/design-studio-metadata"
import { pickCopy } from "@/lib/phase-copy"

const ORIGINAL_ENV = { ...process.env }

function setTmpDataDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `phase-studio-meta-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  process.env.PHASE_SERVER_DATA_DIR = dir
  return dir
}

describe("design-studio-metadata (phase-258 / #711)", () => {
  beforeEach(() => {
    setTmpDataDir()
    process.env.NEXT_PUBLIC_FEATURE_PHASE_258 = "1"
    process.env.FEATURE_PHASE_258 = "1"
  })

  after(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  it("flag off hides editor and keeps drafts inert", async () => {
    delete process.env.NEXT_PUBLIC_FEATURE_PHASE_258
    delete process.env.FEATURE_PHASE_258
    assert.equal(isDesignStudioMetadataEnabled(), false)

    await assert.rejects(
      () =>
        saveMetadataDraft({
          tokenId: 42,
          metadata: {
            name: "Hidden",
            description: "Should fail",
            image: "https://www.phasee.xyz/og-phase.png",
            external_url: "https://www.phasee.xyz",
            attributes: [],
            collectionId: null,
          },
        }),
      (err: unknown) =>
        err instanceof DesignStudioMetadataError && err.code === "FLAG_DISABLED",
    )

    const committed = await getCommittedArtifactMetadata(42)
    assert.equal(committed, null)
  })

  it("rejects invalid schema output from being previewed or committed", async () => {
    const bad = validateArtifactMetadata({
      name: "",
      description: "bad",
      image: "http://insecure.example.com/a.png",
      external_url: "ftp://bad",
      attributes: [],
      collectionId: null,
    })
    assert.equal(bad.ok, false)

    await assert.rejects(
      () =>
        commitMetadataDraft({
          tokenId: 7,
          metadata: {
            name: "",
            description: "bad",
            image: "not-a-uri",
            external_url: "https://www.phasee.xyz",
            attributes: [],
            collectionId: null,
          },
        }),
      (err: unknown) =>
        err instanceof DesignStudioMetadataError &&
        err.code === "VALIDATION_FAILED" &&
        err.status === 400,
    )
  })

  it("persists drafts with If-Match and returns 409 on stale edits", async () => {
    const valid = {
      name: "  Phase Seal #1  ",
      description: "Studio artifact",
      image: "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
      external_url: "https://www.phasee.xyz/artifact/1",
      attributes: [{ trait_type: "Palette", value: "Phosphor" }],
      collectionId: 12,
    }

    const d1 = await saveMetadataDraft({
      tokenId: 1,
      metadata: valid,
      ifMatch: '"v0"',
    })
    assert.equal(d1.version, 1)
    assert.equal(d1.etag, '"v1"')
    assert.equal(d1.status, "draft")

    // Stale If-Match returns 409
    await assert.rejects(
      () =>
        saveMetadataDraft({
          tokenId: 1,
          metadata: { ...valid, name: "Stale Edit" },
          ifMatch: '"v0"',
        }),
      (err: unknown) =>
        err instanceof DesignStudioMetadataError &&
        err.code === "STALE_DRAFT" &&
        err.status === 409,
    )

    // Matching If-Match succeeds
    const d2 = await saveMetadataDraft({
      tokenId: 1,
      metadata: { ...valid, name: "Phase Seal #1 v2" },
      ifMatch: d1.etag,
    })
    assert.equal(d2.version, 2)
    assert.equal(d2.etag, '"v2"')

    const loaded = await getMetadataDraft(1)
    assert.equal(loaded?.metadata.name, "Phase Seal #1 v2")
  })

  it("preview matches committed metadata exactly", async () => {
    const raw = {
      name: "  Deterministic Artifact  ",
      description: "  Preview must match commit  ",
      image: "https://www.phasee.xyz/og-phase.png",
      external_url: "https://www.phasee.xyz",
      attributes: [{ trait_type: "Tier", value: 3, display_type: "number" as const }],
      collectionId: null,
    }
    const preview = previewArtifactMetadata(raw)
    const committed = await commitMetadataDraft({
      tokenId: 9,
      metadata: raw,
      ifMatch: "*",
    })
    assert.deepEqual(preview, committed.metadata)

    const served = await getCommittedArtifactMetadata(9)
    assert.deepEqual(served?.metadata, preview)
  })

  it("provides EN and ES studioMetadata copy", () => {
    const en = pickCopy("en").studioMetadata
    const es = pickCopy("es").studioMetadata
    assert.ok(en.panelTitle.length > 0 && es.panelTitle.length > 0)
    assert.ok(en.staleConflict.includes("409") && es.staleConflict.includes("409"))
    assert.notEqual(en.commitMetadata, es.commitMetadata)
  })
})
