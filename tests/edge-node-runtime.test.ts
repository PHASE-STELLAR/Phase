/**
 * #242 — Edge vs Node runtime guard for app/api routes.
 *
 * The issue reported `app/api/ipfs/[...cid]/route.ts` running on the Edge runtime
 * and crashing with "process is not defined" from `process.env` access. That
 * route declares `runtime = "nodejs"`, and so does every other route in
 * `app/api`. This test locks that in so a future Edge declaration — or a route
 * that reads server-only env without declaring a runtime — fails loudly.
 *
 * Run: npx tsx --test tests/edge-node-runtime.test.ts
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"

const API_DIR = path.join(process.cwd(), "app", "api")

function routeFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...routeFiles(full))
    else if (/^route\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

describe("app/api runtime declarations (#242)", () => {
  it("finds the route tree", () => {
    assert.ok(routeFiles(API_DIR).length > 0, "expected route files under app/api")
  })

  it("declares no Edge runtime anywhere in app/api", () => {
    const offenders: string[] = []
    for (const file of routeFiles(API_DIR)) {
      const content = fs.readFileSync(file, "utf8")
      const match = content.match(/export const runtime\s*=\s*["']([a-z]+)["']/)
      if (match && match[1] === "edge") {
        offenders.push(path.relative(process.cwd(), file))
      }
    }
    assert.deepEqual(offenders, [], `Edge runtime routes are not Edge-safe: ${offenders.join(", ")}`)
  })

  it("never puts a Node-builtin route on the Edge runtime", () => {
    // Routes importing node: builtins cannot run on Edge, where `process` and the
    // Node stdlib are undefined. Undeclared runtimes default to Node in Next.js.
    const offenders: string[] = []
    for (const file of routeFiles(API_DIR)) {
      const content = fs.readFileSync(file, "utf8")
      if (!/from "node:(fs|crypto|path|os|stream|buffer)[^"]*"/.test(content)) continue
      const declared = content.match(/export const runtime\s*=\s*["']([a-z]+)["']/)
      if (declared && declared[1] !== "nodejs") {
        offenders.push(path.relative(process.cwd(), file))
      }
    }
    assert.deepEqual(offenders, [], `Node-builtin routes must not run on Edge: ${offenders.join(", ")}`)
  })

  it("keeps the IPFS CID route on the Node runtime", () => {
    const content = fs.readFileSync(path.join(API_DIR, "ipfs", "[...cid]", "route.ts"), "utf8")
    assert.match(content, /export const runtime\s*=\s*["']nodejs["']/)
  })

  it("guards process access in the Edge-reachable IPFS modules", () => {
    // Guarded form keeps these modules importable where `process` is absent.
    for (const rel of ["lib/ipfs-fallback.ts", "lib/cid-cache.ts"]) {
      const content = fs.readFileSync(path.join(process.cwd(), rel), "utf8")
      const bareEnv = content.match(/^(?!.*typeof process).*\bprocess\.env\b.*$/m)
      assert.equal(bareEnv, null, `${rel} reads process.env without a typeof process guard`)
    }
  })
})
