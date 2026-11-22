# Preview environment teardown (phase-228)

When a PR is merged or closed, the per-PR Soroban contract and branch-scoped
data must be cleaned up so testnet resources do not accumulate indefinitely.

## Automatic teardown

The `deploy-preview.yml` workflow runs the `teardown-preview-contract` job
automatically when a pull request is **closed** (merged or abandoned).  It
removes the `NEXT_PUBLIC_PHASE_PREVIEW_CONTRACT_ID` env override from Vercel
for that branch so the next preview deployment falls back to no contract
(which the env validation will catch and block until a fresh deploy runs).

No action is required from the developer for the common case.

## What is NOT automatically deleted

Soroban contracts on testnet are immutable and cannot be "deleted"; the
deployer account simply stops holding a reference to the instance.  The
contract instance itself persists on-chain but becomes unreachable by the
preview app once its ID is removed from the env.

Branch-scoped data written to `.preview-data/previews/<preview-id>/` on disk
(or Vercel's ephemeral `/tmp`) is naturally ephemeral — it disappears when
the Vercel preview function instance is recycled.

## Manual teardown steps

If automatic teardown failed (e.g. the Vercel API call timed out):

1. **Remove the Vercel env override**

   ```bash
   BRANCH=your-branch-name
   PROJECT_ID=your-vercel-project-id
   TOKEN=your-vercel-token

   # List env vars for the branch
   curl -sf \
     "https://api.vercel.com/v10/projects/$PROJECT_ID/env?gitBranch=$BRANCH" \
     -H "Authorization: Bearer $TOKEN" | jq '.envs[] | select(.key=="NEXT_PUBLIC_PHASE_PREVIEW_CONTRACT_ID")'

   # Delete the env var by ID (replace ENV_ID with the id from above)
   curl -sf -X DELETE \
     "https://api.vercel.com/v10/projects/$PROJECT_ID/env/ENV_ID" \
     -H "Authorization: Bearer $TOKEN"
   ```

2. **Reset the preview contract** (optional — the contract is on testnet only)

   If you want to fully reset the testnet state used by the preview:

   ```bash
   cd scripts
   ADMIN_SECRET_KEY=<preview-admin-secret> \
   NEXT_PUBLIC_PHASER_TOKEN_ID=<token-id> \
   NEXT_PUBLIC_CLASSIC_LIQ_ISSUER=<issuer> \
   npx tsx reset-phase.ts
   ```

3. **Delete local branch-scoped data** (CI runner only)

   On ephemeral CI runners this is handled automatically.  On a persistent
   runner or in local development:

   ```bash
   rm -rf .preview-data/previews/pr-<PR_NUMBER>
   ```

## Env vars involved (phase-228)

| Variable | Where set | Purpose |
|---|---|---|
| `NEXT_PUBLIC_PHASE_PREVIEW_CONTRACT_ID` | Vercel (branch override) | Per-PR contract ID injected by CI |
| `PREVIEW_ADMIN_SECRET_KEY` | Vercel environment / GitHub secret | Testnet deployer key (never production) |
| `PHASE_PROD_CONTRACT_IDS` | Vercel production env | Comma-separated production contract IDs used by env validation to block collision |
| `NEXT_PUBLIC_FEATURE_PHASE_228` | Vercel env / `.env.local` | Enables phase-228; set to `1` to enable, unset or `0` to disable |

## Rollback

Unset `NEXT_PUBLIC_FEATURE_PHASE_228` (or set to `0`/`false`) in the Vercel
environment and redeploy.  The preview will revert to shared contract state
exactly as before phase-228.  Per-preview directories on disk remain inert.
