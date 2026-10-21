import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const scratch = mkdtempSync(path.join(tmpdir(), "phase-mcp-test-"))
process.env.PHASE_DATA_DIR = scratch
process.env.PHASE_DATA_ROOT = scratch
process.env.NEXT_PUBLIC_FEATURE_PHASE_152 = "1"
process.env.FEATURE_PHASE_152 = "1"

import {
  listMcpTools,
  executeMcpTool,
  handleMcpRpc,
} from "@/lib/mcp-server"
import { getSecurityCounter, resetSecurityCounters } from "@/lib/security-counters"

function testToolList() {
  resetSecurityCounters()
  const tools = listMcpTools()
  assert.ok(tools.length >= 4)
  const names = tools.map((t) => t.name)
  assert.ok(names.includes("phase_query_signals"))
  assert.ok(names.includes("phase_get_world_lore"))
  assert.ok(names.includes("phase_check_ledger_balance"))
  assert.ok(names.includes("phase_get_market_offers"))
  assert.ok(getSecurityCounter("mcp_tools_listed") >= 1)
}

async function testRpcDispatch() {
  resetSecurityCounters()

  // tools/list RPC
  const listRes = await handleMcpRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
  })
  assert.equal(listRes.jsonrpc, "2.0")
  assert.equal(listRes.id, 1)
  assert.ok(listRes.result.tools.length >= 4)

  // tools/call RPC
  const callRes = await handleMcpRpc({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "phase_get_world_lore",
      arguments: { collection_id: 12 },
    },
  })
  assert.equal(callRes.id, 2)
  assert.ok(callRes.result)
  assert.ok(callRes.result.content[0].text.includes("Collection #12"))
  assert.ok(getSecurityCounter("mcp_tool_calls_executed") >= 1)

  // invalid tool call RPC
  const errRes = await handleMcpRpc({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "non_existent_tool" },
  })
  assert.equal(errRes.id, 3)
  assert.ok(errRes.error)
}

testToolList()
testRpcDispatch()
