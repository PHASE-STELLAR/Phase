import { getDb } from "@/lib/sqlite-db";
import { readVeLock } from "@/lib/ve-phaselq";
import { incSecurityCounter } from "@/lib/security-counters";

export const GAUGE_EPOCH_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

export type GaugeVoteEntry = {
  collectionId: number;
  weightPct: number; // 1 to 100
};

export type GaugeVoteRecord = {
  id: string;
  epoch: number;
  wallet: string;
  collectionId: number;
  weightBps: number;
  effectiveVeWeight: number;
  updatedAt: number;
};

export type GaugeEpochAggregate = {
  epoch: number;
  collectionId: number;
  totalVeWeight: number;
  allocatedBudgetStroops: string;
};

/**
 * Derives current weekly epoch sequence number.
 */
export function getGaugeEpochId(timestampMs = Date.now()): number {
  return Math.floor(timestampMs / GAUGE_EPOCH_MS);
}

/**
 * Casts ve-weighted gauge votes allocating emission share across collections for an epoch.
 */
export function castGaugeVote(
  wallet: string,
  votes: GaugeVoteEntry[],
  nowMs = Date.now(),
): { ok: boolean; records?: GaugeVoteRecord[]; error?: string } {
  const normWallet = wallet.trim().toLowerCase();
  if (!normWallet) return { ok: false, error: "Missing wallet address" };

  if (!votes || votes.length === 0) {
    return { ok: false, error: "Must specify at least one collection gauge vote" };
  }

  // Validate percentage allocation
  const totalPct = votes.reduce((acc, v) => acc + (v.weightPct || 0), 0);
  if (totalPct <= 0 || totalPct > 100) {
    return { ok: false, error: `Total vote weight must be between 1 and 100% (got ${totalPct}%)` };
  }

  const ve = readVeLock(normWallet, nowMs);
  if (!ve || ve.veWeight <= 0) {
    return { ok: false, error: "Active ve-PHASELQ lock required to participate in gauge voting" };
  }

  const epoch = getGaugeEpochId(nowMs);
  const db = getDb();

  // Clear any existing votes for this wallet in the current epoch before recording new ones
  db.prepare("DELETE FROM gauge_votes WHERE wallet = ? AND epoch = ?").run(normWallet, epoch);

  const records: GaugeVoteRecord[] = [];

  for (const v of votes) {
    if (v.weightPct <= 0) continue;
    const bps = Math.round(v.weightPct * 100);
    const effectiveVe = Math.round((ve.veWeight * (v.weightPct / 100)) * 10_000) / 10_000;
    const voteId = `${epoch}:${normWallet}:${v.collectionId}`;

    db.prepare(`
      INSERT INTO gauge_votes (id, epoch, wallet, collection_id, weight_bps, effective_ve_weight, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      voteId,
      epoch,
      normWallet,
      v.collectionId,
      bps,
      effectiveVe,
      nowMs,
    );

    records.push({
      id: voteId,
      epoch,
      wallet: normWallet,
      collectionId: v.collectionId,
      weightBps: bps,
      effectiveVeWeight: effectiveVe,
      updatedAt: nowMs,
    });
  }

  // Recalculate epoch aggregates for affected collections
  recomputeEpochAggregates(epoch);

  incSecurityCounter("gauge_vote_cast");
  return { ok: true, records };
}

/**
 * Recomputes aggregate ve-weights per collection for a given epoch.
 */
export function recomputeEpochAggregates(epoch = getGaugeEpochId()): void {
  const db = getDb();
  const rows = db.prepare(`
    SELECT collection_id, SUM(effective_ve_weight) as total_weight
    FROM gauge_votes
    WHERE epoch = ?
    GROUP BY collection_id
  `).all(epoch) as Array<{ collection_id: number; total_weight: number }>;

  for (const row of rows) {
    db.prepare(`
      INSERT INTO gauge_epoch_aggregates (epoch, collection_id, total_ve_weight, allocated_budget_stroops)
      VALUES (?, ?, ?, '0')
      ON CONFLICT(epoch, collection_id) DO UPDATE SET
        total_ve_weight = excluded.total_ve_weight
    `).run(epoch, row.collection_id, row.total_weight);
  }
}

/**
 * Apportions total weekly emission budget according to final gauge votes.
 */
export function distributeEpochEmissions(
  epoch: number,
  totalEmissionStroops: bigint,
): GaugeEpochAggregate[] {
  recomputeEpochAggregates(epoch);
  const db = getDb();

  const rows = db.prepare(`
    SELECT epoch, collection_id, total_ve_weight, allocated_budget_stroops
    FROM gauge_epoch_aggregates
    WHERE epoch = ?
  `).all(epoch) as Array<{ epoch: number; collection_id: number; total_ve_weight: number; allocated_budget_stroops: string }>;

  const sumWeight = rows.reduce((acc, r) => acc + r.total_ve_weight, 0);
  const updated: GaugeEpochAggregate[] = [];

  for (const r of rows) {
    let budgetStroops = 0n;
    if (sumWeight > 0) {
      const share = BigInt(Math.floor((r.total_ve_weight / sumWeight) * Number(totalEmissionStroops)));
      budgetStroops = share;
    }

    db.prepare(`
      UPDATE gauge_epoch_aggregates
      SET allocated_budget_stroops = ?
      WHERE epoch = ? AND collection_id = ?
    `).run(budgetStroops.toString(), epoch, r.collection_id);

    updated.push({
      epoch,
      collectionId: r.collection_id,
      totalVeWeight: r.total_ve_weight,
      allocatedBudgetStroops: budgetStroops.toString(),
    });
  }

  incSecurityCounter("gauge_epoch_distributed");
  return updated;
}

/**
 * Reads votes cast by a wallet for an epoch.
 */
export function readWalletGaugeVotes(wallet: string, epoch = getGaugeEpochId()): GaugeVoteRecord[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM gauge_votes
    WHERE wallet = ? AND epoch = ?
  `).all(wallet.toLowerCase(), epoch) as any[];

  return rows.map((r) => ({
    id: r.id,
    epoch: Number(r.epoch),
    wallet: r.wallet,
    collectionId: Number(r.collection_id),
    weightBps: Number(r.weight_bps),
    effectiveVeWeight: Number(r.effective_ve_weight),
    updatedAt: Number(r.updated_at),
  }));
}

/**
 * Reads all collection aggregates for an epoch.
 */
export function readEpochAggregates(epoch = getGaugeEpochId()): GaugeEpochAggregate[] {
  recomputeEpochAggregates(epoch);
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM gauge_epoch_aggregates
    WHERE epoch = ?
    ORDER BY total_ve_weight DESC
  `).all(epoch) as any[];

  return rows.map((r) => ({
    epoch: Number(r.epoch),
    collectionId: Number(r.collection_id),
    totalVeWeight: Number(r.total_ve_weight),
    allocatedBudgetStroops: r.allocated_budget_stroops,
  }));
}

/**
 * Reads the allocated quest emission budget for a specific collection.
 */
export function getCollectionQuestBudget(
  collectionId: number,
  epoch = getGaugeEpochId(),
): { totalBudgetStroops: bigint; veWeight: number } {
  const db = getDb();
  const row = db.prepare(`
    SELECT total_ve_weight, allocated_budget_stroops
    FROM gauge_epoch_aggregates
    WHERE epoch = ? AND collection_id = ?
  `).get(epoch, collectionId) as any;

  if (!row) {
    return { totalBudgetStroops: 0n, veWeight: 0 };
  }

  return {
    totalBudgetStroops: BigInt(row.allocated_budget_stroops || "0"),
    veWeight: Number(row.total_ve_weight || 0),
  };
}
