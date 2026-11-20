import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "vitest"
import { Keypair } from "@stellar/stellar-sdk"
import { DECLARED_ENV_VARS, SECRET_ENV_VARS, validateEnvSurfaces } from "@/lib/env-schemas"
import {
  enforceEnvAtStartup,
  EnvValidationStartupError,
  validateEnvCrossRules,
  validateEnvSchemas,
} from "@/lib/env-validation"
import { checkEnvCoverage, findReferencedEnvVars, renderEnvDoc } from "@/lib/env-coverage"
import { STELLAR_PASSPHRASES } from "@/lib/stellar-network"

const TOKEN = "CDOAXHWC6YJB7U3ELV67HKJY6HEMJFBNRGJK6WZGUAELBWP3WP77RLFD"
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex")

function variables(errors: { variable: string }[]): string[] {
  return errors.map((e) => e.variable).sort()
}

afterEach(() => {
  delete process.env.FEATURE_PHASE_266
})

describe("phase-266 surface schemas", () => {
  it("accepts a typical testnet configuration", () => {
    const env = {
      STELLAR_NETWORK: "testnet",
      STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
      NEXT_PUBLIC_PHASER_TOKEN_ID: TOKEN,
      ADMIN_SECRET_KEY: Keypair.random().secret(),
      SOROBAN_PROXY_FETCH_TIMEOUT_MS: "45000",
      LOG_SINK_URL: "https://logs.example.com/ingest",
      PHASE_KYC_MODE: "mock",
      X402_LOCAL_SHIM_ENABLED: "TRUE",
      NEXT_PUBLIC_FEATURE_PHASE_266: "1",
      FEATURE_PHASE_174: "on",
      NODE_ENV: "production",
      UNRELATED_SHELL_VAR: "anything",
    }
    assert.deepEqual(validateEnvSurfaces(env), [])
    assert.equal(validateEnvSchemas(env).valid, true)
  })

  it("names each invalid variable and its surface", () => {
    const issues = validateEnvSurfaces({
      STELLAR_RPC_URL: "not-a-url",
      NEXT_PUBLIC_PHASER_TOKEN_ID: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7",
      ADMIN_SECRET_KEY: "SNOTASECRET",
      LOG_SINK_URL: "http://logs.example.com",
      PHASE_KYC_MODE: "sometimes",
      SOROBAN_PROXY_FETCH_TIMEOUT_MS: "12",
      PHASE_EXPERIMENT_CONFIG: "{not json",
      PHASE_PROD_SECRET_SHA256S: "abc",
      FEATURE_PHASE_266: "maybe",
    })
    const bySurface = Object.fromEntries(issues.map((i) => [i.variable, i.surface]))
    assert.deepEqual(bySurface, {
      STELLAR_RPC_URL: "network",
      SOROBAN_PROXY_FETCH_TIMEOUT_MS: "network",
      NEXT_PUBLIC_PHASER_TOKEN_ID: "contracts",
      ADMIN_SECRET_KEY: "signing",
      PHASE_PROD_SECRET_SHA256S: "access",
      PHASE_EXPERIMENT_CONFIG: "app",
      LOG_SINK_URL: "observability",
      PHASE_KYC_MODE: "compliance",
      FEATURE_PHASE_266: "feature_flags",
    })
  })

  it("treats empty values as unset", () => {
    assert.deepEqual(validateEnvSurfaces({ STELLAR_RPC_URL: "", ADMIN_SECRET_KEY: "  " }), [])
  })

  it("never prints a secret value in an error", () => {
    const secret = "SBK2VIYYSVG76E7VC3QHYARNFLY2EAQXDHRC7BMXBBGIFG74ARPRMNQ"
    const result = validateEnvSchemas({ ADMIN_SECRET_KEY: secret })
    assert.equal(result.valid, false)
    assert.equal(JSON.stringify(result).includes(secret), false)
  })

  it("declares no secret under a NEXT_PUBLIC_ name", () => {
    assert.ok(SECRET_ENV_VARS.length > 20)
    for (const name of SECRET_ENV_VARS) assert.equal(name.startsWith("NEXT_PUBLIC_"), false, name)
  })
})

describe("phase-266 cross-variable rules fail closed", () => {
  it("rejects a passphrase that does not match the network", () => {
    const errors = validateEnvCrossRules({
      STELLAR_NETWORK: "testnet",
      STELLAR_NETWORK_PASSPHRASE: STELLAR_PASSPHRASES.mainnet,
    })
    assert.deepEqual(variables(errors), ["STELLAR_NETWORK_PASSPHRASE"])
  })

  it("rejects server and client overrides that disagree", () => {
    const errors = validateEnvCrossRules({
      STELLAR_NETWORK_PASSPHRASE: STELLAR_PASSPHRASES.testnet,
      NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE: "Some Other Network",
    })
    assert.ok(errors.some((e) => e.message.includes("disagree")))
    assert.ok(errors.some((e) => e.variable === "NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE"))
  })

  it("accepts matching overrides", () => {
    assert.deepEqual(
      validateEnvCrossRules({
        STELLAR_NETWORK: "testnet",
        STELLAR_NETWORK_PASSPHRASE: STELLAR_PASSPHRASES.testnet,
        NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE: STELLAR_PASSPHRASES.testnet,
      }),
      [],
    )
  })

  it("requires the mainnet cutover ACK", () => {
    assert.deepEqual(variables(validateEnvCrossRules({ STELLAR_NETWORK: "mainnet" })), ["PHASE_MAINNET_CUTOVER_ACK"])
    assert.deepEqual(validateEnvCrossRules({ STELLAR_NETWORK: "mainnet", PHASE_MAINNET_CUTOVER_ACK: "1" }), [])
  })

  it("rejects a secret value re-exported through NEXT_PUBLIC_*", () => {
    const errors = validateEnvCrossRules({ CRON_SECRET: "cron-secret-value-123", NEXT_PUBLIC_DEBUG_TOKEN: "cron-secret-value-123" })
    assert.deepEqual(variables(errors), ["NEXT_PUBLIC_DEBUG_TOKEN"])
    assert.equal(errors[0].issue, "wrong_key_type")
  })

  describe("previews", () => {
    const preview = { VERCEL_ENV: "preview" }

    it("must run on testnet", () => {
      const errors = validateEnvCrossRules({ ...preview, STELLAR_NETWORK: "mainnet", PHASE_MAINNET_CUTOVER_ACK: "1" })
      assert.deepEqual(variables(errors), ["STELLAR_NETWORK"])
    })

    it("must carry production fingerprints when they hold credentials", () => {
      const errors = validateEnvCrossRules({ ...preview, CRON_SECRET: "preview-cron" })
      assert.deepEqual(variables(errors), ["PHASE_PROD_SECRET_SHA256S"])
      assert.deepEqual(validateEnvCrossRules({ ...preview }), [])
    })

    it("cannot share a production secret", () => {
      const prodSeed = Keypair.random().secret()
      const errors = validateEnvCrossRules({
        ...preview,
        ADMIN_SECRET_KEY: prodSeed,
        CRON_SECRET: "preview-only-cron",
        PHASE_PROD_SECRET_SHA256S: `${sha256("prod-cron")},${sha256(prodSeed).toUpperCase()}`,
      })
      assert.deepEqual(variables(errors), ["ADMIN_SECRET_KEY"])
      assert.equal(errors[0].issue, "isolation_violation")
      assert.equal(JSON.stringify(errors).includes(prodSeed), false)
    })

    it("passes with preview-only credentials", () => {
      assert.deepEqual(
        validateEnvCrossRules({
          ...preview,
          CRON_SECRET: "preview-only-cron",
          PHASE_PROD_SECRET_SHA256S: sha256("prod-cron"),
        }),
        [],
      )
    })

    it("does not apply preview rules to production", () => {
      assert.deepEqual(validateEnvCrossRules({ VERCEL_ENV: "production", CRON_SECRET: "prod-cron" }), [])
    })
  })
})

describe("phase-266 startup enforcement", () => {
  const invalid = { STELLAR_NETWORK: "mainnet" }

  it("only warns when the flag is off", () => {
    const warnings: string[] = []
    const outcome = enforceEnvAtStartup(invalid, { warn: (message: string) => warnings.push(message) })
    assert.equal(outcome.enforced, false)
    assert.equal(outcome.result.valid, false)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /PHASE_MAINNET_CUTOVER_ACK/)
  })

  it("refuses to boot on invalid configuration when the flag is on", () => {
    process.env.FEATURE_PHASE_266 = "1"
    assert.throws(() => enforceEnvAtStartup(invalid, { warn: () => {} }), EnvValidationStartupError)
    assert.throws(
      () => enforceEnvAtStartup({ VERCEL_ENV: "preview", CRON_SECRET: "x" }, { warn: () => {} }),
      /PHASE_PROD_SECRET_SHA256S/,
    )
  })

  it("boots on valid configuration when the flag is on", () => {
    process.env.FEATURE_PHASE_266 = "1"
    const outcome = enforceEnvAtStartup({ STELLAR_NETWORK: "testnet" }, { warn: () => assert.fail("no warning") })
    assert.deepEqual(outcome, { enforced: true, result: { valid: true, errors: [] } })
  })

  it("skips the edge runtime in instrumentation", async () => {
    const previous = process.env.NEXT_RUNTIME
    process.env.NEXT_RUNTIME = "edge"
    process.env.FEATURE_PHASE_266 = "1"
    process.env.STELLAR_NETWORK = "mainnet"
    try {
      const { register } = await import("@/instrumentation")
      await register()
    } finally {
      delete process.env.STELLAR_NETWORK
      if (previous === undefined) delete process.env.NEXT_RUNTIME
      else process.env.NEXT_RUNTIME = previous
    }
  })
})

describe("phase-266 env coverage (CI check)", () => {
  it("declares and documents every variable the code reads", () => {
    const report = checkEnvCoverage(process.cwd())
    assert.deepEqual(report.undeclared, [])
    assert.deepEqual(report.unused, [])
    assert.deepEqual(report.publicSecrets, [])
    assert.equal(report.docStale, false, "run npm run env:docs")
  })

  it("flags a variable that is read but not declared", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "phase-env-coverage-"))
    try {
      fs.mkdirSync(path.join(root, "lib"))
      fs.writeFileSync(
        path.join(root, "lib", "x.ts"),
        'const a = process.env.UNDECLARED_THING\nconst b = process.env["OTHER_UNDECLARED"]\nconst c = process.env.STELLAR_RPC_URL\n',
      )
      fs.mkdirSync(path.join(root, "docs"))
      fs.writeFileSync(path.join(root, "docs", "ENVIRONMENT.md"), renderEnvDoc())
      const referenced = findReferencedEnvVars(root)
      assert.deepEqual([...referenced.keys()].sort(), ["OTHER_UNDECLARED", "STELLAR_RPC_URL", "UNDECLARED_THING"])
      const report = checkEnvCoverage(root)
      assert.equal(report.ok, false)
      assert.deepEqual(report.undeclared.map((u) => u.name), ["OTHER_UNDECLARED", "UNDECLARED_THING"])
      assert.equal(report.docStale, false)
      assert.ok(report.unused.length > 0)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("documents every declared variable", () => {
    const doc = renderEnvDoc()
    for (const name of DECLARED_ENV_VARS.keys()) assert.ok(doc.includes(`\`${name}\``), name)
  })
})
