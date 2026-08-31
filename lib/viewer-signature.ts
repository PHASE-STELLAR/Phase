/**
 * Community-signal proof of wallet ownership (SEP-53 Ed25519 message signing).
 *
 * The previous implementation stored a mock signature (the wallet address
 * itself), which proves nothing. Here the client signs a canonical payload and
 * the server verifies it with @stellar/stellar-sdk `Keypair.verify` before the
 * signal is persisted, so a forger cannot claim authorship of another wallet.
 *
 * Signing and verification share a single deterministic message derivation so
 * the bytes signed client-side are exactly the bytes verified server-side.
 */

/** SEP-53 fixed prefix, concatenated with the message before hashing. */
export const SIGNATURE_PREFIX = "Stellar Signed Message:\n"

/** Canonical payload signed/proven for a community signal. */
export type SignalProofPayload = {
  title: string
  body: string
  timestamp: number
}

/**
 * Deterministic JSON serialization of the payload. Both the client (before
 * signing) and the server (before verifying) build this identical string, so
 * the Ed25519 signature always binds to the exact signal content.
 */
export function canonicalSignalPayload(payload: SignalProofPayload): string {
  return JSON.stringify({ title: payload.title, body: payload.body, timestamp: payload.timestamp })
}

/** SHA-256 of a UTF-8 string, hex-encoded. Works on both browser & Node 22+. */
export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text)
  const buf = await crypto.subtle.digest("SHA-256", data)
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

/**
 * Fixed-size message that gets signed. We sign a digest of the canonical
 * payload rather than the raw payload so the signed string stays well under
 * the ~1KB limit some wallets impose on `sign_message`.
 */
export async function signalProofMessage(payload: SignalProofPayload): Promise<string> {
  const digest = await sha256Hex(canonicalSignalPayload(payload))
  return `phase-signal:v1:${digest}`
}

/** Server-only: verify a SEP-53 Ed25519 signature over the given payload. */
export async function verifySignalSignature(
  wallet: string,
  payload: SignalProofPayload,
  signatureBase64: string,
): Promise<boolean> {
  try {
    const { Keypair } = await import("@stellar/stellar-sdk")
    const message = await signalProofMessage(payload)
    const data = new TextEncoder().encode(SIGNATURE_PREFIX + message)
    const signature = Buffer.from(signatureBase64, "base64")
    return Keypair.fromPublicKey(wallet).verify(data, signature)
  } catch {
    return false
  }
}

/**
 * Client-only: sign the payload with the currently-selected wallet via the
 * Stellar Wallets Kit `signMessage` (SEP-53). Returns the base64 signature.
 */
export async function signSignalPayload(
  payload: SignalProofPayload,
  address: string,
): Promise<string> {
  const { StellarWalletsKit } = await import("@creit.tech/stellar-wallets-kit")
  const message = await signalProofMessage(payload)
  const result = (await StellarWalletsKit.signMessage(message, { address })) as {
    signedMessage?: string | null
  }
  const signature = result?.signedMessage
  if (!signature) {
    throw new Error("Wallet signing returned no signature")
  }
  return signature
}
