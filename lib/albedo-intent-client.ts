"use client"

import { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit"
import {
  albedoRetiredSignMessage,
  isAlbedoRetired,
} from "@/lib/albedo-sunset"

/** Misma red que `Networks.TESTNET` del kit Albedo (`albedo.module.js`). */
export const ALBEDO_NETWORK_TESTNET = "testnet"

const SELECTED_MODULE_LS = "@StellarWalletsKit/selectedModuleId"
export const ALBEDO_WALLET_MODULE_ID = "albedo"

type AlbedoLike = {
  implicitFlow: (p: { intents: string | string[]; network?: string }) => Promise<{ granted?: boolean }>
  isImplicitSessionAllowed: (intent: string, pubkey: string) => boolean
}

function resolveAlbedoApi(m: unknown): AlbedoLike {
  const x = m as { default?: unknown }
  const first = (x.default ?? m) as AlbedoLike | { default?: AlbedoLike }
  if (first && typeof (first as AlbedoLike).implicitFlow === "function") {
    return first as AlbedoLike
  }
  const second = (first as { default?: AlbedoLike }).default
  if (second && typeof second.implicitFlow === "function") return second
  throw new Error("Albedo intent API not found")
}

export function getSelectedStellarKitModuleId(): string | null {
  if (typeof window === "undefined") return null
  try {
    return StellarWalletsKit.selectedModule.productId
  } catch {
    return window.localStorage.getItem(SELECTED_MODULE_LS)
  }
}

/** Usa el módulo activo del kit (fuente de verdad) y hace fallback a localStorage. */
export function isAlbedoSelectedInKit(): boolean {
  if (typeof window === "undefined") return false
  const fromLs = window.localStorage.getItem(SELECTED_MODULE_LS)
  try {
    return StellarWalletsKit.selectedModule.productId === ALBEDO_WALLET_MODULE_ID
  } catch {
    return fromLs === ALBEDO_WALLET_MODULE_ID
  }
}

export async function getAlbedoIntent(): Promise<AlbedoLike> {
  // Spike 626: once retired the intent bundle is never loaded and no popup
  // can open — the write path is closed at the source.
  if (isAlbedoRetired()) {
    throw new Error(`Albedo retired: ${albedoRetiredSignMessage()}`)
  }
  const pkg = await import("@albedo-link/intent")
  return resolveAlbedoApi(pkg)
}

export async function albedoImplicitTxAllowed(pubkey: string): Promise<boolean> {
  if (!pubkey || !isAlbedoSelectedInKit()) return true
  // Spike 626: pre-sign probes short-circuit when retired; signing itself is
  // blocked fail-closed by the kit sign guard with migration copy.
  if (isAlbedoRetired()) return true
  const albedo = await getAlbedoIntent()
  return albedo.isImplicitSessionAllowed("tx", pubkey)
}

/**
 * Debe llamarse desde un clic del usuario (gesto explícito) para que el popup de Albedo no sea bloqueado.
 * Tras conceder, `tx` puede firmarse vía iframe sin ventana emergente en flujos async largos.
 */
export async function requestAlbedoImplicitTxFlow(): Promise<{ ok: true } | { ok: false; message: string }> {
  // Spike 626: never open the Albedo popup once retired — surface migration copy.
  if (isAlbedoRetired()) {
    return { ok: false, message: albedoRetiredSignMessage() }
  }
  try {
    const albedo = await getAlbedoIntent()
    const res = await albedo.implicitFlow({
      // `tx`: Soroban y envelopes firmados; `trust`: intent dedicado de Albedo (changeTrust vía UI).
      intents: ["tx", "trust"],
      network: ALBEDO_NETWORK_TESTNET,
    })
    if (res.granted) return { ok: true }
    return { ok: false, message: "Permiso de firma no concedido en Albedo." }
  } catch (e: unknown) {
    const msg =
      e && typeof e === "object" && "message" in e && typeof (e as { message: string }).message === "string"
        ? (e as { message: string }).message
        : String(e)
    return { ok: false, message: msg || "Albedo implicit flow failed" }
  }
}
