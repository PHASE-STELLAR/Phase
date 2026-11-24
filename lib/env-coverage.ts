/**
 * phase-266 (issue #724): finds every environment variable the code reads and
 * checks it against `lib/env-schemas.ts` and `docs/ENVIRONMENT.md`.
 * `scripts/check-env-coverage.ts` runs this in CI; Node-only (reads the tree).
 */

import fs from "node:fs"
import path from "node:path"
import { DECLARED_ENV_VARS, ENV_SURFACES, isDeclaredEnvVar } from "@/lib/env-schemas"

export const ENV_SCAN_ROOTS = ["app", "lib", "components", "hooks", "middleware.ts", "instrumentation.ts", "next.config.mjs", "diagnose-env.ts"]
export const ENV_DOC_PATH = "docs/ENVIRONMENT.md"

const SOURCE_FILE = /\.(ts|tsx|mjs|js)$/
const ACCESSORS = [
  /\b(?:process\.env|env|e)\.([A-Z][A-Z0-9_]+)\b/g,
  /\b(?:process\.env|env)\[\s*["'`]([A-Z][A-Z0-9_]+)["'`]\s*\]/g,
  /\breadEnvVar\(\s*["'`]([A-Z][A-Z0-9_]+)["'`]\s*\)/g,
]

function walk(root: string, rel: string, out: string[]): void {
  const full = path.join(root, rel)
  if (!fs.existsSync(full)) return
  const stat = fs.statSync(full)
  if (stat.isFile()) {
    if (SOURCE_FILE.test(rel)) out.push(rel)
    return
  }
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "__tests__" || entry.name.startsWith(".")) continue
    walk(root, path.join(rel, entry.name), out)
  }
}

export function envScanFiles(root: string = process.cwd()): string[] {
  const out: string[] = []
  for (const entry of ENV_SCAN_ROOTS) walk(root, entry, out)
  return out.sort()
}

/** Variable name → files that read it. */
export function findReferencedEnvVars(root: string = process.cwd()): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const file of envScanFiles(root)) {
    const source = fs.readFileSync(path.join(root, file), "utf8")
    for (const pattern of ACCESSORS) {
      for (const match of source.matchAll(pattern)) {
        const name = match[1]
        const files = found.get(name) ?? []
        if (!files.includes(file)) files.push(file)
        found.set(name, files)
      }
    }
  }
  return found
}

/** The generated reference; regenerate with `npm run env:docs`. */
export function renderEnvDoc(): string {
  const lines = [
    "# Environment variables",
    "",
    "<!-- Generated from lib/env-schemas.ts by `npm run env:docs`. Do not edit by hand. -->",
    "",
    "Every variable the app reads is declared in `lib/env-schemas.ts`, one Zod schema per surface.",
    "`npm run env:check` fails CI when code reads a variable that is not declared here.",
    "With `phase-266` on, the server validates these at startup (`instrumentation.ts`) and refuses",
    "to boot on invalid configuration, conflicting passphrases, mainnet without",
    "`PHASE_MAINNET_CUTOVER_ACK=1`, or a preview holding production credentials.",
    "Variables marked **secret** must never be `NEXT_PUBLIC_*` and are fingerprinted against",
    "`PHASE_PROD_SECRET_SHA256S` on previews.",
    "",
    "Feature flags follow the pattern `NEXT_PUBLIC_FEATURE_*` / `FEATURE_*` and accept",
    "`0/1/true/false/yes/no/on/off`; see `lib/feature-flags.ts`.",
  ]
  for (const [surface, fields] of Object.entries(ENV_SURFACES)) {
    lines.push("", `## ${surface}`, "", "| Variable | Secret | Description |", "| --- | --- | --- |")
    for (const [name, spec] of Object.entries(fields)) {
      lines.push(`| \`${name}\` | ${spec.secret ? "**secret**" : ""} | ${spec.description} |`)
    }
  }
  return `${lines.join("\n")}\n`
}

export type EnvCoverageReport = {
  ok: boolean
  /** Read by the code but not declared in any schema. */
  undeclared: { name: string; files: string[] }[]
  /** Declared in a schema but never mentioned in the code. */
  unused: string[]
  /** Secrets declared under a NEXT_PUBLIC_* name, which would ship them to the browser. */
  publicSecrets: string[]
  /** docs/ENVIRONMENT.md differs from the schemas. */
  docStale: boolean
}

export function checkEnvCoverage(root: string = process.cwd()): EnvCoverageReport {
  const referenced = findReferencedEnvVars(root)
  const undeclared = [...referenced]
    .filter(([name]) => !isDeclaredEnvVar(name))
    .map(([name, files]) => ({ name, files }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const corpus = envScanFiles(root)
    .map((file) => fs.readFileSync(path.join(root, file), "utf8"))
    .join("\n")
  const unused = [...DECLARED_ENV_VARS.keys()]
    .filter((name) => !new RegExp(`\\b${name}\\b`).test(corpus))
    .sort()

  const publicSecrets = [...DECLARED_ENV_VARS]
    .filter(([name, spec]) => spec.secret && name.startsWith("NEXT_PUBLIC_"))
    .map(([name]) => name)

  const docPath = path.join(root, ENV_DOC_PATH)
  const docStale = !fs.existsSync(docPath) || fs.readFileSync(docPath, "utf8") !== renderEnvDoc()

  return {
    ok: undeclared.length === 0 && unused.length === 0 && publicSecrets.length === 0 && !docStale,
    undeclared,
    unused,
    publicSecrets,
    docStale,
  }
}
