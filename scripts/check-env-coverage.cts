/**
 * phase-266 (issue #724): CI gate for undeclared or undocumented environment
 * variables. `--write` regenerates docs/ENVIRONMENT.md from lib/env-schemas.ts.
 */

import { writeFileSync } from "node:fs"
import path from "node:path"
import { checkEnvCoverage, ENV_DOC_PATH, renderEnvDoc } from "../lib/env-coverage"

const root = process.cwd()

if (process.argv.includes("--write")) {
  writeFileSync(path.join(root, ENV_DOC_PATH), renderEnvDoc())
  console.log(`Wrote ${ENV_DOC_PATH}`)
}

const report = checkEnvCoverage(root)
for (const { name, files } of report.undeclared) {
  console.error(`✗ ${name} is read but not declared in lib/env-schemas.ts (${files.join(", ")})`)
}
for (const name of report.unused) {
  console.error(`✗ ${name} is declared in lib/env-schemas.ts but nothing reads it`)
}
for (const name of report.publicSecrets) {
  console.error(`✗ ${name} is a secret but named NEXT_PUBLIC_*, which ships it to the browser`)
}
if (report.docStale) {
  console.error(`✗ ${ENV_DOC_PATH} is out of date; run npm run env:docs`)
}
if (!report.ok) process.exit(1)
console.log("✓ Every environment variable is declared and documented.")
