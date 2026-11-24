# Spike 686 — Model Context Protocol (MCP) Server for PHASE Tools Findings (Issue #549)

## What the issue claimed

The issue noted that agent integrations were fragmented across bespoke endpoints, requiring custom HTTP wrappers and non-standard JSON payloads for each read/write capability across signals, worlds, and market books.

## What the code actually did at spike time

- Next.js route handlers served client UI needs with varying pagination, error shapes, and query parameters.
- Autonomous LLM agents lacked a standard tool discovery and invocation interface.
- No JSON-RPC 2.0 MCP interface existed for PHASE.

## The gap that was real

AI agents and developer tooling lacked standard MCP primitives to list tools (`tools/list`) and execute protocol actions (`tools/call`) in a unified, typed protocol format.

## Delivered specification (phase-152)

1. **MCP tool definitions (`lib/mcp-server.ts`)**:
   - `phase_query_signals`: inspects recent community signals and announcements.
   - `phase_get_world_lore`: reads narrative world lore and active entities.
   - `phase_check_ledger_balance`: verifies wallet presence and attribution records.
   - `phase_get_market_offers`: queries active secondary quotes and offer books.
2. **JSON-RPC 2.0 dispatch (`lib/mcp-server.ts`)**:
   - Handles `tools/list` and `tools/call` with standard input schema validation and error codes.
3. **API endpoint (`app/api/mcp/route.ts`)**:
   - GET: Server metadata and tool discovery.
   - POST: JSON-RPC 2.0 tool execution endpoint.

## Decision & Rollback

- Gated under feature flag `phase-152` (`NEXT_PUBLIC_FEATURE_PHASE_152` / `FEATURE_PHASE_152`).
- Rollback: unset env var and restart. MCP route returns 404.
