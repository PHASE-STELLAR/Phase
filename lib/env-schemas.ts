/**
 * phase-266 (issue #724): one Zod schema per environment surface.
 *
 * Every environment variable the app reads is declared here exactly once, with
 * a description, so `scripts/check-env-coverage.ts` can fail CI on a variable
 * that is read but not declared or documented. Validators are only as strict as
 * the code that reads the value; cross-variable rules (passphrase conflicts,
 * the mainnet ACK, preview isolation) live in `lib/env-validation.ts`.
 *
 * This module reaches client bundles through `lib/env-validation.ts`, so it
 * must stay free of `node:*` imports.
 */

import { StrKey } from "@stellar/stellar-sdk"
import { z } from "zod"

export type EnvFieldSpec = {
  schema: z.ZodTypeAny
  description: string
  /** Credentials: never `NEXT_PUBLIC_*`, and fingerprinted against production in previews. */
  secret?: boolean
}

type FieldOptions = { secret?: boolean }

const optionalString = () => z.string().optional()

function field(schema: z.ZodTypeAny, description: string, options: FieldOptions = {}): EnvFieldSpec {
  return { schema: schema.describe(description), description, secret: options.secret }
}

function refined(description: string, test: (value: string) => boolean, message: string, options?: FieldOptions) {
  return field(
    optionalString().refine((value) => value === undefined || value.trim() === "" || test(value.trim()), { message }),
    description,
    options,
  )
}

const text = (description: string, options?: FieldOptions) => field(optionalString(), description, options)

function isUrl(value: string, httpsOnly = false): boolean {
  try {
    const protocol = new URL(value).protocol
    return httpsOnly ? protocol === "https:" : protocol === "https:" || protocol === "http:"
  } catch {
    return false
  }
}

const url = (description: string) => refined(description, (v) => isUrl(v), "must be an http(s) URL")
const httpsUrl = (description: string, options?: FieldOptions) =>
  refined(description, (v) => isUrl(v, true), "must be an https:// URL", options)
const urlList = (description: string) =>
  refined(
    description,
    (v) => v.split(/[\s,]+/).filter(Boolean).every((item) => isUrl(item)),
    "must be a comma- or space-separated list of http(s) URLs",
  )
const int = (description: string, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  refined(
    description,
    (v) => /^-?\d+$/.test(v) && Number(v) >= min && Number(v) <= max,
    `must be an integer between ${min} and ${max}`,
  )
const num = (description: string, min: number, max: number) =>
  refined(
    description,
    (v) => /^-?(\d+\.?\d*|\.\d+)$/.test(v) && Number(v) >= min && Number(v) <= max,
    `must be a number between ${min} and ${max}`,
  )
const stroops = (description: string) =>
  refined(description, (v) => /^\d{1,19}$/.test(v), "must be a whole number of stroops")
const decimalAmount = (description: string) =>
  refined(description, (v) => /^\d{1,12}(\.\d{1,7})?$/.test(v), "must be a decimal amount with at most 7 decimals")
const flag = (description: string) =>
  refined(description, (v) => /^(0|1|true|false|yes|no|on|off)$/i.test(v), "must be 0/1/true/false/yes/no/on/off")
const oneOf = (description: string, values: readonly string[]) =>
  refined(description, (v) => values.includes(v.toLowerCase()), `must be one of: ${values.join(", ")}`)
const contractId = (description: string) =>
  refined(description, (v) => StrKey.isValidContract(v), "must be a Stellar contract ID (C...)")
const accountId = (description: string) =>
  refined(description, (v) => StrKey.isValidEd25519PublicKey(v), "must be a Stellar account (G...)")
const contractList = (description: string) =>
  refined(
    description,
    (v) => v.split(",").map((s) => s.trim()).filter(Boolean).every((s) => StrKey.isValidContract(s)),
    "must be a comma-separated list of contract IDs (C...)",
  )
const accountList = (description: string) =>
  refined(
    description,
    (v) => v.split(",").map((s) => s.trim()).filter(Boolean).every((s) => StrKey.isValidEd25519PublicKey(s)),
    "must be a comma-separated list of Stellar accounts (G...)",
  )
const secretSeed = (description: string) =>
  refined(description, (v) => StrKey.isValidEd25519SecretSeed(v), "must be a Stellar secret seed (S...)", { secret: true })
const credential = (description: string) => text(description, { secret: true })
const json = (description: string) =>
  refined(
    description,
    (v) => {
      try {
        JSON.parse(v)
        return true
      } catch {
        return false
      }
    },
    "must be valid JSON",
  )
const sha256Hex = (description: string) =>
  refined(description, (v) => /^[0-9a-f]{64}$/i.test(v), "must be a 64-character hex SHA-256 digest")
const sha256List = (description: string) =>
  refined(
    description,
    (v) => v.split(",").map((s) => s.trim()).filter(Boolean).every((s) => /^[0-9a-f]{64}$/i.test(s)),
    "must be a comma-separated list of 64-character hex SHA-256 digests",
  )

export const ENV_SURFACES = {
  network: {
    STELLAR_NETWORK: oneOf("Stellar network the server signs against.", ["testnet", "mainnet"]),
    STELLAR_NETWORK_PASSPHRASE: text("Server passphrase override; must match STELLAR_NETWORK."),
    NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE: text("Client passphrase override; must match STELLAR_NETWORK."),
    PHASE_MAINNET_CUTOVER_ACK: refined(
      "Set to 1 to acknowledge the mainnet cutover ceremony. Required for STELLAR_NETWORK=mainnet.",
      (v) => v === "1",
      "must be 1 when set",
    ),
    STELLAR_RPC_URL: url("Upstream Soroban RPC used by the server and /api/soroban-rpc."),
    SOROBAN_RPC_URL: url("Alternative name for the upstream Soroban RPC."),
    STELLAR_RPC_FALLBACK_URLS: urlList("Extra Soroban RPC URLs tried in order when the primary fails."),
    NEXT_PUBLIC_SOROBAN_RPC_URL: url("Soroban RPC the browser uses directly."),
    NEXT_PUBLIC_SOROBAN_RPC_PROXY_URL: url("Absolute URL of the RPC proxy the browser calls."),
    SOROBAN_PROXY_FETCH_TIMEOUT_MS: int("Per-request timeout for the RPC proxy, in ms.", 1000, 600_000),
    NEXT_PUBLIC_SOROBAN_SIM_ACCOUNT: accountId("Funded account used as fee source for read-only simulation."),
    PHASE_READONLY_SIM_SOURCE_G: accountId("Server-side read-only simulation source account."),
  },
  contracts: {
    NEXT_PUBLIC_PHASER_TOKEN_ID: contractId("PHASELQ token contract (SAC)."),
    PHASER_TOKEN_ID: contractId("Server alias for the PHASELQ token contract."),
    NEXT_PUBLIC_TOKEN_CONTRACT_ID: contractId("Legacy client alias for the token contract."),
    TOKEN_CONTRACT_ID: contractId("Legacy server alias for the token contract."),
    MOCK_TOKEN_ID: contractId("Mock token contract used on testnet."),
    NEXT_PUBLIC_PHASER_LIQ_TOKEN_CONTRACT: contractId("Client PHASELQ token contract override."),
    NEXT_PUBLIC_PHASE_PROTOCOL_ID: contractId("PHASE protocol (NFT) contract."),
    PHASE_PROTOCOL_ID: contractId("Server alias for the PHASE protocol contract."),
    NEXT_PUBLIC_CLASSIC_LIQ_ASSET_CODE: refined("Classic PHASELQ asset code.", (v) => /^[A-Za-z0-9]{1,12}$/.test(v), "must be 1-12 alphanumeric characters"),
    CLASSIC_LIQ_ASSET_CODE: refined("Server classic asset code.", (v) => /^[A-Za-z0-9]{1,12}$/.test(v), "must be 1-12 alphanumeric characters"),
    NEXT_PUBLIC_CLASSIC_LIQ_ISSUER: accountId("Classic PHASELQ issuer account."),
    SOROSWAP_ROUTER_CONTRACT_ID: contractId("Soroswap router contract."),
    SOROSWAP_FACTORY_CONTRACT_ID: contractId("Soroswap factory contract."),
    SOROSWAP_EXPECTED_ROUTER_ID: contractId("Pinned router ID; drift from it is flagged."),
    PHASE_PROD_CONTRACT_IDS: contractList("Production contract IDs a preview must never point at."),
    PHASE_CONTRACT_CODE_HASH: sha256Hex("Expected WASM code hash of the PHASE protocol contract, checked at startup outside testnet when phase-271 is on (#729)."),
    PHASE_PROD_ISSUER: accountId("Production issuer account a preview must never resolve to."),
  },
  signing: {
    ADMIN_SECRET_KEY: secretSeed("Issuer / admin signer for the faucet in mint mode."),
    FAUCET_DISTRIBUTOR_SECRET_KEY: secretSeed("Distributor signer for the faucet in transfer mode."),
    AGENT_STELLAR_SECRET_KEY: secretSeed("Signer for the forge agent's x402 payments."),
    CLASSIC_LIQ_ISSUER_SECRET: secretSeed("Classic PHASELQ issuer signer."),
    PHASE_MINT_DISTRIBUTOR_SECRET: secretSeed("Mint distributor signer."),
    SEP10_SERVER_SECRET: secretSeed("SEP-10 web-auth server signing key."),
  },
  access: {
    ADMIN_API_TOKEN: credential("Bearer token for admin API routes."),
    PHASE_ADMIN_KEY: credential("x-admin-key for admin routes such as /api/nft-index/subscribe."),
    PHASE_MODERATOR_KEY: credential("Key for moderator routes."),
    PHASE_REGULATOR_TOKEN: credential("Token for the regulator audit-export role."),
    AGENT_API_KEY: credential("API key callers present to the agent routes."),
    FORGE_AGENT_API_KEY: credential("API key for the forge agent route."),
    CRON_SECRET: credential("Bearer secret Vercel Cron sends to cron routes."),
    PHASE_PROD_CRON_SECRET_SHA256: sha256Hex("SHA-256 of the production CRON_SECRET, used by preview isolation."),
    PHASE_PROD_SECRET_SHA256S: sha256List(
      "SHA-256 digests of production credentials; previews fail startup if any of their credentials matches.",
    ),
    PHASE_GOVERNANCE_SIGNERS: accountList("Accounts allowed to veto faucet deny-list entries."),
    SEP10_HOME_DOMAIN: text("Home domain advertised in SEP-10 challenges."),
    SEP10_WEB_AUTH_DOMAIN: text("Web-auth domain advertised in SEP-10 challenges."),
    CLOUDFLARE_TURNSTILE_SECRET: credential("Turnstile server secret for the faucet."),
    NEXT_PUBLIC_CLOUDFLARE_TURNSTILE_SITE_KEY: text("Turnstile site key (public)."),
  },
  ai: {
    GEMINI_API_KEY: credential("Gemini API key for lore and moderation."),
    GOOGLE_AI_STUDIO_API_KEY: credential("Alternative name for the Gemini API key."),
    GEMINI_MODEL: text("Gemini text model id."),
    GEMINI_IMAGE_MODEL: text("Gemini image model id."),
    GEMINI_API_VERSION: oneOf("Gemini API version.", ["v1", "v1beta"]),
    NANOBANANA_API_KEY: credential("Nano Banana image API key."),
    NANOBANANA_CALLBACK_URL: httpsUrl("Public callback URL Nano Banana posts results to."),
    NANOBANANA_WEBHOOK_SECRET: credential("Shared secret for Nano Banana callbacks."),
    FORGE_LORE_TIMEOUT_MS: int("Forge lore generation timeout, in ms.", 1000, 600_000),
    FORGE_IMAGE_TIMEOUT_MS: int("Forge image generation timeout, in ms.", 1000, 600_000),
    FORGE_IPFS_TIMEOUT_MS: int("Forge IPFS upload timeout, in ms.", 1000, 600_000),
    NARRATOR_TIMEOUT_MS: int("Narrator timeout, in ms.", 1000, 600_000),
    PHASE_AI_JSON_TIMEOUT_MS: int("Structured AI JSON call timeout, in ms.", 1000, 600_000),
    FORGE_DISABLE_POLLINATIONS_FALLBACK: flag("Disable the Pollinations image fallback."),
    PHASE_MODERATION_HOLD_UNSCORED: flag("Hold content the classifier could not score."),
  },
  ipfs: {
    PINATA_JWT: credential("Pinata JWT for pinning forge uploads."),
    PINATA_API_JWT: credential("Alternative name for the Pinata JWT."),
    PINATA_GATEWAY_URL: url("Pinata gateway base URL."),
    NEXT_PUBLIC_PHASE_IPFS_GATEWAY: url("Primary IPFS gateway for the client."),
    NEXT_PUBLIC_PHASE_IPFS_GATEWAYS: urlList("Comma-separated IPFS gateways, in fallback order."),
  },
  payments: {
    X402_FACILITATOR_URL: url("x402 facilitator; defaults to the local /api/x402 shim."),
    X402_FORGE_PAY_TO: accountId("Account the forge x402 challenge pays."),
    X402_LOCAL_SHIM_ENABLED: oneOf("Enable the local x402 demo shim.", ["true", "false"]),
    CLASSIC_LIQ_BOOTSTRAP_AMOUNT: decimalAmount("Classic PHASELQ sent by the bootstrap route."),
    PHASE_QUEST_ARC_MAX_STROOPS: stroops("Cap on a generated quest arc reward, in stroops."),
    PHASE_KYC_THRESHOLD_STROOPS: stroops("Amount above which compliance screening applies, in stroops."),
    PHASE_FORGE_BILLING_TIERS: json("JSON map of forge billing tiers to daily quotas."),
    PHASE_FORGE_BILLING_DEFAULT_TIER: text("Billing tier for wallets without one."),
    PHASE_COST_BUDGET_FORGE: num("Forge cost budget per window.", 0, Number.MAX_SAFE_INTEGER),
    PHASE_COST_BUDGET_WARNING_RATIO: num("Budget ratio that triggers a warning.", 0, 1),
    PHASE_COST_BUDGET_WINDOW_MS: int("Cost budget window, in ms.", 1000),
    PHASE_PRICING_CONTROL_PCT: num("Share of listings held out of pricing suggestions, in percent.", 0, 100),
  },
  compliance: {
    PHASE_KYC_MODE: oneOf("Compliance mode.", ["off", "mock", "live"]),
    PHASE_KYC_HASH_KEY: credential("Key for hashing wallets before screening (32+ chars)."),
    PHASE_KYC_WEBHOOK_SECRET: credential("Secret for compliance webhooks (32+ chars)."),
    PHASE_KYC_MOCK_BLOCKED_WALLETS: accountList("Wallets the mock screener blocks (testnet only)."),
    PHASE_SANCTIONS_URL: httpsUrl("Sanctions screening endpoint (live mode)."),
    PHASE_SANCTIONS_API_KEY: credential("Sanctions screening API key."),
  },
  integrations: {
    MERCURY_JWT: credential("Mercury indexer JWT."),
    MERCURY_API_KEY: credential("Mercury API key."),
    MERCURY_REST_URL: url("Mercury Classic REST endpoint."),
    SOROSWAP_API_URL: url("Soroswap quote API."),
    PHASE_INDEXER_BASE_URL: url("PHASE indexer base URL."),
    PHASE_OWNER_TOKENS_ENDPOINT: url("Endpoint listing tokens per owner."),
    PHASE_API_BASE_URL: url("Base URL for server-to-server API calls."),
    FAUCET_RATE_LIMIT_REDIS_URL: text("Redis URL for the faucet rate limiter.", { secret: true }),
    REDIS_URL: text("Redis URL.", { secret: true }),
    KV_URL: text("Vercel KV URL.", { secret: true }),
    PHASE_DATABASE_URL: text("Postgres URL for the dual-write rehearsal.", { secret: true }),
    DISCORD_WEBHOOK_URL: httpsUrl("Discord webhook for alerts.", { secret: true }),
    SLACK_WEBHOOK_URL: httpsUrl("Slack webhook for alerts.", { secret: true }),
    GENERIC_WEBHOOK_URL: httpsUrl("Generic webhook for alerts.", { secret: true }),
    TELEGRAM_BOT_TOKEN: credential("Telegram bot token for alerts."),
    TELEGRAM_CHAT_ID: text("Telegram chat id for alerts."),
    PHASE_ANDROID_PACKAGE: text("Android package name for assetlinks.json."),
    PHASE_ANDROID_SHA256_CERTS: text("Comma-separated Android signing certificate fingerprints."),
    PHASE_IOS_APP_ID: text("iOS app id for apple-app-site-association."),
    NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: text("Reown / WalletConnect project id."),
    NEXT_PUBLIC_WALLETCONNECT_RELAY_URL: text("WalletConnect relay URL."),
  },
  observability: {
    LOG_SINK_URL: httpsUrl("External log sink; https only so records never travel in the clear."),
    LOG_SINK_TOKEN: credential("Bearer token for the log sink."),
    LOG_SINK_BATCH_SIZE: int("Log records per batch.", 1, 100_000),
    LOG_SINK_FLUSH_MS: int("Log flush interval, in ms.", 1),
    LOG_SINK_MAX_BUFFER: int("Max buffered log records.", 1),
    LOG_SINK_TIMEOUT_MS: int("Log sink request timeout, in ms.", 1),
    LOG_SAMPLE_RATE_INFO: num("Share of info logs kept, 0 to 1.", 0, 1),
  },
  app: {
    NODE_ENV: oneOf("Node environment.", ["development", "production", "test"]),
    NEXT_PUBLIC_PHASE_ENV: text("App environment label shown in the UI and used for CSP."),
    NEXT_PUBLIC_SITE_URL: url("Canonical site URL (Open Graph, metadataBase)."),
    NEXT_PUBLIC_BASE_URL: url("Base URL for absolute links."),
    NEXT_PUBLIC_BASE_PATH: text("Sub-path the app is served under."),
    NEXT_PUBLIC_OG_IMAGE_URL: url("Absolute social image URL."),
    NEXT_PUBLIC_PHASER_LIQ_EXPERT_URL: url("Stellar Expert link for PHASELQ."),
    PHASE_SERVER_DATA_DIR: text("Writable directory for the JSON sidecar stores."),
    SETTLEMENT_STORE_PATH: text("Path of the used-settlements store."),
    PHASE_EXPLORE_SCAN_CAP: int("Max tokens the explore scan reads per request.", 1),
    PHASE_EXPERIMENT_CONFIG: json("JSON A/B experiment configuration."),
    PHASE_EXPERIMENT_SALT: credential("Salt for experiment bucketing."),
    PHASE_KILL_SWITCH_FLAGS: text("Comma-separated feature flags forced off."),
    ALBEDO_SUNSET_MODE: oneOf("Albedo sunset mode.", ["parity-freeze", "retired"]),
    SYBIL_CAUTION_MAX: int("Sybil score above which a wallet is cautioned.", 0),
    SYBIL_SUSPECT_MAX: int("Sybil score above which a wallet is suspect.", 0),
    NEXT_PUBLIC_SYBIL_CAUTION_MAX: int("Client copy of SYBIL_CAUTION_MAX.", 0),
    NEXT_PUBLIC_SYBIL_SUSPECT_MAX: int("Client copy of SYBIL_SUSPECT_MAX.", 0),
  },
  deployment: {
    NEXT_RUNTIME: oneOf("Runtime Next.js is executing in; set by Next.js.", ["nodejs", "edge"]),
    VERCEL: text("Set by Vercel on every deployment."),
    VERCEL_ENV: oneOf("Vercel environment.", ["production", "preview", "development"]),
    VERCEL_URL: text("Deployment host set by Vercel."),
    VERCEL_GIT_COMMIT_REF: text("Git branch set by Vercel."),
    VERCEL_GIT_PULL_REQUEST_ID: text("Pull request id set by Vercel for previews."),
    PHASE_PREVIEW_CRON_ENABLED: flag("Allow cron routes to run in a preview."),
  },
} as const satisfies Record<string, Record<string, EnvFieldSpec>>

export type EnvSurface = keyof typeof ENV_SURFACES

/** Feature flags are declared by pattern; their values must be boolean-like. */
export const FEATURE_FLAG_ENV_PATTERN = /^(NEXT_PUBLIC_)?FEATURE_[A-Z0-9_]+$/
const FEATURE_FLAG_VALUE = /^(|0|1|true|false|yes|no|on|off)$/i

export const ENV_SURFACE_SCHEMAS = Object.fromEntries(
  Object.entries(ENV_SURFACES).map(([surface, fields]) => [
    surface,
    z
      .object(Object.fromEntries(Object.entries(fields).map(([name, spec]) => [name, spec.schema])))
      .passthrough(),
  ]),
) as Record<EnvSurface, z.ZodObject<z.ZodRawShape>>

export const DECLARED_ENV_VARS: ReadonlyMap<string, { surface: EnvSurface } & EnvFieldSpec> = new Map(
  Object.entries(ENV_SURFACES).flatMap(([surface, fields]) =>
    Object.entries(fields).map(([name, spec]) => [name, { surface: surface as EnvSurface, ...spec }] as const),
  ),
)

export const SECRET_ENV_VARS: readonly string[] = [...DECLARED_ENV_VARS]
  .filter(([, spec]) => spec.secret)
  .map(([name]) => name)

export function isDeclaredEnvVar(name: string): boolean {
  return DECLARED_ENV_VARS.has(name) || FEATURE_FLAG_ENV_PATTERN.test(name)
}

export type EnvSchemaIssue = { surface: EnvSurface | "feature_flags"; variable: string; message: string }

/** Runs every surface schema plus the feature-flag pattern over `env`. */
export function validateEnvSurfaces(env: Record<string, string | undefined>): EnvSchemaIssue[] {
  const issues: EnvSchemaIssue[] = []
  for (const surface of Object.keys(ENV_SURFACE_SCHEMAS) as EnvSurface[]) {
    const parsed = ENV_SURFACE_SCHEMAS[surface].safeParse(env)
    if (parsed.success) continue
    for (const issue of parsed.error.issues) {
      const variable = String(issue.path[0] ?? surface)
      issues.push({ surface, variable, message: `${variable} ${issue.message}` })
    }
  }
  for (const [name, value] of Object.entries(env)) {
    if (FEATURE_FLAG_ENV_PATTERN.test(name) && value !== undefined && !FEATURE_FLAG_VALUE.test(value.trim())) {
      issues.push({ surface: "feature_flags", variable: name, message: `${name} must be 0/1/true/false/yes/no/on/off` })
    }
  }
  return issues
}
