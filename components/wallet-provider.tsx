"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import {
  albedoImplicitTxAllowed,
  isAlbedoSelectedInKit,
  requestAlbedoImplicitTxFlow,
} from "@/lib/albedo-intent-client"
import {
  initStellarWalletKit,
  isWalletConnectSelectedInKit,
  kit,
  KitEventType,
  parseError,
} from "@/lib/stellar-wallet-kit"
import { isWcResilienceEnabled, restoreWcSession } from "@/lib/walletconnect-resilience"
import { isAlbedoRetired, isAlbedoSunset221Enabled } from "@/lib/albedo-sunset"
import { AlbedoSunsetBanner } from "@/components/albedo-sunset-banner"
import { WalletConnectBanner } from "@/components/walletconnect-banner"
import { cn } from "@/lib/utils"

type WalletContextValue = {
  address: string | null
  connecting: boolean
  /** phase-167: true when the active kit module is WalletConnect. */
  isWalletConnect: boolean
  hint: string | null
  artistAlias: string | null
  aliasLoading: boolean
  connect: () => Promise<void>
  disconnect: () => void
  /** Re-sync con la wallet vía kit; devuelve la dirección activa o null. */
  refresh: () => Promise<string | null>
  /**
   * Abre el modal de @creit.tech/stellar-wallets-kit para elegir o cambiar wallet (misma sesión que `connect`).
   * Útil antes de firmar un settle: el usuario confirma qué G… firma y recibe el NFT. `null` si cierra el modal.
   */
  openWalletPicker: () => Promise<string | null>
  refreshArtistAlias: () => Promise<string | null>
  saveArtistAlias: (alias: string) => Promise<{ ok: true } | { ok: false; error: string }>
}

const WalletContext = createContext<WalletContextValue | null>(null)

/**
 * React 18 Strict Mode (dev) monta/desmonta dos veces: sin esto, el auto-claim del faucet
 * dispara POST duplicados (409 already claimed / 412 trustline) y ensucia la consola de red.
 */
/** Solo amortigua el doble `useEffect` de Strict Mode (~ms); no sustituye al ref por wallet. */
const FAUCET_AUTO_CLAIM_DEDUPE_MS = 4000
const lastFaucetAutoClaimAt = new Map<string, number>()

export function WalletProvider({ children }: { children: ReactNode }) {
  if (typeof window !== "undefined") {
    initStellarWalletKit()
  }

  const [address, setAddress] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [isWalletConnect, setIsWalletConnect] = useState(false)
  const [hint, setHint] = useState<string | null>(null)
  const [artistAlias, setArtistAlias] = useState<string | null>(null)
  const [aliasLoading, setAliasLoading] = useState(false)

  /**
   * Tras conectar, el kit mantiene la dirección en memoria; al desconectar en la app
   * no queremos que un `refresh()` vuelva a rellenarla hasta un nuevo `connect`.
   */
  const userDisconnectedRef = useRef(false)
  const autoFundedWalletsRef = useRef<Set<string>>(new Set())

  /** Albedo: sin `implicit_flow` para `tx`, el popup de firma se bloquea tras awaits largos (Soroban). */
  const [albedoTxPrep, setAlbedoTxPrep] = useState<"hidden" | "needed" | "checking">("hidden")
  const [albedoPrepBusy, setAlbedoPrepBusy] = useState(false)
  const [albedoPrepError, setAlbedoPrepError] = useState<string | null>(null)

  const syncAlbedoTxPrep = useCallback(async (addr: string | null) => {
    // phase-221: the legacy prep banner is replaced by the sunset banner.
    if (isAlbedoRetired()) {
      setAlbedoTxPrep("hidden")
      return
    }
    if (!addr || typeof window === "undefined") {
      setAlbedoTxPrep("hidden")
      return
    }
    if (!isAlbedoSelectedInKit()) {
      setAlbedoTxPrep("hidden")
      return
    }
    setAlbedoTxPrep("checking")
    try {
      const ok = await albedoImplicitTxAllowed(addr)
      setAlbedoTxPrep(ok ? "hidden" : "needed")
    } catch {
      setAlbedoTxPrep("needed")
    }
  }, [])

  const refresh = useCallback((): Promise<string | null> => {
    const run = async (): Promise<string | null> => {
      try {
        if (userDisconnectedRef.current) {
          setAddress(null)
          return null
        }
        initStellarWalletKit()
        const { address: addr } = await kit.getAddress()
        if (addr) {
          setAddress(addr)
          return addr
        }
        setAddress(null)
        return null
      } catch (e) {
        const pe = parseError(e)
        if (pe.code === -1 && pe.message === "No wallet has been connected.") {
          setAddress(null)
          return null
        }
        const msg = pe.message || "Wallet unavailable"
        setHint(msg)
        setAddress(null)
        return null
      }
    }
    return run().catch(() => {
      setAddress(null)
      setHint("Wallet unavailable")
      return null
    })
  }, [])

  useEffect(() => {
    void refresh().catch(() => {})
  }, [refresh])

  /** phase-167: keep the mobile banner in sync with the kit's selected module. */
  useEffect(() => {
    setIsWalletConnect(isWalletConnectSelectedInKit())
    if (!address) return
    const id = window.setTimeout(() => setIsWalletConnect(isWalletConnectSelectedInKit()), 0)
    return () => window.clearTimeout(id)
  }, [address])

  /** Cross-session resume: validate the persisted WC session before trusting it. */
  useEffect(() => {
    if (!isWcResilienceEnabled()) return
    const restored = restoreWcSession({ expectedNetwork: "testnet" })
    if (!restored.restored) return
    void fetch("/api/wallet/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "connect" }),
      cache: "no-store",
    }).catch(() => {})
  }, [])

  useEffect(() => {
    const onFocus = () => void refresh().catch(() => {})
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [refresh])

  useEffect(() => {
    initStellarWalletKit()
    const stop = kit.on(KitEventType.STATE_UPDATED, ({ payload }) => {
      try {
        if (userDisconnectedRef.current) return
        setAddress(payload.address ?? null)
      } catch {
        setAddress(null)
      }
    })
    return stop
  }, [])

  useEffect(() => {
    if (!address || userDisconnectedRef.current) return
    if (autoFundedWalletsRef.current.has(address)) return
    const now = Date.now()
    const prev = lastFaucetAutoClaimAt.get(address) ?? 0
    if (now - prev < FAUCET_AUTO_CLAIM_DEDUPE_MS) return
    lastFaucetAutoClaimAt.set(address, now)
    autoFundedWalletsRef.current.add(address)

    const autoClaimGenesis = async () => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
      const postReward = async (reward: string) => {
        const res = await fetch("/api/faucet", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ walletAddress: address, reward }),
        })
        const data = (await res.json().catch(() => ({}))) as { ok?: boolean; pending?: boolean; code?: string }
        return { res, data }
      }
      const settleReward = async (reward: string) => {
        for (let i = 0; i < 8; i++) {
          const { res, data } = await postReward(reward)
          if (res.status === 503 || res.status === 412) return
          if (res.status === 202 || data.pending === true) {
            await sleep(2200)
            continue
          }
          if (res.status === 200 && data.ok === true) return
          if (res.status === 409 && data.code === "FAUCET_MINT_IN_PROGRESS") {
            await sleep(2000)
            continue
          }
          return
        }
      }
      try {
        await settleReward("genesis")
        await settleReward("quest_connect_wallet")
      } catch {
        // Silent: faucet may be disabled or already claimed.
      }
    }

    void autoClaimGenesis().catch(() => {})
  }, [address])

  const refreshArtistAlias = useCallback(async (): Promise<string | null> => {
    if (!address) {
      setArtistAlias(null)
      return null
    }
    setAliasLoading(true)
    try {
      const res = await fetch(`/api/artist-profile?walletAddress=${encodeURIComponent(address)}`, {
        cache: "no-store",
      })
      const data = (await res.json().catch(() => ({}))) as { alias?: string | null }
      if (!res.ok) {
        setArtistAlias(null)
        return null
      }
      const alias = typeof data.alias === "string" && data.alias.trim().length > 0 ? data.alias.trim() : null
      setArtistAlias(alias)
      return alias
    } catch {
      setArtistAlias(null)
      return null
    } finally {
      setAliasLoading(false)
    }
  }, [address])

  const saveArtistAlias = useCallback(
    async (alias: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      if (!address) return { ok: false, error: "Wallet not connected." }
      setAliasLoading(true)
      try {
        const res = await fetch("/api/artist-profile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ walletAddress: address, alias }),
        })
        const data = (await res.json().catch(() => ({}))) as { error?: string; alias?: string }
        if (!res.ok) {
          return { ok: false, error: data.error || `HTTP ${res.status}` }
        }
        const nextAlias = typeof data.alias === "string" ? data.alias : alias
        setArtistAlias(nextAlias)
        return { ok: true }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      } finally {
        setAliasLoading(false)
      }
    },
    [address],
  )

  useEffect(() => {
    if (!address) {
      setArtistAlias(null)
      return
    }
    void refreshArtistAlias().catch(() => {})
  }, [address, refreshArtistAlias])

  useEffect(() => {
    void syncAlbedoTxPrep(address)
  }, [address, syncAlbedoTxPrep])

  const connect = useCallback((): Promise<void> => {
    const run = async (): Promise<void> => {
      userDisconnectedRef.current = false
      setConnecting(true)
      setHint(null)
      initStellarWalletKit()
      try {
        const { address: next } = await kit.authModal()
        if (!userDisconnectedRef.current) {
          setAddress(next)
          // Defer: el kit persiste `selectedModuleId` en localStorage en un effect de Preact.
          queueMicrotask(() => void syncAlbedoTxPrep(next))
        }
        setHint(null)
      } catch (e) {
        const pe = parseError(e)
        setAddress(null)
        if (pe.code !== -1) {
          setHint(pe.message || "Wallet connection failed")
        }
      } finally {
        setConnecting(false)
      }
    }
    return run().catch(() => {
      setConnecting(false)
      setAddress(null)
      setHint("Wallet unavailable")
    })
  }, [syncAlbedoTxPrep])

  const openWalletPicker = useCallback((): Promise<string | null> => {
    userDisconnectedRef.current = false
    initStellarWalletKit()
    return kit
      .authModal()
      .then(({ address: next }) => {
        const g = typeof next === "string" ? next.trim() : ""
        if (!g) {
          setAddress(null)
          return null
        }
        setAddress(g)
        setHint(null)
        queueMicrotask(() => void syncAlbedoTxPrep(g))
        return g
      })
      .catch((e: unknown) => {
        const pe = parseError(e)
        if (pe.code !== -1) {
          setHint(pe.message || "Wallet unavailable")
        }
        return null
      })
  }, [syncAlbedoTxPrep])

  const disconnect = useCallback(() => {
    userDisconnectedRef.current = true
    void kit.disconnect().catch(() => {})
    setAddress(null)
    setArtistAlias(null)
    setHint(null)
    setAlbedoTxPrep("hidden")
    setAlbedoPrepError(null)
  }, [])

  const value = useMemo(
    () => ({
      address,
      connecting,
      isWalletConnect,
      hint,
      artistAlias,
      aliasLoading,
      connect,
      disconnect,
      refresh,
      openWalletPicker,
      refreshArtistAlias,
      saveArtistAlias,
    }),
    [
      address,
      connecting,
      isWalletConnect,
      hint,
      artistAlias,
      aliasLoading,
      connect,
      disconnect,
      refresh,
      openWalletPicker,
      refreshArtistAlias,
      saveArtistAlias,
    ],
  )

  return (
    <>
      <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
      {isWcResilienceEnabled() ? <WalletConnectBanner /> : null}
      {isAlbedoSunset221Enabled() ? <AlbedoSunsetBanner /> : null}
      {address && albedoTxPrep === "needed" && !isAlbedoRetired() && (
        <div
          role="status"
          className={cn(
            "fixed bottom-0 left-0 right-0 z-[300] border-t border-cyan-500/40 bg-background/95 px-4 py-3 text-sm shadow-lg backdrop-blur-sm",
          )}
        >
          <div className="mx-auto flex max-w-3xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-foreground">
              <strong>Albedo:</strong> concedé permiso de firma en esta pestaña (una vez). Sin esto, el navegador suele
              bloquear el diálogo tras cargar Horizon o armar Soroban (incl. trustline PHASELQ). /{" "}
              <span className="text-foreground/80">
                Grant signing once so wallet dialogs are not blocked after Horizon/Soroban (including PHASELQ trustline).
              </span>
            </p>
            <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center">
              {albedoPrepError ? (
                <span className="text-xs text-destructive sm:max-w-[200px]">{albedoPrepError}</span>
              ) : null}
              <button
                type="button"
                disabled={albedoPrepBusy}
                className="rounded-md border border-cyan-500/60 bg-cyan-500/10 px-3 py-1.5 font-mono text-xs font-semibold text-cyan-200 hover:bg-cyan-500/20 disabled:opacity-50"
                onClick={() => {
                  setAlbedoPrepBusy(true)
                  setAlbedoPrepError(null)
                  void requestAlbedoImplicitTxFlow()
                    .then((r) => {
                      if (r.ok) {
                        setAlbedoTxPrep("hidden")
                        return
                      }
                      setAlbedoPrepError(r.message)
                    })
                    .catch((e: unknown) => {
                      setAlbedoPrepError(e instanceof Error ? e.message : String(e))
                    })
                    .finally(() => setAlbedoPrepBusy(false))
                }}
              >
                {albedoPrepBusy ? "…" : "Permitir firma / Allow signing"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export function useWallet() {
  const ctx = useContext(WalletContext)
  if (!ctx) {
    throw new Error("useWallet must be used within WalletProvider")
  }
  return ctx
}
