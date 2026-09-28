# Spike 033 — Gated Preview `viewerSignature` Findings (Issue #227)

## What the issue claimed

The issue asserted that `lib/viewer-signature.ts:23-61` verified a
`viewerSignature` over `viewer + token_id` and cached `verified: true` in a
5-minute in-memory `Map` in `lib/cid-cache.ts:12-28`, and that a stolen
signature therefore replayed for any `token_id`, forever.

## What the code actually did at spike time

- `lib/viewer-signature.ts` is a **community-signal** signer
  (`canonicalSignalPayload({ title, body, timestamp })`), not a token gate.
  There is no `verifyViewerSignature` and no `token_id` in its payload.
- `lib/cid-cache.ts` holds a content cache with real SHA-256 integrity
  verification (`verifyBytesIntegrity`, `HASH_MISMATCH`, `TAMPERED`), not a
  `token_id: viewer → true` verification map.
- Gating in `components/phase-protected-preview.tsx` reduced to
  `resolvePhaseProtectedPreviewVerified`, a **client-side string comparison**
  of `ownerTruncated` against the connected wallet. There was no server-side
  grant, so there was no server-side signature to steal.
- The real cache exposure was on the metadata/IPFS routes:
  `app/api/ipfs/[...cid]/route.ts` served
  `Cache-Control: public, max-age=2592000, s-maxage=31536000, immutable`
  for **every** CID with no gated/public distinction and no `Vary`.

So the three-layer leak described in the issue was not reproducible, but the
underlying concern — **gated content served with shared-cache headers, and no
server-side grant that cannot be replayed** — was real and worth fixing.

## Domain-separator spec (delivered)

```
signedPayload = SHA256(
  "Phase SEP50" | networkPassphrase | contractId | viewer | tokenId | exp | jti
)
signedBytes   = "Stellar Signed Message:\n" + "phase-viewer:v1:" + hex(signedPayload)
```

Every field is inside the digest, so none can be swapped after signing:

| Field | What it prevents |
|---|---|
| `networkPassphrase` | testnet signature replayed against mainnet |
| `contractId` | signature minted for one contract honoured on another |
| `tokenId` | one signature opening every gated token |
| `exp` | indefinite replay |
| `jti` | second presentation of the same signature |

`jti` is single-use via `INSERT … ON CONFLICT (jti) DO NOTHING` against a
`viewer_jti` table. The primary key does the work, so two concurrent
presentations cannot both win — a read-then-write in the request path would let
exactly that race through. `jti` is consumed **after** signature verification so
a signature that fails to verify is not burned.

## Replay-window measurements

| Mechanism | Window | Consequence |
|---|---|---|
| Signature `exp` (delivered) | 300s, ±30s skew | bounded regardless of cache |
| `jti` single-use (delivered) | once | second presentation rejected |
| `public, s-maxage=31536000` (before) | 1 year | grant outlived any signature |
| `private, no-store` (delivered) | none | no shared-cache copy of a grant |

## Cache architecture (delivered)

- Gated / per-viewer responses: `private, no-store`, `Vary: Authorization`.
- Verified public content keeps its long `s-maxage` but gains
  `Vary: Authorization` so a shared cache keys per viewer.

## Decision

Implement the grant server-side (default-deny) rather than hardening a
client-side string compare, and stop serving per-viewer grants to shared
caches. The spike's measured conclusion is that the *signature lifetime* is not
the security boundary — the cache layer is. A 300s `exp` on a response marked
`public, max-age=31536000` is still a year-long bearer token.
