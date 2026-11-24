import { getDb } from "@/lib/sqlite-db";
import { incSecurityCounter } from "@/lib/security-counters";
import { randomUUID } from "node:crypto";

export type MarketMakerQuote = {
  id: string;
  agentWallet: string;
  collectionId: number;
  bidPriceStroops: string;
  askPriceStroops: string;
  bidSize: number;
  askSize: number;
  inventoryUnits: number;
  maxInventoryUnits: number;
  status: "ACTIVE" | "CANCELLED" | "EXHAUSTED";
  updatedAt: number;
};

export type QuoteCalculation = {
  bidPriceStroops: string;
  askPriceStroops: string;
  spreadBps: number;
  inventorySkewPct: number;
  inventoryLimitExceeded: boolean;
};

/**
 * Calculates skewed two-sided quotes based on mid-price, base spread, and inventory level.
 */
export function calculateAgentQuotes(
  midPriceStroops: bigint,
  baseSpreadBps = 400, // 4.0% base spread
  inventoryUnits = 0,
  maxInventoryUnits = 10,
): QuoteCalculation {
  if (midPriceStroops <= 0n) throw new Error("midPriceStroops must be positive");
  if (maxInventoryUnits <= 0) throw new Error("maxInventoryUnits must be positive");

  const inventoryLimitExceeded = inventoryUnits >= maxInventoryUnits;
  const inventorySkewPct = Math.round((inventoryUnits / maxInventoryUnits) * 100);

  // If long inventory: shade quotes downward to encourage selling and discourage buying
  // skewAdjustment ranges up to 200 bps
  const skewAdjustmentBps = Math.round(((inventoryUnits - maxInventoryUnits / 2) / maxInventoryUnits) * 200);

  const halfSpreadBps = BigInt(Math.max(50, Math.floor(baseSpreadBps / 2)));
  const skewBps = BigInt(skewAdjustmentBps);

  // bid = mid * (10000 - halfSpread - skew) / 10000
  const bidFactor = 10000n - halfSpreadBps - skewBps;
  const bidPrice = (midPriceStroops * (bidFactor > 0n ? bidFactor : 100n)) / 10000n;

  // ask = mid * (10000 + halfSpread - skew) / 10000
  const askFactor = 10000n + halfSpreadBps - skewBps;
  const askPrice = (midPriceStroops * askFactor) / 10000n;

  return {
    bidPriceStroops: bidPrice.toString(),
    askPriceStroops: askPrice.toString(),
    spreadBps: baseSpreadBps,
    inventorySkewPct,
    inventoryLimitExceeded,
  };
}

/**
 * Publishes an agent market making quote with inventory boundary checks.
 */
export function publishAgentQuote(params: {
  agentWallet: string;
  collectionId: number;
  midPriceStroops: bigint;
  bidSize: number;
  askSize: number;
  inventoryUnits: number;
  maxInventoryUnits: number;
  baseSpreadBps?: number;
  nowMs?: number;
}): { ok: boolean; quote?: MarketMakerQuote; error?: string } {
  const now = params.nowMs ?? Date.now();
  const normWallet = params.agentWallet.trim().toLowerCase();

  const calc = calculateAgentQuotes(
    params.midPriceStroops,
    params.baseSpreadBps ?? 400,
    params.inventoryUnits,
    params.maxInventoryUnits,
  );

  if (calc.inventoryLimitExceeded && params.bidSize > 0) {
    incSecurityCounter("agent_inventory_limit_breaches");
    return {
      ok: false,
      error: `Inventory limit breached: holding ${params.inventoryUnits}/${params.maxInventoryUnits} units. Cannot place bid.`,
    };
  }

  const id = `quote_${randomUUID().slice(0, 12)}`;
  const db = getDb();

  db.prepare(`
    INSERT INTO agent_market_maker_quotes (
      id, agent_wallet, collection_id, bid_price_stroops, ask_price_stroops,
      bid_size, ask_size, inventory_units, max_inventory_units, status, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)
  `).run(
    id,
    normWallet,
    params.collectionId,
    calc.bidPriceStroops,
    calc.askPriceStroops,
    calc.inventoryLimitExceeded ? 0 : params.bidSize,
    params.askSize,
    params.inventoryUnits,
    params.maxInventoryUnits,
    now,
  );

  incSecurityCounter("agent_quotes_published");

  return {
    ok: true,
    quote: {
      id,
      agentWallet: normWallet,
      collectionId: params.collectionId,
      bidPriceStroops: calc.bidPriceStroops,
      askPriceStroops: calc.askPriceStroops,
      bidSize: calc.inventoryLimitExceeded ? 0 : params.bidSize,
      askSize: params.askSize,
      inventoryUnits: params.inventoryUnits,
      maxInventoryUnits: params.maxInventoryUnits,
      status: "ACTIVE",
      updatedAt: now,
    },
  };
}

/**
 * Retrieves quotes filtered by collection and/or agent wallet.
 */
export function getAgentQuotes(collectionId?: number, agentWallet?: string): MarketMakerQuote[] {
  const db = getDb();
  let query = "SELECT * FROM agent_market_maker_quotes WHERE status = 'ACTIVE'";
  const args: any[] = [];

  if (collectionId !== undefined) {
    query += " AND collection_id = ?";
    args.push(collectionId);
  }
  if (agentWallet) {
    query += " AND agent_wallet = ?";
    args.push(agentWallet.trim().toLowerCase());
  }

  query += " ORDER BY updated_at DESC LIMIT 50";
  const rows = db.prepare(query).all(...args) as any[];

  return rows.map((r) => ({
    id: r.id,
    agentWallet: r.agent_wallet,
    collectionId: Number(r.collection_id),
    bidPriceStroops: r.bid_price_stroops,
    askPriceStroops: r.ask_price_stroops,
    bidSize: Number(r.bid_size),
    askSize: Number(r.ask_size),
    inventoryUnits: Number(r.inventory_units),
    maxInventoryUnits: Number(r.max_inventory_units),
    status: r.status,
    updatedAt: Number(r.updated_at),
  }));
}

/**
 * Cancels an active quote for an agent.
 */
export function cancelAgentQuote(quoteId: string, agentWallet: string): boolean {
  const db = getDb();
  const res = db.prepare(`
    UPDATE agent_market_maker_quotes
    SET status = 'CANCELLED', updated_at = ?
    WHERE id = ? AND agent_wallet = ?
  `).run(Date.now(), quoteId, agentWallet.trim().toLowerCase());

  return res.changes > 0;
}
