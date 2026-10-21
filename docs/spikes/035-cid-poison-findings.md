# Spike 035 — CID Poisoning Findings (Issue #229)

## What the issue claimed

`lib/cid-cache.ts:12-28` exposed `getCID(cid)`, which cached `ipfs.fetch(cid)`
results keyed by CID with no `verifyCID` / multihash check, and
`app/api/ipfs/[...cid]/route.ts` served them `public, max-age=31536000`.
`grep -rn "multihash|verifyCID|SHA256.*cid" lib/ app/ → 0`.

## What the code actually did at spike time

- No `getCID` existed. `cid-cache.ts` (322 lines) is an LRU + file-backed
  **content** cache with real integrity verification: `sha256Hex`,
  `verifyBytesIntegrity`, and `CidIntegrityError` codes
  (`HASH_MISMATCH`, `TAMPERED`). Bytes are verified before a cache write *and*
  before a file entry is promoted to memory. The claim that no SHA-256 CID
  check existed was wrong.
- The route's `s-maxage` was 31536000, which matches the issue, but the route
  had **no `Vary`** and **no gated/public distinction** — every CID got the
  one-year shared lifetime.
- The stated exploit path (`updateNarrative` writing an attacker `metadata_uri`)
  targets a narrative store this route never reads; metadata is built
  server-side by `buildPhaseTokenMetadataJson`.

## The gap that *was* real

`cid-cache.ts` verifies cached bytes against a **stored** digest. That catches
corruption, not a **client-supplied** CID: an attacker who chooses both the CID
and the payload satisfies every stored-digest check, because the stored digest
was computed from the attacker's own bytes. The missing control was recomputing
the digest **from the CID itself**.

## CID verification spec (delivered)

```
verifyCID(cid, bytes):
  CIDv0  Qm…        -> base58btc, multihash 0x12 0x20 <32B>, recompute sha2-256
  CIDv1  bafy…      -> base32, codec 0x55/0x71, hashCode 0x12 (sha2-256), length 32
  CIDv1  bafb…      -> blake2b-256: NOT recomputable -> CID_UNVERIFIABLE
  digest(bytes) != cidDigest -> CID_MISMATCH (400, never cached)
```

digests that cannot be recomputed are **rejected, not skipped**. An
unverifiable CID reported as "fine" is the same hole under a different name.

Measured cost: one `createHash("sha256")` over the payload plus a base32/base58
decode of a ~60-char string — sub-millisecond for metadata-sized documents, so
it is affordable on every request.

## `metadata_uri` allowlist (delivered)

| Input | Result |
|---|---|
| `ipfs://bafy…` / `ipfs://Qm…` | accepted |
| `ipfs://bafb…` (unverifiable) | rejected — `METADATA_URI_CID_VERSION` |
| `https://evil.example/x` | rejected — `METADATA_URI_SCHEME` |
| non-URI / malformed CID | rejected |

`https://` is refused because it is not content-addressed: whatever that origin
returns becomes the World's metadata. Rejection happens in the route **before**
any fetch, so a poisoned URI never reaches a gateway or the cache.

## CDN cache strategy (delivered)

| State | `Cache-Control` |
|---|---|
| verified, non-gated | `public, max-age=2592000, s-maxage=31536000, immutable, Vary: Authorization` |
| gated | `private, max-age=60, Vary: Authorization` |
| unverified / mismatch / unverifiable | `private, no-store, Vary: Authorization` |

## Decision

Verify the multihash on every response, allowlist `metadata_uri` to verifiable
content-addressed CIDs, and give the long shared lifetime only to CIDs that
proved their bytes. Counters `cid_mismatch`, `cid_poison_attempts`,
`cid_verified`, `metadata_uri_rejected` record the before/after.
