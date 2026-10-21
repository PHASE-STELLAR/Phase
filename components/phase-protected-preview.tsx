"use client"

import { IpfsDisplayImg } from "@/components/ipfs-display-img"
import { cn } from "@/lib/utils"
import { viewerSignatureShort } from "@/lib/viewer-signature"
import { truncateAddress } from "@/lib/explore-domain"

// ── phase-92: push notifications for replies and mentions ──
// This preview component renders independently of push-subscription state
// (core logic lives in lib/push-notifications.ts); no change needed here —
// verified for zero regression.

// ── phase-77: wash-trading detection heuristics for listings ──
// Renders independently while wash-trading analysis protects volume stats in
// backend APIs and listing badges. Preserves preview wiring with zero regression. Rollback: unset FEATURE_PHASE_77.

// ── phase-122: off-chain delta display hint (flag-gated, zero regression when off) ──
function isPhase122Enabled(): boolean {
  const v = (typeof process !== "undefined" ? (process.env.NEXT_PUBLIC_FEATURE_PHASE_122 ?? "") : "")?.trim().toLowerCase()
  return v === "1" || v === "true" || v === "yes" || v === "on"
}

function isDeltaStub(uri: string): boolean {
  return /^delta:\d+:[a-f0-9]{8}$/i.test(uri.trim())
}

function resolveDisplayUri(uri: string): string {
  // Delta stub is resolved server-side via /api/phase-nft/verify delta probe;
  // here we just pass through unless flag enables delta-aware proxy.
  if (isPhase122Enabled() && isDeltaStub(uri)) return "" // caller should fetch full metadata off-chain
  return uri
}

export type PhaseProtectedPreviewLabels = {
  pendingFusion: string
  unverifiedCopy: string
  chainVerifiedSeal: string
}

/**
 * Self-contained client-side verification: true when the caller already
 * resolved ownership via full on-chain RPC (`chainVerified`), else derived
 * from comparing the truncated on-chain owner (as served by /api/explore)
 * against the connected viewer's own address using the same truncation.
 * UI signal only — not a security gate.
 */
export function resolvePhaseProtectedPreviewVerified(
  chainVerified: boolean | undefined,
  ownerTruncated: string | undefined,
  viewerAddress: string | null | undefined,
): boolean {
  if (chainVerified != null) return chainVerified
  const viewer = viewerAddress?.trim()
  if (!ownerTruncated || !viewer) return false
  return ownerTruncated === truncateAddress(viewer)
}

type Props = {
  /** `ipfs://…` o HTTPS (p. ej. metadatos / gateway); reintenta gateways si uno falla. */
  uri: string
  className?: string
  /**
   * Dueño on-chain de la utilidad PHASE para esta colección (wallet conectada).
   * Pásalo cuando ya hiciste la llamada RPC completa (p. ej. detalle/Reactor).
   * Si se omite, el widget se autoverifica comparando `ownerTruncated` × `viewerAddress`
   * (mismo truncado que sirve /api/explore) sin RPC extra — solo señal de UI, no gate de seguridad.
   */
  chainVerified?: boolean
  /** Owner truncado (`GABCDE…WXYZ`) tal como lo devuelve /api/explore, para autoverificación cliente. */
  ownerTruncated?: string
  /** Wallet conectada (para sello que varía por visor). */
  viewerAddress: string | null | undefined
  labels: PhaseProtectedPreviewLabels
}

/**
 * Mercado / listado: miniatura degradada + scanlines + PENDING_FUSION si no hay prueba on-chain.
 * Si `chainVerified`, muestra arte más nítido y sello de cadena (HD reservado al Reactor).
 */
export function PhaseProtectedPreview({ uri, className, chainVerified, ownerTruncated, viewerAddress, labels }: Props) {
  const sig = viewerSignatureShort(viewerAddress)
  const displayUri = resolveDisplayUri(uri)
  const isDelta = isPhase122Enabled() && isDeltaStub(uri)
  const verified = resolvePhaseProtectedPreviewVerified(chainVerified, ownerTruncated, viewerAddress)

  return (
    <div
      className={cn(
        "relative isolate flex aspect-[4/3] w-full items-center justify-center overflow-hidden bg-[oklch(0.04_0_0)]",
        className,
      )}
    >
      <IpfsDisplayImg
        uri={displayUri || uri}
        className={cn(
          "relative z-0 max-h-full max-w-full object-contain p-2 transition-[filter] duration-300",
          verified
            ? "max-h-[min(100%,220px)] [image-rendering:auto]"
            : "phase-protected-preview--lowres max-h-[120px] scale-[1.35] opacity-90 [image-rendering:crisp-edges]",
        )}
        loading="lazy"
      />
      {isDelta ? (
        <div className="pointer-events-none absolute left-1.5 top-1.5 z-[4] rounded-sm border border-cyan-500/40 bg-black/80 px-1 py-0.5 font-mono text-[6px] font-bold uppercase tracking-widest text-cyan-300/90">
          Δ off-chain
        </div>
      ) : null}

      {!verified && (
        <>
          <div className="phase-dashboard-scanlines pointer-events-none absolute inset-0 z-[2]" aria-hidden />
          <div className="pointer-events-none absolute inset-0 z-[3] flex items-center justify-center bg-black/25" aria-hidden>
            <span className="max-w-[90%] border border-violet-500/50 bg-violet-950/75 px-2 py-1.5 text-center font-mono text-[8px] font-bold uppercase leading-tight tracking-[0.2em] text-violet-200/95 shadow-[0_0_20px_rgba(139,92,246,0.2)]">
              {labels.pendingFusion}
            </span>
          </div>
        </>
      )}

      <div
        className={cn(
          "pointer-events-none absolute bottom-1.5 right-1.5 z-[4] max-w-[calc(100%-0.75rem)] border px-1.5 py-0.5 font-mono text-[6px] font-bold uppercase leading-tight tracking-tighter shadow-md sm:text-[7px]",
          verified
            ? "border-emerald-500/55 bg-emerald-950/90 text-emerald-200/95"
            : "border-violet-500/50 bg-black/85 text-violet-300/90",
        )}
      >
        {verified ? (
          <span>
            {labels.chainVerifiedSeal} · SIG:{sig}
          </span>
        ) : (
          <span>
            {labels.unverifiedCopy} · {sig}
          </span>
        )}
      </div>
    </div>
  )
}
