import { afterEach, describe, it } from "node:test"
import * as assert from "node:assert/strict"
import { fetchArtistAlias } from "../artist-profile-client"

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

describe("artist profile request coalescing", () => {
  it("shares concurrent requests and reuses a recent alias", async () => {
    let calls = 0
    globalThis.fetch = async () => {
      calls++
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { ok: true, json: async () => ({ alias: "  artist  " }) } as Response
    }

    const [first, second] = await Promise.all([
      fetchArtistAlias("wallet-coalesce"),
      fetchArtistAlias("wallet-coalesce"),
    ])
    assert.equal(first, "artist")
    assert.equal(second, "artist")
    assert.equal(await fetchArtistAlias("wallet-coalesce"), "artist")
    assert.equal(calls, 1)
  })

  it("limits concurrent requests for distinct creators", async () => {
    let active = 0
    let peak = 0
    let calls = 0
    globalThis.fetch = async () => {
      calls++
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
      return { ok: true, json: async () => ({ alias: "artist" }) } as Response
    }

    const wallets = Array.from({ length: 25 }, (_, i) => `wallet-batch-${i}`)
    const aliases = await Promise.all([...wallets, ...wallets].map(fetchArtistAlias))
    assert.equal(aliases.length, 50)
    assert.ok(aliases.every((alias) => alias === "artist"))
    assert.equal(calls, 25)
    assert.ok(peak <= 8)
    assert.ok(peak > 1)
  })

  it("retries failed requests instead of caching a rate-limit response", async () => {
    let calls = 0
    globalThis.fetch = async () => {
      calls++
      return calls === 1
        ? ({ ok: false, status: 429 } as Response)
        : ({ ok: true, json: async () => ({ alias: "artist" }) } as Response)
    }

    assert.equal(await fetchArtistAlias("wallet-retry"), null)
    assert.equal(await fetchArtistAlias("wallet-retry"), "artist")
    assert.equal(calls, 2)
  })
})
