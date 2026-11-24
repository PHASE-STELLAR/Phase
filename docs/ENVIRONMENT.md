# Environment variables

<!-- Generated from lib/env-schemas.ts by `npm run env:docs`. Do not edit by hand. -->

Every variable the app reads is declared in `lib/env-schemas.ts`, one Zod schema per surface.
`npm run env:check` fails CI when code reads a variable that is not declared here.
With `phase-266` on, the server validates these at startup (`instrumentation.ts`) and refuses
to boot on invalid configuration, conflicting passphrases, mainnet without
`PHASE_MAINNET_CUTOVER_ACK=1`, or a preview holding production credentials.
Variables marked **secret** must never be `NEXT_PUBLIC_*` and are fingerprinted against
`PHASE_PROD_SECRET_SHA256S` on previews.

Feature flags follow the pattern `NEXT_PUBLIC_FEATURE_*` / `FEATURE_*` and accept
`0/1/true/false/yes/no/on/off`; see `lib/feature-flags.ts`.

## network

| Variable | Secret | Description |
| --- | --- | --- |
| `STELLAR_NETWORK` |  | Stellar network the server signs against. |
| `STELLAR_NETWORK_PASSPHRASE` |  | Server passphrase override; must match STELLAR_NETWORK. |
| `NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE` |  | Client passphrase override; must match STELLAR_NETWORK. |
| `PHASE_MAINNET_CUTOVER_ACK` |  | Set to 1 to acknowledge the mainnet cutover ceremony. Required for STELLAR_NETWORK=mainnet. |
| `STELLAR_RPC_URL` |  | Upstream Soroban RPC used by the server and /api/soroban-rpc. |
| `SOROBAN_RPC_URL` |  | Alternative name for the upstream Soroban RPC. |
| `STELLAR_RPC_FALLBACK_URLS` |  | Extra Soroban RPC URLs tried in order when the primary fails. |
| `NEXT_PUBLIC_SOROBAN_RPC_URL` |  | Soroban RPC the browser uses directly. |
| `NEXT_PUBLIC_SOROBAN_RPC_PROXY_URL` |  | Absolute URL of the RPC proxy the browser calls. |
| `SOROBAN_PROXY_FETCH_TIMEOUT_MS` |  | Per-request timeout for the RPC proxy, in ms. |
| `NEXT_PUBLIC_SOROBAN_SIM_ACCOUNT` |  | Funded account used as fee source for read-only simulation. |
| `PHASE_READONLY_SIM_SOURCE_G` |  | Server-side read-only simulation source account. |

## contracts

| Variable | Secret | Description |
| --- | --- | --- |
| `NEXT_PUBLIC_PHASER_TOKEN_ID` |  | PHASELQ token contract (SAC). |
| `PHASER_TOKEN_ID` |  | Server alias for the PHASELQ token contract. |
| `NEXT_PUBLIC_TOKEN_CONTRACT_ID` |  | Legacy client alias for the token contract. |
| `TOKEN_CONTRACT_ID` |  | Legacy server alias for the token contract. |
| `MOCK_TOKEN_ID` |  | Mock token contract used on testnet. |
| `NEXT_PUBLIC_PHASER_LIQ_TOKEN_CONTRACT` |  | Client PHASELQ token contract override. |
| `NEXT_PUBLIC_PHASE_PROTOCOL_ID` |  | PHASE protocol (NFT) contract. |
| `PHASE_PROTOCOL_ID` |  | Server alias for the PHASE protocol contract. |
| `NEXT_PUBLIC_CLASSIC_LIQ_ASSET_CODE` |  | Classic PHASELQ asset code. |
| `CLASSIC_LIQ_ASSET_CODE` |  | Server classic asset code. |
| `NEXT_PUBLIC_CLASSIC_LIQ_ISSUER` |  | Classic PHASELQ issuer account. |
| `SOROSWAP_ROUTER_CONTRACT_ID` |  | Soroswap router contract. |
| `SOROSWAP_FACTORY_CONTRACT_ID` |  | Soroswap factory contract. |
| `SOROSWAP_EXPECTED_ROUTER_ID` |  | Pinned router ID; drift from it is flagged. |
| `PHASE_PROD_CONTRACT_IDS` |  | Production contract IDs a preview must never point at. |
| `PHASE_CONTRACT_CODE_HASH` |  | Expected WASM code hash of the PHASE protocol contract, checked at startup outside testnet when phase-271 is on (#729). |
| `PHASE_PROD_ISSUER` |  | Production issuer account a preview must never resolve to. |

## signing

| Variable | Secret | Description |
| --- | --- | --- |
| `ADMIN_SECRET_KEY` | **secret** | Issuer / admin signer for the faucet in mint mode. |
| `FAUCET_DISTRIBUTOR_SECRET_KEY` | **secret** | Distributor signer for the faucet in transfer mode. |
| `AGENT_STELLAR_SECRET_KEY` | **secret** | Signer for the forge agent's x402 payments. |
| `CLASSIC_LIQ_ISSUER_SECRET` | **secret** | Classic PHASELQ issuer signer. |
| `PHASE_MINT_DISTRIBUTOR_SECRET` | **secret** | Mint distributor signer. |
| `SEP10_SERVER_SECRET` | **secret** | SEP-10 web-auth server signing key. |

## access

| Variable | Secret | Description |
| --- | --- | --- |
| `ADMIN_API_TOKEN` | **secret** | Bearer token for admin API routes. |
| `PHASE_ADMIN_KEY` | **secret** | x-admin-key for admin routes such as /api/nft-index/subscribe. |
| `PHASE_MODERATOR_KEY` | **secret** | Key for moderator routes. |
| `PHASE_REGULATOR_TOKEN` | **secret** | Token for the regulator audit-export role. |
| `AGENT_API_KEY` | **secret** | API key callers present to the agent routes. |
| `FORGE_AGENT_API_KEY` | **secret** | API key for the forge agent route. |
| `CRON_SECRET` | **secret** | Bearer secret Vercel Cron sends to cron routes. |
| `PHASE_PROD_CRON_SECRET_SHA256` |  | SHA-256 of the production CRON_SECRET, used by preview isolation. |
| `PHASE_PROD_SECRET_SHA256S` |  | SHA-256 digests of production credentials; previews fail startup if any of their credentials matches. |
| `PHASE_GOVERNANCE_SIGNERS` |  | Accounts allowed to veto faucet deny-list entries. |
| `SEP10_HOME_DOMAIN` |  | Home domain advertised in SEP-10 challenges. |
| `SEP10_WEB_AUTH_DOMAIN` |  | Web-auth domain advertised in SEP-10 challenges. |
| `CLOUDFLARE_TURNSTILE_SECRET` | **secret** | Turnstile server secret for the faucet. |
| `NEXT_PUBLIC_CLOUDFLARE_TURNSTILE_SITE_KEY` |  | Turnstile site key (public). |

## ai

| Variable | Secret | Description |
| --- | --- | --- |
| `GEMINI_API_KEY` | **secret** | Gemini API key for lore and moderation. |
| `GOOGLE_AI_STUDIO_API_KEY` | **secret** | Alternative name for the Gemini API key. |
| `GEMINI_MODEL` |  | Gemini text model id. |
| `GEMINI_IMAGE_MODEL` |  | Gemini image model id. |
| `GEMINI_API_VERSION` |  | Gemini API version. |
| `NANOBANANA_API_KEY` | **secret** | Nano Banana image API key. |
| `NANOBANANA_CALLBACK_URL` |  | Public callback URL Nano Banana posts results to. |
| `NANOBANANA_WEBHOOK_SECRET` | **secret** | Shared secret for Nano Banana callbacks. |
| `FORGE_LORE_TIMEOUT_MS` |  | Forge lore generation timeout, in ms. |
| `FORGE_IMAGE_TIMEOUT_MS` |  | Forge image generation timeout, in ms. |
| `FORGE_IPFS_TIMEOUT_MS` |  | Forge IPFS upload timeout, in ms. |
| `NARRATOR_TIMEOUT_MS` |  | Narrator timeout, in ms. |
| `PHASE_AI_JSON_TIMEOUT_MS` |  | Structured AI JSON call timeout, in ms. |
| `FORGE_DISABLE_POLLINATIONS_FALLBACK` |  | Disable the Pollinations image fallback. |
| `PHASE_MODERATION_HOLD_UNSCORED` |  | Hold content the classifier could not score. |

## ipfs

| Variable | Secret | Description |
| --- | --- | --- |
| `PINATA_JWT` | **secret** | Pinata JWT for pinning forge uploads. |
| `PINATA_API_JWT` | **secret** | Alternative name for the Pinata JWT. |
| `PINATA_GATEWAY_URL` |  | Pinata gateway base URL. |
| `NEXT_PUBLIC_PHASE_IPFS_GATEWAY` |  | Primary IPFS gateway for the client. |
| `NEXT_PUBLIC_PHASE_IPFS_GATEWAYS` |  | Comma-separated IPFS gateways, in fallback order. |

## payments

| Variable | Secret | Description |
| --- | --- | --- |
| `X402_FACILITATOR_URL` |  | x402 facilitator; defaults to the local /api/x402 shim. |
| `X402_FORGE_PAY_TO` |  | Account the forge x402 challenge pays. |
| `X402_LOCAL_SHIM_ENABLED` |  | Enable the local x402 demo shim. |
| `CLASSIC_LIQ_BOOTSTRAP_AMOUNT` |  | Classic PHASELQ sent by the bootstrap route. |
| `PHASE_QUEST_ARC_MAX_STROOPS` |  | Cap on a generated quest arc reward, in stroops. |
| `PHASE_KYC_THRESHOLD_STROOPS` |  | Amount above which compliance screening applies, in stroops. |
| `PHASE_FORGE_BILLING_TIERS` |  | JSON map of forge billing tiers to daily quotas. |
| `PHASE_FORGE_BILLING_DEFAULT_TIER` |  | Billing tier for wallets without one. |
| `PHASE_COST_BUDGET_FORGE` |  | Forge cost budget per window. |
| `PHASE_COST_BUDGET_WARNING_RATIO` |  | Budget ratio that triggers a warning. |
| `PHASE_COST_BUDGET_WINDOW_MS` |  | Cost budget window, in ms. |
| `PHASE_PRICING_CONTROL_PCT` |  | Share of listings held out of pricing suggestions, in percent. |

## compliance

| Variable | Secret | Description |
| --- | --- | --- |
| `PHASE_KYC_MODE` |  | Compliance mode. |
| `PHASE_KYC_HASH_KEY` | **secret** | Key for hashing wallets before screening (32+ chars). |
| `PHASE_KYC_WEBHOOK_SECRET` | **secret** | Secret for compliance webhooks (32+ chars). |
| `PHASE_KYC_MOCK_BLOCKED_WALLETS` |  | Wallets the mock screener blocks (testnet only). |
| `PHASE_SANCTIONS_URL` |  | Sanctions screening endpoint (live mode). |
| `PHASE_SANCTIONS_API_KEY` | **secret** | Sanctions screening API key. |

## integrations

| Variable | Secret | Description |
| --- | --- | --- |
| `MERCURY_JWT` | **secret** | Mercury indexer JWT. |
| `MERCURY_API_KEY` | **secret** | Mercury API key. |
| `MERCURY_REST_URL` |  | Mercury Classic REST endpoint. |
| `SOROSWAP_API_URL` |  | Soroswap quote API. |
| `PHASE_INDEXER_BASE_URL` |  | PHASE indexer base URL. |
| `PHASE_OWNER_TOKENS_ENDPOINT` |  | Endpoint listing tokens per owner. |
| `PHASE_API_BASE_URL` |  | Base URL for server-to-server API calls. |
| `FAUCET_RATE_LIMIT_REDIS_URL` | **secret** | Redis URL for the faucet rate limiter. |
| `REDIS_URL` | **secret** | Redis URL. |
| `KV_URL` | **secret** | Vercel KV URL. |
| `PHASE_DATABASE_URL` | **secret** | Postgres URL for the dual-write rehearsal. |
| `DISCORD_WEBHOOK_URL` | **secret** | Discord webhook for alerts. |
| `SLACK_WEBHOOK_URL` | **secret** | Slack webhook for alerts. |
| `GENERIC_WEBHOOK_URL` | **secret** | Generic webhook for alerts. |
| `TELEGRAM_BOT_TOKEN` | **secret** | Telegram bot token for alerts. |
| `TELEGRAM_CHAT_ID` |  | Telegram chat id for alerts. |
| `PHASE_ANDROID_PACKAGE` |  | Android package name for assetlinks.json. |
| `PHASE_ANDROID_SHA256_CERTS` |  | Comma-separated Android signing certificate fingerprints. |
| `PHASE_IOS_APP_ID` |  | iOS app id for apple-app-site-association. |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` |  | Reown / WalletConnect project id. |
| `NEXT_PUBLIC_WALLETCONNECT_RELAY_URL` |  | WalletConnect relay URL. |

## observability

| Variable | Secret | Description |
| --- | --- | --- |
| `LOG_SINK_URL` |  | External log sink; https only so records never travel in the clear. |
| `LOG_SINK_TOKEN` | **secret** | Bearer token for the log sink. |
| `LOG_SINK_BATCH_SIZE` |  | Log records per batch. |
| `LOG_SINK_FLUSH_MS` |  | Log flush interval, in ms. |
| `LOG_SINK_MAX_BUFFER` |  | Max buffered log records. |
| `LOG_SINK_TIMEOUT_MS` |  | Log sink request timeout, in ms. |
| `LOG_SAMPLE_RATE_INFO` |  | Share of info logs kept, 0 to 1. |

## app

| Variable | Secret | Description |
| --- | --- | --- |
| `NODE_ENV` |  | Node environment. |
| `NEXT_PUBLIC_PHASE_ENV` |  | App environment label shown in the UI and used for CSP. |
| `NEXT_PUBLIC_SITE_URL` |  | Canonical site URL (Open Graph, metadataBase). |
| `NEXT_PUBLIC_BASE_URL` |  | Base URL for absolute links. |
| `NEXT_PUBLIC_BASE_PATH` |  | Sub-path the app is served under. |
| `NEXT_PUBLIC_OG_IMAGE_URL` |  | Absolute social image URL. |
| `NEXT_PUBLIC_PHASER_LIQ_EXPERT_URL` |  | Stellar Expert link for PHASELQ. |
| `PHASE_SERVER_DATA_DIR` |  | Writable directory for the JSON sidecar stores. |
| `SETTLEMENT_STORE_PATH` |  | Path of the used-settlements store. |
| `PHASE_EXPLORE_SCAN_CAP` |  | Max tokens the explore scan reads per request. |
| `PHASE_EXPERIMENT_CONFIG` |  | JSON A/B experiment configuration. |
| `PHASE_EXPERIMENT_SALT` | **secret** | Salt for experiment bucketing. |
| `PHASE_KILL_SWITCH_FLAGS` |  | Comma-separated feature flags forced off. |
| `ALBEDO_SUNSET_MODE` |  | Albedo sunset mode. |
| `SYBIL_CAUTION_MAX` |  | Sybil score above which a wallet is cautioned. |
| `SYBIL_SUSPECT_MAX` |  | Sybil score above which a wallet is suspect. |
| `NEXT_PUBLIC_SYBIL_CAUTION_MAX` |  | Client copy of SYBIL_CAUTION_MAX. |
| `NEXT_PUBLIC_SYBIL_SUSPECT_MAX` |  | Client copy of SYBIL_SUSPECT_MAX. |

## deployment

| Variable | Secret | Description |
| --- | --- | --- |
| `NEXT_RUNTIME` |  | Runtime Next.js is executing in; set by Next.js. |
| `VERCEL` |  | Set by Vercel on every deployment. |
| `VERCEL_ENV` |  | Vercel environment. |
| `VERCEL_URL` |  | Deployment host set by Vercel. |
| `VERCEL_GIT_COMMIT_REF` |  | Git branch set by Vercel. |
| `VERCEL_GIT_PULL_REQUEST_ID` |  | Pull request id set by Vercel for previews. |
| `PHASE_PREVIEW_CRON_ENABLED` |  | Allow cron routes to run in a preview. |
