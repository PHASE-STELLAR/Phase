/**
 * phase-213 acceptance check — the CI gate must block a deliberate regression.
 * Run with: npx tsx tests/web-vitals-gate.test.ts
 * (npm test only picks up lib/__tests__ via vitest.config.ts)
 */
import { describe, it } from "node:test"
import * as assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import path from "node:path"

const root = process.cwd()
const script = path.join(root, "scripts/evaluate-web-vitals.ts")

function runGate(field: string, flag: boolean) {
  const env = { ...process.env }
  if (flag) env.FEATURE_PHASE_213 = "1"
  else {
    delete env.FEATURE_PHASE_213
    delete env.NEXT_PUBLIC_FEATURE_PHASE_213
  }
  return spawnSync(
    path.join(root, "node_modules/.bin/tsx"),
    [
      script,
      "--field",
      path.join(root, "tests/fixtures", field),
      "--baseline",
      path.join(root, "tests/fixtures/rum-baseline.json"),
    ],
    { env, encoding: "utf8" },
  )
}

describe("phase-213 web-vitals CI gate", () => {
  it("passes the recorded good field data", () => {
    const result = runGate("rum-field-data.json", true)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /Gate: PASS/)
  })

  it("blocks a deliberate budget regression", () => {
    const result = runGate("rum-regression.json", true)
    assert.equal(result.status, 1, result.stdout + result.stderr)
    assert.match(result.stdout, /Gate: FAIL/)
  })

  it("evaluates nothing when the flag is off", () => {
    const result = runGate("rum-regression.json", false)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /SKIP/)
  })
})
