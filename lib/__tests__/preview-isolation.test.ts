import { afterEach, beforeEach, describe, expect, it } from "vitest"
import path from "node:path"
import { Keypair } from "@stellar/stellar-sdk"
import { createHash } from "node:crypto"
import {
  checkPreviewIsolation,
  isCronBlockedInPreview,
  previewDataSubdir,
  previewTrustsVercelCronHeader,
  resolvePreviewId,
} from "@/lib/preview-isolation"
import { validatePhaseEnv } from "@/lib/env-validation"
import { serverDataJsonPath } from "@/lib/server-data-paths"

const KEEP = ["VERCEL", "VERCEL_ENV", "VERCEL_GIT_PULL_REQUEST_ID", "VERCEL_GIT_COMMIT_REF", "PHASE_SERVER_DATA_DIR", "CRON_SECRET", "PHASE_PROD_ISSUER", "PHASE_PROD_CRON_SECRET_SHA256", "PHASE_PROD_CONTRACT_IDS", "CLASSIC_LIQ_ISSUER_SECRET", "NEXT_PUBLIC_PHASE_PROTOCOL_ID"]
let saved: Record<string, string | undefined> = {}

function enable(on: boolean) {
  if (on) {
    process.env.NEXT_PUBLIC_FEATURE_PHASE_173 = "1"
    process.env.FEATURE_PHASE_173 = "1"
  } else {
    delete process.env.NEXT_PUBLIC_FEATURE_PHASE_173
    delete process.env.FEATURE_PHASE_173
  }
}

beforeEach(() => {
  saved = Object.fromEntries(KEEP.map((k) => [k, process.env[k]]))
  for (const k of KEEP) delete process.env[k]
  enable(true)
})
afterEach(() => {
  for (const k of KEEP) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  enable(false)
})

describe("phase-173 preview isolation", () => {
  it("resolves per-preview ids only in previews, as one safe path segment", () => {
    expect(resolvePreviewId({ VERCEL_ENV: "production", VERCEL_GIT_PULL_REQUEST_ID: "5" })).toBeNull()
    expect(resolvePreviewId({})).toBeNull()
    expect(resolvePreviewId({ VERCEL_ENV: "preview", VERCEL_GIT_PULL_REQUEST_ID: "467" })).toBe("pr-467")
    const a = resolvePreviewId({ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "feat/a-b" })!
    const b = resolvePreviewId({ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "feat/a/b" })!
    expect(a).not.toBe(b)
    const evil = resolvePreviewId({ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "../../etc/passwd" })!
    expect(evil).toMatch(/^br-[a-z0-9-]+$/)
    expect(evil).not.toContain("/")
    expect(resolvePreviewId({ VERCEL_ENV: "preview", VERCEL_GIT_PULL_REQUEST_ID: "../x" })).toBe("preview-unknown")
  })

  it("namespaces the data root per preview and is inert when the flag is off", () => {
    process.env.PHASE_SERVER_DATA_DIR = "/data"
    process.env.VERCEL_ENV = "preview"
    process.env.VERCEL_GIT_PULL_REQUEST_ID = "12"
    expect(previewDataSubdir()).toBe("previews/pr-12")
    expect(serverDataJsonPath("faucetClaims")).toBe(path.join("/data", "previews", "pr-12", "faucet-claims.json"))
    process.env.VERCEL_GIT_PULL_REQUEST_ID = "13"
    expect(serverDataJsonPath("faucetClaims")).not.toBe(path.join("/data", "previews", "pr-12", "faucet-claims.json"))

    enable(false)
    expect(serverDataJsonPath("faucetClaims")).toBe(path.join("/data", "faucet-claims.json"))
    process.env.VERCEL_ENV = "production"
    enable(true)
    expect(serverDataJsonPath("faucetClaims")).toBe(path.join("/data", "faucet-claims.json"))
  })

  it("flags a preview that reuses the production issuer, cron secret, contract or mainnet", () => {
    const issuer = Keypair.random()
    const env = {
      VERCEL_ENV: "preview",
      PHASE_PROD_ISSUER: issuer.publicKey(),
      CLASSIC_LIQ_ISSUER_SECRET: issuer.secret(),
      PHASE_PROD_CRON_SECRET_SHA256: createHash("sha256").update("prod-cron").digest("hex"),
      CRON_SECRET: "prod-cron",
      PHASE_PROD_CONTRACT_IDS: "CBBCEDZ747IC3V4TWWCVGP33V74QM5T3MCPZV7DQ7CB6MA66YNWAC3DX",
      NEXT_PUBLIC_PHASE_PROTOCOL_ID: "CBBCEDZ747IC3V4TWWCVGP33V74QM5T3MCPZV7DQ7CB6MA66YNWAC3DX",
      STELLAR_NETWORK: "mainnet",
    }
    const codes = checkPreviewIsolation(env).map((v) => v.code).sort()
    expect(codes).toEqual(["contract_matches_production", "cron_secret_matches_production", "issuer_matches_production", "mainnet_in_preview"])
    const serialized = JSON.stringify(checkPreviewIsolation(env))
    expect(serialized).not.toContain(issuer.secret())
    expect(serialized).not.toContain("prod-cron")
  })

  it("passes an isolated preview and ignores production and flag-off", () => {
    const prod = Keypair.random()
    const isolated = { VERCEL_ENV: "preview", PHASE_PROD_ISSUER: prod.publicKey(), CLASSIC_LIQ_ISSUER_SECRET: Keypair.random().secret(), CRON_SECRET: "preview-cron" }
    expect(checkPreviewIsolation(isolated)).toEqual([])
    const shared = { ...isolated, CLASSIC_LIQ_ISSUER_SECRET: prod.secret() }
    expect(checkPreviewIsolation({ ...shared, VERCEL_ENV: "production" })).toEqual([])
    enable(false)
    expect(checkPreviewIsolation(shared)).toEqual([])
  })

  it("blocks preview cron unless enabled and stops trusting the vercel-cron header", () => {
    expect(isCronBlockedInPreview({ VERCEL_ENV: "preview" })).toBe(true)
    expect(isCronBlockedInPreview({ VERCEL_ENV: "preview", PHASE_PREVIEW_CRON_ENABLED: "1" })).toBe(false)
    expect(isCronBlockedInPreview({ VERCEL_ENV: "production" })).toBe(false)
    expect(previewTrustsVercelCronHeader({ VERCEL_ENV: "preview" })).toBe(false)
    expect(previewTrustsVercelCronHeader({ VERCEL_ENV: "production" })).toBe(true)
    enable(false)
    expect(isCronBlockedInPreview({ VERCEL_ENV: "preview" })).toBe(false)
    expect(previewTrustsVercelCronHeader({ VERCEL_ENV: "preview" })).toBe(true)
  })

  it("surfaces violations through validatePhaseEnv", () => {
    const prod = Keypair.random()
    process.env.VERCEL_ENV = "preview"
    process.env.PHASE_PROD_ISSUER = prod.publicKey()
    process.env.CLASSIC_LIQ_ISSUER_SECRET = prod.secret()
    const result = validatePhaseEnv()
    expect(result.errors.some((e) => e.issue === "isolation_violation" && e.variable === "CLASSIC_LIQ_ISSUER_SECRET")).toBe(true)
    enable(false)
    expect(validatePhaseEnv().errors.some((e) => e.issue === "isolation_violation")).toBe(false)
  })
})
