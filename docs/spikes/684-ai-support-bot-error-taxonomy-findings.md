# Spike 684 — AI Support Bot with Docs-Grounded Answers and Error-Taxonomy Diagnosis Findings (Issue #547)

## What the issue claimed

The issue noted that static bilingual documentation lacked retrieval index and citation anchors at runtime, while contract/gateway errors presented raw cryptic traces without machine-readable runbook diagnosis or secret redaction.

## What the code actually did at spike time

- Documentation lived in markdown and TS files outside interactive API query routes.
- Error handling in `lib/phase-host-error.ts` and `app/api/*` returned codes without guided troubleshooting runbook steps.
- User queries and pasted error traces lacked automatic redaction of Stellar seed secrets (`S...`) or private keys.

## The gap that was real

Users and integrators encountering protocol gates (e.g. `BIOMETRIC_TRUST_GATE_CLOSED`), version CAS conflicts (409), x402 payment requirements, or IPFS timeouts had no unified assistant to parse traces, categorize retryability, and cite exact documentation runbooks.

## Delivered specification (phase-150)

1. **Error taxonomy diagnosis (`lib/support-bot.ts`)**:
   - Pattern classification into `PROTOCOL_GATE`, `AUTH_ERROR`, `NETWORK_TIMEOUT`, `CONCURRENCY_CONFLICT`, and `PAYMENT_REQUIRED`.
   - Identification of retryability and actionable runbook steps.
   - PII and secret redaction (`[REDACTED_STELLAR_SEED]`, `[REDACTED_PRIVATE_KEY]`).
2. **Docs grounding (`lib/support-bot.ts`)**:
   - Keyword retrieval matching across trustline setup, forge agent pipeline, signal CAS store, and i18n rules.
   - Explicit citations to repo architecture and technical documentation.
3. **API endpoint (`app/api/support/bot/route.ts`)**:
   - POST route accepting user queries and error traces.

## Decision & Rollback

- Gated under feature flag `phase-150` (`NEXT_PUBLIC_FEATURE_PHASE_150` / `FEATURE_PHASE_150`).
- Rollback: unset env var and restart. Endpoint returns 404.
