import { getDb } from "@/lib/sqlite-db";
import { incSecurityCounter } from "@/lib/security-counters";

export type BondingCurveParams = {
  collectionId: number;
  basePriceStroops: bigint;
  slopeStroops: bigint;
  currentSupply: number;
  maxSupply: number;
  reserveStroops: bigint;
};

export type MintQuote = {
  quantity: number;
  unitPriceStroops: string;
  totalPriceStroops: string;
  nextUnitPriceStroops: string;
  newSupply: number;
};

export type BurnQuote = {
  quantity: number;
  totalRefundStroops: string;
  nextUnitPriceStroops: string;
  newSupply: number;
};

/**
 * Calculates price of single unit at exact supply index s.
 * price(s) = basePrice + s * slope
 */
export function priceAtSupply(basePrice: bigint, slope: bigint, s: number): bigint {
  return basePrice + BigInt(s) * slope;
}

/**
 * Computes cost quote to mint `quantity` open editions along the bonding curve.
 */
export function quoteMint(params: BondingCurveParams, quantity = 1): MintQuote {
  if (quantity <= 0) throw new Error("Quantity must be positive");
  if (params.currentSupply + quantity > params.maxSupply) {
    throw new Error(`Exceeds maximum supply cap of ${params.maxSupply}`);
  }

  const s = params.currentSupply;
  const k = BigInt(quantity);
  const base = params.basePriceStroops;
  const slope = params.slopeStroops;

  // sum_{i=0}^{k-1} (base + (s + i) * slope) = k*base + slope * (k*s + k*(k-1)/2)
  const slopeSum = (k * BigInt(s)) + (k * (k - 1n)) / 2n;
  const totalPrice = k * base + slope * slopeSum;
  const unitPrice = priceAtSupply(base, slope, s);
  const nextUnitPrice = priceAtSupply(base, slope, s + quantity);

  return {
    quantity,
    unitPriceStroops: unitPrice.toString(),
    totalPriceStroops: totalPrice.toString(),
    nextUnitPriceStroops: nextUnitPrice.toString(),
    newSupply: s + quantity,
  };
}

/**
 * Computes refund quote to burn `quantity` open editions along the bonding curve.
 */
export function quoteBurn(params: BondingCurveParams, quantity = 1): BurnQuote {
  if (quantity <= 0) throw new Error("Quantity must be positive");
  if (params.currentSupply < quantity) {
    throw new Error("Cannot burn more editions than current supply");
  }

  const s = params.currentSupply;
  const k = BigInt(quantity);
  const base = params.basePriceStroops;
  const slope = params.slopeStroops;

  // sum_{i=1}^{k} (base + (s - i) * slope) = k*base + slope * (k*(s - k) + k*(k-1)/2)
  const slopeSum = (k * BigInt(s - quantity)) + (k * (k - 1n)) / 2n;
  const totalRefund = k * base + slope * slopeSum;
  const nextUnitPrice = priceAtSupply(base, slope, s - quantity);

  return {
    quantity,
    totalRefundStroops: totalRefund.toString(),
    nextUnitPriceStroops: nextUnitPrice.toString(),
    newSupply: s - quantity,
  };
}

/**
 * Retrieves bonding curve parameters for a collection from SQLite.
 */
export function getBondingCurveParams(collectionId: number): BondingCurveParams | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM bonding_curve_editions WHERE collection_id = ?").get(collectionId) as any;
  if (!row) return null;

  return {
    collectionId: Number(row.collection_id),
    basePriceStroops: BigInt(row.base_price_stroops || "10000000"),
    slopeStroops: BigInt(row.slope_stroops || "100000"),
    currentSupply: Number(row.current_supply || 0),
    maxSupply: Number(row.max_supply || 1000),
    reserveStroops: BigInt(row.reserve_stroops || "0"),
  };
}

/**
 * Stores or updates bonding curve parameters for a collection.
 */
export function setBondingCurveParams(params: BondingCurveParams, nowMs = Date.now()): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO bonding_curve_editions (collection_id, base_price_stroops, slope_stroops, current_supply, max_supply, reserve_stroops, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(collection_id) DO UPDATE SET
      base_price_stroops = excluded.base_price_stroops,
      slope_stroops = excluded.slope_stroops,
      current_supply = excluded.current_supply,
      max_supply = excluded.max_supply,
      reserve_stroops = excluded.reserve_stroops,
      updated_at = excluded.updated_at
  `).run(
    params.collectionId,
    params.basePriceStroops.toString(),
    params.slopeStroops.toString(),
    params.currentSupply,
    params.maxSupply,
    params.reserveStroops.toString(),
    nowMs,
  );
}

/**
 * Executes and commits a bonding curve mint against stored state.
 */
export function recordBondingCurveMint(
  collectionId: number,
  quantity = 1,
  nowMs = Date.now(),
): MintQuote {
  let params = getBondingCurveParams(collectionId);
  if (!params) {
    // Default open edition curve: base = 1 PHASELQ, slope = 0.01 PHASELQ (100k stroops)
    params = {
      collectionId,
      basePriceStroops: 10_000_000n,
      slopeStroops: 100_000n,
      currentSupply: 0,
      maxSupply: 1000,
      reserveStroops: 0n,
    };
  }

  const quote = quoteMint(params, quantity);
  params.currentSupply = quote.newSupply;
  params.reserveStroops += BigInt(quote.totalPriceStroops);
  setBondingCurveParams(params, nowMs);

  incSecurityCounter("bonding_curve_mint");
  return quote;
}

/**
 * Executes and commits a bonding curve burn against stored state.
 */
export function recordBondingCurveBurn(
  collectionId: number,
  quantity = 1,
  nowMs = Date.now(),
): BurnQuote {
  const params = getBondingCurveParams(collectionId);
  if (!params) throw new Error("Collection has no active bonding curve");

  const quote = quoteBurn(params, quantity);
  params.currentSupply = quote.newSupply;
  params.reserveStroops -= BigInt(quote.totalRefundStroops);
  setBondingCurveParams(params, nowMs);

  incSecurityCounter("bonding_curve_burn");
  return quote;
}
