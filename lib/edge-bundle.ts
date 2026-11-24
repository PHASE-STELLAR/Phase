/**
 * phase-268 (issue #726): builds every edge entry the way the edge runtime
 * sees it and proves the bundle has no Node-only imports and boots.
 *
 * Node-only (uses esbuild and Next's compiled edge-runtime sandbox); run by
 * `scripts/check-edge-runtime.cts` in CI and by the unit tests.
 *
 * - Entries: `middleware.ts` / `proxy.ts`, every `app/` file that declares
 *   `export const runtime = "edge"`, and EDGE_SAFE_MODULES, the shared helpers
 *   edge code is allowed to import.
 * - Bundling uses the `edge-light` / `worker` export conditions and defines
 *   `process.env.NEXT_RUNTIME` as "edge", as Next does, so branches guarded by
 *   it are dropped exactly as in a real edge build.
 * - Booting evaluates the bundle in `next/dist/compiled/edge-runtime`, the
 *   sandbox Next uses for edge code: no `require`, `Buffer`, `__dirname` or
 *   Node builtins, and only `process.env`. `next/server` is replaced by a small
 *   Web-API stand-in, because Next's own server internals only bundle through
 *   Next's compiler; what is verified is this repo's code.
 */

import fs from "node:fs"
import { builtinModules, createRequire } from "node:module"
import path from "node:path"
import { build, type Metafile, type Plugin } from "esbuild"

/** Shared modules that must stay importable from edge code. */
export const EDGE_SAFE_MODULES = [
  "lib/feature-flags.ts",
  "lib/security-counters.ts",
  "lib/decimal-amount.ts",
  "lib/stellar-network.ts",
  "lib/deep-links.ts",
  "lib/ipfs-fallback.ts",
  "lib/edge-runtime.ts",
  "lib/edge-store.ts",
  "lib/dependency-cadence-shared.ts",
] as const

const NODE_BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]))

export function isNodeOnlyImport(specifier: string): boolean {
  return specifier.startsWith("node:") || NODE_BUILTINS.has(specifier) || NODE_BUILTINS.has(specifier.split("/")[0])
}

const EDGE_RUNTIME_DECLARATION = /export\s+const\s+runtime\s*=\s*["']edge["']/

function walkApp(dir: string, root: string, out: string[]): void {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkApp(full, root, out)
    else if (/\.(ts|tsx)$/.test(entry.name) && EDGE_RUNTIME_DECLARATION.test(fs.readFileSync(full, "utf8"))) {
      out.push(path.relative(root, full))
    }
  }
}

/** Files Next.js runs on the edge runtime. */
export function findEdgeEntries(root: string = process.cwd()): string[] {
  const out = ["middleware.ts", "proxy.ts"].filter((file) => fs.existsSync(path.join(root, file)))
  walkApp(path.join(root, "app"), root, out)
  return out.sort()
}

const NEXT_SERVER_STAND_IN = `
export class NextRequest extends Request {
  constructor(input, init) {
    super(input, init)
    const url = new URL(typeof input === "string" ? input : input.url)
    url.clone = () => { const copy = new URL(url.href); copy.clone = url.clone; return copy }
    Object.defineProperty(this, "nextUrl", { value: url })
  }
}
export class NextResponse extends Response {
  static next(init) { return new NextResponse(null, init) }
  static rewrite(destination, init) {
    const response = new NextResponse(null, init)
    response.headers.set("x-middleware-rewrite", String(destination))
    return response
  }
  static redirect(url, status = 307) {
    return new NextResponse(null, { status, headers: { Location: String(url) } })
  }
  static json(body, init) { return new NextResponse(JSON.stringify(body), init) }
}
`

export type EdgeBundleResult = {
  entry: string
  ok: boolean
  /** Node-only specifiers with the import chain that reached each one. */
  nodeImports: { specifier: string; chain: string[] }[]
  errors: string[]
  code: string | null
}

function chainTo(metafile: Metafile | undefined, importer: string, entry: string): string[] {
  if (!metafile) return [importer]
  const parents = new Map<string, string>()
  const queue = [entry]
  const seen = new Set(queue)
  while (queue.length > 0) {
    const current = queue.shift() as string
    for (const dep of metafile.inputs[current]?.imports ?? []) {
      if (seen.has(dep.path)) continue
      seen.add(dep.path)
      parents.set(dep.path, current)
      queue.push(dep.path)
    }
  }
  const chain = [importer]
  let cursor = importer
  while (parents.has(cursor)) {
    cursor = parents.get(cursor) as string
    chain.unshift(cursor)
  }
  return chain
}

/** Bundles one entry for the edge runtime and records any Node-only import. */
export async function buildEdgeBundle(entry: string, root: string = process.cwd()): Promise<EdgeBundleResult> {
  const found: { specifier: string; importer: string }[] = []
  const edgeImports: Plugin = {
    name: "edge-imports",
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /^next\/server$/ }, () => ({ path: "next/server", namespace: "edge-stand-in" }))
      pluginBuild.onLoad({ filter: /.*/, namespace: "edge-stand-in" }, () => ({ contents: NEXT_SERVER_STAND_IN, loader: "js" }))
      pluginBuild.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point" || !isNodeOnlyImport(args.path)) return undefined
        found.push({ specifier: args.path, importer: path.relative(root, args.importer) })
        return { path: args.path, external: true }
      })
    },
  }
  try {
    const result = await build({
      absWorkingDir: root,
      entryPoints: [entry],
      bundle: true,
      write: false,
      metafile: true,
      platform: "neutral",
      format: "iife",
      globalName: "__edgeEntry",
      target: "es2022",
      conditions: ["edge-light", "worker", "browser"],
      mainFields: ["browser", "module", "main"],
      alias: { "@": root },
      define: { "process.env.NEXT_RUNTIME": '"edge"', "process.env.NODE_ENV": '"production"' },
      minifySyntax: true,
      logLevel: "silent",
      plugins: [edgeImports],
    })
    const nodeImports = found.map(({ specifier, importer }) => ({
      specifier,
      chain: chainTo(result.metafile, importer, entry),
    }))
    return { entry, ok: nodeImports.length === 0, nodeImports, errors: [], code: result.outputFiles[0]?.text ?? null }
  } catch (error) {
    const errors = (error as { errors?: { text: string; location?: { file: string } | null }[] }).errors
    return {
      entry,
      ok: false,
      nodeImports: found.map(({ specifier, importer }) => ({ specifier, chain: [importer] })),
      errors: errors?.map((e) => `${e.text}${e.location ? ` (${e.location.file})` : ""}`) ?? [String(error)],
      code: null,
    }
  }
}

type EdgeRuntimeInstance = { evaluate: <T = unknown>(code: string) => T }
type EdgeRuntimeCtor = new (options?: {
  extend?: (context: Record<string, unknown>) => Record<string, unknown>
}) => EdgeRuntimeInstance

function loadEdgeRuntime(): EdgeRuntimeCtor {
  const load = createRequire(path.join(process.cwd(), "package.json"))
  return (load("next/dist/compiled/edge-runtime") as { EdgeRuntime: EdgeRuntimeCtor }).EdgeRuntime
}

/** Evaluates a built edge bundle in Next's edge sandbox and returns its runtime. */
export function bootEdgeBundle(code: string, env: Record<string, string> = {}): EdgeRuntimeInstance {
  const EdgeRuntime = loadEdgeRuntime()
  const runtime = new EdgeRuntime({
    extend: (context) => {
      context.process = { env: { ...env, NEXT_RUNTIME: "edge" } }
      return context
    },
  })
  runtime.evaluate(code)
  return runtime
}
