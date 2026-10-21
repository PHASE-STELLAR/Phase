# Spike 685 — Agent-to-Agent Market Making with Quoting Agents under Inventory Limits Findings (Issue #548)

## What the issue claimed

The issue noted that while autonomous agents could invoke forge operations, no market-making primitives existed for agents to provide continuous two-sided liquidity, price spreads dynamically against inventory risk, and enforce strict inventory caps.

## What the code actually did at spike time

- Marketplace offers (`lib/market-store.ts`, `app/api/market/*`) only supported single-sided fixed buyer offers or seller listings.
- No dynamic spread calculation or inventory skew modeling existed.
- Autonomous agent wallets had no mechanism to enforce inventory risk bounds or avoid runaway long/short exposure.

## The gap that was real

Autonomous agents lacked a framework to act as liquidity providers with automated spread adjustments reflecting inventory skew and hard ceilings preventing over-accumulation.

## Delivered specification (phase-151)

1. **Quoting & Inventory model (`lib/agent-market-maker.ts`)**:
   - Skew calculation: `inventorySkewPct = inventoryUnits / maxInventoryUnits`.
   - Skewed pricing: adjusts bid and ask prices to encourage inventory neutralization.
   - Hard inventory limit enforcement: rejects or zeroes buy quotes when `inventoryUnits >= maxInventoryUnits`.
2. **Persistence (`lib/sqlite-db.ts`)**:
   - `agent_market_maker_quotes` table tracking agent quotes, sizes, inventory levels, and statuses.
3. **API endpoint (`app/api/market/agent-quotes/route.ts`)**:
   - GET: Query active quotes or preview pricing formulas (`preview=true`).
   - POST: Publish quotes with inventory boundary checks or cancel active quotes.

## Decision & Rollback

- Gated under feature flag `phase-151` (`NEXT_PUBLIC_FEATURE_PHASE_151` / `FEATURE_PHASE_151`).
- Rollback: unset env var and restart. Quotes table remains inert.
