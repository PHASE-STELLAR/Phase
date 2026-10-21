# Spike 603 — Vercel Preview-Environment Isolation with Per-PR Contracts, Sidecars and Data Findings (Issue #467)

## What the issue claimed / what the code did

- One staging lane (`deploy-staging` on push to main); PRs run contracts and a web build only.
- The data root is ambient (`cwd/.data`, `os.tmpdir()` on Vercel, `PHASE_SERVER_DATA_DIR`) and nothing set it per preview.
- Issuer, distributor and cron secrets are global; validation checked shape, not isolation.
- `x-vercel-cron` was trusted as authentication, and cron fires per project: N previews could drain one issuer.

## Delivered slice (phase-173)

- **Identity**: `resolvePreviewId` yields `pr-<n>` or `br-<slug>-<hash>` (hash so `feat/a-b` and `feat/a/b` differ); always a single safe path segment, `null` outside previews.
- **Data**: `serverDataRoot()` appends `previews/<id>` when the flag is on.
- **Fencing**: `checkPreviewIsolation` (surfaced by `validatePhaseEnv` as `isolation_violation`) flags a production issuer (public key or derived from the secret), the production cron secret (compared by sha256 only), production contract IDs, and mainnet. Production identity is supplied as public or hashed values, so no production secret is ever needed in a preview.
- **Cron**: previews skip scheduled work unless `PHASE_PREVIEW_CRON_ENABLED=1` and no longer trust `x-vercel-cron`.
- `lib/preview-isolation.ts` has no `node:*` imports because `env-validation` is bundled for the client via `phase-protocol.ts`.

## Affected files: changed or explicitly ruled out

| File | Status |
|---|---|
| `lib/server-data-paths.ts` | Changed: per-preview root. |
| `lib/env-validation.ts` | Changed: isolation violations. |
| `app/api/cron/faucet-health/route.ts` | Changed: preview cron gate, header trust. |
| `.env.local.example` | Changed: new variables. |
| `lib/sqlite-db.ts`, `lib/json-store.ts` | Used unchanged: both resolve paths via `serverDataJsonPath`, so they inherit the namespace. |
| `.github/workflows/ci.yml`, `vercel.json` | Ruled out: a preview deploy job needs Vercel credentials that cannot be validated here. |
| `lib/phase-contract-defaults.ts`, `lib/phase-protocol.ts`, `next.config.mjs` | Ruled out: per-PR contract IDs are baked at build time and need a deploy pipeline. |
| `diagnose-env.ts`, `scripts/diagnose-env.ts` | Ruled out: they call `validatePhaseEnv`, so they report violations without changes. |
| `scripts/deploy-phase-sep50.ts`, `scripts/deploy-phase.ts`, `scripts/seed-phaser-prueba.ts`, `scripts/migrate-json-to-sqlite.ts` | Ruled out: per-PR deploy and seeding automation. |
| `app/api/faucet/route.ts` | Ruled out: it inherits the namespaced data root. |

## Rollback

Unset `FEATURE_PHASE_173` and restart: data root, cron auth and validation revert; per-preview directories stay inert.

## Follow-ups

This is a partial slice. The issue's acceptance criteria that need a live testnet or hosted environment (end-to-end transaction proof, kill-the-primary resilience demo) are not claimed here; see `docs/TECHNICAL.md` for what the unit tests do cover.
