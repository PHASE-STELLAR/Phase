# Spike Index — Batch 550–599

Status: **proposed spike / research complete, implementation not started**.
Baseline: `main` @ `2e2f64e` (branch `spike/batch-550-599`). All line references
below are for that baseline.

This batch contains four independent, cross-boundary spikes. Each one was
specified as a *proposed* advanced integration spike, so the deliverable of this
batch is a code-grounded design and a go/no-go decision — not a half-merged
feature. No runtime route, contract entrypoint, or dependency was added.

The collaborative-canvas brief appeared twice in the source text; it is tracked
once as spike 552. The refund, live-update, canvas, and WebGL briefs are the
four unique spikes in this batch.

> Note on the brief: it references `docs/spikes/SPIKE_INDEX_500_549.md` for the
> previous batch. That file is **not present in this tree**. The only prior
> spike documents here are `033`, `035`, `036`, and `037`. The "does not
> duplicate 500–549" claim therefore cannot be verified from the repository; it
> is treated as an external dependency for review.

## Batch map

| # | Spike | Proposed flag | Files | Effort | Verdict |
|---|---|---|---|---|---|
| 550 | Refundable settlement for irreversible forge payments | `phase-550` | 16 | 4–8 w | **NO-GO until two preconditions land**: `initialize` re-entry guard and a custody model for the 95/5 split |
| 551 | Real-time live updates (SSE / fanout) for signals, notifications, market, explore | `phase-551` | 20 | 3–6 w | **Conditional GO** after the signal store is repaired and write auth is tightened; in-process SSE first, external fanout second |
| 552 | Collaborative vector canvas (multi-author CRDT, touch/pen) | `phase-552` | 18 | 4–8 w | **Conditional GO**; the canvas is currently unreachable, so this is greenfield, not a refactor |
| 553 | WebGL artifact viewer with protected textures | `phase-553` | 18 | 3–8 w | **Conditional GO** after the texture authorization model is fixed; a shader watermark alone is not a security boundary |

## Shared invariants (apply to every spike)

1. **Signing stays client-side.** Freighter / Stellar Wallet Kit signs; the
   server only holds custodied `ADMIN`, `FAUCET_DISTRIBUTOR`, `AGENT`, and issuer
   keys (`PROJECT_ARCHITECTURE.md` §3).
2. **Flags default off.** A flag is only added to `lib/feature-flags.ts` when a
   route or behavior exists to gate. The proposed names above are reserved in
   this document; they are deliberately **not** in `FLAG_ENV_MAP` while the
   features are unimplemented, so no dead flag can be mistaken for a shipped
   control.
3. **Three clocks.** SQLite `version` CAS, JSON file locks / atomic
   `tmp+rename`, and Yjs/vector-clock ordering are different mechanisms with
   different failure modes. A spike must name which clock owns each write.
4. **No PII in metric labels.** Counters use closed labels only; wallet, signal
   text, CID, and prompt are never label values.
5. **Testnet-only assumptions are fenced.** Friendbot, open `mint_public`, the
   placeholder payer `GAAA...`, and testnet passphrases must be explicit and
   must fail closed on mainnet config.
6. **Docs and env move together.** Contract ID, issuer, or asset changes update
   `.env.local.example`, `PROJECT_ARCHITECTURE.md`, `docs/TECHNICAL.md`, and the
   relevant spike document in the same change.

## Baseline hazards found while spiking

These are pre-existing and block *any* safe implementation. They are listed here
because each spike touches at least one of them:

| Hazard | Evidence | Impact |
|---|---|---|
| `initialize` can be called again | `contracts/phase-protocol/src/lib.rs:430-460` has no "already initialized" check | Anyone can re-point the authorized token/treasury and set themselves as `Admin`, then call `upgrade` (`:464-472`). This invalidates every admin-gated refund or texture grant. |
| Signal store is a broken JSON/SQLite merge | `lib/signal-store.ts:154-177` references undeclared `conditions`, unimported `getDb`, and redeclares `items`; `voteOnPoll`/scheduled exports are missing while routes import them | `GET /api/signals` and poll/scheduled routes cannot run on this HEAD. A repair exists on `origin/fix/signal-store-sqlite-merge-repair` (`936e42a`) but is not merged. |
| Chamber components are placeholders | `components/chamber/artifact-viewer.tsx` and `settlement-wizard.tsx` contain the literal text `placeholder`; `fusion-chamber.tsx:71-75` imports five modules that do not exist | The app is not build-clean before 553 starts. |
| Missing viewer export | `viewerSignatureShort` is imported by `phase-artifact-visualizer.tsx:6` and `fusion-chamber.tsx:89` but not exported by `lib/viewer-signature.ts` | Build/runtime failure in 553's primary surface. |
| Replay test is broken | `tests/replay-settlement.test.ts:2` imports `mkdtmpSync` from `fs`; it also asserts `used === true` before marking (`:19-22`) | 550 has no valid replay regression test today. |
| `used-settlements.json` bypasses the platform-safe data path | `lib/settlement-store.ts:4` uses `process.cwd()/.data` instead of `serverDataJsonPath` | On Vercel it can be read-only or ephemeral; replay protection silently degrades. |

## Recommended order

1. **Repair baseline** (signal store, chamber placeholders, viewer export,
   replay test, `initialize` guard, `settlement-store` path). This is not a
   spike; it is the floor.
2. **550 contract custody** — everything financial depends on it.
3. **551 live updates** — read-only fanout is the lowest-risk visible feature,
   but only after write auth is fixed.
4. **553 WebGL viewer** — consumes the same viewer grant that 550/551 must not
   weaken.
5. **552 collaborative canvas** — greenfield and independent; can run in
   parallel once the baseline is green.

## What "done" means for this batch

Each numbered document answers the five spike questions with concrete types,
SQL, contract storage, status codes, and a file-by-file invariant table. Closing
any one of them still requires the acceptance evidence listed in its final
section (testnet tx hashes, concurrency proof, abuse proof, resilience proof,
EN/ES copy, flag row, and a green `npm run typecheck && npm test` with all flags
off). Those proofs cannot be produced by a documentation-only change.
