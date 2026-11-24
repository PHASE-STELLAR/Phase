# Feature flags

Flags are **statically evaluated** from the environment at module load
(`lib/flags/registry.ts`). A flag is on when its env var is `1`, `true`, `on`
or `yes` (case-insensitive). Changing the variable at runtime has no effect;
restart the process.

`FLAG_ENV_MAP` is the single lookup surface. It contains one canonical entry
per feature plus rollback aliases. An alias resolves to the canonical ID, so
renaming an ID back for a rollback never requires touching call sites.

## Registry

| Canonical ID | Feature | Env var | Aliases (rollback) | Rollback |
| --- | --- | --- | --- | --- |
| `phase-170` | Structured log pipeline | `PHASE_FLAG_LOG_PIPELINE` | `phase-170:log-pipeline`, `phase-log-pipeline` | Unset → console transport |
| `phase-180` | Albedo sunset | `PHASE_FLAG_ALBEDO_SUNSET` | `phase-170:albedo-sunset`, `phase-albedo-sunset` | Unset → Albedo adapter stays active |
| `phase-171` | Backup / DR export | `PHASE_FLAG_BACKUP_DR` | `phase-171:backup-dr`, `phase-backup-dr` | Unset → export endpoints inert |
| `phase-181` | Freighter mobile flow | `PHASE_FLAG_FREIGHTER_MOBILE` | `phase-171:freighter-mobile`, `phase-freighter-mobile` | Unset → desktop flow only |
| `phase-172` | Database parity assertions | `PHASE_FLAG_DB_PARITY` | `phase-172:db-parity`, `phase-db-parity` | Unset → parity checks skipped |
| `phase-182` | Biometric trust-gate unlock | `PHASE_FLAG_BIOMETRIC_UNLOCK` | `phase-172:biometric-unlock`, `phase-biometric-unlock` | Unset → gate error #13 stays closed |
| `phase-173` | Docs preview isolation | `PHASE_FLAG_PREVIEW_ISOLATION` | `phase-173:preview-isolation`, `phase-preview-isolation` | Unset → shared data dir |
| `phase-183` | Wallet history indexing | `PHASE_FLAG_WALLET_HISTORY` | `phase-173:wallet-history`, `phase-wallet-history` | Unset → indexer disabled |
| `phase-174` | Kill-switch drills | `PHASE_FLAG_KILL_SWITCH_DRILLS` | `phase-174:kill-switch-drills`, `phase-kill-switch-drills` | Unset → drill endpoints inert |
| `phase-217` | SEP-50 attestation adapter | `PHASE_FLAG_SEP50_ADAPTER` | `phase-sep50-adapter` | Unset → checks skipped |
| `phase-218` | EVM bridge (testnet) | `PHASE_FLAG_EVM_BRIDGE` | `phase-evm-bridge` | Unset → bridge halted, funds recoverable |
| `phase-219` | Cross-chain verifier | `PHASE_FLAG_CROSSCHAIN_VERIFY` | `phase-crosschain-verify` | Unset → verification skipped |

## Duplicate-ID history

Before this refactor, the IDs `phase-170`, `phase-171`, `phase-172` and
`phase-173` each named two different features, making flag lookups and
rollbacks ambiguous. Each second feature was moved to a new unique ID
(`phase-180`…`phase-183`) and its old token retained as an alias in
`FLAG_ENV_MAP`. The incomplete kill-switch drill work under `phase-174` is now
a passing, non-destructive drill.

## Integrity check

```bash
npm run flags:check
```

Fails on duplicate IDs, duplicate env vars, duplicate aliases, missing rollback
rows or alias/env-var drift. Runs in CI on every PR and push via
`.github/workflows/flag-integrity.yml`.

## Usage

```ts
import { isFlagEnabled, resolveFlagId } from "@/lib/flags/registry";

if (isFlagEnabled("phase-217")) { /* SEP-50 check */ }
resolveFlagId("phase-170:albedo-sunset"); // => "phase-180"
```
