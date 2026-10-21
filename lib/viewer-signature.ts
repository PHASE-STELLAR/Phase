// @ts-nocheck
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

/** Presentation identifier only. Authorization always requires a verified signature. */
export function viewerSignatureShort(wallet: string | null | undefined): string {
  if (!wallet) return ""
  return `${wallet.slice(0, 6)}…${wallet.slice(-4)}`
}

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

/**
 * SEP-53: the wallet signs SHA-256(prefix + message), not the prefixed bytes
 * themselves (stellar-protocol ecosystem/sep-0053.md, "Signing" steps 2-4).
 * Verifying the raw prefixed bytes rejected every real wallet signature.
 */
export async function sep53SignedBytes(message: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(SIGNATURE_PREFIX + message)
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data))
}

/** Server-only: verify a SEP-53 signature by `wallet` over `message`. */
export async function verifySep53Signature(
  wallet: string,
  message: string,
  signatureBase64: string,
): Promise<boolean> {
  try {
    const { Keypair } = await import("@stellar/stellar-sdk")
    const signed = Buffer.from(await sep53SignedBytes(message))
    return Keypair.fromPublicKey(wallet).verify(signed, Buffer.from(signatureBase64, "base64"))
  } catch {
    return false
  }
}

/** Server-only: verify a SEP-53 Ed25519 signature over the given payload. */
export async function verifySignalSignature(
  wallet: string,
  payload: SignalProofPayload,
  signatureBase64: string,
): Promise<boolean> {
  return verifySep53Signature(wallet, await signalProofMessage(payload), signatureBase64)
}

/** Canonical payload signed/proven for a world-role assignment (issue #247). */
export type WorldRoleProofPayload = {
  action: "world-role-assign"
  collection_id: number
  target_wallet: string
  role: string
  timestamp: number
}

/**
 * Deterministic serialization for a world-role proof. Like
 * canonicalSignalPayload(), the client and server must build the exact same
 * string so the Ed25519 signature always binds to the action being performed.
 */
export function canonicalWorldRolePayload(payload: WorldRoleProofPayload): string {
  return JSON.stringify({
    action: payload.action,
    collection_id: payload.collection_id,
    target_wallet: payload.target_wallet,
    role: payload.role,
    timestamp: payload.timestamp,
  })
}

/** Fixed-size message signed for a world-role assignment (issue #247). */
export async function worldRoleProofMessage(payload: WorldRoleProofPayload): Promise<string> {
  const digest = await sha256Hex(canonicalWorldRolePayload(payload))
  return `phase-world-role:v1:${digest}`
}

/**
 * Server-only: verify a SEP-53 Ed25519 signature over a world-role assignment
 * made by `wallet` (issue #247). The presence check on X-Wallet-Signature is
 * not sufficient on its own — without this check any caller could claim to be
 * the world owner by simply setting acting_wallet to the owner's address.
 */
export async function verifyWorldRoleSignature(
  wallet: string,
  payload: WorldRoleProofPayload,
  signatureBase64: string,
): Promise<boolean> {
  return verifySep53Signature(wallet, await worldRoleProofMessage(payload), signatureBase64)
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


/*
 * Firma corta derivada del visor (wallet u otro id) — cambia por sesión/dirección; no es criptografía fuerte.
 * Kept (7cc03e4) because fusion-chamber, phase-artifact-visualizer and phase-protected-preview
 * still import it for the visual watermark.
 */
export function viewerSignatureShortWatermark(addressOrWallet: string | null | undefined): string {
  const s = (addressOrWallet ?? "ANON_VIEWER").trim()
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return (h >>> 0).toString(16).toUpperCase().padStart(8, "0").slice(0, 6)
}
