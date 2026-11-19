import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "vitest"
import { ESLint } from "eslint"
import {
  bootEdgeBundle,
  buildEdgeBundle,
  EDGE_SAFE_MODULES,
  findEdgeEntries,
  isNodeOnlyImport,
} from "@/lib/edge-bundle"
import { EdgeStoreUnavailableError, readServerStore, resetEdgeStoreMemory, updateServerStore } from "@/lib/edge-store"
import { getSecurityCounter, resetSecurityCounters } from "@/lib/security-counters"

const ROOT = process.cwd()

describe("phase-268 edge bundles", () => {
  it("finds the middleware as an edge entry", () => {
    assert.ok(findEdgeEntries(ROOT).includes("middleware.ts"))
  })

  it("classifies Node-only specifiers", () => {
    for (const specifier of ["node:fs", "fs", "fs/promises", "path", "node:crypto", "child_process"]) {
      assert.equal(isNodeOnlyImport(specifier), true, specifier)
    }
    for (const specifier of ["zod", "@stellar/stellar-sdk", "next/server", "@/lib/feature-flags"]) {
      assert.equal(isNodeOnlyImport(specifier), false, specifier)
    }
  })

  it("bundles every edge entry and edge-safe module without Node-only imports", async () => {
    for (const target of [...findEdgeEntries(ROOT), ...EDGE_SAFE_MODULES]) {
      const result = await buildEdgeBundle(target, ROOT)
      assert.deepEqual(result.nodeImports, [], `${target} reaches Node-only modules`)
      assert.deepEqual(result.errors, [], target)
      assert.equal(result.ok, true, target)
    }
  }, 60_000)

  it("boots the built middleware in the edge sandbox and serves a request", async () => {
    const built = await buildEdgeBundle("middleware.ts", ROOT)
    assert.ok(built.code)
    const runtime = bootEdgeBundle(built.code)
    assert.equal(runtime.evaluate("typeof require"), "undefined")
    assert.equal(runtime.evaluate("typeof Buffer"), "undefined")
    const [csp, nosniff, frame] = await runtime.evaluate<Promise<(string | null)[]>>(`(async () => {
      const response = __edgeEntry.middleware(Object.assign(new Request("https://phase.test/forge"), {
        nextUrl: new URL("https://phase.test/forge"),
      }))
      return [
        response.headers.get("content-security-policy"),
        response.headers.get("x-content-type-options"),
        response.headers.get("x-frame-options"),
      ]
    })()`)
    assert.match(String(csp), /default-src 'self'/)
    assert.equal(nosniff, "nosniff")
    assert.equal(frame, "DENY")
  }, 60_000)

  it("drops the Node branch of edge-store from the edge bundle", async () => {
    const built = await buildEdgeBundle("lib/edge-store.ts", ROOT)
    assert.equal(built.ok, true)
    assert.equal(/json-store|readFile|writeFile/.test(built.code ?? ""), false)
  }, 60_000)

  it("reports the import chain that reaches a Node builtin", async () => {
    const dir = fs.mkdtempSync(path.join(ROOT, "lib", ".edge-fixture-"))
    try {
      fs.writeFileSync(path.join(dir, "leaf.ts"), 'import { readFileSync } from "node:fs"\nexport const read = () => readFileSync("x")\n')
      fs.writeFileSync(path.join(dir, "mid.ts"), 'export { read } from "./leaf"\n')
      fs.writeFileSync(path.join(dir, "entry.ts"), 'import { read } from "./mid"\nexport const run = () => read()\n')
      const rel = path.relative(ROOT, path.join(dir, "entry.ts"))
      const result = await buildEdgeBundle(rel, ROOT)
      assert.equal(result.ok, false)
      assert.equal(result.nodeImports.length, 1)
      assert.equal(result.nodeImports[0].specifier, "node:fs")
      assert.deepEqual(
        result.nodeImports[0].chain.map((file) => path.basename(file)),
        ["entry.ts", "mid.ts", "leaf.ts"],
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it("keeps phase-protocol free of Node-only imports after the dependency-cadence split", async () => {
    const result = await buildEdgeBundle("lib/phase-protocol.ts", ROOT)
    assert.deepEqual(result.nodeImports, [])
  }, 60_000)
})

describe("phase-268 lint rule", () => {
  const eslint = new ESLint({ cwd: ROOT })

  it("covers every edge entry and edge-safe module", async () => {
    for (const file of [...findEdgeEntries(ROOT), ...EDGE_SAFE_MODULES]) {
      const config = await eslint.calculateConfigForFile(path.join(ROOT, file))
      assert.ok(config.rules?.["no-restricted-imports"], `${file} is not covered by the edge lint rule`)
      assert.ok(config.rules?.["no-restricted-globals"], `${file} is not covered by the edge lint rule`)
    }
  }, 60_000)

  it("rejects Node imports and globals in edge files", async () => {
    const [result] = await eslint.lintText(
      'import fs from "node:fs"\nimport path from "path"\nexport const x = Buffer.from(path.join(fs.realpathSync("."), __dirname))\n',
      { filePath: path.join(ROOT, "middleware.ts") },
    )
    const rules = result.messages.map((m) => m.ruleId)
    assert.equal(rules.filter((r) => r === "no-restricted-imports").length, 2)
    assert.equal(rules.filter((r) => r === "no-restricted-globals").length, 2)
  }, 60_000)

  it("leaves Node-runtime modules alone", async () => {
    const [result] = await eslint.lintText('import fs from "node:fs"\nexport const x = fs.existsSync(".")\n', {
      filePath: path.join(ROOT, "lib", "json-store.ts"),
    })
    assert.equal(result.messages.some((m) => m.ruleId === "no-restricted-imports"), false)
  }, 60_000)
})

describe("phase-268 file-backed store fallback", () => {
  let dataDir = ""

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase-edge-store-"))
    process.env.PHASE_SERVER_DATA_DIR = dataDir
    resetEdgeStoreMemory()
    resetSecurityCounters()
  })

  afterEach(() => {
    delete (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime
    delete process.env.FEATURE_PHASE_268
    delete process.env.PHASE_SERVER_DATA_DIR
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it("uses the JSON sidecar on Node", async () => {
    const write = await updateServerStore<Record<string, number>, number>("faucetClaims", () => ({}), (store) => {
      store.a = 1
      return 1
    })
    assert.deepEqual(write, { value: 1, degraded: false })
    const read = await readServerStore<Record<string, number>>("faucetClaims", () => ({}))
    assert.deepEqual(read, { value: { a: 1 }, degraded: false })
    assert.ok(fs.readdirSync(dataDir).length > 0)
  })

  it("throws EdgeStoreUnavailableError on edge with the flag off (legacy behaviour)", async () => {
    ;(globalThis as { EdgeRuntime?: unknown }).EdgeRuntime = "edge-runtime"
    await assert.rejects(readServerStore("faucetClaims", () => ({})), EdgeStoreUnavailableError)
    await assert.rejects(updateServerStore("faucetClaims", () => ({}), () => undefined), EdgeStoreUnavailableError)
  })

  it("degrades to a per-isolate memory copy on edge with the flag on", async () => {
    ;(globalThis as { EdgeRuntime?: unknown }).EdgeRuntime = "edge-runtime"
    process.env.FEATURE_PHASE_268 = "1"
    const first = await readServerStore<{ hits: number }>("faucetClaims", () => ({ hits: 0 }))
    assert.deepEqual(first, { value: { hits: 0 }, degraded: true })
    first.value.hits = 99
    const write = await updateServerStore<{ hits: number }, number>("faucetClaims", () => ({ hits: 0 }), (store) => {
      store.hits += 1
      return store.hits
    })
    assert.deepEqual(write, { value: 1, degraded: true })
    const again = await readServerStore<{ hits: number }>("faucetClaims", () => ({ hits: 0 }))
    assert.deepEqual(again, { value: { hits: 1 }, degraded: true })
    assert.equal(getSecurityCounter("edge_store_degraded"), 3)
    assert.deepEqual(fs.readdirSync(dataDir), [])
  })
})
