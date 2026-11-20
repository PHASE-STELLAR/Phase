/**
 * phase-268 (issue #726): CI gate for edge runtime compatibility. Bundles every
 * edge entry and edge-safe module for the edge runtime, fails on any Node-only
 * import (printing the import chain), and boots each edge entry in Next's
 * edge sandbox.
 */

import { bootEdgeBundle, buildEdgeBundle, EDGE_SAFE_MODULES, findEdgeEntries } from "../lib/edge-bundle"

async function main(): Promise<void> {
  const entries = findEdgeEntries()
  let failed = false
  for (const target of [...entries, ...EDGE_SAFE_MODULES]) {
    const result = await buildEdgeBundle(target)
    if (!result.ok || !result.code) {
      failed = true
      console.error(`✗ ${target} is not edge-safe`)
      for (const { specifier, chain } of result.nodeImports) console.error(`    ${specifier} via ${chain.join(" -> ")}`)
      for (const error of result.errors) console.error(`    ${error}`)
      continue
    }
    if (entries.includes(target)) {
      try {
        bootEdgeBundle(result.code)
        console.log(`✓ ${target} bundles and boots on the edge runtime`)
      } catch (error) {
        failed = true
        console.error(`✗ ${target} bundles but fails to boot on the edge runtime: ${String(error)}`)
      }
    } else {
      console.log(`✓ ${target} is edge-safe`)
    }
  }
  if (failed) process.exit(1)
}

void main()
