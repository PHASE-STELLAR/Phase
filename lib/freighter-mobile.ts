"use client"

/**
 * Freighter mobile browser support with in-app UA, injection and return flow.
 * Spike 627 / Issue #490.
 *
 * The app previously assumed the desktop Freighter extension: a default
 * FREIGHTER_ID in the kit, the authModal popup, a `getNetwork` mismatch
 * label, and a clipboard + `window.open` friendbot fallback. None of those
 * hold inside the Freighter mobile app's in-app browser (injection exists but
 * popups/window.open are restricted) or in plain mobile browsers (no
 * extension injection at all).
 *
 * This module adds:
 * - user-agent detection for mobile browsers and the Freighter in-app browser
 * - injection detection (`window.freighterApi`) to pick the support path
 * - viewport-fit=cover + theme-color injection for notched devices
 * - visualViewport keyboard-inset math so fixed banners avoid the soft keyboard
 * - a friendbot open strategy that never relies on `window.open` on mobile
 * - a sessionStorage return-flow marker so the connect/sign flow can resume
 *   after the user switches to the Freighter app and back
 *
 * Not spike 556 (desktop Freighter API depth: signMessage/watchAsset/authEntry)
 * — this is mobile-app browser compatibility, no new wallet APIs.
 *
 * Feature flag: phase-171.
 * Rollback: unset NEXT_PUBLIC_FEATURE_PHASE_171 / FEATURE_PHASE_171; the
 * notice renders nothing and every helper falls back to desktop behavior.
 */

import { isFeatureEnabled } from "@/lib/feature-flags";
import type {
  FriendbotOpenStrategy,
  FreighterMobileSupport,
  MobileEnvironment,
  ReturnFlowRecord,
  StorageLike,
} from "@/lib/types/freighter-mobile";

export function isFreighterMobile171Enabled(): boolean {
  return isFeatureEnabled("phase-171");
}

const MOBILE_TOKENS = ["iphone", "ipad", "ipod", "android", "mobile"];
const IOS_TOKENS = ["iphone", "ipad", "ipod", "ios"];
const ANDROID_TOKENS = ["android"];
/** Tokens observed in the Freighter mobile app's in-app browser UA. */
const FREIGHTER_IN_APP_TOKENS = ["freighter"];

/**
 * Pure UA classifier. Kept pure so the matrix is unit-testable without a
 * browser; `currentMobileEnvironment()` wraps it with `navigator.userAgent`.
 *
 * Caveat: iPadOS 13+ reports a desktop Safari UA ("Macintosh"); it is
 * classified as desktop. The viewport-fit/keyboard helpers still work there,
 * and the notice degrades to the WalletConnect guidance path only when the
 * phone UA tokens are present.
 */
export function detectMobileEnvironment(ua: string | null | undefined): MobileEnvironment {
  const s = (ua ?? "").toLowerCase();
  const isMobileBrowser = MOBILE_TOKENS.some((t) => s.includes(t));
  const isFreighterInAppBrowser =
    isMobileBrowser && FREIGHTER_IN_APP_TOKENS.some((t) => s.includes(t));
  const platform = ANDROID_TOKENS.some((t) => s.includes(t))
    ? "android"
    : IOS_TOKENS.some((t) => s.includes(t))
      ? "ios"
      : "other";
  return {
    isMobileBrowser,
    platform,
    isFreighterInAppBrowser,
    isDesktop: !isMobileBrowser,
  };
}

/** Browser wrapper around `detectMobileEnvironment` (null on the server). */
export function currentMobileEnvironment(): MobileEnvironment | null {
  if (typeof navigator === "undefined") return null;
  return detectMobileEnvironment(navigator.userAgent);
}

/**
 * Whether this browser is the Freighter mobile app's in-app browser. This is
 * the check named in spike 627: inside it, Freighter injection is available
 * but popup/`window.open` flows are restricted.
 */
export function isFreighterMobileApp(ua?: string): boolean {
  const s = ua ?? (typeof navigator !== "undefined" ? navigator.userAgent : "");
  return detectMobileEnvironment(s).isFreighterInAppBrowser;
}

/**
 * Whether a Freighter-compatible extension is injected into this page. This
 * is the only reliable signal inside the in-app browser — the kit's
 * FreighterModule performs the same probe internally.
 */
export function hasFreighterInjection(
  win: { freighterApi?: unknown } | undefined = typeof window !== "undefined" ? (window as unknown as { freighterApi?: unknown }) : undefined,
): boolean {
  return Boolean(win && win.freighterApi);
}

/**
 * Support matrix: the in-app browser has injection but restricts popups;
 * plain mobile browsers have neither and must go through WalletConnect or the
 * Freighter app browser; desktop keeps the extension path.
 */
export function freighterMobileSupport(
  env: MobileEnvironment,
  injection: boolean,
): FreighterMobileSupport {
  if (env.isDesktop) {
    return injection
      ? { supported: true, mode: "extension", reason: "Desktop browser with Freighter extension." }
      : {
          supported: false,
          mode: "extension",
          reason: "Desktop browser without the Freighter extension injected.",
        };
  }
  if (env.isFreighterInAppBrowser) {
    return injection
      ? { supported: true, mode: "in-app", reason: "Freighter app in-app browser with injection." }
      : {
          supported: false,
          mode: "in-app",
          reason: "Freighter in-app browser without injection — update the Freighter app.",
        };
  }
  return {
    supported: false,
    mode: "walletconnect-required",
    reason:
      "Mobile browser without Freighter injection — connect via WalletConnect or open this site inside the Freighter app.",
  };
}

/**
 * viewport-fit=cover + theme-color so the in-app browser chrome blends with
 * the dark UI on notched devices.
 */
export function mobileViewportMeta(): { viewport: string; themeColor: string } {
  return {
    viewport: "width=device-width, initial-scale=1, viewport-fit=cover",
    themeColor: "#09090b",
  };
}

/**
 * Idempotently injects/updates the viewport + theme-color metas. Returns
 * true when anything changed so callers can log the adaptation. Client-only.
 */
export function applyMobileViewportFit(doc?: Document): boolean {
  const d = doc ?? (typeof document !== "undefined" ? document : undefined);
  if (!d) return false;
  const { viewport, themeColor } = mobileViewportMeta();
  let changed = false;

  let viewportMeta = d.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!viewportMeta) {
    viewportMeta = d.createElement("meta");
    viewportMeta.name = "viewport";
    d.head.appendChild(viewportMeta);
    changed = true;
  }
  const currentViewport = viewportMeta.content ?? "";
  if (!currentViewport.includes("viewport-fit=cover")) {
    // Preserve any existing directives (e.g. user-scalable) and append ours.
    viewportMeta.content = currentViewport.trim()
      ? `${currentViewport.trim().replace(/\s*$/, "")}, ${viewport}`
      : viewport;
    changed = true;
  }

  let themeMeta = d.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!themeMeta) {
    themeMeta = d.createElement("meta");
    themeMeta.name = "theme-color";
    d.head.appendChild(themeMeta);
    changed = true;
  }
  if (themeMeta.content !== themeColor) {
    themeMeta.content = themeColor;
    changed = true;
  }

  return changed;
}

/**
 * Friendbot funding for an unfunded testnet account. Desktop opens a new tab
 * (the legacy behavior); mobile — where `window.open` is frequently blocked
 * or spawned as a popup the in-app browser cannot return from — uses the
 * same tab so the redirect completes and the browser Back gesture resumes the
 * app.
 */
export function friendbotUrl(walletAddress: string): string {
  return `https://friendbot.stellar.org/?addr=${encodeURIComponent(walletAddress)}`;
}

export function friendbotOpenStrategy(ua: string | null | undefined): FriendbotOpenStrategy {
  const env = detectMobileEnvironment(ua);
  return env.isDesktop ? "new-tab" : "same-tab";
}

/**
 * Executes the friendbot funding per strategy. `navigate` defaults to
 * `window.location.assign` so the same-tab path never depends on window.open.
 */
export function openFriendbot(
  walletAddress: string,
  ua: string | null | undefined,
  nav?: (url: string) => void,
): FriendbotOpenStrategy {
  const strategy = friendbotOpenStrategy(ua);
  const url = friendbotUrl(walletAddress);
  if (strategy === "same-tab") {
    const navigate = nav ?? ((u: string) => window.location.assign(u));
    navigate(url);
    return strategy;
  }
  if (typeof window !== "undefined") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
  return strategy;
}

/**
 * Keyboard avoidance: soft keyboards shrink `visualViewport` while leaving
 * `layoutViewport` fixed, so fixed bottom banners end up behind the keyboard.
 * Pure math keeps the rounding testable.
 */
export function keyboardInsetPx(
  visualViewportHeight: number,
  layoutViewportHeight: number,
): number {
  if (!Number.isFinite(visualViewportHeight) || !Number.isFinite(layoutViewportHeight)) return 0;
  return Math.max(0, Math.round(layoutViewportHeight - visualViewportHeight));
}

/**
 * Installs visualViewport listeners that publish the keyboard inset as the
 * `--phase-keyboard-inset` CSS variable and invoke `onInset`. Returns a
 * cleanup function; a no-op on browsers without visualViewport (legacy).
 */
export function installKeyboardAvoidance(
  onInset?: (insetPx: number) => void,
  win?: Window & { visualViewport?: { height: number; addEventListener: Function; removeEventListener: Function } },
): () => void {
  const w = win ?? (typeof window !== "undefined" ? window : undefined);
  if (!w || !w.visualViewport) return () => {};
  const vv = w.visualViewport;
  const update = () => {
    const inset = keyboardInsetPx(vv.height, w.innerHeight);
    if (typeof document !== "undefined") {
      document.documentElement.style.setProperty("--phase-keyboard-inset", `${inset}px`);
    }
    onInset?.(inset);
  };
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
  update();
  return () => {
    vv.removeEventListener("resize", update);
    vv.removeEventListener("scroll", update);
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Return flow: connect/sign is interrupted when the user switches to the
// Freighter app to approve. The marker survives the round-trip so the app can
// detect an unfinished flow on focus and resume it.
// ─────────────────────────────────────────────────────────────────────────────

export const RETURN_FLOW_LS_KEY = "@Phase/freighter-return-flow";
export const RETURN_FLOW_TTL_MS = 5 * 60_000;

function defaultStorage(): StorageLike | null {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : null;
  } catch {
    return null;
  }
}

export function setPendingReturnFlow(
  kind: ReturnFlowRecord["kind"],
  path: string,
  storage: StorageLike | null = defaultStorage(),
): boolean {
  if (!storage) return false;
  const record: ReturnFlowRecord = { kind, path, started_at: Date.now() };
  try {
    storage.setItem(RETURN_FLOW_LS_KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads and clears the return-flow marker. Returns null when absent, stale
 * (older than ttlMs), or corrupt — a corrupt marker never throws into the UI.
 */
export function consumePendingReturnFlow(
  ttlMs: number = RETURN_FLOW_TTL_MS,
  storage: StorageLike | null = defaultStorage(),
  now: number = Date.now(),
): ReturnFlowRecord | null {
  if (!storage) return null;
  let raw: string | null = null;
  try {
    raw = storage.getItem(RETURN_FLOW_LS_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    storage.removeItem(RETURN_FLOW_LS_KEY);
    const parsed = JSON.parse(raw) as Partial<ReturnFlowRecord>;
    if (
      !parsed ||
      (parsed.kind !== "connect" && parsed.kind !== "sign") ||
      typeof parsed.path !== "string" ||
      typeof parsed.started_at !== "number"
    ) {
      return null;
    }
    if (now - parsed.started_at > ttlMs) return null;
    return parsed as ReturnFlowRecord;
  } catch {
    return null;
  }
}

export function clearPendingReturnFlow(storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.removeItem(RETURN_FLOW_LS_KEY);
  } catch {
    // best-effort cleanup
  }
}
