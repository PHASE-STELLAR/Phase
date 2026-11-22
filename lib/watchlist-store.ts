/**
 * phase-255: Watchlist with price-drop alerts (#708).
 *
 * - Per-wallet watchlist persisted in a version-guarded JSON store
 * - Concurrent edits with a stale `expectedVersion` return 409 VERSION_CONFLICT
 * - Threshold crossing triggers one alert per wallet/item/window
 * - Price reversal above threshold resets `armed = true`
 * - Closed counters (`watchlist_mutation`, `watchlist_price_drop_alert`) & EN/ES copy
 *
 * Rollback: unset NEXT_PUBLIC_FEATURE_PHASE_255 / FEATURE_PHASE_255 —
 * watchlist route 404; rows inert.
 */

import { z } from "zod"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { readJsonFile, updateStore } from "@/lib/json-store"
import { serverDataJsonPath } from "@/lib/server-data-paths"
import { createNotification } from "@/lib/notification-store"
import { incSecurityCounter } from "@/lib/security-counters"
import { readMarketStore } from "@/lib/market-store"

export const DEFAULT_ALERT_WINDOW_MS = 60 * 60 * 1000 // 1 hour

export function isWatchlistEnabled(wallet?: string): boolean {
  return isFeatureEnabled("phase-255", wallet ? { wallet } : undefined)
}

export function watchlistRollbackNote(): string {
  return "Rollback phase-255: unset NEXT_PUBLIC_FEATURE_PHASE_255 / FEATURE_PHASE_255. Watchlist route 404; rows inert."
}

export const WatchlistUpsertSchema = z.object({
  collectionId: z.number().int().min(0),
  tokenId: z.number().int().min(0),
  targetPrice: z.number().positive().optional(),
  dropThresholdPct: z.number().min(0.1).max(99.9).optional(),
  expectedVersion: z.number().int().min(0).optional(),
})

export type WatchlistUpsertInput = z.infer<typeof WatchlistUpsertSchema>

export type WatchlistItem = {
  itemKey: string
  collectionId: number
  tokenId: number
  targetPrice?: number
  dropThresholdPct?: number
  armed: boolean
  lastPrice?: number
  lastAlertAt?: number
  lastAlertWindow?: number
  createdAt: number
  updatedAt: number
}

export type WalletWatchlist = {
  version: number
  items: WatchlistItem[]
}

export type WatchlistStore = {
  byWallet: Record<string, WalletWatchlist>
}

const DEFAULT_STORE: WatchlistStore = {
  byWallet: {},
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

export function makeWatchlistItemKey(collectionId: number, tokenId: number): string {
  return `${collectionId}:${tokenId}`
}

export async function readWatchlistStore(): Promise<WatchlistStore> {
  return readJsonFile<WatchlistStore>(serverDataJsonPath("watchlists"), DEFAULT_STORE)
}

export async function getWalletWatchlist(wallet: string): Promise<WalletWatchlist> {
  if (!isWatchlistEnabled(wallet)) return { version: 0, items: [] }
  const store = await readWatchlistStore()
  const entry = hasOwn(store.byWallet, wallet) ? store.byWallet[wallet] : undefined
  return entry ? { version: entry.version, items: [...entry.items] } : { version: 0, items: [] }
}

export type WatchlistMutationResult =
  | { ok: true; status: 200; version: number; items: WatchlistItem[] }
  | {
      ok: false
      status: 400 | 404 | 409
      code: "FLAG_DISABLED" | "INVALID_INPUT" | "VERSION_CONFLICT" | "NOT_FOUND"
      error: string
      currentVersion?: number
    }

export async function upsertWatchlistItem(
  wallet: string,
  rawInput: WatchlistUpsertInput,
  nowMs = Date.now(),
): Promise<WatchlistMutationResult> {
  if (!isWatchlistEnabled(wallet)) {
    return { ok: false, status: 404, code: "FLAG_DISABLED", error: "Watchlist disabled" }
  }

  const parsed = WatchlistUpsertSchema.safeParse(rawInput)
  if (!parsed.success) {
    return { ok: false, status: 400, code: "INVALID_INPUT", error: "Invalid watchlist item" }
  }

  const { collectionId, tokenId, targetPrice, dropThresholdPct, expectedVersion } = parsed.data
  const itemKey = makeWatchlistItemKey(collectionId, tokenId)

  return updateStore<WatchlistStore, WatchlistMutationResult>("watchlists", (store) => {
    const current: WalletWatchlist = hasOwn(store.byWallet, wallet)
      ? store.byWallet[wallet]!
      : { version: 0, items: [] }

    if (expectedVersion !== undefined && expectedVersion !== current.version) {
      incSecurityCounter("watchlist_price_drop_alert", { reason: "version_conflict" })
      return {
        ok: false,
        status: 409,
        code: "VERSION_CONFLICT",
        error: "Concurrent watchlist edit detected",
        currentVersion: current.version,
      }
    }

    const idx = current.items.findIndex((it) => it.itemKey === itemKey)
    if (idx >= 0) {
      const prev = current.items[idx]!
      current.items[idx] = {
        ...prev,
        targetPrice,
        dropThresholdPct,
        armed: true,
        updatedAt: nowMs,
      }
    } else {
      current.items.push({
        itemKey,
        collectionId,
        tokenId,
        targetPrice,
        dropThresholdPct,
        armed: true,
        createdAt: nowMs,
        updatedAt: nowMs,
      })
    }

    current.version += 1
    store.byWallet[wallet] = current
    incSecurityCounter("watchlist_mutation")
    return { ok: true, status: 200, version: current.version, items: [...current.items] }
  })
}

export async function removeWatchlistItem(
  wallet: string,
  opts: { collectionId: number; tokenId: number; expectedVersion?: number },
): Promise<WatchlistMutationResult> {
  if (!isWatchlistEnabled(wallet)) {
    return { ok: false, status: 404, code: "FLAG_DISABLED", error: "Watchlist disabled" }
  }

  const itemKey = makeWatchlistItemKey(opts.collectionId, opts.tokenId)
  return updateStore<WatchlistStore, WatchlistMutationResult>("watchlists", (store) => {
    const current: WalletWatchlist = hasOwn(store.byWallet, wallet)
      ? store.byWallet[wallet]!
      : { version: 0, items: [] }

    if (opts.expectedVersion !== undefined && opts.expectedVersion !== current.version) {
      incSecurityCounter("watchlist_price_drop_alert", { reason: "version_conflict" })
      return {
        ok: false,
        status: 409,
        code: "VERSION_CONFLICT",
        error: "Concurrent watchlist edit detected",
        currentVersion: current.version,
      }
    }

    const nextItems = current.items.filter((it) => it.itemKey !== itemKey)
    if (nextItems.length === current.items.length) {
      return { ok: false, status: 404, code: "NOT_FOUND", error: "Watchlist item not found" }
    }

    current.items = nextItems
    current.version += 1
    store.byWallet[wallet] = current
    incSecurityCounter("watchlist_mutation")
    return { ok: true, status: 200, version: current.version, items: [...current.items] }
  })
}

export type PriceDropAlert = {
  wallet: string
  itemKey: string
  collectionId: number
  tokenId: number
  previousPrice: number
  newPrice: number
  dropPct: number
  windowBucket: number
}

function crossesDropThreshold(
  item: WatchlistItem,
  previousPrice: number,
  newPrice: number,
): boolean {
  if (newPrice >= previousPrice) return false
  if (item.targetPrice !== undefined) {
    return newPrice <= item.targetPrice
  }
  if (item.dropThresholdPct !== undefined) {
    const dropPct = previousPrice > 0 ? ((previousPrice - newPrice) / previousPrice) * 100 : 0
    return dropPct >= item.dropThresholdPct
  }
  return true
}

function isPriceReversal(
  item: WatchlistItem,
  previousPrice: number,
  newPrice: number,
): boolean {
  if (item.targetPrice !== undefined) {
    return newPrice > item.targetPrice
  }
  return newPrice > previousPrice
}

/**
 * Evaluate a market price change against all watchlists.
 * - Triggers one alert per wallet/item/window on threshold crossing
 * - Resets `armed = true` when price reverses above threshold
 * - Delivers notifications outside the store lock
 */
export async function evaluateMarketPriceDrops(input: {
  collectionId: number
  tokenId: number
  previousPrice: number
  newPrice: number
  sellerWallet?: string
  tokenName?: string
  nowMs?: number
  windowMs?: number
}): Promise<{ alerts: PriceDropAlert[]; rearmedCount: number; dedupedCount: number }> {
  if (!isWatchlistEnabled()) {
    return { alerts: [], rearmedCount: 0, dedupedCount: 0 }
  }

  const nowMs = input.nowMs ?? Date.now()
  const windowMs = Math.max(1, input.windowMs ?? DEFAULT_ALERT_WINDOW_MS)
  const windowBucket = Math.floor(nowMs / windowMs)
  const itemKey = makeWatchlistItemKey(input.collectionId, input.tokenId)
  const dropPct =
    input.previousPrice > 0
      ? Number((((input.previousPrice - input.newPrice) / input.previousPrice) * 100).toFixed(2))
      : 0

  const outcome = await updateStore<
    WatchlistStore,
    { alerts: PriceDropAlert[]; rearmedCount: number; dedupedCount: number }
  >("watchlists", (store) => {
    const alerts: PriceDropAlert[] = []
    let rearmedCount = 0
    let dedupedCount = 0

    for (const wallet of Object.keys(store.byWallet)) {
      if (input.sellerWallet && wallet === input.sellerWallet) continue
      const entry = store.byWallet[wallet]
      if (!entry) continue

      for (const item of entry.items) {
        if (item.itemKey !== itemKey) continue

        if (!item.armed && isPriceReversal(item, input.previousPrice, input.newPrice)) {
          item.armed = true
          item.lastPrice = input.newPrice
          item.updatedAt = nowMs
          rearmedCount += 1
          incSecurityCounter("watchlist_price_drop_alert", { reason: "rearmed_reversal" })
          continue
        }

        if (!crossesDropThreshold(item, input.previousPrice, input.newPrice)) {
          item.lastPrice = input.newPrice
          continue
        }

        if (!item.armed || item.lastAlertWindow === windowBucket) {
          dedupedCount += 1
          incSecurityCounter("watchlist_price_drop_alert", { reason: "deduped_window" })
          continue
        }

        item.armed = false
        item.lastAlertAt = nowMs
        item.lastAlertWindow = windowBucket
        item.lastPrice = input.newPrice
        item.updatedAt = nowMs
        incSecurityCounter("watchlist_price_drop_alert", { reason: "triggered" })

        alerts.push({
          wallet,
          itemKey,
          collectionId: input.collectionId,
          tokenId: input.tokenId,
          previousPrice: input.previousPrice,
          newPrice: input.newPrice,
          dropPct,
          windowBucket,
        })
      }
    }

    return { alerts, rearmedCount, dedupedCount }
  })

  for (const alert of outcome.alerts) {
    await createNotification(
      alert.wallet,
      "watchlist_price_drop",
      {
        collectionId: alert.collectionId,
        tokenId: alert.tokenId,
        tokenName: input.tokenName ?? `Artifact #${alert.tokenId}`,
        previousPrice: alert.previousPrice,
        newPrice: alert.newPrice,
        dropPct: alert.dropPct,
      },
      { eventKey: `watchlist:${alert.wallet}:${alert.itemKey}:${alert.windowBucket}` },
    )
  }

  return outcome
}

/**
 * Compute price changes from the market store's active listings and trigger
 * watchlist alerts for any watched items whose price crossed their threshold.
 */
export async function syncWatchlistAlertsFromMarket(
  nowMs = Date.now(),
): Promise<{ evaluated: number; alertsTriggered: number }> {
  if (!isWatchlistEnabled()) return { evaluated: 0, alertsTriggered: 0 }

  const market = await readMarketStore()
  const activeByKey = new Map<string, { price: number; seller: string }>()
  for (const listing of market.listings) {
    if (listing.status !== "active") continue
    const key = makeWatchlistItemKey(0, listing.token_id)
    const prev = activeByKey.get(key)
    if (!prev || listing.price_phaselq < prev.price) {
      activeByKey.set(key, { price: listing.price_phaselq, seller: listing.seller })
    }
  }

  const store = await readWatchlistStore()
  const pairs = new Map<string, { collectionId: number; tokenId: number; previousPrice: number }>()
  for (const entry of Object.values(store.byWallet)) {
    for (const item of entry.items) {
      if (item.lastPrice !== undefined && !pairs.has(item.itemKey)) {
        pairs.set(item.itemKey, {
          collectionId: item.collectionId,
          tokenId: item.tokenId,
          previousPrice: item.lastPrice,
        })
      }
    }
  }

  let evaluated = 0
  let alertsTriggered = 0
  for (const [key, info] of pairs.entries()) {
    const active = activeByKey.get(key)
    if (!active) continue
    evaluated += 1
    const res = await evaluateMarketPriceDrops({
      collectionId: info.collectionId,
      tokenId: info.tokenId,
      previousPrice: info.previousPrice,
      newPrice: active.price,
      sellerWallet: active.seller,
      nowMs,
    })
    alertsTriggered += res.alerts.length
  }

  return { evaluated, alertsTriggered }
}
