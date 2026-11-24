import { describe, it, expect } from "vitest"
import { Keypair } from "@stellar/stellar-sdk"
import { parsePhaseLink, restoreIntent, INTENT_TTL_MS, intentPath } from "@/lib/deep-links"

const origin = "https://phase.example"
describe("inbound intent validation", () => {
  it("normalizes custom, stellar and universal collection links", () => {
    for (const url of ["phase://collection/42", "stellar://phase/collection/42", `${origin}/link/collection/42`]) {
      expect(parsePhaseLink(url, origin, 100)).toMatchObject({ kind: "collection", id: "42", capturedAt: 100 })
    }
  })
  it("retains reviewed context across disconnect, reload, and a stripped query", () => {
    const recipient = Keypair.random().publicKey()
    const intent = parsePhaseLink(`phase://offer/listing-1/offer-2?ref=ABCDEFGH&recipient=${recipient}`, origin, 100)
    expect(restoreIntent(JSON.stringify(intent), origin, 200)).toEqual(intent)
    expect(parsePhaseLink(intentPath(intent), origin, 100)).toEqual(intent)
  })
  it("expires persisted intents and rejects future timestamps", () => {
    const intent = parsePhaseLink("phase://quest/quest_first_settle", origin, 100)
    expect(restoreIntent(JSON.stringify(intent), origin, 100 + INTENT_TTL_MS)).toBeNull()
    expect(restoreIntent(JSON.stringify(intent), origin, 99)).toBeNull()
    expect(restoreIntent('{"version":1,"kind":"quest","id":"../escape"}', origin)).toBeNull()
  })
  it.each([
    "https://evil.example/link/collection/1", "javascript:alert(1)", "//evil.example/link/quest/foo",
    "stellar://pay?destination=GAAA", "phase://collection/0", "phase://collection/1junk", "phase://collection/9007199254740993",
    "phase://offer/one", "phase://quest/foo/extra", "phase://quest/foo?recipient=GAAA", "phase://quest/foo?ref=bad",
    "phase://quest/foo?ref=ABCDEFGH&ref=ABCDEFGH", "phase://quest/foo?redirect=https://evil.example", "phase://quest/foo#sign",
  ])("rejects tampered or unsupported links: %s", raw => expect(() => parsePhaseLink(raw, origin)).toThrow())
})
