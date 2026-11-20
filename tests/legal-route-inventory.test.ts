/**
 * Issue #730: Route inventory test — ensures every protected API route is
 * registered in PROTECTED_ROUTE_PATTERNS so the centralized guard applies.
 *
 * This test scans the app/api directory for route files and asserts each
 * one matches a pattern in PROTECTED_ROUTE_PATTERNS.
 *
 * Run: npx tsx tests/legal-route-inventory.test.ts
 */
import * as assert from "node:assert/strict"
import { readdirSync, existsSync } from "node:fs"
import path from "node:path"
import { PROTECTED_ROUTE_PATTERNS, isProtectedRoute } from "@/lib/legal-middleware-guard"

function findApiRoutes(baseDir: string, prefix = "/api"): string[] {
  const routes: string[] = []
  if (!existsSync(baseDir)) return routes

  for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      routes.push(...findApiRoutes(path.join(baseDir, entry.name), `${prefix}/${entry.name}`))
    } else if (entry.name === "route.ts" || entry.name === "route.tsx") {
      routes.push(prefix)
    }
  }
  return routes
}

function testRouteInventory() {
  const appApiDir = path.join(process.cwd(), "app", "api")
  const allRoutes = findApiRoutes(appApiDir)

  // Routes that are intentionally public (not protected)
  const PUBLIC_ROUTES = [
    "/api/soroban-rpc",
    "/api/health",
    "/api/metadata",
    "/api/nft-index",
    "/api/og",
    "/api/stellar.toml",
  ]

  const unregistered: string[] = []
  for (const route of allRoutes) {
    if (PUBLIC_ROUTES.includes(route)) continue
    if (!isProtectedRoute(route)) {
      unregistered.push(route)
    }
  }

  if (unregistered.length > 0) {
    console.error("✗ Unregistered protected routes found:")
    for (const r of unregistered) {
      console.error(`  ${r} — add to PROTECTED_ROUTE_PATTERNS in lib/legal-middleware-guard.ts`)
    }
    assert.fail(`${unregistered.length} route(s) not registered in PROTECTED_ROUTE_PATTERNS`)
  }

  console.log(`✓ all ${allRoutes.length} API routes are registered or explicitly public`)
}

function testProtectedRouteDetection() {
  assert.equal(isProtectedRoute("/api/world/123"), true)
  assert.equal(isProtectedRoute("/api/forge"), true)
  assert.equal(isProtectedRoute("/api/faucet"), true)
  assert.equal(isProtectedRoute("/api/health"), false)
  assert.equal(isProtectedRoute("/api/soroban-rpc"), false)
  assert.equal(isProtectedRoute("/api/metadata/1"), false)
  console.log("✓ protected route detection works correctly")
}

function testPatternListIsNotEmpty() {
  assert.ok(PROTECTED_ROUTE_PATTERNS.length > 0, "PROTECTED_ROUTE_PATTERNS must not be empty")
  console.log(`✓ PROTECTED_ROUTE_PATTERNS has ${PROTECTED_ROUTE_PATTERNS.length} patterns`)
}

async function run() {
  testPatternListIsNotEmpty()
  testProtectedRouteDetection()
  testRouteInventory()
  console.log("\nAll legal route inventory tests passed.\n")
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
