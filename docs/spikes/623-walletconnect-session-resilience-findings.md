# Spike 623 — WalletConnect v2 Mobile Session Resilience with Reconnect and Chain-Switch Findings (Issue #486)

## What the issue claimed

The issue noted that WalletConnect integration had multiple critical resilience gaps:
- `WalletConnectModule` initialized with hardcoded testnet-only metadata without persistence configuration or custom `relayUrl`.
- The provider heartbeat polled `getAddress` every 30s displaying an expired-session hint without reconnect actions or socket recovery.
- The repository lacked event listeners for `session_delete`, `session_expire`, and `chainChanged`.
- There was no chain-switch guard preventing transactions when a mobile wallet was set to a divergent network.
- Deep-link return flow was missing, leaving mobile users stranded in mobile wallet apps without automatic navigation back to Phase.

## What the code actually did at spike time

- `lib/stellar-wallet-kit.ts` initialized `WalletConnectModule` with `allowedChains: [WalletConnectTargetChain.TESTNET]` only, no `relayUrl`, and no persistence metadata.
- When `getAddress()` failed in `components/wallet-provider.tsx`, the address was silently dropped with a generic text hint.
- No banner or action button allowed users to trigger re-connection with the WalletConnect relay.

## The gap that was real

Mobile users connecting via WalletConnect (e.g., LOBSTR or xBull mobile) experienced silent session drops when relay websockets disconnected in background tabs, and had no way to restore connection without restarting the entire onboarding flow.

## Delivered specification (phase-167)

1. **Configurable Relay and Multi-Chain Support (`lib/walletconnect-resilience.ts`)**:
   - `getWalletConnectRelayUrl()` resolves default `wss://relay.walletconnect.org`, fallback, or `NEXT_PUBLIC_WALLETCONNECT_RELAY_URL`.
   - `resolveAllowedChains()` supports both `stellar:testnet` and `stellar:pubnet` aligned with network configuration (`phase-163`).

2. **Session Persistence and Metadata**:
   - Stores session topic, peer metadata, expiry, and connection timestamp in localStorage (`@PHASE/wc_session_metadata`).
   - `isWcSessionExpired` checks expiry boundaries.

3. **Chain-Switch Guard**:
   - `validateWcChain` ensures active session chain matches application expectations before transaction submission.

4. **Mobile Deep Link Return**:
   - `recordMobileDeepLinkReturn` and `buildMobileWalletDeepLink` construct universal and app links for Lobstr and xBull to return to Phase smoothly after signing.

5. **UI & Banner Integration**:
   - `components/walletconnect-banner.tsx`: Dedicated status bar showing peer wallet, relay connection state, deep link button, and one-click reconnect action.
   - Telemetry endpoint: `POST /api/wallet/session`.

## Decision & Rollback

- Gated under feature flag `phase-167` (`NEXT_PUBLIC_FEATURE_PHASE_167` / `FEATURE_PHASE_167`).
- Rollback: unset env var or set to `0`/`false` and restart. Zero persistent state to revert.
