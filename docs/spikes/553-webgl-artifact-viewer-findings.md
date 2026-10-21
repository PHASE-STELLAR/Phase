# Spike 553 — WebGL Artifact Viewer with Protected Textures

Status: **proposed spike / research complete, not implemented**.
Batch: 550–599. Files in scope: 18. Effort: 3–8 weeks.

## Verdict first

The current "protection" is a client-side illusion. The full-resolution IPFS URL
is shipped in the RSC payload, `<meta og:image>`, `/api/explore`, and
`/api/metadata`; `/api/ipfs/[...cid]` returns `Access-Control-Allow-Origin: *`
and the viewer never sets `x-phase-gated`, so verified CIDs receive a one-year
public cache. The 2D canvas watermark runs **in the browser** and fails open to
the unwatermarked URL when every gateway fails.

A WebGL shader watermark does not fix that. A texture uploaded to the GPU is
still readable from the page; `readPixels`/screenshot/DevTools can exfiltrate it.
The only real boundary is **not sending the full-resolution bytes to an
unauthorized client**. The spike must therefore deliver, in order:

1. a server-side texture route that returns a **watermarked derivative** for
   non-owners and the original only to an authorized owner;
2. a short-lived, token-bound grant (the existing `viewer_jti` verifier is the
   right primitive);
3. then the Three.js presentation layer, with a graceful CSS fallback.

Doing 3 before 1 and 2 ships a prettier leak.

## What the brief claimed vs. what the code actually does

| Claim | Verified reality |
|---|---|
| "CSS tactical-holo-wrap + blur/pixel gate + 1-line chamber/artifact-viewer stub" | The stub exists (`components/chamber/artifact-viewer.tsx` contains only `placeholder`) but is **unused**. The real viewer is `components/phase-artifact-visualizer.tsx` (923 lines), rendering a DOM `<img>`. `FusionChamber` renders it at `fusion-chamber.tsx:1951`. |
| "Protection model (protectArt, ownerUnlocked, 2D canvas baked watermark toDataURL)" | True: `protectArt`/`ownerUnlocked` at `phase-artifact-visualizer.tsx:260-261`; watermark at `:33-86` (`toDataURL` at `:82`); fallback to the raw URL at `:320`. The owner gate is computed **in the browser**. |
| "breaks on WebGL textures: texImage2D + readPixels allows exfil" | True in principle; the current viewer has no WebGL at all. WebGL would not make it worse, but a shader watermark is not a security control. |
| "Gateway fanout gwIdx retry in 3 components" | Close. `PhaseArtifactVisualizer` owns `gwIdx` (`:257-258`), `IpfsDisplayImg` owns `idx` (`:16-23`), `WalletAvatar` has a separate list (`:10-16`). `PhaseArtifactVisualizer` also has a second independent watermark retry loop (`:300-319`). None has a timeout/abort. Client retries use a **static** order; `prioritizeGatewaysByHealth` is server-only (`lib/phase-nft-metadata-build.ts:59-80`). |
| "No three/@react-three in deps (~600KB gz)" | `three`, `@react-three/fiber`, `@react-three/drei` are all absent from `package.json`/`package-lock.json`. The 600 KB figure is **not measured in this repo**; do not repeat it as fact. |
| "Canvas replaces img alt + aria lightbox" | The lightbox has `role="dialog"`, `aria-modal`, Escape, and a close button, but no focus trap/focus restore, and both images use `alt=""` (`:455`, `:843`). The dialog name is a generic "Expand". |
| "Watermarked vs owner-decrypt semantics as materials/uniforms without leaking full-res URL in NEXT_DATA" | Today the full-res URL **is** in the RSC payload and OG metadata: `app/collection/[id]/page.tsx:51-64,80-96`; `/api/explore` returns it (`:124-131`); `/api/metadata/[id]` returns it; `/api/ipfs` is CORS `*` (`:8-12`). The current gate is cosmetic. |
| "CSP worker-src blob: present but img-src data: blob: https: allows bypass" | There are **two** CSPs. `middleware.ts:18-19` has `img-src 'self' data: blob: https:` and `connect-src 'self' https://*.stellar.org https://soroban-testnet.stellar.org wss:` but **no `worker-src`**. `next.config.mjs:55-59` has `worker-src 'self' blob:`, `connect-src 'self' https: wss:`, and `img-src ... http:`. The browser enforces the intersection, so middleware blocks blob workers and direct gateway fetches. |

### Baseline blockers

- `viewerSignatureShort` is imported by `phase-artifact-visualizer.tsx:6` and
  `fusion-chamber.tsx:89`, but `lib/viewer-signature.ts` does not export it.
- `components/chamber/artifact-viewer.tsx` and `settlement-wizard.tsx` are
  literal `placeholder` files; `fusion-chamber.tsx:71-75` imports five modules
  that do not exist. The current tree is not build-clean.
- `lib/viewer-authorization.ts` has a real verifier (Ed25519, contract/network/
  token/exp/jti binding, single-use SQLite `viewer_jti`), but nothing calls it
  for image delivery. `/api/phase-nft/verify` returns only a boolean
  (`:97-167`).

## Q1 — Minimal closed loop

```
owner/non-owner opens /collection/[id]
  -> server renders metadata WITHOUT the full-res image URL
  -> client POST /api/phase-nft/verify { tokenId, wallet, viewerClaims, viewerSignature }
     <- { verified, owner, texture: { url, token, expiresAt, variant: "preview"|"original" } }
  -> GET /api/artifact/[tokenId]/texture?token=...&v=preview
     <- server fetches CID, verifies multihash, applies a server-side watermark,
        returns WebP/PNG with Cache-Control: private, no-store, Vary: Authorization
  -> dynamic import three -> TextureLoader -> shader material -> lightbox
  -> WebGL unavailable / reduced motion -> <img> CSS holo fallback with alt text
```

The loop is proven when an unauthenticated browser cannot obtain the original
bytes from the HTML, RSC payload, OG tags, explore JSON, or a direct texture URL;
and an authorized owner can, with a grant that expires.

### Which file can fail it independently

| Stage | File | Independent failure |
|---|---|---|
| URL exposure | `app/collection/[id]/page.tsx`, `app/api/explore/route.ts`, `lib/phase-nft-metadata-build.ts` | Full-res URL published before the viewer runs. |
| Grant | `lib/viewer-authorization.ts`, `app/api/phase-nft/verify/route.ts` | Verifier exists but no token is issued; or a boolean is mistaken for a grant. |
| Cache | `app/api/ipfs/[...cid]/route.ts` | Public one-year cache + CORS `*`; `x-phase-gated` is never set. |
| Texture | new `/api/artifact/[tokenId]/texture` | Fetches a third-party gateway directly, leaking the CID; no watermark. |
| CSP | `middleware.ts` + `next.config.mjs` | Two policies; direct gateway fetch blocked or `blob:` worker blocked. |
| Renderer | `components/phase-artifact-visualizer.tsx` | No fallback, no dispose, no context-loss handling. |
| A11y | same | Canvas with no accessible name/alt, no keyboard orbit. |
| Build | `fusion-chamber.tsx`, placeholder imports, missing `viewerSignatureShort` | App does not compile. |

## Q2 — Replay/idempotency map

The viewer is read-mostly; the only write is the grant issuance.

| Write | Key | Store | Replay behavior |
|---|---|---|---|
| Viewer grant | `jti` | SQLite `viewer_jti` PK + `INSERT ... ON CONFLICT DO NOTHING` (`lib/viewer-authorization.ts:70-116`) | Second presentation rejected. |
| Texture token | HMAC over `(tokenId, contractId, wallet, variant, exp, nonce)` | Stateless, 60s TTL | Repeated GETs within TTL are allowed; token is not single-use (textures are fetched more than once). |
| Texture cache | `sha256(bytes)` + `variant` | Server cache keyed by CID+variant | Content-addressed; safe to reuse. |
| NFT ownership | on-chain `ownerOf`/`TokenOwner` | Chain | Re-check on grant; do not trust a cached owner past TTL. |
| Refund state | see spike 550 | Chain + refund ledger | A refunded token must not receive an "original" grant. |

Do not put the texture token in a URL that is logged or cached publicly. Prefer
an HttpOnly cookie set by `/api/phase-nft/verify`, or a `Authorization: Bearer`
header fetched by the client (not an `<img src>`). If a URL token is unavoidable,
keep it short-lived, bind it to the token id, and mark the response
`private, no-store`.

## Q3 — Drift, rotation, failover

| Failure | Fence |
|---|---|
| Contract-ID drift | `get_config()` (`lib/phase-protocol.ts:623-643`); grant payload includes `contractId`, and the texture route re-checks it. |
| Issuer rotation | `resolvePhaserLiqClassicAsset()` (`lib/stellar.ts:93`) for classic assets; never infer from a stale env. |
| CID poisoning | `lib/cid-verification.ts` verifies the multihash before caching/serving; reject unverifiable CIDs. |
| Gateway failover | Server-side `fetchWithIpfsFallback` + `prioritizeGatewaysByHealth`; the browser requests only `/api/artifact/...`, never Pinata/dweb/ipfs.io directly. |
| Ownership change | Re-read owner on grant; a transfer invalidates the old owner's "original" variant at the next grant. |
| CSP drift | One source of truth for CSP; if both files must emit, generate both from the same builder and add an intersection test. |
| WebGL context loss | Listen for `webglcontextlost`, prevent default, and fall back to the `<img>` renderer. |
| Bundle failure | Dynamic import with `ssr:false`; if the chunk fails, render the CSS fallback, not a blank box. |

## Q4 — Status-code taxonomy

| Code | When | Headers / recovery |
|---|---|---|
| `401 TEXTURE_TOKEN_REQUIRED` | No/invalid grant for a gated token. | `WWW-Authenticate`; UI requests a grant; fallback preview. |
| `403 TEXTURE_FORBIDDEN` | Grant wallet is not the owner and requested `variant=original`. | Serve `preview` instead, or 403; never silently upgrade. |
| `404 TEXTURE_NOT_FOUND` | Unknown token/CID or no verified metadata. | Placeholder + link to the gateway. |
| `409 TEXTURE_REFUNDED` | Token is refunded/held (spike 550). | Show `REFUNDED`; no texture. |
| `412 TEXTURE_GRANT_EXPIRED` | `exp` passed or ownership changed. | Re-issue the grant; do not cache a stale original. |
| `429 TEXTURE_RATE_LIMITED` | Per-wallet/IP texture fetch cap. | `Retry-After`; keep the last frame. |
| `503 TEXTURE_GATEWAY_UNAVAILABLE` | All gateways failed / circuit open. | `Retry-After`; CSS fallback. |

The UI never loses the user's place: the lightbox stays open, shows the
watermarked preview, and retries the original in the background.

## Q5 — Migration and rollback

- **No schema change.** The grant uses the existing `viewer_jti` table.
- Add `three` as an exact dependency (and only `three`; raw Three.js, not the
  R3F stack, unless measured otherwise). Import it with
  `next/dynamic(..., { ssr: false })` so the chamber bundle does not grow for
  every page.
- The texture route is additive; flag `phase-553` gates it and the WebGL
  renderer. Off: the current DOM/CSS viewer remains, the texture route returns
  404, and no full-res URL is newly exposed.
- Rollback: unset/restart. The CSS viewer is still present; no data migration to
  undo. If the server-side watermark derivative was cached, it is inert.
- **Do not** make the rollback depend on removing `three` from
  `package.json`; a dynamic chunk that is not imported is harmless.
- Reconcile CSP in the same change; a WebGL rollout that works in dev and is
  blocked by middleware in prod is a failed rollout.

## Rendering design

```ts
// dynamic, client-only
const ArtifactCanvas = dynamic(() => import("./artifact-canvas"), {
  ssr: false,
  loading: () => <ArtifactFallback />,
});

// artifact-canvas.tsx
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  alpha: true,
  powerPreference: "high-performance",
  preserveDrawingBuffer: false, // raises the cost of a trivial canvas readback
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const texture = await new THREE.TextureLoader().load(textureUrl, undefined, undefined, onError);
texture.colorSpace = THREE.SRGBColorSpace;
texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

// Non-owner: the server has already watermarked the derivative. The shader
// watermark is defense-in-depth, not the security boundary.
```

- Dispose geometry/material/texture/renderer on unmount; cancel the RAF loop.
- `prefers-reduced-motion`: no auto-orbit, no parallax; static camera.
- `IntersectionObserver` pauses rendering when off-screen.
- Low-end fallback: if WebGL2 is unavailable, or the context is lost twice,
  render the CSS holo `<img>`.
- No `NEXT_DATA` full-res URL: the RSC payload carries a token id and a
  variant, not the image URL.

## Accessibility

- The canvas gets `role="img"` and an `aria-label` containing the artifact name,
  not just "artifact".
- A visually hidden `<img alt={name}>` fallback is always present for screen
  readers; the canvas is `aria-hidden` when the fallback is active.
- Keyboard: focusable canvas, arrow keys orbit, `+`/`-` zoom, Enter opens the
  lightbox, Escape closes.
- Lightbox: focus trap, initial focus on close, focus restored to the opener,
  `aria-labelledby` pointing at the artifact name.
- `prefers-reduced-motion` disables the decrypt pulse and auto-rotation.
- Color is not the only state signal: `REFUNDED`/`LOCKED`/`OWNED` have text.

## File-by-file invariant map

| File | Change or ruling-out | Invariant |
|---|---|---|
| `components/phase-artifact-visualizer.tsx` | Replace `<img>` with dynamic canvas + fallback; remove client-only gate as the authority. | No full-res URL in DOM for non-owners. |
| `components/chamber/artifact-viewer.tsx` | Implement or delete the placeholder; do not leave a fake stub. | One viewer, not two. |
| `components/crt-collection-preview.tsx` | Use the texture route; add variant/alt. | Collection list does not leak originals. |
| `components/ipfs-display-img.tsx` | Keep for non-gated images; add timeout/abort. | Gateway failover is bounded. |
| `components/phase-protected-preview.tsx` | Stop claiming "verified" from a string compare; use the grant. | UI signal is not auth. |
| `components/fusion-chamber.tsx` | Fix missing imports; dynamic viewer; no hardcoded `mode="verified"`. | Real verification mode. |
| `components/chamber/settlement-wizard.tsx` | Implement or remove placeholder; settlement must not render a broken viewer. | Build-clean. |
| `app/chamber/page.tsx` | Keep Suspense fallback; add error boundary. | No blank chamber. |
| `app/collection/[id]/page.tsx` | Remove full-res `nft.image` from RSC/OG for gated tokens; emit token id + preview. | No URL leak. |
| `app/explore/page.tsx` | Consume `preview` variant only. | Public list cannot fetch originals. |
| `app/dashboard/page.tsx` | Same; owner-only originals. | Dashboard does not leak. |
| `lib/phase-protocol.ts` | Texture/grant helpers; no server key. | Signing boundary. |
| `lib/viewer-authorization.ts` | Issue texture token from the verified claims; keep `jti` single-use. | Grant is bound and expires. |
| `lib/viewer-signature.ts` | Restore `viewerSignatureShort`; keep SEP-53. | Build + client signing. |
| `lib/cid-verification.ts` | Verify before watermark/cache. | No poisoned texture. |
| `next.config.mjs` | Single CSP source; no wildcard texture origins. | Effective policy. |
| `middleware.ts` | Same CSP builder; allow only the texture route. | No bypass. |
| `app/layout.tsx` | No preload of gated textures; keep JSON-LD inline. | No early fetch. |

## Tests and acceptance evidence

- RSC/HTML test: a non-owner response contains no `ipfs://` original and no
  `/api/ipfs/<cid>` full-res URL in `og:image`.
- Grant: valid signature → token; expired/replayed `jti` → 401/412; wrong
  contract/token → 403.
- Texture: non-owner gets a watermarked derivative; owner gets original; a
  refunded token gets 409.
- CSP: no violations under the intersection; direct gateway fetch is blocked.
- WebGL: context loss → fallback; reduced motion → static; keyboard orbit works;
  screen reader sees the artifact name.
- Bundle: measure the dynamic chunk; record the number in the PR (do not claim
  600 KB without measurement).
- Flag off: current CSS viewer, no texture route, no regression.
- `npm run typecheck && npm test` green.

## Risks / non-goals / estimate

- **Risk:** treating a shader watermark as DRM. It is not; the server-side
  derivative is the boundary.
- **Risk:** two CSPs. Fix before adding WebGL.
- **Risk:** public cache headers on a private texture. `private, no-store` and
  `Vary: Authorization` are mandatory.
- **Non-goal:** screenshot prevention, mainnet, production DRM, 3D model
  formats, or replacing IPFS.
- **Estimate:** 1 w grant/texture route, 1–2 w renderer/fallback, 1 w
  a11y/CSP/hardening. Add 1 w if the server-side watermark pipeline is new.
