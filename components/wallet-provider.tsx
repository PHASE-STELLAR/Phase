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
  isHardwareWalletSelected,
  isWalletConnectSelected,
  kit,
  KitEventType,
  parseError,
  TESTNET_PASSPHRASE,
} from "@/lib/stellar-wallet-kit"
import { cn } from "@/lib/utils"

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type WalletContextValue = {
  address: string | null
  connecting: boolean
  hint: string | null
  artistAlias: string | null
  aliasLoading: boolean
  /** Whether the active module is a hardware wallet (Ledger). */
  isHardwareWallet: boolean
  /** Whether the active module is WalletConnect. */
  isWalletConnect: boolean
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

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const WalletContext = createContext<WalletContextValue | null>(null)

/**
 * React 18 Strict Mode (dev) monta/desmonta dos veces: sin esto, el auto-claim del faucet
 * dispara POST duplicados (409 already claimed / 412 trustline) y ensucia la consola de red.
 */
const FAUCET_AUTO_CLAIM_DEDUPE_MS = 4000
const lastFaucetAutoClaimAt = new Map<string, number>()

/**
 * How often the heartbeat checks that the connected wallet is still reachable.
 * For hardware wallets (Ledger) this is shorter because USB HID connections can
 * drop silently; for extension wallets we rely on kit state events instead.
 */
const HEARTBEAT_INTERVAL_HW_MS = 8_000
const HEARTBEAT_INTERVAL_SW_MS = 30_000

// ─────────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────────

export function WalletProvider({ children }: { children: ReactNode }) {
  if (typeof window !== "undefined") {
    initStellarWalletKit()
  }

  const [address, setAddress] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [hint, setHint] = useState<string | null>(null)
  const [artistAlias, setArtistAlias] = useState<string | null>(null)
  const [aliasLoading, setAliasLoading] = useState(false)
  const [isHardwareWallet, setIsHardwareWallet] = useState(false)
  const [isWalletConnect, setIsWalletConnect] = useState(false)

  /** True when user deliberately disconnected — blocks session restoration. */
  const userDisconnectedRef = useRef(false)
  const autoFundedWalletsRef = useRef<Set<string>>(new Set())
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  /** Albedo: sin `implicit_flow` para `tx`, el popup de firma se bloquea tras awaits largos (Soroban). */
  const [albedoTxPrep, setAlbedoTxPrep] = useState<"hidden" | "needed" | "checking">("hidden")
  const [albedoPrepBusy, setAlbedoPrepBusy] = useState(false)
  const [albedoPrepError, setAlbedoPrepError] = useState<string | null>(null)

  // Network passphrase mismatch alert — shown when Ledger is connected but the
  // kit's active network doesn't match TESTNET_PASSPHRASE.
  const [networkMismatch, setNetworkMismatch] = useState<string | null>(null)

  // ── helpers ──────────────────────────────────────────────────────────────

  /** Sync module-type flags from localStorage (mirrors kit persisted selection). */
  const syncModuleFlags = useCallback(() => {
    setIsHardwareWallet(isHardwareWalletSelected())
    setIsWalletConnect(isWalletConnectSelected())
  }, [])

  const syncAlbedoTxPrep = useCallback(async (addr: string | null) => {
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

  /**
   * Validate that a hardware-wallet connection is using the expected network
   * passphrase.  Ledger's Stellar app is mode-specific; signing testnet XDRs
   * with a mainnet app returns a wrong signature silently.
   */
  const validateHardwareNetwork = useCallback(async () => {
    if (typeof window === "undefined") return
    if (!isHardwareWalletSelected()) {
      setNetworkMismatch(null)
      return
    }
    try {
      const { networkPassphrase } = await kit.getNetwork()
      if (networkPassphrase && networkPassphrase !== TESTNET_PASSPHRASE) {
        setNetworkMismatch(
          `Ledger está conectado a "${networkPassphrase.slice(0, 48)}…" pero la app espera la testnet. Abrí la app Stellar en tu Ledger y seleccioná la red correcta (Test SDF Network). / Ledger is on the wrong network. Open the Stellar app on your Ledger and switch to the correct network.`,
        )
      } else {
        setNetworkMismatch(null)
      }
    } catch {
      // Not critical — leave any previous mismatch shown.
    }
  }, [])

  // ── session refresh ────────────────────────────────────────────────────────

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
        if (pe.code === "-1" && pe.message === "No wallet has been connected.") {
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

  // ── heartbeat ─────────────────────────────────────────────────────────────

  /**
   * Start a recurring heartbeat that re-verifies the active wallet is still
   * reachable. For hardware wallets this detects silent USB HID disconnects.
   * For WalletConnect it keeps the session alive and detects remote disconnects.
   */
  const startHeartbeat = useCallback(
    (addr: string) => {
      if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current)
      const interval = isHardwareWalletSelected() ? HEARTBEAT_INTERVAL_HW_MS : HEARTBEAT_INTERVAL_SW_MS

      heartbeatTimerRef.current = setInterval(async () => {
        if (userDisconnectedRef.current) {
          clearInterval(heartbeatTimerRef.current!)
          heartbeatTimerRef.current = null
          return
        }
        try {
          const { address: current } = await kit.getAddress()
          if (!current || current !== addr) {
            // Session expired or wallet changed — surface a hint.
            setHint(
              "Wallet sesión expirada. Reconectá tu wallet. / Wallet session expired. Please reconnect.",
            )
            setAddress(null)
            clearInterval(heartbeatTimerRef.current!)
            heartbeatTimerRef.current = null
          }
        } catch {
          // Hardware wallet USB disconnect: clear address and notify.
          if (isHardwareWalletSelected()) {
            setAddress(null)
            setHint(
              "Ledger desconectado. Volvé a enchufar el dispositivo y reconectá. / Ledger disconnected. Re-plug the device and reconnect.",
            )
          }
          clearInterval(heartbeatTimerRef.current!)
          heartbeatTimerRef.current = null
        }
      }, interval)
    },
    [],
  )

  const stopHeartbeat = useCallback(() => {
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current)
      heartbeatTimerRef.current = null
    }
  }, [])

  // ── effects ───────────────────────────────────────────────────────────────

  /** Initial session restoration on mount. */
  useEffect(() => {
    syncModuleFlags()
    void refresh().then((addr) => {
      if (addr) startHeartbeat(addr)
    }).catch(() => {})
  }, [refresh, startHeartbeat, syncModuleFlags])

  /** Re-check session when the tab regains focus (catches page navigations). */
  useEffect(() => {
    const onFocus = () => {
      void refresh().then((addr) => {
        if (addr && !heartbeatTimerRef.current) startHeartbeat(addr)
      }).catch(() => {})
    }
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [refresh, startHeartbeat])

  /** Stop polling when the provider unmounts. */
  useEffect(() => stopHeartbeat, [stopHeartbeat])

  /** Subscribe to kit state events (extension wallets dispatch these). */
  useEffect(() => {
    initStellarWalletKit()
    const stop = kit.on(KitEventType.STATE_UPDATED, ({ payload }: { payload: any }) => {
      try {
        if (userDisconnectedRef.current) return
        const addr = payload.address ?? null
        setAddress(addr)
        if (addr) startHeartbeat(addr)
        else stopHeartbeat()
      } catch {
        setAddress(null)
        stopHeartbeat()
      }
    })
    return stop
  }, [startHeartbeat, stopHeartbeat])

  /**
   * HID device disconnect events — WebUSB fires `connect`/`disconnect` events
   * on `navigator.usb`.  When the Ledger is physically unplugged the heartbeat
   * will catch it, but we also listen here for an immediate UX response.
   */
  useEffect(() => {
    if (typeof navigator === "undefined" || !("usb" in navigator)) return

    const usb = (navigator as Navigator & { usb?: USBManager }).usb
    if (!usb) return

    const onDisconnect = () => {
      if (!isHardwareWalletSelected()) return
      if (userDisconnectedRef.current) return
      stopHeartbeat()
      setAddress(null)
      setHint(
        "Ledger desconectado (USB). Volvé a enchufar y reconectá. / Ledger disconnected (USB). Re-plug and reconnect.",
      )
    }

    const onConnect = () => {
      if (!isHardwareWalletSelected()) return
      // Clear the stale disconnect hint and attempt to restore the session.
      setHint(null)
      void refresh().then((addr) => {
        if (addr) startHeartbeat(addr)
      }).catch(() => {})
    }

    usb.addEventListener("disconnect", onDisconnect)
    usb.addEventListener("connect", onConnect)
    return () => {
      usb.removeEventListener("disconnect", onDisconnect)
      usb.removeEventListener("connect", onConnect)
    }
  }, [refresh, startHeartbeat, stopHeartbeat])

  /** Validate hardware wallet network passphrase whenever address or module changes. */
  useEffect(() => {
    if (isHardwareWallet && address) {
      void validateHardwareNetwork().catch(() => {})
    } else {
      setNetworkMismatch(null)
    }
  }, [address, isHardwareWallet, validateHardwareNetwork])

  /** Faucet auto-claim (unchanged from original). */
  useEffect(() => {
    if (!address || userDisconnectedRef.current) return
    if (autoFundedWalletsRef.current.has(address)) return
    const now = Date.now()
    const prev = lastFaucetAutoClaimAt.get(address) ?? 0
    if (now - prev < FAUCET_AUTO_CLAIM_DEDUPE_MS) return
    lastFaucetAutoClaimAt.set(address, now)
    autoFundedWalletsRef.current.add(address)
    const controller = new AbortController()

    const autoClaimGenesis = async () => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
      const postReward = async (reward: string) => {
        const res = await fetch("/api/faucet", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ walletAddress: address, reward }),
          signal: controller.signal,
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
    return () => controller.abort()
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

  // ── actions ───────────────────────────────────────────────────────────────

  const connect = useCallback((): Promise<void> => {
    const run = async (): Promise<void> => {
      userDisconnectedRef.current = false
      setConnecting(true)
      setHint(null)
      initStellarWalletKit()
      try {
        if (!kit.authModal) {
          throw new Error("authModal not available")
        }
        const { address: next } = await kit.authModal()
        syncModuleFlags()
        if (!userDisconnectedRef.current) {
          setAddress(next)
          startHeartbeat(next)
          queueMicrotask(() => void syncAlbedoTxPrep(next))
          queueMicrotask(() => void validateHardwareNetwork())
        }
        setHint(null)
      } catch (e) {
        const pe = parseError(e)
        setAddress(null)
        stopHeartbeat()
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
      stopHeartbeat()
      setHint("Wallet unavailable")
    })
  }, [syncAlbedoTxPrep, syncModuleFlags, startHeartbeat, stopHeartbeat, validateHardwareNetwork])

  const openWalletPicker = useCallback((): Promise<string | null> => {
    userDisconnectedRef.current = false
    initStellarWalletKit()
    if (!kit.authModal) {
      return Promise.reject(new Error("authModal not available"))
    }
    return kit
      .authModal()
      .then(({ address: next }: { address: any }) => {
        const g = typeof next === "string" ? next.trim() : ""
        syncModuleFlags()
        if (!g) {
          setAddress(null)
          stopHeartbeat()
          return null
        }
        setAddress(g)
        setHint(null)
        startHeartbeat(g)
        queueMicrotask(() => void syncAlbedoTxPrep(g))
        queueMicrotask(() => void validateHardwareNetwork())
        return g
      })
      .catch((e: unknown) => {
        const pe = parseError(e)
        if (pe.code !== "-1") {
          setHint(pe.message || "Wallet unavailable")
        }
        return null
      })
  }, [syncAlbedoTxPrep, syncModuleFlags, startHeartbeat, stopHeartbeat, validateHardwareNetwork])

  const disconnect = useCallback(() => {
    userDisconnectedRef.current = true
    stopHeartbeat()
    void kit.disconnect().catch(() => {})
    setAddress(null)
    setArtistAlias(null)
    setHint(null)
    setAlbedoTxPrep("hidden")
    setAlbedoPrepError(null)
    setNetworkMismatch(null)
    setIsHardwareWallet(false)
    setIsWalletConnect(false)
  }, [stopHeartbeat])

  // ── context value ─────────────────────────────────────────────────────────

  const value = useMemo(
    () => ({
      address,
      connecting,
      hint,
      artistAlias,
      aliasLoading,
      isHardwareWallet,
      isWalletConnect,
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
      hint,
      artistAlias,
      aliasLoading,
      isHardwareWallet,
      isWalletConnect,
      connect,
      disconnect,
      refresh,
      openWalletPicker,
      refreshArtistAlias,
      saveArtistAlias,
    ],
  )

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <>
      <WalletContext.Provider value={value}>{children}</WalletContext.Provider>

      {/* ── Network passphrase mismatch alert (Ledger on wrong network) ──── */}
      {networkMismatch && address && isHardwareWallet && (
        <div
          role="alert"
          aria-live="assertive"
          className={cn(
            "fixed bottom-0 left-0 right-0 z-[400] border-t border-red-500/50 bg-background/95 px-4 py-3 text-sm shadow-lg backdrop-blur-sm",
          )}
        >
          <div className="mx-auto flex max-w-3xl flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start gap-2">
              {/* Ledger icon indicator */}
              <span className="mt-0.5 shrink-0 text-red-400" aria-hidden>
                ⬡
              </span>
              <p className="text-foreground leading-snug">
                <strong className="text-red-400">Ledger — red incorrecta.</strong>{" "}
                {networkMismatch}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void validateHardwareNetwork().catch(() => {})}
              className="shrink-0 rounded-md border border-red-500/50 bg-red-500/10 px-3 py-1.5 font-mono text-xs font-semibold text-red-300 hover:bg-red-500/20"
            >
              Reintentar / Retry
            </button>
          </div>
        </div>
      )}

      {/* ── Albedo implicit-tx permission banner ─────────────────────────── */}
      {address && albedoTxPrep === "needed" && !networkMismatch && (
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

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────

export function useWallet() {
  const ctx = useContext(WalletContext)
  if (!ctx) {
    throw new Error("useWallet must be used within WalletProvider")
  }
  return ctx
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal types
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal shape of the WebUSB manager (navigator.usb). */
interface USBManager extends EventTarget {
  addEventListener(type: "connect" | "disconnect", listener: EventListenerOrEventListenerObject): void
  removeEventListener(type: "connect" | "disconnect", listener: EventListenerOrEventListenerObject): void
}
