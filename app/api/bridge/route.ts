import { NextResponse, type NextRequest } from "next/server";

import {
  assertTestnetFenced,
  bridgeRoutes,
  prepareLock,
} from "@/lib/adapters/bridge/adapter";
import { MemoryBridgeStore } from "@/lib/adapters/bridge/store";
import {
  BridgeError,
  BridgePubnetFencedError,
  type BridgeCustody,
  type BridgeIntent,
  type BridgeLimits,
  type BridgeNetwork,
  type FinalityOracle,
} from "@/lib/adapters/bridge/types";
import { isFlagEnabled } from "@/lib/flags/registry";

export const dynamic = "force-dynamic";

/** Static network snapshot: the bridge cannot be flipped to pubnet at runtime. */
const NETWORK: BridgeNetwork =
  (process.env.PHASE_NETWORK ?? "testnet").trim().toLowerCase() === "pubnet"
    ? "pubnet"
    : "testnet";

function limitsFromEnv(): BridgeLimits {
  const positiveInt = (name: string, fallback: number): number => {
    const parsed = parseInt(process.env[name] ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    finalityDepth: positiveInt("PHASE_BRIDGE_FINALITY_DEPTH", 12),
    maxDriftBps: positiveInt("PHASE_BRIDGE_MAX_DRIFT_BPS", 50),
    orphanAfterMs: positiveInt("PHASE_BRIDGE_ORPHAN_AFTER_MS", 15 * 60_000),
  };
}

function disabled() {
  return NextResponse.json({ ok: false, error: "bridge_disabled" }, { status: 404 });
}

export async function GET() {
  if (!isFlagEnabled("phase-218")) return disabled();
  try {
    assertTestnetFenced(NETWORK);
  } catch (error) {
    if (error instanceof BridgePubnetFencedError) {
      return NextResponse.json({ ok: false, error: error.code }, { status: 403 });
    }
    throw error;
  }
  return NextResponse.json({ ok: true, routes: bridgeRoutes(true) });
}

export async function POST(request: NextRequest) {
  if (!isFlagEnabled("phase-218")) return disabled();
  try {
    assertTestnetFenced(NETWORK);
  } catch (error) {
    if (error instanceof BridgePubnetFencedError) {
      return NextResponse.json({ ok: false, error: error.code }, { status: 403 });
    }
    throw error;
  }

  let raw: Record<string, unknown>;
  try {
    raw = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }

  const numberField = (key: string): number =>
    typeof raw[key] === "number" && Number.isFinite(raw[key]) ? (raw[key] as number) : NaN;
  const stringField = (key: string): string =>
    typeof raw[key] === "string" ? (raw[key] as string).trim() : "";

  const intent: BridgeIntent = {
    sourceTxHash: stringField("sourceTxHash"),
    amount: numberField("amount"),
    quotedAmount: numberField("quotedAmount"),
    fee: numberField("fee"),
    maxFee: numberField("maxFee"),
    destinationEvmAddress: stringField("destinationEvmAddress"),
    stellarAccount: stringField("stellarAccount"),
    asset: stringField("asset"),
  };

  // Minting is gated behind configured server-side custody; the prepare step
  // returns only a client-signable request and never signs on the server.
  const deps = {
    store: new MemoryBridgeStore(),
    custody: {} as BridgeCustody,
    oracle: { confirmations: async () => 0 } as FinalityOracle,
    limits: limitsFromEnv(),
    network: NETWORK,
    now: () => Date.now(),
    flagEnabled: true,
  };

  try {
    const prepared = prepareLock(intent, deps);
    return NextResponse.json({ ok: true, prepared });
  } catch (error) {
    if (error instanceof BridgeError) {
      return NextResponse.json({ ok: false, error: error.code }, { status: 422 });
    }
    throw error;
  }
}
