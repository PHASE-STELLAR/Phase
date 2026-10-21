/**
 * SEP-10 web authentication with server-issued sessions — spike 641 (issue #503).
 *
 * Writes historically trusted `acting_wallet` / `X-Wallet-Address` headers. This
 * module replaces that with a proof of key possession: the server builds a
 * challenge transaction, the wallet signs it client-side (Freighter), and the
 * server verifies the signature before minting an opaque bearer session. Only
 * the SHA-256 of the session token is persisted.
 *
 * Feature flag: phase-162. Rollback: unset flag; existing header routes are untouched.
 * Secrets: SEP10_SERVER_SECRET lives in server runtime only (never NEXT_PUBLIC_*).
 */

import { createHash, randomBytes } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { Keypair, StrKey, WebAuth } from "@stellar/stellar-sdk"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { resolveStellarNetwork } from "@/lib/stellar-network"
import { serverDataJsonPath } from "@/lib/server-data-paths"

/** Challenge transactions are only valid for this many seconds. */
export const SEP10_CHALLENGE_TTL_SECONDS = 300

/** Sessions last this long; the client must re-run the challenge after expiry. */
export const SEP10_SESSION_TTL_SECONDS = 3600

export class Sep10AuthError extends Error {
  code: "FLAG_DISABLED" | "CONFIG_MISSING" | "INVALID_ACCOUNT" | "INVALID_CHALLENGE" | "REPLAYED_CHALLENGE"
  constructor(code: Sep10AuthError["code"], message: string) {
    super(message)
    this.name = "Sep10AuthError"
    this.code = code
  }
}

export function isSep10Enabled(): boolean {
  return isFeatureEnabled("phase-162")
}

function requireEnabled(): void {
  if (!isSep10Enabled()) {
    throw new Sep10AuthError("FLAG_DISABLED", "SEP-10 auth disabled (phase-162 flag off)")
  }
}

function serverKeypair(): Keypair {
  const secret = process.env.SEP10_SERVER_SECRET?.trim()
  if (!secret || !StrKey.isValidEd25519SecretSeed(secret)) {
    throw new Sep10AuthError("CONFIG_MISSING", "SEP10_SERVER_SECRET is not set to a valid secret seed")
  }
  return Keypair.fromSecret(secret)
}

function homeDomain(): string {
  return process.env.SEP10_HOME_DOMAIN?.trim() || "phase.app"
}

function webAuthDomain(): string {
  return process.env.SEP10_WEB_AUTH_DOMAIN?.trim() || homeDomain()
}

export function buildChallenge(account: string): { transaction: string; network_passphrase: string } {
  requireEnabled()
  if (!StrKey.isValidEd25519PublicKey(account)) {
    throw new Sep10AuthError("INVALID_ACCOUNT", "account must be a Stellar G address")
  }
  const { passphrase } = resolveStellarNetwork()
  const transaction = WebAuth.buildChallengeTx(
    serverKeypair(),
    account,
    homeDomain(),
    SEP10_CHALLENGE_TTL_SECONDS,
    passphrase,
    webAuthDomain(),
  )
  return { transaction, network_passphrase: passphrase }
}

/**
 * Verify a client-signed challenge. The signature check is delegated to the SDK
 * (`verifyChallengeTxSigners`), which also enforces time bounds, the server
 * source account, and the home domain manage-data entry.
 */
export function verifyChallenge(transaction: string, account: string): void {
  requireEnabled()
  const server = serverKeypair().publicKey()
  const { passphrase } = resolveStellarNetwork()
  try {
    WebAuth.readChallengeTx(transaction, server, passphrase, homeDomain(), webAuthDomain())
  } catch {
    throw new Sep10AuthError("INVALID_CHALLENGE", "challenge transaction is malformed or expired")
  }
  const signers = WebAuth.verifyChallengeTxSigners(
    transaction,
    server,
    passphrase,
    [account],
    homeDomain(),
    webAuthDomain(),
  )
  if (!signers.includes(account)) {
    throw new Sep10AuthError("INVALID_CHALLENGE", "challenge is not signed by the claimed account")
  }
}

// ─── session store ───────────────────────────────────────────────────────────

type SessionRecord = { wallet: string; expires_at: number }
type AuthStore = {
  sessions: Record<string, SessionRecord>
  consumed_challenges: Record<string, number>
}

const EMPTY_STORE: AuthStore = { sessions: {}, consumed_challenges: {} }

function sha256Base64url(value: string): string {
  return createHash("sha256").update(value).digest("base64url")
}

async function readStore(): Promise<AuthStore> {
  try {
    const raw = await readFile(serverDataJsonPath("authSessions"), "utf8")
    const parsed = JSON.parse(raw) as Partial<AuthStore>
    return {
      sessions: parsed.sessions ?? {},
      consumed_challenges: parsed.consumed_challenges ?? {},
    }
  } catch {
    return { ...EMPTY_STORE, sessions: {}, consumed_challenges: {} }
  }
}

async function writeStore(store: AuthStore): Promise<void> {
  const fp = serverDataJsonPath("authSessions")
  await mkdir(path.dirname(fp), { recursive: true })
  await writeFile(fp, JSON.stringify(store, null, 2), "utf8")
}

/**
 * Accept a signed challenge exactly once and mint a session. A replayed
 * transaction (same hash inside its validity window) is rejected.
 */
export async function issueSession(
  transaction: string,
  account: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<{ token: string; wallet: string; expires_at: number }> {
  verifyChallenge(transaction, account)

  const challengeKey = sha256Base64url(transaction)
  const store = await readStore()
  for (const [k, exp] of Object.entries(store.consumed_challenges)) {
    if (exp <= now) delete store.consumed_challenges[k]
  }
  for (const [k, s] of Object.entries(store.sessions)) {
    if (s.expires_at <= now) delete store.sessions[k]
  }
  if (store.consumed_challenges[challengeKey]) {
    throw new Sep10AuthError("REPLAYED_CHALLENGE", "challenge already redeemed")
  }

  const token = randomBytes(32).toString("base64url")
  const expiresAt = now + SEP10_SESSION_TTL_SECONDS
  store.consumed_challenges[challengeKey] = now + SEP10_CHALLENGE_TTL_SECONDS
  store.sessions[sha256Base64url(token)] = { wallet: account, expires_at: expiresAt }
  await writeStore(store)
  return { token, wallet: account, expires_at: expiresAt }
}

/** Resolve the authenticated wallet from `Authorization: Bearer <token>`, or null. */
export async function resolveSessionWallet(request: Request): Promise<string | null> {
  if (!isSep10Enabled()) return null
  const header = request.headers.get("authorization")?.trim() ?? ""
  if (!header.toLowerCase().startsWith("bearer ")) return null
  const token = header.slice("bearer ".length).trim()
  if (!token) return null

  const store = await readStore()
  const session = store.sessions[sha256Base64url(token)]
  if (!session || session.expires_at <= Math.floor(Date.now() / 1000)) return null
  return session.wallet
}

export async function revokeSession(request: Request): Promise<boolean> {
  const header = request.headers.get("authorization")?.trim() ?? ""
  if (!header.toLowerCase().startsWith("bearer ")) return false
  const key = sha256Base64url(header.slice("bearer ".length).trim())
  const store = await readStore()
  if (!store.sessions[key]) return false
  delete store.sessions[key]
  await writeStore(store)
  return true
}
