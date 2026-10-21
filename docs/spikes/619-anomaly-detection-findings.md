# Spike 619: Anomaly Detection on Volume, Counters and Balances with Alert Routing

**Issue**: #482
**Type**: Advanced Integration Spike
**Feature Flag**: `phase-181` (`NEXT_PUBLIC_FEATURE_PHASE_181` / `FEATURE_PHASE_181`)
**Precedents Analyzed**: faucet-health cron with webhook fan-out, distributor-health ring buffer, wash-trade scoring thresholds, security-counter registry

## Context & Motivation

PHASE already emitted the raw signals — market volume, process counters, distributor balances — and already had an alert transport (`lib/webhook-alerts.ts`: Discord/Telegram/Slack/generic with a 15-minute dedup), but nothing compared current values to history. A volume pump, a counter spinning out of control or a balance draining would only be noticed by a human reading dashboards.

## Key Architectural Decisions

1. **Three detectors matched to three signal shapes (`lib/anomaly-detection.ts`)**:
   - **volume** — robust z-score (median + MAD × 1.4826, falling back to standard deviation, then a tiny sigma floor so a flat baseline with a non-zero value still breaches) against persisted per-metric history; `z ≥ 3.5` warning, `≥ 6` critical.
   - **counters** — cumulative snapshots reduced to per-run deltas first (`counterDeltas`; resets and first-seen keys skipped), then z-scored. Anomaly's own counters are excluded from the sample so the detector can never alert on itself.
   - **balances** — deterministic percentage drop vs the previous run: `≥ 15%` warning, `≥ 35%` critical. A drain needs no baseline.

2. **Detection before self-poisoning**:
   - Each sample is measured against the baseline and only then pushed into it, so a spike never becomes its own reference. History is a capped ring (`maxHistory`, default 100) persisted in `anomaly-baselines.json`.

3. **Alert routing**:
   - Findings map to webhook alerts with a distinct `title` per kind+metric (dedup keys on `type:title`, so one flapping metric cannot suppress another) and route through `sendWebhookAlert`; attempts count into `anomaly_alerts_routed`.

4. **Cron**: `GET /api/cron/anomaly-detect` runs hourly (minute 5) behind `validateCronAuth`, the preview cron fence and the phase-171 restore marker — baselines built on half-restored data would fire false alerts and poison history.

## Rollback

Unset `NEXT_PUBLIC_FEATURE_PHASE_181` / `FEATURE_PHASE_181` or set to `0`. The cron returns `404`; `anomaly-baselines.json` stays inert and no alerts are routed.
