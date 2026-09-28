"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  albedoImplicitTxAllowed,
  isAlbedoSelectedInKit,
  requestAlbedoImplicitTxFlow,
} from "@/lib/albedo-intent-client"
import { signTransaction } from "@/lib/stellar-wallet-kit"
import { useLang } from "@/components/lang-context"
import { TokenIcon } from "@/components/token-icon"
import {
  buildClassicTrustlineXdrFromSequence,
  classicLiqAssetConfigFromPublicEnv,
  fetchTestnetHorizonAccountJson,
  nativeXlmBalanceFromHorizonAccount,
  parseSignedTxXdr,
  readClassicWalletStatus,
} from "@/lib/classic-liq"
import { pickCopy } from "@/lib/phase-copy"
import { HORIZON_URL, NETWORK_PASSPHRASE } from "@/lib/phase-protocol"
import { playTacticalUiClick } from "@/lib/tactical-ui-click"
import { cn } from "@/lib/utils"

// phase-119 wiring preserved: trustline-button can optionally verify CID integrity
// when the flag is enabled. Dynamic import keeps flag-off path zero-cost.
// When flag off, verifyRePinned… is a no-op in lib/classic-liq.

type TrustlineUiState = "STANDBY" | "SIGNING" | "SYNCING" | "READY" | "GET_TESTNET_XLM"

type Props = {
  address: string | null | undefined
  onRequestConnect?: () => Promise<string | null> | string | null
  onReady?: () => void | Promise<void>
  className?: string
  /** Forja: bloque más visible y texto para principiantes. */
  hero?: boolean
}

type HorizonBalance = {
  asset_type?: string
  balance?: string
}

async function fetchNativeXlmBalance(address: string): Promise<number> {
  const res = await fetch(`${HORIZON_URL}/accounts/${encodeURIComponent(address)}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  })
  if (res.status === 404) return 0
  if (!res.ok) throw new Error(`Could not read testnet account (${res.status}).`)

  const data = (await res.json()) as { balances?: HorizonBalance[] }
  const native = (data.balances ?? []).find((b) => b.asset_type === "native")
  const parsed = Number.parseFloat(native?.balance ?? "0")
  return Number.isFinite(parsed) ? parsed : 0
}

export function TrustlineButton({ address, onRequestConnect, onReady, className, hero = false }: Props) {
  const { lang } = useLang()
  const ff = pickCopy(lang).forge
  const onReadyRef = useRef(onReady)
  const onRequestConnectRef = useRef(onRequestConnect)
  onReadyRef.current = onReady
  onRequestConnectRef.current = onRequestConnect
  const asset = useMemo(() => classicLiqAssetConfigFromPublicEnv(), [])
  const [walletAddress, setWalletAddress] = useState<string | null>(address ?? null)
  const [uiState, setUiState] = useState<TrustlineUiState>("STANDBY")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string>("")
  const [xlmBalance, setXlmBalance] = useState<number | null>(null)
  /** null = no aplica (no Albedo) o comprobando; false = hace falta permiso implícito */
  const [albedoImplicitOk, setAlbedoImplicitOk] = useState<boolean | null>(null)
  const [albedoPrepBusy, setAlbedoPrepBusy] = useState(false)

  useEffect(() => {
    setWalletAddress(address ?? null)
  }, [address])

  useEffect(() => {
    if (!walletAddress || !isAlbedoSelectedInKit()) {
      setAlbedoImplicitOk(null)
      return
    }
    let cancelled = false
    void albedoImplicitTxAllowed(walletAddress).then((ok) => {
      if (!cancelled) setAlbedoImplicitOk(ok)
    })
    return () => {
      cancelled = true
    }
  }, [walletAddress])

  const refreshTrustlineState = useCallback(
    async (addr: string) => {
      if (!asset) return
      const [status, xlm] = await Promise.all([readClassicWalletStatus(addr, asset), fetchNativeXlmBalance(addr)])
      setXlmBalance(xlm)
      if (status.hasTrustline) {
        setUiState("READY")
        setMessage(ff.trustline_msg_initialized)
        await onReadyRef.current?.()
      } else if (xlm < 2) {
        setUiState("GET_TESTNET_XLM")
        setMessage(ff.trustline_msg_empty_account)
      } else {
        setUiState("STANDBY")
        setMessage("")
      }
    },
    [asset, ff.trustline_msg_empty_account, ff.trustline_msg_initialized],
  )

  useEffect(() => {
    if (!walletAddress || !asset) return
    void refreshTrustlineState(walletAddress).catch(() => {})
  }, [asset, refreshTrustlineState, walletAddress])

  const buttonLabel =
    uiState === "SIGNING"
      ? ff.trustline_signing
      : uiState === "SYNCING"
        ? ff.trustline_syncing
        : uiState === "READY"
          ? ff.trustline_ready
          : uiState === "GET_TESTNET_XLM"
            ? ff.trustline_get_testnet_xlm
            : ff.trustline_standby

  const handleClick = useCallback(async () => {
    playTacticalUiClick()
    if (!asset) {
      setMessage(ff.trustline_msg_config_missing)
      return
    }

    let addr = walletAddress
    if (!addr && onRequestConnectRef.current) {
      const next = await onRequestConnectRef.current()
      addr = next ?? null
      setWalletAddress(addr)
    }
    if (!addr) {
      setMessage(ff.trustline_msg_connect_wallet)
      return
    }

    if (uiState === "GET_TESTNET_XLM") {
      if (typeof window !== "undefined") {
        window.open(`https://friendbot.stellar.org/?addr=${encodeURIComponent(addr)}`, "_blank", "noopener,noreferrer")
      }
      return
    }
    if (uiState === "READY" || busy) return

    setBusy(true)
    setMessage("")
    try {
      if (isAlbedoSelectedInKit()) {
        const allowed = await albedoImplicitTxAllowed(addr)
        setAlbedoImplicitOk(allowed)
        if (!allowed) {
          setMessage(
            lang === "es"
              ? "Con Albedo: primero tocá «Permitir firma con Albedo» abajo (o la barra inferior). Así el navegador no bloquea el diálogo tras cargar la cuenta."
              : "With Albedo: tap “Allow Albedo signing” below (or the bottom bar) first so the browser does not block the dialog after Horizon loads.",
          )
          return
        }
      }

      // Un solo GET Horizon: menos awaits antes de firmar (mejor para Albedo, xBull, etc.).
      let accountJson: Awaited<ReturnType<typeof fetchTestnetHorizonAccountJson>>
      try {
        accountJson = await fetchTestnetHorizonAccountJson(addr)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (msg.includes("not found") || msg.includes("Fund")) {
          setUiState("GET_TESTNET_XLM")
          setMessage(ff.trustline_msg_empty_account)
          setXlmBalance(0)
          return
        }
        throw e
      }

      const xlm = nativeXlmBalanceFromHorizonAccount(accountJson)
      setXlmBalance(xlm)
      if (xlm < 2) {
        setUiState("GET_TESTNET_XLM")
        setMessage(ff.trustline_msg_empty_account)
        return
      }

      const sequence = accountJson.sequence?.trim()
      if (!sequence) throw new Error("Missing account sequence.")

      setUiState("SIGNING")
      const txXdr = buildClassicTrustlineXdrFromSequence(addr, asset, sequence)
      const signed = await signTransaction(txXdr, {
        networkPassphrase: NETWORK_PASSPHRASE,
        address: addr,
      })
      if (signed.error) throw new Error(signed.error.message || "SIGN_REJECTED")
      const signedXdr = parseSignedTxXdr(signed)
      if (!signedXdr) throw new Error("Missing signed transaction.")

      setUiState("SYNCING")
      const submitRes = await fetch("/api/classic-liq/trustline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signedXdr }),
      })
      const payload = (await submitRes.json().catch(() => ({}))) as { error?: string; detail?: string; code?: string; deadLetterId?: string }
      if (!submitRes.ok) {
        // Mensajes de error más específicos basados en el código
        if (payload.code === "QUARANTINED") {
          // phase-144 (Module #44): malformed payload was filed in the review queue
          throw new Error(
            lang === "es"
              ? `Solicitud con formato inválido: se archivó en la cola de revisión${payload.deadLetterId ? ` (ref ${payload.deadLetterId.slice(0, 8)})` : ""}. Un operador la revisará.`
              : `Malformed request: filed in the review queue${payload.deadLetterId ? ` (ref ${payload.deadLetterId.slice(0, 8)})` : ""} for an operator to inspect.`,
          )
        }
        if (payload.code === "ACCOUNT_NOT_FOUND" || payload.error?.includes("not found")) {
          throw new Error(
            `Cuenta no encontrada\n\n` +
            `${payload.detail || ""}\n\n` +
            `Hint: Fondea tu cuenta con XLM primero usando Friendbot.`
          )
        }
        if (payload.code === "TRUSTLINE_EXISTS") {
          throw new Error("La trustline ya existe. Intenta sincronizar.")
        }
        throw new Error(payload.error || `Error del servidor: HTTP ${submitRes.status}`)
      }

      let ready = false
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 900))
        const status = await readClassicWalletStatus(addr, asset)
        if (status.hasTrustline) {
          ready = true
          break
        }
      }
      if (!ready) {
        setUiState("SYNCING")
        setMessage(ff.trustline_msg_waiting_confirmation)
        return
      }

      setUiState("READY")
      setMessage(ff.trustline_msg_protocol_ready)
      await onReadyRef.current?.()

      // Auto-claim quest_connect_wallet — fire-and-forget, silent on error or if already claimed
      void fetch("/api/faucet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: addr, reward: "quest_connect_wallet" }),
      }).catch(() => {})
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setUiState("STANDBY")
      setMessage(msg)
    } finally {
      setBusy(false)
    }
  }, [
    asset,
    busy,
    ff.trustline_msg_config_missing,
    ff.trustline_msg_connect_wallet,
    ff.trustline_msg_empty_account,
    ff.trustline_msg_protocol_ready,
    ff.trustline_msg_waiting_confirmation,
    lang,
    uiState,
    walletAddress,
  ])

  return (
    <section
      className={cn(
        "tactical-frame mt-2 shrink-0 border-cyan-400/35 bg-cyan-950/20 px-2.5 py-2 shadow-[0_0_16px_rgba(34,211,238,0.1)]",
        hero &&
          "mt-0 rounded-md border-2 border-amber-400/55 bg-gradient-to-b from-amber-950/40 via-cyan-950/20 to-cyan-950/30 px-3 py-3 shadow-[0_0_32px_rgba(251,191,36,0.18)]",
        className,
      )}
    >
      <p
        className={cn(
          "tactical-phosphor text-[9px] uppercase tracking-[0.2em] text-cyan-300/85",
          hero && "text-[11px] font-semibold tracking-[0.14em] text-amber-100/95",
        )}
      >
        {ff.trustline_section_title}
      </p>
      {hero ? (
        <p className="mt-2 text-[11px] leading-snug text-zinc-300">{ff.trustline_beginner_blurb}</p>
      ) : null}
      {walletAddress && albedoImplicitOk === false ? (
        <div className="mb-2 rounded border border-violet-500/45 bg-violet-950/30 p-2">
          <p className="text-[9px] font-semibold uppercase tracking-wide text-violet-200/95">
            {ff.trustline_albedo_prep_title}
          </p>
          <p className="mt-1 text-[8px] leading-relaxed text-violet-100/85">{ff.trustline_albedo_prep_body}</p>
          <button
            type="button"
            disabled={albedoPrepBusy}
            className="mt-2 w-full border border-violet-500/60 bg-violet-500/15 px-2 py-1.5 text-[9px] font-bold uppercase tracking-wider text-violet-100 hover:bg-violet-500/25 disabled:opacity-50"
            onClick={() => {
              playTacticalUiClick()
              setAlbedoPrepBusy(true)
              setMessage("")
              void requestAlbedoImplicitTxFlow()
                .then((r) => {
                  if (r.ok && walletAddress) {
                    void albedoImplicitTxAllowed(walletAddress).then(setAlbedoImplicitOk)
                    return
                  }
                  setMessage(r.ok ? "" : r.message)
                })
                .catch((e: unknown) => setMessage(e instanceof Error ? e.message : String(e)))
                .finally(() => setAlbedoPrepBusy(false))
            }}
          >
            {albedoPrepBusy ? ff.trustline_albedo_prep_working : ff.trustline_albedo_prep_button}
          </button>
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => void handleClick().catch(() => {})}
        disabled={
          busy ||
          (isAlbedoSelectedInKit() && albedoImplicitOk === false)
        }
        className={cn(
          "tactical-interactive-glitch mt-1.5 w-full border-2 px-2 py-2 text-[10px] font-bold uppercase tracking-[0.16em] transition-colors",
          hero && "mt-3 py-3.5 text-[13px] font-semibold normal-case tracking-normal shadow-[0_0_20px_rgba(34,211,238,0.2)]",
          uiState === "READY"
            ? "border-emerald-500/70 bg-emerald-950/25 text-emerald-200"
            : uiState === "GET_TESTNET_XLM"
              ? "border-violet-500/65 bg-violet-950/25 text-violet-200"
              : "border-cyan-500/60 bg-cyan-950/30 text-cyan-100 hover:border-cyan-300 hover:text-white",
          busy && "opacity-75",
        )}
      >
        <span className="inline-flex items-center justify-center gap-2">
          <TokenIcon className={cn("h-4 w-4", hero && "h-5 w-5", uiState === "READY" && "text-emerald-300")} />
          {buttonLabel}
        </span>
      </button>

      <div className="mt-1.5 flex items-center justify-between gap-2 text-[9px] text-cyan-300/75">
        <span>
          {ff.trustline_gas_label}: {xlmBalance == null ? "—" : xlmBalance.toFixed(2)}
        </span>
        {walletAddress ? (
          <a
            href={`https://friendbot.stellar.org/?addr=${encodeURIComponent(walletAddress)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-cyan-500/50 underline-offset-2 hover:text-cyan-100"
          >
            {ff.trustline_friendbot_link}
          </a>
        ) : null}
      </div>
      {message ? (
        <div className="mt-1.5 rounded border border-cyan-500/20 bg-cyan-950/40 p-1.5">
          <p className="whitespace-pre-line text-[9px] leading-relaxed text-cyan-100/90">{message}</p>
        </div>
      ) : null}
      {asset && uiState !== "READY" ? (
        <details className="mt-2 rounded border border-cyan-800/45 bg-black/35 px-2 py-1.5">
          <summary className="cursor-pointer select-none text-[10px] font-medium text-cyan-300/90 hover:text-cyan-100">
            {ff.trustline_technical_details_label}
          </summary>
          <p className="mt-1.5 break-all font-mono text-[9px] leading-snug text-cyan-400/75">
            {asset.code}:{asset.issuer}
          </p>
          <p className="mt-1 text-[9px] leading-relaxed text-cyan-500/70">{ff.trustline_asset_hint}</p>
        </details>
      ) : null}
    </section>
  )
}
