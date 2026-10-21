import { getDb } from "@/lib/sqlite-db";
import { incSecurityCounter } from "@/lib/security-counters";
import { randomUUID } from "node:crypto";

export type PredictionMarket = {
  id: string;
  question: string;
  category: string;
  collectionId: number | null;
  outcomeYesPool: string;
  outcomeNoPool: string;
  status: "active" | "resolved" | "cancelled";
  resolvedOutcome: "YES" | "NO" | null;
  closesAt: number;
  createdAt: number;
};

export type PredictionPosition = {
  id: string;
  marketId: string;
  wallet: string;
  outcome: "YES" | "NO";
  amountStroops: string;
  shares: number;
  claimed: boolean;
  createdAt: number;
};

/**
 * Creates a new binary prediction market on drop outcomes.
 */
export function createPredictionMarket(
  question: string,
  category = "drop_outcome",
  closesAt: number,
  collectionId: number | null = null,
  initialSeedStroops = 10_000_000n, // 1 PHASELQ initial seed pool
  nowMs = Date.now(),
): PredictionMarket {
  const id = `pred_${randomUUID().slice(0, 12)}`;
  const seedHalf = (initialSeedStroops / 2n).toString();

  const db = getDb();
  db.prepare(`
    INSERT INTO prediction_markets (id, question, category, collection_id, outcome_yes_pool, outcome_no_pool, status, resolved_outcome, closes_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?)
  `).run(
    id,
    question,
    category,
    collectionId,
    seedHalf,
    seedHalf,
    closesAt,
    nowMs,
  );

  incSecurityCounter("prediction_market_created");

  return {
    id,
    question,
    category,
    collectionId,
    outcomeYesPool: seedHalf,
    outcomeNoPool: seedHalf,
    status: "active",
    resolvedOutcome: null,
    closesAt,
    createdAt: nowMs,
  };
}

/**
 * Purchases prediction market outcome shares.
 */
export function buyPredictionShares(
  marketId: string,
  wallet: string,
  outcome: "YES" | "NO",
  amountStroops: bigint,
  nowMs = Date.now(),
): { ok: boolean; position?: PredictionPosition; error?: string } {
  if (amountStroops <= 0n) return { ok: false, error: "amountStroops must be positive" };
  const normWallet = wallet.trim().toLowerCase();

  const db = getDb();
  const market = db.prepare("SELECT * FROM prediction_markets WHERE id = ?").get(marketId) as any;
  if (!market) return { ok: false, error: "Market not found" };
  if (market.status !== "active") return { ok: false, error: `Market is ${market.status}` };
  if (nowMs >= Number(market.closes_at)) return { ok: false, error: "Market is closed for betting" };

  const yesPool = BigInt(market.outcome_yes_pool || "0");
  const noPool = BigInt(market.outcome_no_pool || "0");
  const totalPool = yesPool + noPool;

  // Parimutuel pricing: shares awarded based on inverse pool probability at entry
  const targetPool = outcome === "YES" ? yesPool : noPool;
  const currentRatio = targetPool > 0n ? Number(totalPool) / Number(targetPool) : 2.0;
  const shares = Math.round((Number(amountStroops) / 10_000_000) * currentRatio * 1000) / 1000;

  const posId = `pos_${randomUUID().slice(0, 12)}`;

  db.prepare(`
    INSERT INTO prediction_positions (id, market_id, wallet, outcome, amount_stroops, shares, claimed, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)
  `).run(
    posId,
    marketId,
    normWallet,
    outcome,
    amountStroops.toString(),
    shares,
    nowMs,
  );

  // Update pool sizes
  if (outcome === "YES") {
    db.prepare("UPDATE prediction_markets SET outcome_yes_pool = ? WHERE id = ?").run(
      (yesPool + amountStroops).toString(),
      marketId,
    );
  } else {
    db.prepare("UPDATE prediction_markets SET outcome_no_pool = ? WHERE id = ?").run(
      (noPool + amountStroops).toString(),
      marketId,
    );
  }

  incSecurityCounter("prediction_position_opened");

  return {
    ok: true,
    position: {
      id: posId,
      marketId,
      wallet: normWallet,
      outcome,
      amountStroops: amountStroops.toString(),
      shares,
      claimed: false,
      createdAt: nowMs,
    },
  };
}

/**
 * Resolves a prediction market with verified outcome.
 */
export function resolvePredictionMarket(
  marketId: string,
  winningOutcome: "YES" | "NO",
): { ok: boolean; error?: string } {
  const db = getDb();
  const market = db.prepare("SELECT * FROM prediction_markets WHERE id = ?").get(marketId) as any;
  if (!market) return { ok: false, error: "Market not found" };
  if (market.status !== "active") return { ok: false, error: `Market is already ${market.status}` };

  db.prepare(`
    UPDATE prediction_markets
    SET status = 'resolved', resolved_outcome = ?
    WHERE id = ?
  `).run(winningOutcome, marketId);

  incSecurityCounter("prediction_market_resolved");
  return { ok: true };
}

/**
 * Claims winnings for a winning position after market resolution.
 */
export function claimPredictionPayout(
  positionId: string,
  wallet: string,
): { ok: boolean; payoutStroops?: string; error?: string } {
  const normWallet = wallet.trim().toLowerCase();
  const db = getDb();

  const pos = db.prepare("SELECT * FROM prediction_positions WHERE id = ?").get(positionId) as any;
  if (!pos) return { ok: false, error: "Position not found" };
  if (pos.wallet !== normWallet) return { ok: false, error: "Wallet does not own position" };
  if (pos.claimed === 1) return { ok: false, error: "Position payout already claimed" };

  const market = db.prepare("SELECT * FROM prediction_markets WHERE id = ?").get(pos.market_id) as any;
  if (!market || market.status !== "resolved") {
    return { ok: false, error: "Market is not resolved yet" };
  }

  if (market.resolved_outcome !== pos.outcome) {
    return { ok: false, error: "Position was on the losing outcome" };
  }

  const yesPool = BigInt(market.outcome_yes_pool || "0");
  const noPool = BigInt(market.outcome_no_pool || "0");
  const totalPool = yesPool + noPool;
  const winningPool = market.resolved_outcome === "YES" ? yesPool : noPool;

  // Pro-rata share of total pool
  let payoutStroops = 0n;
  if (winningPool > 0n) {
    payoutStroops = (BigInt(pos.amount_stroops) * totalPool) / winningPool;
  }

  db.prepare("UPDATE prediction_positions SET claimed = 1 WHERE id = ?").run(positionId);
  incSecurityCounter("prediction_payout_claimed");

  return { ok: true, payoutStroops: payoutStroops.toString() };
}

/**
 * Lists prediction markets.
 */
export function listPredictionMarkets(status?: string): PredictionMarket[] {
  const db = getDb();
  const query = status
    ? db.prepare("SELECT * FROM prediction_markets WHERE status = ? ORDER BY created_at DESC").all(status)
    : db.prepare("SELECT * FROM prediction_markets ORDER BY created_at DESC").all();

  return (query as any[]).map((m) => ({
    id: m.id,
    question: m.question,
    category: m.category,
    collectionId: m.collection_id ? Number(m.collection_id) : null,
    outcomeYesPool: m.outcome_yes_pool,
    outcomeNoPool: m.outcome_no_pool,
    status: m.status,
    resolvedOutcome: m.resolved_outcome,
    closesAt: Number(m.closes_at),
    createdAt: Number(m.created_at),
  }));
}

/**
 * Retrieves positions for a wallet.
 */
export function getPositionsForWallet(wallet: string): PredictionPosition[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM prediction_positions WHERE wallet = ? ORDER BY created_at DESC").all(wallet.toLowerCase()) as any[];

  return rows.map((r) => ({
    id: r.id,
    marketId: r.market_id,
    wallet: r.wallet,
    outcome: r.outcome,
    amountStroops: r.amount_stroops,
    shares: Number(r.shares),
    claimed: r.claimed === 1,
    createdAt: Number(r.created_at),
  }));
}
