/**
 * Stellar network resolution with passphrase validation — spike 640 (issue #502)
 * and mainnet cutover ceremony tooling (issue #689, phase-238).
 *
 * The passphrase used for signature domains (viewer gate, SEP-10 challenges) was
 * read from ad-hoc env vars with a testnet fallback. A mainnet deploy that set
 * only the RPC URL would silently sign and verify against testnet. This module
 * is the single source: the network name picks the canonical passphrase, a
 * conflicting override throws, and mainnet stays closed until the cutover
 * ceremony is acknowledged via PHASE_MAINNET_CUTOVER_ACK and confirmed with
 * PHASE_MAINNET_CONFIRMATION_TOKEN.
 *
 * Feature flags:
 * - phase-163 (gates the mainnet status route only; resolution is always on).
 * - phase-238 (enforces dual-acknowledgement cutover, testnet fixture fencing, and dry-run safety).
 * Rollback: unset STELLAR_NETWORK (defaults to testnet) and restart.
 */

export type StellarNetworkName = "testnet" | "mainnet"

export const STELLAR_PASSPHRASES: Record<StellarNetworkName, string> = {
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
}

export type ResolvedStellarNetwork = {
  network: StellarNetworkName
  passphrase: string
}

export class StellarNetworkConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "StellarNetworkConfigError"
  }
}

export function isPhase238Enabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.NEXT_PUBLIC_FEATURE_PHASE_238 === "1" || env.FEATURE_PHASE_238 === "1"
}

export function isMainnetDryRun(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isPhase238Enabled(env) && env.PHASE_MAINNET_DRY_RUN === "1"
}

export function assertNonMainnetFixture(
  context: string,
  env: Record<string, string | undefined> = process.env,
): void {
  if (!isPhase238Enabled(env)) return
  const raw = (env.STELLAR_NETWORK ?? "testnet").trim().toLowerCase()
  if (raw === "mainnet") {
    throw new StellarNetworkConfigError(
      `Testnet fixture "${context}" is fenced and forbidden in mainnet configuration`,
    )
  }
}

export function resolveStellarNetwork(
  env: Record<string, string | undefined> = process.env,
): ResolvedStellarNetwork {
  const raw = (env.STELLAR_NETWORK ?? "testnet").trim().toLowerCase()
  if (raw !== "testnet" && raw !== "mainnet") {
    throw new StellarNetworkConfigError(`STELLAR_NETWORK must be "testnet" or "mainnet", got "${raw}"`)
  }
  const network: StellarNetworkName = raw

  const override = (env.STELLAR_NETWORK_PASSPHRASE ?? env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE)?.trim()
  if (override && override !== STELLAR_PASSPHRASES[network]) {
    throw new StellarNetworkConfigError(
      `Passphrase override does not match STELLAR_NETWORK=${network}; refusing to sign against a mixed domain`,
    )
  }

  if (network === "mainnet") {
    if (env.PHASE_MAINNET_CUTOVER_ACK?.trim() !== "1") {
      throw new StellarNetworkConfigError(
        "Mainnet selected without PHASE_MAINNET_CUTOVER_ACK=1 (cutover ceremony not acknowledged)",
      )
    }

    if (isPhase238Enabled(env)) {
      const confirmationToken = env.PHASE_MAINNET_CONFIRMATION_TOKEN?.trim()
      if (!confirmationToken || confirmationToken.length < 16) {
        throw new StellarNetworkConfigError(
          "Mainnet selected without valid PHASE_MAINNET_CONFIRMATION_TOKEN (minimum 16 characters required)",
        )
      }
    }
  }

  return { network, passphrase: STELLAR_PASSPHRASES[network] }
}

export type MainnetCutoverChecklist = {
  issuerValid: boolean
  contractValid: boolean
  passphraseValid: boolean
  tokenValid: boolean
  isDryRun: boolean
  ready: boolean
  errors: string[]
}

export function verifyMainnetCutoverReadiness(params: {
  issuerPublicKey?: string
  contractId?: string
  confirmationToken?: string
  env?: Record<string, string | undefined>
}): MainnetCutoverChecklist {
  const env = params.env ?? process.env
  const errors: string[] = []

  // Check ACK
  if (env.PHASE_MAINNET_CUTOVER_ACK?.trim() !== "1") {
    errors.push("Missing PHASE_MAINNET_CUTOVER_ACK=1")
  }

  // Check confirmation token (min 16 chars)
  const token = params.confirmationToken ?? env.PHASE_MAINNET_CONFIRMATION_TOKEN
  const tokenValid = typeof token === "string" && token.trim().length >= 16
  if (!tokenValid) {
    errors.push("Invalid or missing PHASE_MAINNET_CONFIRMATION_TOKEN (min 16 chars required)")
  }

  // Check issuer public key (G...)
  const issuer = params.issuerPublicKey ?? env.PHASE_MAINNET_ISSUER_PUBLIC_KEY
  const issuerValid = typeof issuer === "string" && /^G[A-Z2-7]{55}$/.test(issuer.trim())
  if (!issuerValid) {
    errors.push("Invalid or missing mainnet issuer public key (must start with G, 56 chars)")
  }

  // Check contract ID (C...)
  const contract = params.contractId ?? env.PHASE_MAINNET_CONTRACT_ID
  const contractValid = typeof contract === "string" && /^C[A-Z2-7]{55}$/.test(contract.trim())
  if (!contractValid) {
    errors.push("Invalid or missing mainnet contract ID (must start with C, 56 chars)")
  }

  // Passphrase
  const override = env.STELLAR_NETWORK_PASSPHRASE?.trim()
  const passphraseValid = !override || override === STELLAR_PASSPHRASES.mainnet
  if (!passphraseValid) {
    errors.push("STELLAR_NETWORK_PASSPHRASE does not match canonical mainnet passphrase")
  }

  const isDryRun = isMainnetDryRun(env)

  return {
    issuerValid,
    contractValid,
    passphraseValid,
    tokenValid,
    isDryRun,
    ready: errors.length === 0,
    errors,
  }
}
