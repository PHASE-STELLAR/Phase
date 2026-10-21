import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  applyMobileViewportFit,
  clearPendingReturnFlow,
  consumePendingReturnFlow,
  detectMobileEnvironment,
  friendbotOpenStrategy,
  friendbotUrl,
  freighterMobileSupport,
  hasFreighterInjection,
  installKeyboardAvoidance,
  isFreighterMobile171Enabled,
  isFreighterMobileApp,
  keyboardInsetPx,
  mobileViewportMeta,
  openFriendbot,
  RETURN_FLOW_TTL_MS,
  setPendingReturnFlow,
} from "@/lib/freighter-mobile";
import type { StorageLike } from "@/lib/types/freighter-mobile";

const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPHONE_FREIGHTER_IN_APP =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Freighter/1.0 Mobile/15E148 Safari/604.1";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
const DESKTOP_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data: Record<string, string> = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v;
    },
    removeItem: (k) => {
      delete data[k];
    },
  };
}

/** Minimal Document stub covering only the meta tags we touch. */
function fakeDocument(existing: { name: string; content: string }[] = []) {
  const head: { name: string; content: string }[] = [];
  const created: { name: string; content: string }[] = [];
  const doc = {
    head: {
      appendChild: (el: { name: string; content: string }) => {
        head.push(el);
        created.push(el);
      },
    },
    createElement: (tag: string) => ({ name: tag, content: "" }),
    querySelector: (sel: string) => {
      const name = sel.match(/name="([^"]+)"/)?.[1] ?? "";
      return existing.find((e) => e.name === name) ?? created.find((e) => e.name === name) ?? null;
    },
  };
  return doc as unknown as Document;
}

describe("phase-171 Freighter mobile support", () => {
  const originalFlag = process.env.FEATURE_PHASE_171;

  beforeEach(() => {
    process.env.FEATURE_PHASE_171 = "1";
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.FEATURE_PHASE_171;
    else process.env.FEATURE_PHASE_171 = originalFlag;
  });

  it("checks the feature flag", () => {
    expect(isFreighterMobile171Enabled()).toBe(true);
    process.env.FEATURE_PHASE_171 = "0";
    expect(isFreighterMobile171Enabled()).toBe(false);
  });

  it("classifies mobile browser user agents", () => {
    const iphone = detectMobileEnvironment(IPHONE_SAFARI);
    expect(iphone.isMobileBrowser).toBe(true);
    expect(iphone.platform).toBe("ios");
    expect(iphone.isFreighterInAppBrowser).toBe(false);
    expect(iphone.isDesktop).toBe(false);

    const android = detectMobileEnvironment(ANDROID_CHROME);
    expect(android.isMobileBrowser).toBe(true);
    expect(android.platform).toBe("android");

    const desktop = detectMobileEnvironment(DESKTOP_CHROME);
    expect(desktop.isDesktop).toBe(true);
    expect(desktop.isMobileBrowser).toBe(false);
  });

  it("detects the Freighter in-app browser via UA token", () => {
    const env = detectMobileEnvironment(IPHONE_FREIGHTER_IN_APP);
    expect(env.isMobileBrowser).toBe(true);
    expect(env.isFreighterInAppBrowser).toBe(true);
  });

  it("exposes the isFreighterMobileApp check named in the spike", () => {
    expect(isFreighterMobileApp(IPHONE_FREIGHTER_IN_APP)).toBe(true);
    expect(isFreighterMobileApp(IPHONE_SAFARI)).toBe(false);
    expect(isFreighterMobileApp(DESKTOP_CHROME)).toBe(false);
    expect(isFreighterMobileApp("")).toBe(false); // server/SSR-safe
  });

  it("treats empty/undefined UA as desktop (server-safe)", () => {
    expect(detectMobileEnvironment(undefined).isDesktop).toBe(true);
    expect(detectMobileEnvironment("").isDesktop).toBe(true);
    expect(detectMobileEnvironment(null).isDesktop).toBe(true);
  });

  it("detects injected Freighter API", () => {
    expect(hasFreighterInjection({ freighterApi: {} })).toBe(true);
    expect(hasFreighterInjection({})).toBe(false);
    expect(hasFreighterInjection(undefined)).toBe(false);
  });

  it("produces the full support matrix", () => {
    const desktop = detectMobileEnvironment(DESKTOP_CHROME);
    expect(freighterMobileSupport(desktop, true).mode).toBe("extension");
    expect(freighterMobileSupport(desktop, false).supported).toBe(false);

    const inApp = detectMobileEnvironment(IPHONE_FREIGHTER_IN_APP);
    const inAppOk = freighterMobileSupport(inApp, true);
    expect(inAppOk.supported).toBe(true);
    expect(inAppOk.mode).toBe("in-app");
    expect(freighterMobileSupport(inApp, false).supported).toBe(false);

    const plainMobile = detectMobileEnvironment(IPHONE_SAFARI);
    const plain = freighterMobileSupport(plainMobile, false);
    expect(plain.supported).toBe(false);
    expect(plain.mode).toBe("walletconnect-required");
    expect(plain.reason).toMatch(/WalletConnect/);
  });

  it("emits viewport-fit and theme-color meta values", () => {
    const meta = mobileViewportMeta();
    expect(meta.viewport).toContain("viewport-fit=cover");
    expect(meta.themeColor).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("applies viewport-fit idempotently and preserves existing directives", () => {
    const doc1 = fakeDocument();
    expect(applyMobileViewportFit(doc1)).toBe(true);
    expect(applyMobileViewportFit(doc1)).toBe(false);

    const existing = [{ name: "viewport", content: "initial-scale=1" }];
    const doc2 = fakeDocument(existing);
    expect(applyMobileViewportFit(doc2)).toBe(true);
    expect(existing[0].content).toContain("initial-scale=1");
    expect(existing[0].content).toContain("viewport-fit=cover");

    expect(applyMobileViewportFit(undefined)).toBe(false); // no document on the server
  });

  it("builds the friendbot URL with an encoded address", () => {
    expect(friendbotUrl("GABC")).toBe("https://friendbot.stellar.org/?addr=GABC");
    expect(friendbotUrl("G A/B")).toBe("https://friendbot.stellar.org/?addr=G%20A%2FB");
  });

  it("picks the friendbot open strategy per environment", () => {
    expect(friendbotOpenStrategy(DESKTOP_CHROME)).toBe("new-tab");
    expect(friendbotOpenStrategy(IPHONE_SAFARI)).toBe("same-tab");
    expect(friendbotOpenStrategy(IPHONE_FREIGHTER_IN_APP)).toBe("same-tab");
  });

  it("navigates same-tab on mobile without window.open", () => {
    const seen: string[] = [];
    const strategy = openFriendbot("GXYZ", ANDROID_CHROME, (u) => seen.push(u));
    expect(strategy).toBe("same-tab");
    expect(seen).toEqual(["https://friendbot.stellar.org/?addr=GXYZ"]);
  });

  it("computes the keyboard inset with clamping", () => {
    expect(keyboardInsetPx(400, 800)).toBe(400);
    expect(keyboardInsetPx(800, 800)).toBe(0);
    expect(keyboardInsetPx(900, 800)).toBe(0); // zoomed visualViewport never goes negative
    expect(keyboardInsetPx(NaN, 800)).toBe(0);
    expect(keyboardInsetPx(400.4, 800.6)).toBe(400);
  });

  it("installs keyboard avoidance against visualViewport and cleans up", () => {
    const listeners: Record<string, Function[]> = { resize: [], scroll: [] };
    const insets: number[] = [];
    const vv = {
      height: 800,
      addEventListener: (t: string, fn: Function) => listeners[t].push(fn),
      removeEventListener: (t: string, fn: Function) => {
        listeners[t] = listeners[t].filter((f) => f !== fn);
      },
    };
    const win = { innerHeight: 800, visualViewport: vv } as unknown as Window & {
      visualViewport: { height: number; addEventListener: Function; removeEventListener: Function };
    };
    const stop = installKeyboardAvoidance((px) => insets.push(px), win);
    expect(insets).toEqual([0]); // initial measurement, keyboard open
    vv.height = 500;
    listeners.resize.forEach((fn) => fn());
    expect(insets).toEqual([0, 300]);
    stop();
    expect(listeners.resize.length).toBe(0);
    expect(listeners.scroll.length).toBe(0);
  });

  it("returns a no-op cleanup without visualViewport", () => {
    const stop = installKeyboardAvoidance(undefined, {} as never);
    expect(() => stop()).not.toThrow();
  });

  it("round-trips the return-flow marker", () => {
    const storage = memoryStorage();
    expect(setPendingReturnFlow("connect", "/chamber", storage)).toBe(true);
    const record = consumePendingReturnFlow(RETURN_FLOW_TTL_MS, storage, Date.now());
    expect(record).not.toBeNull();
    expect(record?.kind).toBe("connect");
    expect(record?.path).toBe("/chamber");
    // Consumed exactly once.
    expect(consumePendingReturnFlow(RETURN_FLOW_TTL_MS, storage, Date.now())).toBeNull();
  });

  it("expires stale return-flow markers", () => {
    const storage = memoryStorage();
    setPendingReturnFlow("sign", "/forge", storage);
    const raw = JSON.parse(storage.data["@Phase/freighter-return-flow"]!);
    const later = raw.started_at + RETURN_FLOW_TTL_MS + 1;
    expect(consumePendingReturnFlow(RETURN_FLOW_TTL_MS, storage, later)).toBeNull();
  });

  it("rejects corrupt return-flow markers without throwing", () => {
    const storage = memoryStorage({ "@Phase/freighter-return-flow": "{not json" });
    expect(consumePendingReturnFlow(RETURN_FLOW_TTL_MS, storage, Date.now())).toBeNull();

    const badKind = memoryStorage({
      "@Phase/freighter-return-flow": JSON.stringify({ kind: "drop", path: "/", started_at: 1 }),
    });
    expect(consumePendingReturnFlow(RETURN_FLOW_TTL_MS, badKind, Date.now())).toBeNull();

    const missingStorage = consumePendingReturnFlow(RETURN_FLOW_TTL_MS, null, Date.now());
    expect(missingStorage).toBeNull();
  });

  it("clears the return-flow marker best-effort", () => {
    const storage = memoryStorage();
    setPendingReturnFlow("connect", "/", storage);
    clearPendingReturnFlow(storage);
    expect(storage.data["@Phase/freighter-return-flow"]).toBeUndefined();
    expect(() => clearPendingReturnFlow(null)).not.toThrow();
  });
});
