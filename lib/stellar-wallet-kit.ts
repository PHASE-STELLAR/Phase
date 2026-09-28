"use client"

import {
  KitEventType,
  Networks,
  parseError,
  StellarWalletsKit,
} from "@creit.tech/stellar-wallets-kit"
import { defaultModules } from "@creit.tech/stellar-wallets-kit/modules/utils"
import { FREIGHTER_ID } from "@creit.tech/stellar-wallets-kit/modules/freighter"
import { LedgerModule, LEDGER_ID } from "@creit.tech/stellar-wallets-kit/modules/ledger"
import {
  WalletConnectModule,
  WalletConnectTargetChain,
  WALLET_CONNECT_ID,
} from "@creit.tech/stellar-wallets-kit/modules/wallet-connect"
import { albedoImplicitTxAllowed, isAlbedoSelectedInKit } from "@/lib/albedo-intent-client"
import { randomUUID } from "node:crypto"

let initialized = false

const LS_SELECTED_MODULE_ID = "@StellarWalletsKit/selectedModuleId"
const LS_POSTMESSAGE_NONCE = "@StellarWalletsKit/postMessageNonce"
const LS_POSTMESSAGE_ORIGIN = "@StellarWalletsKit/postMessageOrigin"

/** Testnet network passphrase — used for network validation on hardware wallets. */
export const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015"
export const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015"

/**
 * WalletConnect project ID. Set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID in your environment.
 * Get a free project ID at https://cloud.reown.com
 */
const WC_PROJECT_ID =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "8b0db5d25e9ea3d7bddf2b96e1b7f0eb"

function generatePostMessageNonce(): string {
  if (typeof window === "undefined") return ""
  const nonce = randomUUID()
  try {
    window.localStorage.setItem(LS_POSTMESSAGE_NONCE, nonce)
    window.localStorage.setItem(LS_POSTMESSAGE_ORIGIN, window.location.origin)
  } catch {
    // localStorage unavailable; nonce remains in memory
  }
  return nonce
}

function getPostMessageNonce(): string | null {
  if (typeof window === "undefined") return null
  try {
    return window.localStorage.getItem(LS_POSTMESSAGE_NONCE)
  } catch {
    return null
  }
}

function validatePostMessageOrigin(): boolean {
  if (typeof window === "undefined") return false
  try {
    const storedOrigin = window.localStorage.getItem(LS_POSTMESSAGE_ORIGIN)
    return storedOrigin === window.location.origin
  } catch {
    return false
  }
}

/**
 * Build the full modules list: all defaultModules (no extra config needed) plus
 * LedgerModule (requires Buffer polyfill — provided via next.config) and
 * WalletConnectModule (requires a Reown/WalletConnect project ID).
 *
 * Si siempre pasáramos `selectedWalletId: FREIGHTER_ID`, cada carga pisaba la wallet que el usuario
 * eligió en el modal (p. ej. Albedo) y la firma iba a Freighter o fallaba sin UI clara.
 */
export function initStellarWalletKit() {
  if (initialized) return
  const hasPersistedModule =
    typeof window !== "undefined" && Boolean(window.localStorage.getItem(LS_SELECTED_MODULE_ID)?.trim())

  if (typeof window !== "undefined") {
    generatePostMessageNonce()
    if (!validatePostMessageOrigin()) {
      console.warn("[PHASE] Wallet Kit: postMessage origin mismatch — possible hijack attempt")
    }
  }

  const walletConnectModule = new WalletConnectModule({
    projectId: WC_PROJECT_ID,
    metadata: {
      name: "PHASE Protocol",
      description: "AI artifact minting gated by on-chain Stellar payment.",
      url: typeof window !== "undefined" ? window.location.origin : "https://phase.app",
      icons: ["https://phase.app/icon.png"],
    },
    allowedChains: [WalletConnectTargetChain.TESTNET],
  })

  const ledgerModule = new LedgerModule()

  StellarWalletsKit.init({
    modules: [...defaultModules(), ledgerModule, walletConnectModule],
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

export {
  FREIGHTER_ID,
  LEDGER_ID,
  WALLET_CONNECT_ID,
  KitEventType,
  Networks,
  parseError,
  WalletConnectTargetChain,
}

/**
 * Detect whether the currently-selected wallet module is a hardware wallet (Ledger).
 * Used to apply extra passphrase validation before signing.
 */
export function isHardwareWalletSelected(): boolean {
  if (typeof window === "undefined") return false
  const selected = window.localStorage.getItem(LS_SELECTED_MODULE_ID)?.trim()
  return selected === LEDGER_ID
}

/**
 * Detect whether the currently-selected wallet module is WalletConnect.
 */
export function isWalletConnectSelected(): boolean {
  if (typeof window === "undefined") return false
  const selected = window.localStorage.getItem(LS_SELECTED_MODULE_ID)?.trim()
  return selected === WALLET_CONNECT_ID
}

/** Compatibilidad con el shape de `signTransaction` de Freighter (`error` en lugar de throw). */
export async function signTransaction(
  xdr: string,
  opts: { networkPassphrase: string; address: string },
): Promise<
  | { signedTxXdr: string; signedTransaction?: string; error?: undefined }
  | { error: { message: string }; signedTxXdr?: undefined; signedTransaction?: undefined }
> {
  initStellarWalletKit()

  // ── Network passphrase guard for Ledger ────────────────────────────────────
  // Ledger apps are network-specific: signing testnet XDRs on a mainnet-mode
  // Stellar app will fail cryptographically. Catch this mismatch early and
  // surface a clear human-readable error instead of a cryptic HID timeout.
  if (typeof window !== "undefined" && isHardwareWalletSelected()) {
    if (
      opts.networkPassphrase &&
      opts.networkPassphrase !== TESTNET_PASSPHRASE &&
      opts.networkPassphrase !== MAINNET_PASSPHRASE
    ) {
      return {
        error: {
          message: `Ledger: red desconocida (passphrase "${opts.networkPassphrase.slice(0, 32)}…"). Verificá que la app Stellar del Ledger esté abierta y en la red correcta. / Unknown network passphrase. Make sure the Stellar app is open on your Ledger and set to the correct network.`,
        },
      }
    }
    // Warn if the app is currently operating on testnet but receiving a mainnet passphrase
    if (opts.networkPassphrase === MAINNET_PASSPHRASE) {
      console.warn("[PHASE] Ledger: signing a MAINNET transaction — ensure your Ledger Stellar app is in mainnet mode.")
    }
  }

  // ── Albedo implicit-tx guard ───────────────────────────────────────────────
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

  if (typeof window !== "undefined" && !validatePostMessageOrigin()) {
    return {
      error: {
        message: "Wallet Kit security check failed: origin mismatch. This may indicate a hijack attempt.",
      },
    }
  }

  try {
    const { signedTxXdr } = await StellarWalletsKit.signTransaction(xdr, opts)
    return { signedTxXdr, signedTransaction: signedTxXdr }
  } catch (e: unknown) {
    const err = parseError(e)
    const raw = err.message ?? ""
    let message = raw

    if (/transport|webusb|hid|usb/i.test(raw)) {
      message = `Ledger USB: ${raw}. Intentá desconectar y volver a enchufar el dispositivo, o habilitá el acceso HID/WebUSB en la configuración del navegador. / USB transport error. Try unplugging and reconnecting the Ledger, or enable HID/WebUSB in browser settings.`
    } else if (/timeout/i.test(raw)) {
      message = `Ledger: tiempo de espera agotado. Asegurate de que la app Stellar esté abierta y el dispositivo desbloqueado. / Ledger sign timeout. Make sure the Stellar app is open and the device is unlocked.`
    } else if (/denied|rejected|cancel/i.test(raw)) {
      message = `Ledger: transacción rechazada en el dispositivo. / Transaction rejected on device.`
    } else if (/no wallet has been connected/i.test(raw)) {
      message = `Sin wallet conectada. Conectá tu wallet antes de firmar. / No wallet connected. Please connect a wallet first.`
    }

    return { error: { message } }
  }
}
