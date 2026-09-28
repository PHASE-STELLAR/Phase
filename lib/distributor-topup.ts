/**
 * phase-133: Faucet distributor balance auto-top-up via Mercury.
 *
 * When the distributor account (FAUCET_DISTRIBUTOR_SECRET_KEY) runs low on
 * PHASELQ or XLM, the faucet will fail for users. This module monitors the
 * distributor's PHASELQ balance and, when it drops below a configurable
 * threshold, triggers an auto-top-up from the issuer account.
 *
 * The top-up uses the existing admin mint flow (same as the faucet's own
 * mint path) but with a configurable top-up amount.
 *
 * If Mercury API is configured (MERCURY_API_KEY), balance checks use
 * Mercury's faster REST endpoint instead of Horizon. Otherwise falls back
 * to Horizon.
 *
 * Flag: NEXT_PUBLIC_FEATURE_PHASE_133 / FEATURE_PHASE_133
 * Rollback: unset the flag. No auto-top-up checks; distributor must be
 * manually topped up.
 */

import { isFeatureEnabled } from "@/lib/feature-flags"

const FLAG: "phase-133" = "phase-133"

export function isDistributorTopupEnabled(): boolean {
  return isFeatureEnabled(FLAG)
}

const DEFAULT_TOPUP_THRESHOLD_STROOPS = 100_000_000n   // 10 PHASELQ
const DEFAULT_TOPUP_AMOUNT_STROOPS = 5_000_000_000n     // 500 PHASELQ
const MIN_SIGNER_XLM_THRESHOLD = 5                       // XLM minimum before top-up

export type DistributorBalance = {
  phaseLiqStroops: bigint
  nativeXlm: number
  checkedAt: number
}

type TopupResult =
  | { ok: true; amountStroops: string; hash?: string }
  | { ok: false; reason: string }

/**
 * Fetch the distributor's PHASELQ balance via Mercury or Horizon.
 */
export async function fetchDistributorBalance(
  distributorAddress: string,
  tokenContractId: string,
): Promise<DistributorBalance | null> {
  const mercuryKey = process.env.MERCURY_API_KEY?.trim()

  if (mercuryKey) {
    try {
      return await fetchBalanceViaMercury(mercuryKey, distributorAddress, tokenContractId)
    } catch {
      // Fall through to Horizon
    }
  }

  try {
    return await fetchBalanceViaHorizon(distributorAddress, tokenContractId)
  } catch {
    return null
  }
}

async function fetchBalanceViaMercury(
  apiKey: string,
  distributorAddress: string,
  tokenContractId: string,
): Promise<DistributorBalance> {
  const res = await fetch(
    `https://api.mercurydev.tech/v1/accounts/${encodeURIComponent(distributorAddress)}/balances`,
    {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      cache: "no-store",
    },
  )
  if (!res.ok) throw new Error(`Mercury balance fetch failed: ${res.status}`)
  const data = (await res.json()) as {
    balances?: Array<{ asset_type?: string; asset_code?: string; balance?: string; contract_id?: string }>
  }
  const phaseLiq = data.balances?.find(
    (b) => b.contract_id === tokenContractId || b.asset_code === "PHASELQ",
  )
  const native = data.balances?.find((b) => b.asset_type === "native")
  return {
    phaseLiqStroops: BigInt(phaseLiq?.balance ?? "0"),
    nativeXlm: parseFloat(native?.balance ?? "0"),
    checkedAt: Date.now(),
  }
}

async function fetchBalanceViaHorizon(
  distributorAddress: string,
  tokenContractId: string,
): Promise<DistributorBalance> {
  const { HORIZON_URL } = await import("@/lib/phase-protocol")
  const res = await fetch(`${HORIZON_URL}/accounts/${encodeURIComponent(distributorAddress)}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  })
  if (!res.ok) throw new Error(`Horizon account fetch failed: ${res.status}`)
  const data = (await res.json()) as {
    balances?: Array<{ asset_type?: string; asset_code?: string; balance?: string }>
  }
  const native = data.balances?.find((b) => b.asset_type === "native")
  // For classic PHASELQ, match by code
  const phaseLiq = data.balances?.find(
    (b) => b.asset_code === "PHASELQ" && b.asset_type?.includes("credit_alphanum4"),
  )
  return {
    phaseLiqStroops: BigInt(phaseLiq?.balance ?? "0"),
    nativeXlm: parseFloat(native?.balance ?? "0"),
    checkedAt: Date.now(),
  }
}

/**
 * Check whether the distributor needs a top-up.
 */
export function distributorNeedsTopup(
  balance: DistributorBalance,
  thresholdStroops: bigint = DEFAULT_TOPUP_THRESHOLD_STROOPS,
): boolean {
  return balance.phaseLiqStroops < thresholdStroops
}

/**
 * Execute a top-up: mint PHASELQ from the issuer to the distributor.
 * This reuses the Stellar SDK mint path. The caller must ensure
 * ADMIN_SECRET_KEY is the issuer.
 *
 * Note: This function does NOT submit the transaction — it returns
 * the parameters needed for the caller to build and submit it.
 * This keeps the module free of direct SDK imports and makes it
 * testable in isolation.
 */
export async function prepareTopup(
  distributorAddress: string,
): Promise<{
  topupAmountStroops: string
  shouldTopup: boolean
  reason?: string
}> {
  if (!isDistributorTopupEnabled()) {
    return { topupAmountStroops: "0", shouldTopup: false, reason: "Feature disabled" }
  }

  const tokenContractId = process.env.NEXT_PUBLIC_PHASER_LIQ_TOKEN_CONTRACT?.trim()
  if (!tokenContractId) {
    return { topupAmountStroops: "0", shouldTopup: false, reason: "Token contract not configured" }
  }

  const balance = await fetchDistributorBalance(distributorAddress, tokenContractId)
  if (!balance) {
    return { topupAmountStroops: "0", shouldTopup: false, reason: "Could not fetch distributor balance" }
  }

  if (balance.nativeXlm < MIN_SIGNER_XLM_THRESHOLD) {
    return {
      topupAmountStroops: "0",
      shouldTopup: false,
      reason: `Distributor XLM too low (${balance.nativeXlm.toFixed(2)} XLM). Fund with Friendbot first.`,
    }
  }

  if (!distributorNeedsTopup(balance)) {
    return { topupAmountStroops: "0", shouldTopup: false, reason: "Balance sufficient" }
  }

  return {
    topupAmountStroops: DEFAULT_TOPUP_AMOUNT_STROOPS.toString(),
    shouldTopup: true,
    reason: `Distributor PHASELQ low (${balance.phaseLiqStroops} stroops). Topping up ${DEFAULT_TOPUP_AMOUNT_STROOPS} stroops.`,
  }
}
