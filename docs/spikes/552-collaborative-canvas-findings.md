# Spike 552 — Collaborative Vector Canvas (Multi-Author CRDT, Touch/Pen)

Status: **proposed spike / research complete, not implemented**.
Batch: 550–599. Files in scope: 18. Effort: 4–8 weeks.

## Verdict first

This is **greenfield, not a refactor**. The canvas exists but is unreachable and
local-only; the CRDT files named in the brief do not exist; `yjs` is not a
dependency; there is no `signal_crdt` store, no `/api/signals/[id]/crdt` route,
and no `Y.Text` anywhere. The only collaborative conflict mechanism in the repo
is `expected_version` / `expected_vector_clock` on `POST /api/world`, and its
save is not a CAS.

A collaborative canvas is feasible, but it should not reuse the signal text
model. Use an **immutable operation log** (grow-only set of ops + deterministic
render order + tombstones for clear), batched over HTTP. Do not send 60 Hz
deltas to SQLite, and do not model vector strokes as `Y.Text`.

## What the brief claimed vs. what the code actually does

| Claim | Verified reality |
|---|---|
| "forge-paint-canvas single-user `Segment[]` (path/line/circle, grid-snap 16px)" | True: `components/forge-paint-canvas.tsx:13-16`, `:136`, `:9`. But `Segment` is private, not exported, and has no id/author/timestamp/color/pressure. |
| "mouse-only (onMouseDown/Move/Up, no touch/pen/keyboard, touch-none CSS only)" | True for `ForgePaintCanvas` (`:279-282`, `:277`). `DesignStudioEditor` already uses pointer events + `setPointerCapture` (`:318-323`, `:596-599`), but neither handles pressure/tilt. |
| "signal-crdt lore draft Yjs precedent is Y.Text minimal prefix/suffix diff" | **False.** `lib/signal-crdt.ts`, `lib/signal-crdt-store.ts`, and `app/api/signals/[id]/crdt/route.ts` do not exist and have no git history. `yjs` is absent from `package.json` and `package-lock.json`. There is no `Y.Doc`, `Y.Array`, `Y.Text`, `encodeStateAsUpdate`, or `state_vector` in the app. Text diffing is word-level LCS (`lib/signal-store.ts:diffWords`, `lib/lore-versioning.ts:diffNarrativeText`), not Yjs. |
| "Transport precedent HTTP state-vector" | There is no state-vector transport. `POST /api/world` accepts `expected_version` / `expected_vector_clock` (`app/api/world/route.ts:137-177`), but `saveWorldForCollection` is an unlocked read-modify-write (`lib/narrative-world-store.ts:56-70`). |
| "Seal path + 256-char image validation assumes single author" | The 256 limit is the **image URI string** length, not image bytes (`lib/phase-protocol.ts:1733`). Image checks are 8–8192 px edge (`lib/forge-seal-image.ts:76`) and a 64-byte minimum in the modal (`components/design-studio-modal.tsx:126`). `handleSeal` has no busy state, lock, or idempotency (`:124-129`), so concurrent seals are undefined. |
| "Tool rail labels hardcoded Lápiz/Línea/Círculo" | True for `ForgePaintCanvas` (`:252-254`, footer `:286`). `DesignStudioEditor`/`Modal` already use `pickCopy` (`design-studio-editor.tsx:134-135`, `design-studio-modal.tsx:98-99`). Default app language is EN (`components/lang-context.tsx:15`), so the hardcoded Spanish is visible in the default UI. |
| "Canvas is imported by forge" | False. `ForgePaintCanvas` and `DesignStudioModal` have **no importers**. `app/forge/page.tsx` uses prompt/file/URL only (`:1303-1406`) and calls `composeImageWithPhaseForgeSeal` + `uploadToIPFS` (`:456-460`, `:476-479`). |
| "SQLite docs/updates tables exist" | No. The SQLite schema has `signals`, `signal_replies`, `signal_versions`, `signal_reactions`, not `docs`/`updates` (`lib/sqlite-db.ts:64-131`). |

## Q1 — Minimal closed loop

```
open forge canvas (flag on)
  -> POST /api/canvas/[docId]/join { clientId, stateVector }
     <- { ops, stateVector, version, snapshot? }
  -> pointer/pen strokes -> quantized CanvasOp[]
  -> batch every 50 ms or 16 ops -> POST updates { ops, stateVector }
     <- 409 + current stateVector if stale -> rebase
  -> all peers render sorted ops; last writer wins by (lamport, peer, id)
  -> seal: POST /api/canvas/[docId]/seal { expectedVersion }
     <- one winner with CID; losers 409 + winner CID
  -> IPFS upload (retry path) -> mint/settle
```

The loop is proven when two browsers with different network delays converge to
the same pixel output after concurrent strokes, a `clear`, and a seal race, and
a reload reconstructs the document from snapshot + tail ops.

### Which file can fail it independently

| Stage | File | Independent failure |
|---|---|---|
| Input | `components/forge-paint-canvas.tsx` | Mouse-only; CSS-stretched backing store; no DPR; non-deterministic floats. |
| Doc state | `lib/canvas/*` (new) | No op identity → duplicates; no tombstone → `clear` resurrects. |
| Persistence | `lib/canvas-store.ts` (new) | No CAS → lost updates; unbounded log → OOM. |
| Transport | `app/api/canvas/[docId]/route.ts` (new) | 60 Hz writes; no batch cap; no state-vector response. |
| Seal | `components/design-studio-modal.tsx` | Two seals both upload; last write wins; lineage forks. |
| IPFS | `lib/ipfs-upload.ts` | Forge uses legacy single-shot, not `uploadToIPFSWithFlag`/retry. |
| i18n | `lib/phase-copy.ts` | Spanish labels in an EN session. |
| Flags | `lib/feature-flags.ts` | No canvas flag; accidental exposure. |

## Q2 — Replay/idempotency map

| Write | Key | Store | Double-submit |
|---|---|---|---|
| Append stroke op | `opId = peerId:seq` | `canvas_ops(doc_id, op_id)` primary key | `INSERT ... ON CONFLICT DO NOTHING`; duplicate is a no-op, not an error. |
| Clear | `opId` + `clearThroughLamport` | same table | Idempotent; applies to ops with `lamport <= clearThrough`. |
| Snapshot compaction | `(docId, upToSeq)` | `canvas_snapshots` | One row per seq; rewriting the same seq is a no-op. |
| Seal | `sealId` + `expectedVersion` | `canvas_docs.sealed_cid`, `seal_version` | Conditional `UPDATE ... WHERE version=? AND sealed_cid IS NULL`; exactly one winner. |
| Mint/settle | `invoice_id` | on-chain `PaymentRecord.settled` | Existing contract guard (see spike 550). |
| Upload | CID/content hash | IPFS is content-addressed | Re-upload of identical bytes yields the same CID; safe to retry. |

The op log is the idempotency record. Do not add a second sequence counter that
can disagree with `opId`.

## Q3 — Drift, rotation, failover

| Failure | Fence |
|---|---|
| Doc schema drift | `schemaVersion` in the doc row and every snapshot; reject unknown versions with `CANVAS_SCHEMA_UNSUPPORTED` rather than guessing. |
| Peer-id collision | `peerId` is a random 128-bit id minted per tab; never a wallet address (a wallet can have two tabs). Op id includes it. |
| Contract-ID drift (seal → mint) | `get_config()` + the contract ID captured when the doc was created; a seal against a stale contract fails closed. |
| CID/gateway drift | `lib/cid-verification.ts` verifies the sealed bytes; `token_uri?c=` keys the metadata cache. |
| Issuer rotation | `resolvePhaserLiqClassicAsset()` for any classic asset in the seal path. |
| Store failover | SQLite is local; on Vercel it is not shared across instances. A real multi-instance canvas needs a shared store (Turso/Postgres) before phase 2. Document this as a hard limit, not a bug. |
| Upload failover | Use `uploadToIPFSWithFlag` / `uploadToIpfsWithRetry` (`lib/ipfs-upload-retry.ts`), not the legacy `uploadToIPFS` currently called by forge. |

## Q4 — Status-code taxonomy

| Code | When | Recovery |
|---|---|---|
| `400 CANVAS_OP_INVALID` | Unknown op kind, non-finite/out-of-range coordinate, op too large. | Drop the op, keep the local draft, show a non-blocking error. |
| `401 CANVAS_UNAUTHORIZED` | No wallet proof for a write/seal. | Re-sign; never send the wallet address as a signature. |
| `403 CANVAS_FORBIDDEN` | Wallet is not an editor of the doc. | Read-only mode. |
| `409 CANVAS_VERSION_CONFLICT` | `stateVector`/`expectedVersion` is stale. | Response includes `stateVector` + `ops`; rebase local ops, replay them, do not discard input. |
| `409 CANVAS_ALREADY_SEALED` | Seal race lost. | Show the winner CID; offer "view sealed artifact". |
| `412 CANVAS_PRECONDITION_FAILED` | Doc sealed/archived; op references an unknown parent snapshot. | Reload from snapshot; disable drawing. |
| `413 CANVAS_DOC_TOO_LARGE` | Op count or byte cap exceeded. | Force compaction; reject new ops with a clear message. |
| `428 CANVAS_VERSION_REQUIRED` | Seal/compaction without `If-Match`/`expectedVersion`. | Client bug; attach latest version. |
| `429 CANVAS_RATE_LIMITED` | Batch rate per peer/IP. | `Retry-After`; increase batch window. |
| `503 CANVAS_STORE_UNAVAILABLE` | SQLite/shared store down. | Keep local ops in memory/IndexedDB; retry with the same op ids. |

## Q5 — Migration and rollback

- New additive tables via `CREATE TABLE IF NOT EXISTS`:

```sql
CREATE TABLE IF NOT EXISTS canvas_docs (
  id             TEXT PRIMARY KEY,
  signal_id      TEXT,
  schema_version INTEGER NOT NULL,
  version        INTEGER NOT NULL DEFAULT 0,
  state_vector   TEXT NOT NULL DEFAULT '{}',
  sealed_cid     TEXT,
  seal_version   INTEGER,
  created_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS canvas_ops (
  doc_id     TEXT NOT NULL,
  op_id      TEXT NOT NULL,
  peer_id    TEXT NOT NULL,
  lamport    INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  op_json    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (doc_id, op_id)
);
CREATE INDEX IF NOT EXISTS idx_canvas_ops_order
  ON canvas_ops(doc_id, lamport, peer_id, op_id);

CREATE TABLE IF NOT EXISTS canvas_snapshots (
  doc_id         TEXT NOT NULL,
  up_to_seq      INTEGER NOT NULL,
  snapshot_json  TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (doc_id, up_to_seq)
);
```

- Flag `phase-552` gates the canvas mount, join/update/seal routes, and the
  `forgeCanvas` copy keys. Off: the canvas component is not rendered and the
  routes return 404; all tables remain inert.
- Rollback: unset/restart. No destructive migration; sealed CIDs remain on IPFS
  and the corresponding on-chain mint is unaffected (the mint is the artifact,
  not the doc).
- If Yjs is chosen later, pin the exact version and add it as an explicit
  dependency; do not rely on a transitive copy. The current repo has no Yjs, so
  this spike does not inherit a version.

## Data model (recommended: immutable ops, not `Y.Text`)

```ts
type Fixed = number; // 1/16 px integer; deterministic across DPR/resizes

type CanvasOp =
  | { id: string; peer: string; lamport: number; kind: "path";
      points: [Fixed, Fixed][]; color: string; width: number }
  | { id: string; peer: string; lamport: number; kind: "line";
      x0: Fixed; y0: Fixed; x1: Fixed; y1: Fixed; color: string; width: number }
  | { id: string; peer: string; lamport: number; kind: "circle";
      cx: Fixed; cy: Fixed; r: Fixed; color: string; width: number }
  | { id: string; peer: string; lamport: number; kind: "clear";
      throughLamport: number };
```

Rules:

1. **Coordinates are integers in logical canvas space**, not CSS pixels and not
   DPR-scaled. `clientToCanvas` must use the element's `getBoundingClientRect()`
   and the logical `width`/`height`, then `Math.round(v * 16)`.
2. **Render order** is `(lamport, peer, id)` ascending. Concurrent strokes are
   deterministic; there is no array-index race.
3. **Clear is a tombstone**, not a delete. It hides ops with
   `lamport <= throughLamport`. Deleting rows would let a late op resurrect the
   cleared drawing.
4. **Compaction** rewrites a snapshot at `upToSeq` and may delete ops at or
   below it only after every active peer has acknowledged that seq (or after a
   TTL). Until then, keep the op log.
5. **Caps:** 10,000 ops or 2 MB per doc; 16 ops / 50 ms per POST; 64 KB per
   request. On cap, force a snapshot and reject new ops with
   `CANVAS_DOC_TOO_LARGE`.

If Yjs is preferred, use `Y.Map<opId, CanvasOp>` (immutable values) plus the
same deterministic render sort. Do **not** use `Y.Array` insertion order as the
z-order; concurrent inserts interleave by client id and are not a total order you
control. Do not use `Y.Text` for vector ops.

## Input and i18n

- `onPointerDown/Move/Up/Cancel`, `setPointerCapture`, `touch-action: none`,
  `getCoalescedEvents()` for pen smoothness, `pointerType`/`pressure` stored on
  the op (optional fields; absent means no pressure device).
- Palm rejection: ignore `pointerType === "touch"` while a pen is active; never
  ignore touch entirely (phones are valid clients).
- Keyboard alternative: arrow-key cursor + Enter to place a point, Escape to
  cancel; focus ring on the canvas.
- Backing store scales by `devicePixelRatio` for crispness, but all stored
  coordinates stay in logical space. A resize must not rewrite ops.
- Replace hardcoded `Lápiz`/`Línea`/`Círculo` and the footer with
  `pickCopy(lang).forgeCanvas.*` keys in EN and ES (`lib/phase-copy.ts`).
- `prefers-reduced-motion` disables grid animation, not drawing.

## File-by-file invariant map

| File | Change or ruling-out | Invariant |
|---|---|---|
| `components/forge-paint-canvas.tsx` | Replace local `Segment[]` with props/doc ops; pointer events; quantized coords; i18n. | Deterministic geometry. |
| `components/design-studio-editor.tsx` | Decide: keep as bitmap editor or migrate to vector; do not mix models. | One document model. |
| `components/design-studio-modal.tsx` | Seal busy state, `expectedVersion`, single winner. | No duplicate seal. |
| `lib/signal-crdt.ts` | **Does not exist**; create as `lib/canvas/crdt.ts` or rule out Yjs. | Op merge semantics. |
| `lib/signal-crdt-store.ts` | **Does not exist**; create `lib/canvas-store.ts` with CAS. | Durable op log. |
| `app/api/signals/[id]/crdt/route.ts` | **Does not exist**; create `app/api/canvas/[docId]/route.ts`. | Batch/state-vector contract. |
| `app/forge/page.tsx` | Mount the canvas behind `phase-552`; wire seal to retry upload. | Feature is reachable. |
| `lib/forge-seal-image.ts` | Keep visual seal; do not treat it as cryptographic. | Visual stamp only. |
| `lib/forge-nanobanana.ts` | Rule out: prompt generation is not canvas state. | No hidden coupling. |
| `lib/ipfs-upload.ts` | Use retry/flag path for seals; CID is the content identity. | Upload idempotency. |
| `lib/ipfs-upload-retry.ts` | Reuse for seal; checksum + backoff. | No partial pin. |
| `lib/phase-protocol.ts` | Seal/mint remains wallet-signed; no server key. | Signing boundary. |
| `lib/lore-versioning.ts` | Rule out: lore versions are text, not canvas ops. | No false reuse. |
| `app/api/forge-agent/route.ts` | Rule out: agent pipeline consumes prompts, not strokes. | No blob upload to agent. |
| `app/api/forge-agent/status/route.ts` | Rule out; note it reads a different store than `/api/jobs`. | No status confusion. |
| `hooks/use-toast-queue.ts` | Add sync/conflict/seal states; dedupe by op/seal id. | No toast flood. |
| `lib/phase-copy.ts` | Add `forgeCanvas` EN/ES keys; remove hardcoded Spanish. | Locale consistency. |
| `lib/feature-flags.ts` | Add `phase-552` when the route lands. | Default off, rollback. |

## Tests and acceptance evidence

- Convergence property test: apply the same op set in 100 random orders → same
  rendered hash.
- Concurrent stroke + clear: late stroke does not resurrect cleared content.
- Quantization: same client point at DPR 1/2/3 and two CSS sizes → same `Fixed`.
- Op cap/compaction: 10k ops → snapshot + tail replay equals pre-compaction.
- Seal race: 20 concurrent seals → exactly one CID, 19 × 409 with the winner.
- Touch/pen: synthetic pointer events, pen pressure, palm rejection, keyboard.
- i18n: EN/ES screenshot or key assertion; no hardcoded Spanish.
- Flag off: canvas not mounted; routes 404; tables untouched.
- `npm run typecheck && npm test` green.

## Risks / non-goals / estimate

- **Risk:** multi-instance SQLite is not shared. Do not claim real-time
  collaboration on Vercel without a shared store.
- **Risk:** unbounded op logs. Compaction and caps are part of the feature, not
  hardening.
- **Risk:** seal lineage forks. The seal CAS is mandatory.
- **Non-goal:** presence cursors, undo-per-peer, image layers, 60 Hz transport,
  mainnet.
- **Estimate:** 1–2 w model/transport, 2–3 w canvas/input/store, 1–2 w
  seal/i18n/hardening.
