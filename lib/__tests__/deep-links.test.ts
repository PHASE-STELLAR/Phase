import { describe, it, expect, vi, afterEach } from "vitest"
import { Keypair } from "@stellar/stellar-sdk"
import {
  parsePhaseLink,
  restoreIntent,
  INTENT_TTL_MS,
  intentPath,
  buildChamberCollectionHref,
  canRecipientAuthorizeTransfer,
  hasIntentExpired,
} from "@/lib/deep-links"
import { canPrefetchSameOriginUrl } from "@/hooks/use-link-prefetch"

afterEach(() => {
  vi.unstubAllEnvs()
})

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
    "stellar://pay?destination=GAAA", "stellar://other/collection/1", "phase://evil/1", "phase://collection:8080/1",
    "phase://collection/0", "phase://collection/1junk", "phase://collection/9007199254740993",
    "phase://offer/one", "phase://quest/foo/extra", "phase://quest/foo?recipient=GAAA", "phase://quest/foo?ref=bad",
    "phase://quest/foo?ref=ABCDEFGH&ref=ABCDEFGH", "phase://quest/foo?redirect=https://evil.example", "phase://quest/foo#sign",
  ])("rejects tampered or unsupported links: %s", raw => expect(() => parsePhaseLink(raw, origin)).toThrow())

  it("rewrites collection links to Chamber with parameters preserved and denies recipient signing authority", () => {
    const recipient = Keypair.random().publicKey()
    const intent = parsePhaseLink(`phase://collection/42?ref=ABCDEFGH&recipient=${recipient}`, origin, 1000)
    expect(buildChamberCollectionHref(intent)).toBe(`/chamber?collection=42&ref=ABCDEFGH&recipient=${recipient}`)
    expect(canRecipientAuthorizeTransfer(intent)).toBe(false)
    expect(hasIntentExpired(intent, 1000 + INTENT_TTL_MS - 1)).toBe(false)
    expect(hasIntentExpired(intent, 1000 + INTENT_TTL_MS)).toBe(true)
  })

  it("fences custom schemes and blocks /link prefetch when phase-248 is enabled", () => {
    expect(canPrefetchSameOriginUrl("phase://collection/1", origin)).toBeNull()
    expect(canPrefetchSameOriginUrl("stellar://phase/collection/1", origin)).toBeNull()
    expect(canPrefetchSameOriginUrl("https://evil.example/chamber", origin)).toBeNull()
    vi.stubEnv("NEXT_PUBLIC_FEATURE_PHASE_248", "1")
    expect(canPrefetchSameOriginUrl(`${origin}/link/collection/1`, origin)).toBeNull()
    expect(canPrefetchSameOriginUrl(`${origin}/chamber?collection=1`, origin)).toBe("/chamber?collection=1")
  })
})
