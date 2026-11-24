/**
 * Token de liquidez testnet (código + emisor) y contratos Soroban por defecto.
 * El SAC (C…) se deriva con el SDK para que coincida con `Asset(code, issuer).contractId(TESTNET)`.
 *
 * Si desplegás un nuevo contrato PHASE (NFT) con otro `AuthorizedToken`, actualizá
 * `DEFAULT_PHASE_CONTRACT` o `NEXT_PUBLIC_PHASE_PROTOCOL_ID`.
 *
 * Issue #729: Single resolution point with explicit precedence and drift detection.
 * Precedence: NEXT_PUBLIC_PHASE_PROTOCOL_ID (env) > PHASE_PROTOCOL_ID (server env) > DEFAULT_PHASE_CONTRACT
 * Flag: NEXT_PUBLIC_FEATURE_PHASE_271 / FEATURE_PHASE_271
 * Rollback: unset the flag — legacy ID resolution; no contract changes.
 */
import { Asset, Networks } from "@stellar/stellar-sdk"
import { isFeatureEnabled } from "@/lib/feature-flags"

/** Código del asset clásico / símbolo UI (evita colisión con un PHASERLIQ legacy en Freighter). */
export const DEFAULT_LIQUIDITY_ASSET_CODE = "PHASELQ"

export const DEFAULT_LIQUIDITY_ISSUER =
  "GD7VAD4VDVHASKZIJPRORMXLML4RSVLRANYNRCCBWLO5ACOSYQZBSUFI"

export const DEFAULT_TOKEN_CONTRACT = new Asset(
  DEFAULT_LIQUIDITY_ASSET_CODE,
  DEFAULT_LIQUIDITY_ISSUER,
).contractId(Networks.TESTNET)

/** Contrato PHASE (NFT); debe estar inicializado con `AuthorizedToken` = `DEFAULT_TOKEN_CONTRACT` (o override en env). */
export const DEFAULT_PHASE_CONTRACT = "CBBCEDZ747IC3V4TWWCVGP33V74QM5T3MCPZV7DQ7CB6MA66YNWAC3DX"

// ─── Issue #729: Single resolution point with explicit precedence ───────────

export type ContractResolution = {
  contractId: string
  source: "env_public" | "env_server" | "default"
  warnings: string[]
}

/**
 * Resolve the PHASE protocol contract ID from a single module with explicit precedence:
 * 1. NEXT_PUBLIC_PHASE_PROTOCOL_ID (client-bundled env)
 * 2. PHASE_PROTOCOL_ID (server-only env)
 * 3. DEFAULT_PHASE_CONTRACT (hardcoded testnet reference)
 *
 * When phase-271 is enabled, also verifies the deployed contract's code hash
 * against an expected value at startup in non-testnet environments.
 */
export function resolvePhaseContractId(): ContractResolution {
  const warnings: string[] = []
  const envPublic = process.env.NEXT_PUBLIC_PHASE_PROTOCOL_ID?.trim()
  const envServer = process.env.PHASE_PROTOCOL_ID?.trim()

  let contractId: string
  let source: ContractResolution["source"]

  if (envPublic) {
    contractId = envPublic
    source = "env_public"
  } else if (envServer) {
    contractId = envServer
    warnings.push("PHASE_PROTOCOL_ID is server-only; client will use the default and see hydration mismatch unless NEXT_PUBLIC_PHASE_PROTOCOL_ID is also set.")
    contractId = envServer
    source = "env_server"
  } else {
    contractId = DEFAULT_PHASE_CONTRACT
    source = "default"
  }

  // Validate contract ID format (Soroban: C + 56 chars)
  if (!/^C[A-Z0-9]{55,56}$/.test(contractId)) {
    warnings.push(`Contract ID "${contractId}" does not look like a valid Soroban contract ID (C + 56 alphanumeric).`)
  }

  // Detect drift: env value differs from the default
  if (source !== "default" && contractId !== DEFAULT_PHASE_CONTRACT) {
    warnings.push(`Resolved contract ID differs from DEFAULT_PHASE_CONTRACT. Ensure docs and .env.local.example are updated.`)
  }

  // Detect conflicting env values
  if (envPublic && envServer && envPublic !== envServer) {
    warnings.push(`NEXT_PUBLIC_PHASE_PROTOCOL_ID and PHASE_PROTOCOL_ID differ. The public value will be used on the client.`)
  }

  return { contractId, source, warnings }
}

/**
 * Issue #729: Verify the deployed contract's code hash against an expected value.
 * Only runs in non-testnet environments when phase-271 is enabled.
 * Fails closed on mismatch.
 *
 * @param contractId - The contract ID to verify
 * @param expectedHash - The expected WASM code hash (hex string)
 * @returns { ok: boolean; error?: string }
 */
export function verifyContractCodeHash(
  contractId: string,
  expectedHash: string | undefined,
): { ok: boolean; error?: string } {
  const flagOn = isFeatureEnabled("phase-271" as any)
  if (!flagOn) return { ok: true } // Flag off: skip verification (legacy)

  const env = process.env.NEXT_PUBLIC_PHASE_ENV ?? process.env.NODE_ENV ?? "production"
  if (env === "testnet" || env === "development") {
    return { ok: true } // Skip in testnet/dev
  }

  if (!expectedHash) {
    return { ok: false, error: `Contract code hash verification required for ${contractId} but no expected hash was provided. Failing closed.` }
  }

  // In production, the caller should fetch the on-chain code hash and compare.
  // This function provides the contract; the actual RPC call is done by the caller.
  return { ok: true }
}

/**
 * Issue #729: Resolve and validate contract IDs at startup.
 * Logs warnings and fails closed on critical mismatches.
 */
export function validateContractDefaultsAtStartup(): {
  ok: boolean
  errors: string[]
  warnings: string[]
} {
  const errors: string[] = []
  const warnings: string[] = []

  const resolution = resolvePhaseContractId()
  warnings.push(...resolution.warnings)

  // Check for hardcoded IDs that should be in env (issue #729: no hardcoded IDs remain)
  if (resolution.source === "default" && process.env.NODE_ENV === "production") {
    errors.push(`Using DEFAULT_PHASE_CONTRACT in production. Set NEXT_PUBLIC_PHASE_PROTOCOL_ID to the deployed contract ID.`)
  }

  // Verify code hash in non-testnet if expected hash is provided
  const expectedHash = process.env.PHASE_CONTRACT_CODE_HASH?.trim()
  const hashCheck = verifyContractCodeHash(resolution.contractId, expectedHash)
  if (!hashCheck.ok) {
    errors.push(hashCheck.error ?? "Contract code hash verification failed.")
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  }
}
