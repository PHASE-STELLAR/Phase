import { getDb } from "@/lib/sqlite-db";
import { incSecurityCounter } from "@/lib/security-counters";

export const MIN_LOCK_WEEKS = 1;
export const MAX_LOCK_WEEKS = 208; // 4 years
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export type VeLockRecord = {
  wallet: string;
  amountStroops: string;
  lockStart: number;
  lockEnd: number;
  veWeight: number;
  lastClaimEpoch: number;
  createdAt: number;
  updatedAt: number;
};

export type VeLockResult =
  | { ok: true; lock: VeLockRecord }
  | { ok: false; error: string };

export type VeFeeClaimResult =
  | { ok: true; claimedStroops: string; epochsClaimed: number }
  | { ok: false; error: string };

/**
 * Calculates theoretical ve-weight:
 * Linear scale where 4 years (208 weeks) lock yields 100% of principal weight.
 */
export function calculateVeWeight(amountStroops: bigint, lockWeeks: number): number {
  if (amountStroops <= 0n || lockWeeks <= 0) return 0;
  const clampedWeeks = Math.min(Math.max(lockWeeks, 0), MAX_LOCK_WEEKS);
  const principal = Number(amountStroops) / 10_000_000; // in PHASELQ units
  const weight = principal * (clampedWeeks / MAX_LOCK_WEEKS);
  return Math.round(weight * 10_000) / 10_000; // 4 decimal precision
}

/**
 * Reads the current ve-lock for a wallet, computing decaying veWeight as of nowMs.
 */
export function readVeLock(wallet: string, nowMs = Date.now()): VeLockRecord | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM ve_locks WHERE wallet = ?").get(wallet.toLowerCase()) as any;
  if (!row) return null;

  const lockEnd = Number(row.lock_end);
  const remainingWeeks = Math.max(0, (lockEnd - nowMs) / WEEK_MS);
  const currentWeight = calculateVeWeight(BigInt(row.amount_stroops), remainingWeeks);

  return {
    wallet: row.wallet,
    amountStroops: row.amount_stroops,
    lockStart: Number(row.lock_start),
    lockEnd: Number(row.lock_end),
    veWeight: currentWeight,
    lastClaimEpoch: Number(row.last_claim_epoch ?? 0),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/**
 * Creates or increases/extends a ve-PHASELQ lock.
 */
export function createOrUpdateVeLock(
  wallet: string,
  amountStroops: bigint,
  lockWeeks: number,
  nowMs = Date.now(),
): VeLockResult {
  const normWallet = wallet.trim().toLowerCase();
  if (!normWallet) return { ok: false, error: "Missing wallet address" };
  if (amountStroops <= 0n) return { ok: false, error: "Lock amount must be positive" };
  if (lockWeeks < MIN_LOCK_WEEKS || lockWeeks > MAX_LOCK_WEEKS) {
    return { ok: false, error: `Lock duration must be between ${MIN_LOCK_WEEKS} and ${MAX_LOCK_WEEKS} weeks` };
  }

  const db = getDb();
  const existing = readVeLock(normWallet, nowMs);
  const lockDurationMs = Math.round(lockWeeks * WEEK_MS);

  if (!existing) {
    const lockStart = nowMs;
    const lockEnd = nowMs + lockDurationMs;
    const veWeight = calculateVeWeight(amountStroops, lockWeeks);

    db.prepare(`
      INSERT INTO ve_locks (wallet, amount_stroops, lock_start, lock_end, ve_weight, last_claim_epoch, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      normWallet,
      amountStroops.toString(),
      lockStart,
      lockEnd,
      veWeight,
      nowMs,
      nowMs,
    );

    incSecurityCounter("ve_lock_created");
    return {
      ok: true,
      lock: {
        wallet: normWallet,
        amountStroops: amountStroops.toString(),
        lockStart,
        lockEnd,
        veWeight,
        lastClaimEpoch: 0,
        createdAt: nowMs,
        updatedAt: nowMs,
      },
    };
  }

  // Extend or increase existing lock
  const newAmount = BigInt(existing.amountStroops) + amountStroops;
  const newLockEnd = Math.max(existing.lockEnd, nowMs + lockDurationMs);
  const remainingWeeks = (newLockEnd - nowMs) / WEEK_MS;
  const newWeight = calculateVeWeight(newAmount, remainingWeeks);

  db.prepare(`
    UPDATE ve_locks
    SET amount_stroops = ?, lock_end = ?, ve_weight = ?, updated_at = ?
    WHERE wallet = ?
  `).run(
    newAmount.toString(),
    newLockEnd,
    newWeight,
    nowMs,
    normWallet,
  );

  incSecurityCounter("ve_lock_extended");
  return {
    ok: true,
    lock: {
      ...existing,
      amountStroops: newAmount.toString(),
      lockEnd: newLockEnd,
      veWeight: newWeight,
      updatedAt: nowMs,
    },
  };
}

/**
 * Distributes protocol treasury fee stream into the ve-fee accumulator for an epoch.
 */
export function distributeTreasuryFees(
  epochId: number,
  feeStroops: bigint,
  nowMs = Date.now(),
): { epochId: number; feePerWeight: number; totalVeWeight: number } {
  const db = getDb();

  // Sum active ve_weights of locks that haven't expired
  const locks = db.prepare("SELECT * FROM ve_locks WHERE lock_end > ?").all(nowMs) as any[];
  let totalVeWeight = 0;
  for (const l of locks) {
    const remainingWeeks = (Number(l.lock_end) - nowMs) / WEEK_MS;
    totalVeWeight += calculateVeWeight(BigInt(l.amount_stroops), remainingWeeks);
  }

  const feePerWeight = totalVeWeight > 0 ? Number(feeStroops) / totalVeWeight : 0;

  db.prepare(`
    INSERT INTO ve_fee_distribution (epoch_id, total_fees_stroops, total_ve_weight, fee_per_weight, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(epoch_id) DO UPDATE SET
      total_fees_stroops = excluded.total_fees_stroops,
      total_ve_weight = excluded.total_ve_weight,
      fee_per_weight = excluded.fee_per_weight
  `).run(
    epochId,
    feeStroops.toString(),
    totalVeWeight,
    feePerWeight,
    nowMs,
  );

  incSecurityCounter("ve_fee_distributed");
  return { epochId, feePerWeight, totalVeWeight };
}

/**
 * Calculates accrued claimable protocol fees for a ve-locked wallet.
 */
export function calculateClaimableFees(
  wallet: string,
  nowMs = Date.now(),
): { claimableStroops: bigint; epochsCount: number; lastEpoch: number } {
  const lock = readVeLock(wallet, nowMs);
  if (!lock || lock.veWeight <= 0) {
    return { claimableStroops: 0n, epochsCount: 0, lastEpoch: 0 };
  }

  const db = getDb();
  const epochs = db.prepare(`
    SELECT epoch_id, fee_per_weight
    FROM ve_fee_distribution
    WHERE epoch_id > ?
    ORDER BY epoch_id ASC
  `).all(lock.lastClaimEpoch) as Array<{ epoch_id: number; fee_per_weight: number }>;

  let totalAccrued = 0;
  let maxEpoch = lock.lastClaimEpoch;

  for (const ep of epochs) {
    totalAccrued += lock.veWeight * ep.fee_per_weight;
    if (ep.epoch_id > maxEpoch) maxEpoch = ep.epoch_id;
  }

  return {
    claimableStroops: BigInt(Math.floor(totalAccrued)),
    epochsCount: epochs.length,
    lastEpoch: maxEpoch,
  };
}

/**
 * Claims accrued treasury fees for a ve-locked wallet and advances its last_claim_epoch checkpoint.
 */
export function claimFees(wallet: string, nowMs = Date.now()): VeFeeClaimResult {
  const normWallet = wallet.trim().toLowerCase();
  const db = getDb();
  const claimable = calculateClaimableFees(normWallet, nowMs);

  if (claimable.claimableStroops <= 0n) {
    return { ok: false, error: "No fees available to claim" };
  }

  db.prepare(`
    UPDATE ve_locks
    SET last_claim_epoch = ?, updated_at = ?
    WHERE wallet = ?
  `).run(claimable.lastEpoch, nowMs, normWallet);

  incSecurityCounter("ve_fee_claimed");
  return {
    ok: true,
    claimedStroops: claimable.claimableStroops.toString(),
    epochsClaimed: claimable.epochsCount,
  };
}

/**
 * Withdraws locked tokens if lock has expired.
 */
export function withdrawVeLock(
  wallet: string,
  nowMs = Date.now(),
): { ok: boolean; releasedStroops?: string; error?: string } {
  const normWallet = wallet.trim().toLowerCase();
  const lock = readVeLock(normWallet, nowMs);
  if (!lock) return { ok: false, error: "No active lock found" };

  if (nowMs < lock.lockEnd) {
    const daysRemaining = Math.ceil((lock.lockEnd - nowMs) / (24 * 60 * 60 * 1000));
    return { ok: false, error: `Lock is still active (${daysRemaining} days remaining)` };
  }

  // Claim any remaining fees before closing
  calculateClaimableFees(normWallet, nowMs);

  const db = getDb();
  db.prepare("DELETE FROM ve_locks WHERE wallet = ?").run(normWallet);

  return { ok: true, releasedStroops: lock.amountStroops };
}
