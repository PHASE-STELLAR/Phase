# Spike 689 — AI-Driven Churn & Winback with Dormant Detection Plus Experiments Findings (Issue #552)

## What the issue claimed

The issue stated that push notifications lacked dormancy segmentation across fragmented activity (claims, mints, reads, signals, offers), had no personalized winback reason generation grounded in prior user engagement, lacked experiment rigor (holdout and randomized cohorts), and risked fatigue from unmanaged contact frequency.

## What the code actually did at spike time

- `lib/notification-store.ts` and `app/api/notifications/route.ts` supported basic transactional and system notifications per wallet without temporal dormancy classification.
- No wallet activity dormancy tiering existed (`active`, `at_risk`, `dormant_mild`, `dormant_deep`, `churned`).
- Push notifications were dispatched without holdout groups or randomized experiment variant allocation.
- No fatigue cap was enforced to prevent repeated notification bursts to dormant accounts.

## The gap that was real

Dormant users could either be forgotten entirely or subjected to irrelevant, repetitive notifications that degrade engagement rather than restoring activity.

## Delivered specification (phase-143)

1. **Dormancy classification (`lib/churn-winback.ts`)**:
   - `classifyWalletDormancy(lastActiveMs, nowMs)`: Classifies into 5 tiers (`active` <7d, `at_risk` 7-14d, `dormant_mild` 14-30d, `dormant_deep` 30-60d, `churned` >60d).
2. **Personalized winback hooks (`determineWinbackHook`)**:
   - Identifies the most relevant return motivation: broken quest streak recovery, unfinished quest arcs, new artifact drops in followed worlds, or ecosystem digests.
3. **Experiment cohorts (`assignExperimentCohort`)**:
   - Deterministic salt-hashed cohort assignment (`control`, `quest_bonus`, `fee_discount`, `social_digest`).
4. **Fatigue capping (`checkFatigueCap`)**:
   - Enforces 7-day cooldown between winback notifications per wallet.
5. **API route (`app/api/notifications/winback/route.ts`)**:
   - GET / POST endpoints to evaluate eligibility and safely record campaign dispatches.

## Decision & Rollback

- Gated under feature flag `phase-143` (`NEXT_PUBLIC_FEATURE_PHASE_143` / `FEATURE_PHASE_143`).
- Rollback: unset env var and restart. Sidecar history in `winback-experiments.json` remains inert.
