export type MobilePlatform = "ios" | "android" | "other";

export interface MobileEnvironment {
  /** True for phone/tablet browsers (UA-based; see iPadOS desktop-mode caveat). */
  isMobileBrowser: boolean;
  platform: MobilePlatform;
  /** True when running inside the Freighter mobile app's in-app browser. */
  isFreighterInAppBrowser: boolean;
  /** Convenience inverse of `isMobileBrowser` for support-matrix reads. */
  isDesktop: boolean;
}

export type FreighterMobileSupportMode = "in-app" | "extension" | "walletconnect-required";

export interface FreighterMobileSupport {
  supported: boolean;
  mode: FreighterMobileSupportMode;
  reason: string;
}

/** "new-tab" keeps the app flow on desktop; "same-tab" survives in-app browsers that block popups. */
export type FriendbotOpenStrategy = "new-tab" | "same-tab";

export interface ReturnFlowRecord {
  kind: "connect" | "sign";
  path: string;
  started_at: number;
}

/** Minimal storage surface so the return-flow marker is testable without a browser. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
