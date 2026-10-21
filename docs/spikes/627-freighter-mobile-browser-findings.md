# Spike 627: Freighter Mobile Browser Support with In-App UA, Injection and Return Flow

**Issue**: #490
**Type**: Advanced Integration Spike
**Feature Flag**: `phase-171` (`NEXT_PUBLIC_FEATURE_PHASE_171` / `FEATURE_PHASE_171`)
**Key Surfaces**: `lib/freighter-mobile.ts`, `components/freighter-mobile-notice.tsx`, `components/freighter-connect.tsx`

## Context & Motivation

The wallet layer assumed the desktop Freighter extension everywhere: the kit defaulted to `FREIGHTER_ID`, connection ran through the authModal popup, network mismatch surfaced via `getNetwork`, and the trustline flow used a clipboard + `window.open` friendbot fallback. Inside the Freighter mobile app's in-app browser, injection exists but popups/`window.open` are restricted; in plain mobile browsers (Safari/Chrome iOS/Android) there is no injection at all. Fixed banners ignored the soft keyboard and the viewport meta lacked `viewport-fit=cover` for notched devices.

## Key Architectural Decisions

1. **UA classification (`lib/freighter-mobile.ts`)**: `detectMobileEnvironment` is a pure function (testable without a browser) separating three worlds — desktop extension, Freighter in-app browser (`freighter` UA token on a mobile UA), and plain mobile browser. Documented caveat: iPadOS 13+ desktop-mode UAs classify as desktop.
2. **Injection-first support matrix**: `freighterMobileSupport(env, hasInjection)` decides between `in-app` (supported), `extension` (desktop), and `walletconnect-required` (plain mobile browser) — `window.freighterApi` presence is the only reliable in-app signal.
3. **Return flow via sessionStorage marker**: when a mobile connect flow is interrupted by switching to the Freighter app, `setPendingReturnFlow("connect"|"sign", path)` records the pending intent under `@Phase/freighter-return-flow` with a 5-minute TTL; `consumePendingReturnFlow` reads-and-clears exactly once and fails closed on corrupt/stale markers.
4. **Friendbot without `window.open`**: `friendbotOpenStrategy` returns `new-tab` on desktop (legacy) and `same-tab` on mobile; `openFriendbot` navigates via `location.assign` so the in-app browser completes the funding redirect and the Back gesture resumes the app.
5. **Viewport + keyboard adaptation**: `applyMobileViewportFit` idempotently injects `viewport-fit=cover` (preserving existing directives) and `theme-color`; `installKeyboardAvoidance` publishes the visualViewport delta as `--phase-keyboard-inset` so fixed bottom banners can clear the soft keyboard.

## Rollback

Unset `NEXT_PUBLIC_FEATURE_PHASE_171` / `FEATURE_PHASE_171` or set to `0`. `FreighterMobileNotice` renders nothing, no viewport/keyboard adaptation runs, and friendbot/link flows revert to the legacy desktop behavior (zero regression). No data migration — the return-flow marker is ephemeral sessionStorage.
