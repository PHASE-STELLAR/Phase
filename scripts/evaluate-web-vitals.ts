#!/usr/bin/env npx tsx
/**
 * phase-213 — CI web-vitals budget evaluator.
 *
 *   npx tsx scripts/evaluate-web-vitals.ts \
 *     --field tests/fixtures/rum-field-data.json \
 *     --baseline tests/fixtures/rum-baseline.json \
 *     --out .artifacts/vitals
 *
 * Reads recorded field data (closed-label RUM events), evaluates p75 per route
 * and metric against the per-route budget table, writes a markdown PR-comment
 * body plus a JSON summary, and exits non-zero when a configured regression is
 * found. With the phase-213 flag off it skips all evaluation and exits 0.
 */

import { readFile, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

/**
 * tsx's ESM loader does not apply the tsconfig `@/*` alias to standalone
 * scripts, so the shared module is loaded through its absolute file URL.
 * It has no runtime dependencies beyond the flag registry.
 */
const budgets = await import(
  pathToFileURL(path.join(process.cwd(), "lib/web-vitals-budgets.ts")).href
)
const {
  evaluateFieldData,
  formatVitalsMarkdown,
  hasRegression,
  isRumCollectorEnabled,
  parseFieldData,
  rumRollbackNote,
} = budgets

type Args = { field: string; baseline: string; out: string | null }

function parseArgs(argv: string[]): Args {
  const args: Args = {
    field: "tests/fixtures/rum-field-data.json",
    baseline: "tests/fixtures/rum-baseline.json",
    out: null,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (key === "--field" || key === "--baseline" || key === "--out") {
      const value = argv[i + 1]
      if (!value) throw new Error(`Missing value for ${key}`)
      args[key.slice(2) as keyof Args] = value
      i += 1
    } else if (key === "--help") {
      throw new Error("usage: evaluate-web-vitals.ts [--field FILE] [--baseline FILE] [--out DIR]")
    }
  }
  return args
}

async function readEvents(file: string) {
  try {
    return parseFieldData(JSON.parse(await readFile(file, "utf8")))
  } catch (error) {
    throw new Error(`Cannot read field data at ${file}: ${String(error)}`)
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))

  if (!isRumCollectorEnabled()) {
    console.log(`SKIP — ${rumRollbackNote()}`)
    return 0
  }

  const field = await readEvents(args.field)
  const baseline = await readEvents(args.baseline)
  const report = evaluateFieldData(field, baseline)
  const markdown = formatVitalsMarkdown(report)

  if (args.out) {
    await mkdir(args.out, { recursive: true })
    await writeFile(path.join(args.out, "vitals-summary.md"), markdown, "utf8")
    await writeFile(
      path.join(args.out, "vitals-summary.json"),
      JSON.stringify(report, null, 2),
      "utf8",
    )
  }

  console.log(markdown)
  return hasRegression(report) ? 1 : 0
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(String(error))
    process.exit(2)
  })
