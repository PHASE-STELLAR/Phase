# Flagged adapters — operations

## Kill switch (ops)

`PHASE_OPS_KILL_SWITCH` is a comma-separated, statically evaluated snapshot.
Targets: `auto_refill`, `all`. `none`/empty means no kill switch.

- `PHASE_OPS_KILL_SWITCH=auto_refill` halts distributor auto-refill.
- `PHASE_OPS_KILL_SWITCH=all` halts every gated background operation.
- `npm run drill:kill-switch` (requires `PHASE_FLAG_KILL_SWITCH_DRILLS=1`) is
  **non-destructive**: in-memory state only, no network, no secrets, no chain
  writes. It asserts that a halted distributor never reaches the issuance path
  and that a `faucetPending` re-poll returns the same hash instead of issuing a
  second claim.

## SEP-50 (`phase-217`)

- `PHASE_SEP50_DISCOVERY_URL` — discovery endpoint returning
  `{ homeDomain, issuerAccount, attestationUrl, network }`.
- `PHASE_SEP50_MOCK=1` + `PHASE_SEP50_ISSUER` — testnet mock mode. The mock is
  fenced by a static network snapshot and refuses to start on pubnet.
- `POST /api/compliance/sep50` with `{ homeDomain, account, sep10Token,
  expiresAt }`. Success returns only `{ ok: true, subjectHash }`.
- Outage returns **503 + `Retry-After`**; invalid attestation returns 422;
  flag off returns 404.
- No PII is persisted: only `sha256(account|issuer)` leaves the adapter.

## EVM bridge (`phase-218`, testnet only)

- `PHASE_NETWORK` must be `testnet`; any other value fences the bridge.
- `PHASE_BRIDGE_FINALITY_DEPTH` (default 12) — confirmations required before a
  lock becomes `confirming`.
- `PHASE_BRIDGE_MAX_DRIFT_BPS` (default 50) — max lock-amount drift.
- `PHASE_BRIDGE_ORPHAN_AFTER_MS` (default 900000) — age before a lock with zero
  confirmations is marked orphaned.
- `GET /api/bridge` returns the active testnet route or 404 when flagged off.
- `POST /api/bridge` validates a lock intent and returns a `lockRequest` with
  `signingBoundary: "client"`. **The server never signs the Stellar leg.**

### Custody boundary

Server-side custody is limited to the EVM leg and is accessed only through
`BridgeCustody.mint(recipient, amount, idempotencyKey)` and
`BridgeCustody.recover(record)`. The `idempotencyKey` is the Stellar source tx
hash. Custody keys are supplied by deployment configuration (an opaque key ID,
never a raw private key in this repository) and are not read by the adapter.

**Orphan recovery procedure:**

1. `detectOrphan` marks a zero-confirmation lock older than the threshold as
   `orphaned`. No funds move at this step.
2. `recoverOrphan` re-checks the finality oracle. If confirmations are still
   below the configured depth it aborts with `STILL_UNCONFIRMED`.
3. On success it calls `custody.recover(record)` and re-queues the message as
   `confirming`; `relayMint` then completes using the original idempotency key.

A replayed `relayMint` returns the original mint tx hash and performs **no**
second mint. The atomic `claimMint` guard prevents concurrent double-mints.

## Cross-chain verification (`phase-219`)

- Read-only. `verifyProof` returns an observation (`key`, `value`, `height`)
  and holds no write handle.
- Trust root: chain, network, root hash and validity window. Header age is
  fenced by `maxHeaderAgeMs`.
- Counters (`verified`, `rejected`) use private backing fields and cannot be
  reset externally. Flag-off returns `disabled` without touching them.

## Testing

```bash
npm run flags:check
npm run drill:kill-switch
npm run test
```
