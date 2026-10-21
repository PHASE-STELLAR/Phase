import { getDb } from "@/lib/sqlite-db";
import { incSecurityCounter } from "@/lib/security-counters";
import { randomUUID } from "node:crypto";

export type BuybackBurnEvent = {
  id: string;
  epoch: number;
  amountSpentStroops: string;
  phaselqBurnedStroops: string;
  source: string;
  txHash: string | null;
  createdAt: number;
};

export type BuybackStats = {
  totalSpentStroops: string;
  totalBurnedStroops: string;
  eventCount: number;
  lastEvent: BuybackBurnEvent | null;
};

/**
 * Executes a programmatic buyback and burn from accumulated treasury fees.
 */
export function executeBuybackAndBurn(
  amountSpentStroops: bigint,
  source = "protocol_treasury",
  txHash: string | null = null,
  epoch?: number,
  nowMs = Date.now(),
): { ok: boolean; event?: BuybackBurnEvent; error?: string } {
  if (amountSpentStroops <= 0n) {
    return { ok: false, error: "amountSpentStroops must be positive" };
  }

  const currentEpoch = epoch ?? Math.floor(nowMs / (7 * 24 * 60 * 60 * 1000));
  // In programmatic buyback, treasury funds convert to PHASELQ and are permanently burned
  const burnedStroops = amountSpentStroops; // 1:1 nominal stroop value burned
  const id = randomUUID();

  const db = getDb();
  db.prepare(`
    INSERT INTO buyback_burn_events (id, epoch, amount_spent_stroops, phaselq_burned_stroops, source, tx_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    currentEpoch,
    amountSpentStroops.toString(),
    burnedStroops.toString(),
    source,
    txHash,
    nowMs,
  );

  incSecurityCounter("buyback_burn_executed");

  const event: BuybackBurnEvent = {
    id,
    epoch: currentEpoch,
    amountSpentStroops: amountSpentStroops.toString(),
    phaselqBurnedStroops: burnedStroops.toString(),
    source,
    txHash,
    createdAt: nowMs,
  };

  return { ok: true, event };
}

/**
 * Returns cumulative metrics on protocol buyback-and-burn operations.
 */
export function getBuybackStats(): BuybackStats {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM buyback_burn_events ORDER BY created_at DESC").all() as any[];

  let totalSpent = 0n;
  let totalBurned = 0n;

  for (const r of rows) {
    totalSpent += BigInt(r.amount_spent_stroops || "0");
    totalBurned += BigInt(r.phaselq_burned_stroops || "0");
  }

  const lastRow = rows[0];
  const lastEvent: BuybackBurnEvent | null = lastRow
    ? {
        id: lastRow.id,
        epoch: Number(lastRow.epoch),
        amountSpentStroops: lastRow.amount_spent_stroops,
        phaselqBurnedStroops: lastRow.phaselq_burned_stroops,
        source: lastRow.source,
        txHash: lastRow.tx_hash,
        createdAt: Number(lastRow.created_at),
      }
    : null;

  return {
    totalSpentStroops: totalSpent.toString(),
    totalBurnedStroops: totalBurned.toString(),
    eventCount: rows.length,
    lastEvent,
  };
}

/**
 * Lists historical buyback-and-burn events.
 */
export function listBuybackEvents(limit = 50): BuybackBurnEvent[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM buyback_burn_events ORDER BY created_at DESC LIMIT ?").all(limit) as any[];

  return rows.map((r) => ({
    id: r.id,
    epoch: Number(r.epoch),
    amountSpentStroops: r.amount_spent_stroops,
    phaselqBurnedStroops: r.phaselq_burned_stroops,
    source: r.source,
    txHash: r.tx_hash,
    createdAt: Number(r.created_at),
  }));
}
