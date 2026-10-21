/**
 * Stellar network resolution with passphrase validation — spike 640 (issue #502).
 *
 * The passphrase used for signature domains (viewer gate, SEP-10 challenges) was
 * read from ad-hoc env vars with a testnet fallback. A mainnet deploy that set
 * only the RPC URL would silently sign and verify against testnet. This module
 * is the single source: the network name picks the canonical passphrase, a
 * conflicting override throws, and mainnet stays closed until the cutover
 * ceremony is acknowledged via PHASE_MAINNET_CUTOVER_ACK.
 *
 * Feature flag: phase-163 (gates the mainnet status route only; resolution is always on).
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

  if (network === "mainnet" && env.PHASE_MAINNET_CUTOVER_ACK?.trim() !== "1") {
    throw new StellarNetworkConfigError(
      "Mainnet selected without PHASE_MAINNET_CUTOVER_ACK=1 (cutover ceremony not acknowledged)",
    )
  }

  return { network, passphrase: STELLAR_PASSPHRASES[network] }
}
