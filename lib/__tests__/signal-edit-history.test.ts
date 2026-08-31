import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"
import { Keypair } from "@stellar/stellar-sdk"
import { createSignal, diffWords, editSignal, getSignalEditHistory, SignalEditError } from "@/lib/signal-store"

let dataDir = ""

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "phase-signal-edit-history-"))
  process.env.PHASE_SERVER_DATA_DIR = dataDir
  process.env.FEATURE_PHASE_82 = "1"
})

after(async () => {
  delete process.env.PHASE_SERVER_DATA_DIR
  delete process.env.FEATURE_PHASE_82
  await rm(dataDir, { recursive: true, force: true })
})

describe("diffWords", () => {
  it("returns a single equal op for identical text", () => {
    assert.deepEqual(diffWords("hello world", "hello world"), [{ type: "equal", value: "hello world" }])
  })

  it("marks a swapped word as a remove+add pair around shared context", () => {
    const ops = diffWords("the quick brown fox", "the quick red fox")
    assert.deepEqual(ops, [
      { type: "equal", value: "the quick " },
      { type: "remove", value: "brown" },
      { type: "add", value: "red" },
      { type: "equal", value: " fox" },
    ])
  })

  it("handles pure insertion and pure deletion", () => {
    assert.deepEqual(diffWords("", "new text"), [{ type: "add", value: "new text" }])
    assert.deepEqual(diffWords("old text", ""), [{ type: "remove", value: "old text" }])
  })
})

describe("phase-82 signal edit history", () => {
  it("snapshots the pre-edit state and applies the patch", async () => {
    const author = Keypair.random().publicKey()
    const signal = await createSignal({
      author_wallet: author,
      author_display: "Editor",
      channel: "general",
      title: "Original title",
      body: "Original body",
      upvotes: [],
      signature: author,
      type: "post",
    })

    const { signal: updated, version } = await editSignal(signal.id, author, { title: "Updated title" })
    assert.equal(updated.title, "Updated title")
    assert.equal(updated.body, "Original body")
    assert.equal(version.version, 1)
    assert.equal(version.title, "Original title")
    assert.equal(version.body, "Original body")
    assert.equal(version.edited_by, author)
  })

  it("rejects edits from a non-author wallet", async () => {
    const author = Keypair.random().publicKey()
    const stranger = Keypair.random().publicKey()
    const signal = await createSignal({
      author_wallet: author,
      author_display: "Editor",
      channel: "general",
      title: "Title",
      body: "Body",
      upvotes: [],
      signature: author,
      type: "post",
    })

    await assert.rejects(
      () => editSignal(signal.id, stranger, { title: "Hijacked" }),
      (error: unknown) => error instanceof SignalEditError && error.code === "FORBIDDEN",
    )
  })

  it("rejects an edit with nothing to change", async () => {
    const author = Keypair.random().publicKey()
    const signal = await createSignal({
      author_wallet: author,
      author_display: "Editor",
      channel: "general",
      title: "Title",
      body: "Body",
      upvotes: [],
      signature: author,
      type: "post",
    })

    await assert.rejects(
      () => editSignal(signal.id, author, {}),
      (error: unknown) => error instanceof SignalEditError && error.code === "VALIDATION_FAILED",
    )
  })

  it("builds full history with diffs across multiple edits", async () => {
    const author = Keypair.random().publicKey()
    const signal = await createSignal({
      author_wallet: author,
      author_display: "Editor",
      channel: "general",
      title: "First draft",
      body: "First body",
      upvotes: [],
      signature: author,
      type: "post",
    })

    await editSignal(signal.id, author, { body: "Second body" })
    await editSignal(signal.id, author, { title: "Final draft" })

    const history = await getSignalEditHistory(signal.id)
    assert.ok(history)
    assert.equal(history!.versions.length, 2)
    assert.equal(history!.signal.title, "Final draft")
    assert.equal(history!.signal.body, "Second body")
    assert.equal(history!.diffs.length, 2)
    assert.equal(history!.diffs[0]?.to_version, 2)
    assert.equal(history!.diffs[1]?.to_version, "current")
    assert.deepEqual(history!.diffs[0]?.body_diff, [
      { type: "remove", value: "First" },
      { type: "add", value: "Second" },
      { type: "equal", value: " body" },
    ])
  })
})
