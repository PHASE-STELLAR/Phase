import { incSecurityCounter } from "@/lib/security-counters";

export type ForgeFeeTier = {
  tier: number;
  name: string;
  minStakedStroops: bigint;
  discountBps: number;
  discountPct: number;
};

export const FORGE_FEE_TIERS: ForgeFeeTier[] = [
  { tier: 4, name: "Obsidian", minStakedStroops: 10_000_000_000n, discountBps: 7500, discountPct: 75 }, // 1000 PHASELQ
  { tier: 3, name: "Gold", minStakedStroops: 2_000_000_000n, discountBps: 5000, discountPct: 50 },     // 200 PHASELQ
  { tier: 2, name: "Silver", minStakedStroops: 500_000_000n, discountBps: 2500, discountPct: 25 },     // 50 PHASELQ
  { tier: 1, name: "Bronze", minStakedStroops: 100_000_000n, discountBps: 1000, discountPct: 10 },     // 10 PHASELQ
  { tier: 0, name: "Standard", minStakedStroops: 0n, discountBps: 0, discountPct: 0 },
];

export type DiscountCalculation = {
  originalFeeStroops: string;
  discountedFeeStroops: string;
  discountAppliedStroops: string;
  tier: ForgeFeeTier;
};

/**
 * Resolves the fee tier for a given amount of staked or locked PHASELQ.
 */
export function getStakedFeeTier(stakedAmountStroops: bigint): ForgeFeeTier {
  for (const t of FORGE_FEE_TIERS) {
    if (stakedAmountStroops >= t.minStakedStroops) {
      return t;
    }
  }
  return FORGE_FEE_TIERS[FORGE_FEE_TIERS.length - 1];
}

/**
 * Calculates discounted fee given base forge fee and staked amount.
 */
export function calculateDiscountedForgeFee(
  baseFeeStroops: bigint,
  stakedAmountStroops: bigint,
): DiscountCalculation {
  const tier = getStakedFeeTier(stakedAmountStroops);
  if (tier.discountBps <= 0 || baseFeeStroops <= 0n) {
    return {
      originalFeeStroops: baseFeeStroops.toString(),
      discountedFeeStroops: baseFeeStroops.toString(),
      discountAppliedStroops: "0",
      tier,
    };
  }

  const discountAmount = (baseFeeStroops * BigInt(tier.discountBps)) / 10000n;
  const discounted = baseFeeStroops - discountAmount;

  incSecurityCounter("staked_fee_discount_applied");

  return {
    originalFeeStroops: baseFeeStroops.toString(),
    discountedFeeStroops: discounted.toString(),
    discountAppliedStroops: discountAmount.toString(),
    tier,
  };
}
