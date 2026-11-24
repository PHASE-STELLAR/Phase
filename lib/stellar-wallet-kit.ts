"use client"

import {
  KitEventType,
  Networks,
  parseError,
  StellarWalletsKit,
} from "@creit.tech/stellar-wallets-kit"
import { defaultModules } from "@creit.tech/stellar-wallets-kit/modules/utils"
import { FREIGHTER_ID } from "@creit.tech/stellar-wallets-kit/modules/freighter"
import { albedoImplicitTxAllowed, isAlbedoSelectedInKit } from "@/lib/albedo-intent-client"
import {
  AlbedoSunsetError,
  albedoRetiredSignMessage,
  assertAlbedoCallSiteAllowed,
} from "@/lib/albedo-sunset"
import { incSecurityCounter } from "@/lib/security-counters"

let initialized = false

const LS_SELECTED_MODULE_ID = "@StellarWalletsKit/selectedModuleId"

/**
 * Si siempre pasáramos `selectedWalletId: FREIGHTER_ID`, cada carga pisaba la wallet que el usuario
 * eligió en el modal (p. ej. Albedo) y la firma iba a Freighter o fallaba sin UI clara.
 */
export function initStellarWalletKit() {
  if (initialized) return
  const hasPersistedModule =
    typeof window !== "undefined" && Boolean(window.localStorage.getItem(LS_SELECTED_MODULE_ID)?.trim())

  StellarWalletsKit.init({
    modules: defaultModules(),
    network: Networks.TESTNET,
    ...(!hasPersistedModule ? { selectedWalletId: FREIGHTER_ID } : {}),
  })
  initialized = true
}

/**
 * v2.x del kit expone la API en la clase estática; este alias coincide con el patrón
 * `kit.*` de la documentación y evita instancias.
 */
export const kit = StellarWalletsKit

/** WalletConnect module detection mirrors the Albedo helper in albedo-intent-client. */
export function isWalletConnectSelectedInKit(): boolean {
  if (typeof window === "undefined") return false
  try {
    return StellarWalletsKit.selectedModule.productId.toLowerCase().includes("walletconnect")
  } catch {
    const stored = window.localStorage.getItem(LS_SELECTED_MODULE_ID) ?? ""
    return stored.toLowerCase().includes("walletconnect")
  }
}

export { FREIGHTER_ID, KitEventType, Networks, parseError }

/** Compatibilidad con el shape de `signTransaction` de Freighter (`error` en lugar de throw). */
export async function signTransaction(
  xdr: string,
  opts: { networkPassphrase: string; address: string },
): Promise<
  | { signedTxXdr: string; signedTransaction?: string; error?: undefined }
  | { error: { message: string }; signedTxXdr?: undefined; signedTransaction?: undefined }
> {
  initStellarWalletKit()
  // phase-221: fail closed with migration copy once Albedo is retired.
  if (typeof window !== "undefined" && opts.address && isAlbedoSelectedInKit()) {
    try {
      assertAlbedoCallSiteAllowed("kit-sign-guard")
    } catch (e) {
      if (e instanceof AlbedoSunsetError) {
        incSecurityCounter("albedo_signing_blocked")
        return { error: { message: albedoRetiredSignMessage() } }
      }
      throw e
    }
  }
  if (typeof window !== "undefined" && opts.address && isAlbedoSelectedInKit()) {
    const implicitOk = await albedoImplicitTxAllowed(opts.address)
    if (!implicitOk) {
      return {
        error: {
          message:
            "Albedo: primero concedé permiso de firma con el aviso inferior («Permitir firma») o en la tarjeta de trustline de Forge. Si no, el navegador bloquea el diálogo tras cargar Horizon o Soroban; permití también ventanas para albedo.link.",
        },
      }
    }
  }
  try {
    const { signedTxXdr } = await StellarWalletsKit.signTransaction(xdr, opts)
    return { signedTxXdr, signedTransaction: signedTxXdr }
  } catch (e: unknown) {
    const err = parseError(e)
    return { error: { message: err.message } }
  }
}
