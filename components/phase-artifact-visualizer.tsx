"use client"

import type { ArtifactLabelsCopy } from "@/lib/phase-copy"
import { ipfsHttpsGatewayUrls } from "@/lib/phase-protocol"
import { viewerSignatureShort } from "@/lib/viewer-signature"
import { cn } from "@/lib/utils"
import { createPortal } from "react-dom"
import { useCallback, useEffect, useId, useMemo, useState } from "react"

export type ArtifactVerificationMode = "locked" | "verifying" | "verified"

const GLITCH_CHARS = "ABCDEFGHKMNPQRSTUVWXYZ023456789#%░▒"

function scramblePreservingShape(target: string): string {
  let out = ""
  for (let i = 0; i < target.length; i++) {
    const ch = target[i]!
    if (!/[A-Za-z0-9#%·/]/.test(ch)) {
      out += ch
      continue
    }
    out += GLITCH_CHARS[(Math.random() * GLITCH_CHARS.length) | 0]!
  }
  return out
}

function formatPowerBp(bp: number) {
  const c = Math.min(10000, Math.max(0, bp))
  return `${(c / 100).toFixed(0)}%`
}

async function bakeWatermarkIntoImageDataUrl(sourceUrl: string, watermarkText: string): Promise<string> {
  const response = await fetch(sourceUrl)
  if (!response.ok) {
    throw new Error(`watermark-fetch-failed:${response.status}`)
  }
  const imageBlob = await response.blob()
  const blobUrl = URL.createObjectURL(imageBlob)
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image()
      img.decoding = "async"
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error("watermark-image-load-failed"))
      img.src = blobUrl
    })

    const width = image.naturalWidth || image.width
    const height = image.naturalHeight || image.height
    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext("2d")
    if (!ctx) {
      throw new Error("watermark-canvas-context-failed")
    }

    ctx.drawImage(image, 0, 0, width, height)

    const minSide = Math.max(1, Math.min(width, height))
    const tile = Math.max(120, Math.floor(minSide * 0.22))
    const fontSize = Math.max(11, Math.floor(minSide * 0.038))
    ctx.save()
    ctx.translate(width / 2, height / 2)
    ctx.rotate((-32 * Math.PI) / 180)
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.font = `700 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace`
    ctx.fillStyle = "rgba(255,255,255,0.2)"
    ctx.strokeStyle = "rgba(0,0,0,0.35)"
    ctx.lineWidth = Math.max(1, Math.floor(fontSize * 0.08))

    for (let y = -height; y <= height; y += tile) {
      for (let x = -width; x <= width; x += tile) {
        ctx.strokeText(watermarkText, x, y)
        ctx.fillText(watermarkText, x, y)
      }
    }
    ctx.restore()

    return canvas.toDataURL("image/png")
  } finally {
    URL.revokeObjectURL(blobUrl)
  }
}

function GlitchDecryptField({
  finalText,
  active,
  durationMs = 1500,
  className,
}: {
  finalText: string
  active: boolean
  durationMs?: number
  className?: string
}) {
  const [text, setText] = useState(() => (active ? scramblePreservingShape(finalText) : finalText))

  useEffect(() => {
    if (!active) {
      setText(finalText)
      return
    }
    setText(scramblePreservingShape(finalText))
    const start = Date.now()
    const id = window.setInterval(() => {
      if (Date.now() - start >= durationMs) {
        setText(finalText)
        window.clearInterval(id)
        return
      }
      setText(scramblePreservingShape(finalText))
    }, 52)
    return () => window.clearInterval(id)
  }, [active, finalText, durationMs])

  return <span className={cn("min-w-0 text-right font-mono", className)}>{text}</span>
}

type Props = {
  mode: ArtifactVerificationMode
  ownerTruncated: string
  serial: number
  energyLevelBp: number
  collectionTitle?: string
  /** Nombre legible para fila pública COLLECTION_NAME. */
  collectionDisplayName?: string
  imageUrl?: string | null
  className?: string
  labels: ArtifactLabelsCopy
  contractId: string
  expertUrl?: string
  expertLabel?: string
  onDownloadCertificate?: () => void
  viewerAddress?: string | null
  isOwner?: boolean
  authenticityPending?: boolean
  onAccessPrivateMetadata?: () => void
  /** `get_total_minted` / cap — null si RPC falla o aún no hay dato. */
  supplyMinted?: number | null
  supplyCap?: number | null
  /** Variante compacta para layouts con poco alto visible (p. ej. Chamber). */
  compact?: boolean
  /** Mostrar panel público (collection/contract/supply) debajo del arte. */
  showPublicMetaPanel?: boolean
  /** Mostrar panel privado (private channel/secret/power/signature) debajo del arte. */
  showPrivateMetaPanel?: boolean
  /** Cámara: un solo panel limpio, sin ASCII ni banner ruidoso cuando el dueño está verificado. */
  chamberPresentation?: boolean
  /** Marco exterior lo aporta el padre (split preview cian); sin tarjeta esmeralda duplicada. */
  chamberFrameless?: boolean
  /** Cámara: preview clicable sin la fila «EXPAND» bajo la imagen. */
  suppressExpandLabel?: boolean
  /** Token ID exacto para copiar (p. ej. Freighter); por defecto entero derivado de `serial`. */
  dockCopyTokenId?: string
  /** NFT en custodia del emisor: mismo dock que owner pero con CTA collect. */
  chamberCollectMode?: boolean
  onCollectNft?: () => void | Promise<void>
  collectNftBusy?: boolean
  collectLabel?: string
  collectBusyLabel?: string
  /** Cámara: el padre muestra caption + copias; aquí solo el bloque de imagen (holo). */
  chamberMetaPanelExternal?: boolean
}

function truncateContractMid(id: string) {
  const t = id.trim()
  if (!t) return "—"
  if (t.length <= 12) return t
  return `${t.slice(0, 4)}…${t.slice(-4)}`
}

/**
 * Monitor de escasez y propiedad: panel público (gris), canal privado (cian) con descifrado animado.
 */
export function PhaseArtifactVisualizer({
  mode,
  ownerTruncated,
  serial,
  energyLevelBp,
  collectionTitle,
  collectionDisplayName,
  imageUrl,
  className,
  labels,
  contractId,
  expertUrl,
  expertLabel,
  onDownloadCertificate,
  viewerAddress = null,
  isOwner = false,
  authenticityPending = false,
  onAccessPrivateMetadata,
  supplyMinted = null,
  supplyCap = null,
  compact = false,
  showPublicMetaPanel = true,
  showPrivateMetaPanel = true,
  chamberPresentation = false,
  chamberFrameless = false,
  suppressExpandLabel = false,
  dockCopyTokenId,
  chamberCollectMode = false,
  onCollectNft,
  collectNftBusy = false,
  collectLabel,
  collectBusyLabel,
  chamberMetaPanelExternal = false,
}: Props) {
  void ownerTruncated

  const asciiInner = 38
  const line = (inner: string) => {
    const t = inner.length > asciiInner ? `${inner.slice(0, asciiInner - 1)}…` : inner
    return `║ ${t.padEnd(asciiInner, " ")} ║`
  }
  const isVerified = mode === "verified"
  const isVerifying = mode === "verifying"
  const isRestricted = mode === "locked" || mode === "verifying"

  const head =
    collectionTitle != null && collectionTitle.length > 0
      ? `  ${collectionTitle.slice(0, 36)}`
      : `  ${labels.registeredDefault} `

  const bannerText =
    mode === "verified"
      ? labels.systemActive
      : mode === "verifying"
        ? labels.verifying
        : labels.terminalRestricted

  const topBlock = ["╔════════════════════════════════════════╗", line(head), "╠════════════════════════════════════════╣"].join("\n")

  const powerStateLabel = isVerified ? labels.stateSolid : labels.stateLiquid
  const powerFinalPrivate = `${powerStateLabel} · ${formatPowerBp(energyLevelBp)}`
  const secretFinal = `#${Math.max(0, Math.floor(serial))}`
  const contractPublic = truncateContractMid(contractId)

  const publicCollectionLine =
    collectionDisplayName?.trim() ||
    (collectionTitle != null && collectionTitle.length > 0 ? collectionTitle.replace(/\s*\/\/.*$/, "").trim() : "") ||
    "—"

  const supplyLine =
    supplyMinted != null && supplyCap != null ? `[ ${supplyMinted} / ${supplyCap} ]` : `[ — / — ]`
  const supplyRemainingRatio =
    supplyCap != null && supplyCap > 0 && supplyMinted != null
      ? (supplyCap - supplyMinted) / supplyCap
      : 1
  const supplyAlert = supplyCap != null && supplyCap > 0 && supplyMinted != null && supplyRemainingRatio < 0.1

  const rawImgUri = imageUrl?.trim() ?? ""
  const imgCandidates = useMemo(() => ipfsHttpsGatewayUrls(rawImgUri), [rawImgUri])
  const [gwIdx, setGwIdx] = useState(0)
  const activeDisplaySrc = imgCandidates[gwIdx] ?? ""

  const protectArt = Boolean(rawImgUri) && (!isVerified || authenticityPending || !isOwner)
  const ownerUnlocked = isVerified && isOwner && !authenticityPending
  const chamberDockEligible =
    Boolean(chamberPresentation) && isVerified && !authenticityPending && (isOwner || Boolean(chamberCollectMode))
  const chamberMinimal = chamberDockEligible
  const chamberDockFrameless = Boolean(chamberFrameless) && chamberMinimal
  const stripBannerForChamber = chamberMinimal
  const showAsciiBlock = !chamberPresentation
  const eligibleForDecrypt = ownerUnlocked && Boolean(rawImgUri)

  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [decrypting, setDecrypting] = useState(false)
  const [copiedContract, setCopiedContract] = useState(false)
  const [copiedDock, setCopiedDock] = useState<null | "contract" | "token">(null)
  const [mainImgFailed, setMainImgFailed] = useState(false)
  const [watermarkedImgSrc, setWatermarkedImgSrc] = useState<string | null>(null)
  const [watermarkBusy, setWatermarkBusy] = useState(false)
  const lightboxTitleId = useId()

  useEffect(() => {
    setGwIdx(0)
    setMainImgFailed(false)
  }, [rawImgUri])

  const shouldUseBakedWatermark = Boolean(rawImgUri) && protectArt && !ownerUnlocked

  useEffect(() => {
    let cancelled = false
    if (!shouldUseBakedWatermark || !rawImgUri) {
      setWatermarkedImgSrc(null)
      setWatermarkBusy(false)
      return
    }
    setWatermarkBusy(true)
    setWatermarkedImgSrc(null)
    const watermarkText = authenticityPending ? "PHASE // OWNERSHIP_PENDING" : "PHASE // PREVIEW_ONLY"
    const cand = ipfsHttpsGatewayUrls(rawImgUri)
    void (async () => {
      try {
        for (const u of cand) {
          if (cancelled) return
          try {
            const res = await fetch(u)
            if (!res.ok) continue
            const blob = await res.blob()
            const objectUrl = URL.createObjectURL(blob)
            try {
              const dataUrl = await bakeWatermarkIntoImageDataUrl(objectUrl, watermarkText)
              if (!cancelled) setWatermarkedImgSrc(dataUrl)
              return
            } catch {
              /* try next gateway */
            } finally {
              URL.revokeObjectURL(objectUrl)
            }
          } catch {
            /* try next gateway */
          }
        }
        if (!cancelled) setWatermarkedImgSrc(cand[0] ?? rawImgUri)
      } finally {
        if (!cancelled) setWatermarkBusy(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [authenticityPending, shouldUseBakedWatermark, rawImgUri])

  useEffect(() => {
    if (!eligibleForDecrypt) {
      setDecrypting(false)
      return
    }
    setDecrypting(true)
    const t = window.setTimeout(() => setDecrypting(false), 1500)
    return () => window.clearTimeout(t)
  }, [eligibleForDecrypt, rawImgUri])

  useEffect(() => {
    setMounted(true)
  }, [])

  const closeLightbox = useCallback(() => setLightboxOpen(false), [])
  const copyContractId = useCallback(async () => {
    if (typeof navigator === "undefined" || !contractId) return
    try {
      await navigator.clipboard.writeText(contractId)
      setCopiedContract(true)
      window.setTimeout(() => setCopiedContract(false), 1000)
    } catch {
      setCopiedContract(false)
    }
  }, [contractId])

  const copyDockField = useCallback(async (kind: "contract" | "token", value: string) => {
    if (typeof navigator === "undefined" || !value.trim()) return
    try {
      await navigator.clipboard.writeText(value.trim())
      setCopiedDock(kind)
      window.setTimeout(() => {
        setCopiedDock((c) => (c === kind ? null : c))
      }, 1200)
    } catch {
      setCopiedDock(null)
    }
  }, [])

  useEffect(() => {
    if (!lightboxOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeLightbox()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [lightboxOpen, closeLightbox])

  const frameClass = isVerified
    ? ownerUnlocked
      ? "border-cyan-500/40 bg-gradient-to-b from-cyan-950/40 to-black/80 shadow-[0_0_32px_rgba(34,211,238,0.22)]"
      : "border-violet-600/30 bg-transparent shadow-[0_0_20px_rgba(139,92,246,0.08)]"
    : isVerifying
      ? "border-cyan-500/40 bg-gradient-to-b from-cyan-950/35 via-violet-950/15 to-black/90 shadow-[0_0_36px_rgba(34,211,238,0.16)]"
      : "border-violet-600/25 bg-transparent shadow-[0_0_20px_rgba(139,92,246,0.06)]"

  const preClass =
    "text-left text-[11px] sm:text-[12px] leading-snug tracking-tight select-all font-mono text-zinc-400/95"

  const bannerClass = isVerified
    ? ownerUnlocked
      ? "border-cyan-500/50 bg-cyan-950/55 text-cyan-200/95 tactical-phosphor shadow-[0_0_14px_rgba(34,211,238,0.15)]"
      : "border-violet-500/40 bg-violet-950/45 text-violet-200/90"
    : isVerifying
      ? "border-cyan-400/55 bg-gradient-to-r from-cyan-950/65 via-violet-950/40 to-cyan-950/65 text-cyan-100 tactical-phosphor shadow-[0_0_22px_rgba(34,211,238,0.22)]"
      : "border-violet-500/35 bg-violet-950/40 text-violet-200/90"

  const showArtFirst = isRestricted && Boolean(rawImgUri)
  const renderedImgSrc = shouldUseBakedWatermark ? watermarkedImgSrc : activeDisplaySrc

  const usePixelTreatment = Boolean(rawImgUri) && !isVerified
  const useBlurOnArt =
    Boolean(rawImgUri) && isVerified && (!isOwner || authenticityPending)

  const holoBlock = (
    <div
      className={cn(
        "relative z-[2] w-full",
        chamberDockFrameless && "flex min-h-0 flex-1 flex-col",
      )}
    >
      <div
        className={cn(
          "art-retro-monitor relative mx-auto flex w-full max-w-[min(100%,32rem)] items-center justify-center px-2 py-4 sm:px-4 sm:py-5",
          compact
            ? "max-w-[min(100%,28rem)] min-h-[190px] max-h-[300px] px-2 py-2 sm:min-h-[210px] sm:max-h-[320px] sm:px-3.5 sm:py-3"
            : "min-h-[min(48vw,260px)] max-h-[min(62svh,520px)] sm:min-h-[280px] sm:max-h-[min(58svh,540px)]",
          chamberDockFrameless &&
            "!mx-0 !flex !h-full !max-h-[min(58svh,440px)] !min-h-[min(28svh,220px)] !max-w-none !w-full !flex-1 !items-start !justify-center !rounded-lg !border-cyan-500/40 !bg-transparent !px-0.5 !py-0.5 shadow-[inset_0_0_48px_rgba(34,211,238,0.07),0_0_20px_rgba(34,211,238,0.08)] sm:!min-h-[min(34svh,260px)] sm:!max-h-[min(62svh,480px)] sm:!px-1 sm:!py-1",
          chamberMinimal &&
            !chamberDockFrameless &&
            "!max-h-[min(42svh,340px)] !min-h-[min(28svh,220px)] rounded-xl !border-zinc-600/40 !bg-transparent !py-4 shadow-[inset_0_0_0_1px_rgba(63,63,70,0.35)] sm:!min-h-[min(30svh,240px)]",
          !rawImgUri && !chamberMinimal && "min-h-[72px] max-h-[120px]",
          !rawImgUri && chamberMinimal && !chamberDockFrameless && "min-h-[min(24svh,200px)] max-h-[min(36svh,280px)]",
          (isRestricted || protectArt || (eligibleForDecrypt && decrypting)) &&
            (isVerifying ? "phase-artifact-monitor--verifying" : "phase-artifact-monitor--locked"),
          ownerUnlocked && !chamberMinimal && "border-cyan-500/45",
          ownerUnlocked && chamberMinimal && !chamberDockFrameless && "!border-emerald-500/30",
          protectArt && !ownerUnlocked && "border-violet-500/35",
        )}
      >
        {renderedImgSrc && !mainImgFailed ? (
          <button
            type="button"
            onClick={() => setLightboxOpen(true)}
            className={cn(
              "group relative z-[2] mx-auto flex max-h-full w-full cursor-zoom-in flex-col items-center gap-2 border-0 bg-transparent p-0 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-black",
              chamberDockFrameless && "min-h-0 max-h-full w-full !max-w-none flex-1 items-stretch gap-0 self-stretch",
              protectArt && !isVerifying
                ? "focus-visible:ring-violet-400/70"
                : "focus-visible:ring-cyan-400/70",
            )}
            aria-label={labels.expandPreview}
          >
            <div
              className={cn(
                "phase-artifact-preview-clean tactical-holo-wrap relative w-full max-w-full justify-center overflow-hidden rounded-sm",
                chamberDockFrameless &&
                  "aspect-square w-full max-w-full max-h-[min(72vw,28rem)] shrink-0 [&_img]:h-full [&_img]:min-h-0 [&_img]:!object-cover",
                protectArt && (isVerifying ? "phase-artifact-holo-verifying" : "phase-artifact-holo-locked"),
              )}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={renderedImgSrc}
                alt=""
                className={cn(
                  compact && chamberDockFrameless
                    ? "art-retro-monitor__img tactical-holo-img phase-artifact-img-lowres !mx-auto block h-full min-h-0 w-full max-w-full object-cover object-center transition-[filter] duration-500"
                    : compact
                      ? "art-retro-monitor__img tactical-holo-img phase-artifact-img-lowres h-[166px] w-[166px] object-contain transition-[filter] duration-500 sm:h-[184px] sm:w-[184px]"
                      : "art-retro-monitor__img tactical-holo-img max-h-[min(54svh,480px)] w-auto max-w-full object-contain transition-[filter] duration-500 sm:max-h-[min(52svh,500px)]",
                  usePixelTreatment && "phase-artifact-img-pixel",
                  useBlurOnArt && "blur-[6px] sm:blur-[5px]",
                  eligibleForDecrypt && !decrypting && "blur-0",
                  eligibleForDecrypt && decrypting && "blur-[3px] brightness-[0.92]",
                )}
                loading="lazy"
                referrerPolicy="no-referrer"
                onError={() => {
                  if (gwIdx + 1 < imgCandidates.length) setGwIdx((i) => i + 1)
                  else setMainImgFailed(true)
                }}
              />
              {eligibleForDecrypt && decrypting && (
                <div
                  className="phase-artifact-decrypt-overlay pointer-events-none absolute inset-0 z-[4] flex items-center justify-center bg-black/25"
                  aria-hidden
                >
                  <span className="max-w-[95%] text-center font-mono text-[clamp(0.6rem,3.2vw,0.95rem)] font-bold uppercase leading-tight tracking-[0.28em] text-cyan-300/95 tactical-phosphor sm:text-base sm:tracking-[0.32em]">
                    {labels.decryptingImage}
                  </span>
                </div>
              )}
              {!isOwner && protectArt && (
                <div
                  className="pointer-events-none absolute inset-0 z-[5] flex items-center justify-center overflow-hidden"
                  aria-hidden
                >
                  <span className="max-w-[min(100%,22rem)] px-2 text-center font-mono text-[clamp(0.45rem,2.2vw,0.7rem)] font-bold uppercase leading-tight tracking-[0.12em] text-white mix-blend-overlay opacity-95 [transform:rotate(45deg)] sm:text-[10px] sm:tracking-[0.18em]">
                    {authenticityPending ? labels.pendingOwnershipVerification : labels.previewOnly}
                  </span>
                </div>
              )}
            </div>
            {!suppressExpandLabel ? (
              <span
                className={cn(
                  "font-mono text-[8px] uppercase tracking-[0.35em] opacity-80 group-hover:opacity-100 sm:text-[9px]",
                  protectArt && !isVerifying
                    ? "text-violet-400/75 group-hover:text-violet-200"
                    : "text-cyan-400/85 group-hover:text-cyan-200",
                )}
              >
                {labels.expandPreview}
              </span>
            ) : null}
          </button>
        ) : watermarkBusy ? (
          <div className="relative z-[3] flex min-h-[160px] w-full max-w-md flex-col items-center justify-center gap-2 px-4 py-6 text-center">
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-cyan-300/90">
              {authenticityPending ? labels.pendingOwnershipVerification : labels.previewOnly}
            </p>
          </div>
        ) : renderedImgSrc && mainImgFailed ? (
          <div className="relative z-[3] flex min-h-[160px] w-full max-w-md flex-col items-center justify-center gap-2 px-4 py-6 text-center">
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-violet-300/90">{labels.noVisual}</p>
            <p className="max-w-[20rem] text-[9px] leading-relaxed text-zinc-500">{labels.imageLoadHint}</p>
            <a
              href={renderedImgSrc}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-[9px] uppercase tracking-widest text-cyan-400/90 underline-offset-2 hover:text-cyan-200 hover:underline"
            >
              {labels.openImageUrl}
            </a>
          </div>
        ) : isVerifying ? (
          <div
            className="phase-artifact-verify-placeholder relative z-[3] flex min-h-[150px] w-full max-w-md flex-col items-center justify-center gap-4 px-4 py-6 sm:min-h-[170px] sm:gap-5"
            aria-busy="true"
            aria-live="polite"
          >
            <div className="pointer-events-none absolute inset-2 rounded-sm opacity-[0.45] [background:repeating-linear-gradient(0deg,transparent,transparent_2px,rgba(34,211,238,0.06)_2px,rgba(34,211,238,0.06)_3px)]" />
            <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-sm">
              <div className="phase-artifact-verify-sweep absolute inset-x-0 top-0 h-[42%] bg-gradient-to-b from-cyan-400/12 via-transparent to-transparent" />
            </div>
            <div className="relative flex h-[5.5rem] w-[5.5rem] items-center justify-center sm:h-24 sm:w-24">
              <span
                className="absolute inset-0 rounded-full border border-cyan-500/25 shadow-[0_0_20px_rgba(34,211,238,0.12)]"
                aria-hidden
              />
              <span
                className="phase-artifact-verify-orbit absolute inset-[6px] rounded-full border border-violet-400/35"
                aria-hidden
              />
              <span
                className="absolute inset-[14px] rounded-full border border-dashed border-cyan-400/30"
                aria-hidden
              />
              <span className="relative flex h-2.5 w-2.5 rounded-full bg-cyan-300 shadow-[0_0_14px_rgba(34,211,238,0.95)]" />
            </div>
            <div className="relative w-[min(100%,16rem)] space-y-2">
              <div className="h-1 overflow-hidden rounded-full bg-cyan-950/90 ring-1 ring-cyan-500/20">
                <div className="phase-artifact-verify-shimmer-bar h-full w-[38%] rounded-full bg-gradient-to-r from-transparent via-cyan-400/55 to-transparent" />
              </div>
              <p className="text-center font-mono text-[8px] uppercase tracking-[0.2em] text-cyan-400/80 sm:text-[9px]">
                {labels.verifying}
              </p>
            </div>
          </div>
        ) : (
          <span
            className={cn(
              "relative z-[3] px-2 text-center font-mono text-[9px] uppercase tracking-[0.35em]",
              ownerUnlocked ? "tactical-phosphor text-cyan-400/70" : "text-violet-400/55",
            )}
          >
            {labels.noVisual}
          </span>
        )}
      </div>
    </div>
  )

  const bannerEl = (
    <div className={cn("relative z-[2]", showArtFirst ? "mb-2 mt-1" : "mb-2")}>
      <p className={cn("border px-2 py-1.5 text-center font-mono text-[10px] uppercase tracking-[0.24em]", bannerClass)}>
        {bannerText}
      </p>
      {mode === "locked" && (
        <p className="mt-1.5 text-center font-mono text-[9px] uppercase leading-snug tracking-[0.12em] text-violet-300/85">
          {labels.accessDeniedLine}
        </p>
      )}
      {isVerifying && (
        <p className="mt-1.5 text-center font-mono text-[9px] uppercase leading-snug tracking-[0.14em] text-cyan-300/90">
          {labels.verifyingHint}
        </p>
      )}
    </div>
  )

  const publicMetaPanel = (
    <div className="mx-auto mt-1 w-full max-w-[min(100%,24rem)] space-y-2 border border-zinc-700/35 bg-black/40 p-4 font-mono text-[10px] uppercase tracking-wide text-zinc-400/95 sm:text-[11px]">
      <div className="flex justify-between gap-2 border-b border-zinc-800/80 pb-2">
        <span className="shrink-0 text-zinc-600">{labels.monitorCollectionName}</span>
        <span className="min-w-0 max-w-[65%] truncate text-right normal-case text-zinc-500" title={publicCollectionLine}>
          {publicCollectionLine}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2 border-b border-zinc-800/80 pb-2">
        <span className="shrink-0 text-zinc-600">{labels.monitorContractAddr}</span>
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="min-w-0 truncate text-right text-zinc-500"
            title={contractId || undefined}
            suppressHydrationWarning
          >
            {contractPublic}
          </span>
          <button
            type="button"
            onClick={() => void copyContractId().catch(() => {})}
            className="ml-3 shrink-0 rounded border border-cyan-500/40 bg-cyan-950/25 px-1.5 py-0.5 text-[8px] font-bold text-cyan-300/90 transition-colors hover:border-cyan-300 hover:text-white"
            title={copiedContract ? "Copied" : "Copy"}
            aria-label="Copy contract address"
          >
            {copiedContract ? "OK" : "COPY"}
          </button>
        </div>
      </div>
      <div className="flex justify-between gap-2 border-b border-zinc-800/80 pb-2">
        <span className="shrink-0 text-zinc-600">{labels.supplyStabilized}</span>
        <span
          className={cn(
            "shrink-0 tabular-nums tracking-tight",
            supplyAlert ? "font-bold text-red-400 tactical-phosphor [text-shadow:0_0_12px_rgba(248,113,113,0.45)]" : "text-zinc-500",
          )}
        >
          {supplyLine}
        </span>
      </div>
      <p className="border-t border-zinc-800/80 pt-2 text-[9px] leading-snug tracking-[0.08em] text-zinc-500/95">
        {labels.readonly}
      </p>
      {expertUrl && expertLabel && (
        <a
          href={expertUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex w-full items-center justify-center border border-cyan-500/40 bg-cyan-950/30 px-2 py-1.5 text-[10px] font-bold tracking-[0.14em] text-cyan-200 transition-colors hover:border-cyan-300 hover:text-cyan-100"
        >
          {expertLabel}
        </a>
      )}
    </div>
  )

  const privateMonitorPanel =
    ownerUnlocked ? (
      <div className="relative z-[2] mx-auto mt-3 w-full max-w-[min(100%,24rem)] space-y-2 border border-cyan-400/35 bg-cyan-950/25 px-2.5 py-2.5 shadow-[0_0_20px_rgba(34,211,238,0.12)]">
        <p className="text-center font-mono text-[8px] font-bold uppercase tracking-[0.3em] text-cyan-300 tactical-phosphor sm:text-[9px]">
          {labels.privateChannelUnlocked}
        </p>
        <div className="flex items-start justify-between gap-2 border-b border-cyan-500/15 pb-2">
          <span className="shrink-0 pt-0.5 font-mono text-[8px] text-cyan-600/95 sm:text-[9px]">{labels.metadataStandard}</span>
          <span className="text-right font-mono text-[9px] font-bold tracking-wide text-cyan-200 tactical-phosphor sm:text-[10px]">
            SEP-41/50
          </span>
        </div>
        <div className="flex items-start justify-between gap-2 border-b border-cyan-500/15 pb-2">
          <span className="shrink-0 pt-0.5 font-mono text-[8px] text-cyan-600/95 sm:text-[9px]">{labels.secretId}</span>
          <GlitchDecryptField
            key={`secret-${serial}`}
            finalText={secretFinal}
            active={ownerUnlocked}
            className="text-[9px] text-cyan-100 tactical-phosphor sm:text-[10px]"
          />
        </div>
        <div className="flex items-start justify-between gap-2 border-b border-cyan-500/15 pb-2">
          <span className="shrink-0 pt-0.5 font-mono text-[8px] text-cyan-600/95 sm:text-[9px]">{labels.powerLevel}</span>
          <GlitchDecryptField
            key={`pow-${serial}-${energyLevelBp}`}
            finalText={powerFinalPrivate}
            active={ownerUnlocked}
            className="text-[9px] text-cyan-100 tactical-phosphor sm:text-[10px]"
          />
        </div>
        <div className="flex items-start justify-between gap-2 border-b border-cyan-500/15 pb-2">
          <span className="shrink-0 pt-0.5 font-mono text-[8px] text-cyan-600/95 sm:text-[9px]">{labels.holderSignature}</span>
          <span className="max-w-[55%] break-all text-right font-mono text-[9px] text-cyan-100 tactical-phosphor sm:text-[10px]">
            {viewerSignatureShort(viewerAddress)}
          </span>
        </div>
        <div className="space-y-1.5 pt-0.5">
          <span className="block font-mono text-[8px] uppercase tracking-wide text-cyan-600/90 sm:text-[9px]">
            {labels.rawMetadata}
          </span>
          {onAccessPrivateMetadata && (
            <button
              type="button"
              onClick={onAccessPrivateMetadata}
              className="tactical-phosphor w-full border-2 border-cyan-400/55 bg-cyan-950/45 py-2 text-[9px] font-bold uppercase tracking-[0.2em] text-cyan-100 shadow-[0_0_16px_rgba(34,211,238,0.28)] transition-colors hover:border-cyan-300 hover:bg-cyan-900/50 hover:text-white"
            >
              {labels.accessPrivateMetadata}
            </button>
          )}
        </div>
      </div>
    ) : null

  const asciiBlock = (
    <div className="relative z-[2] mx-auto max-w-[min(100%,24rem)] py-1">
      <div className="tactical-pedestal-scene">
        <div className="tactical-pedestal-spin">
          <pre className={cn(preClass)}>{topBlock}</pre>
        </div>
      </div>
      {showPublicMetaPanel ? publicMetaPanel : null}
      {showPrivateMetaPanel ? privateMonitorPanel : null}
    </div>
  )

  const chamberCaptionEl =
    chamberMinimal && publicCollectionLine !== "—" ? (
      <div
        className={cn(
          "relative z-[2] mt-2 max-w-[min(100%,22rem)]",
          chamberDockFrameless ? "mx-0 text-left" : "mx-auto text-center",
        )}
      >
        <p className="text-[13px] font-medium leading-snug text-zinc-200">{publicCollectionLine}</p>
        <p className="mt-1 font-mono text-[10px] tracking-wide text-zinc-500">#{Math.max(0, Math.floor(serial))}</p>
      </div>
    ) : chamberMinimal ? (
      <div
        className={cn(
          "relative z-[2] mt-2 max-w-[min(100%,22rem)]",
          chamberDockFrameless ? "mx-0 text-left" : "mx-auto text-center",
        )}
      >
        <p className="font-mono text-[10px] tracking-wide text-zinc-500">#{Math.max(0, Math.floor(serial))}</p>
      </div>
    ) : null

  const dockTokenNumeric = Number.isFinite(Number(serial)) ? Math.max(0, Math.floor(Number(serial))) : 0
  const dockTokenCopyValue = dockCopyTokenId?.trim() || String(dockTokenNumeric)

  const footerOwnerActions =
    chamberDockFrameless && chamberDockEligible ? (
      <div className="relative z-[2] mt-3 flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
        <div className="min-w-0 flex-1 space-y-2.5">
          {contractId ? (
            <div className="border-b border-cyan-500/20 pb-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[8px] uppercase tracking-wider text-zinc-500 sm:text-[9px]">
                  {labels.chamberPreviewCollectionAddress}
                </span>
                <button
                  type="button"
                  onClick={() => void copyDockField("contract", contractId)}
                  className="shrink-0 rounded-sm px-2 py-0.5 font-mono text-[8px] font-semibold uppercase tracking-wider text-cyan-400/90 transition-colors hover:text-cyan-200 sm:text-[9px]"
                >
                  {copiedDock === "contract" ? "OK" : labels.chamberPreviewCopy}
                </button>
              </div>
              <p className="mt-1 break-all font-mono text-[9px] leading-relaxed text-cyan-100/90 sm:text-[10px]">{contractId}</p>
            </div>
          ) : null}
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[8px] uppercase tracking-wider text-zinc-500 sm:text-[9px]">
                {labels.chamberPreviewTokenId}
              </span>
              <button
                type="button"
                onClick={() => void copyDockField("token", dockTokenCopyValue)}
                className="shrink-0 rounded-sm px-2 py-0.5 font-mono text-[8px] font-semibold uppercase tracking-wider text-cyan-400/90 transition-colors hover:text-cyan-200 sm:text-[9px]"
              >
                {copiedDock === "token" ? "OK" : labels.chamberPreviewCopy}
              </button>
            </div>
            <p className="mt-1 font-mono text-[9px] tabular-nums tracking-wide text-cyan-100/90 sm:text-[10px]">
              {dockTokenCopyValue.trim() ? `#${dockTokenCopyValue}` : "—"}
            </p>
          </div>
        </div>
        {chamberCollectMode && onCollectNft ? (
          <button
            type="button"
            disabled={collectNftBusy}
            onClick={() => void Promise.resolve(onCollectNft())}
            className="tactical-interactive-glitch inline-flex shrink-0 items-center justify-center self-end border border-violet-500/55 bg-violet-950/35 px-3 py-2 text-[9px] font-bold uppercase tracking-widest text-violet-100 shadow-[inset_0_0_0_1px_rgba(167,139,250,0.12)] transition-colors hover:border-violet-400 hover:bg-violet-900/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-45 sm:self-auto"
          >
            {collectNftBusy ? collectBusyLabel ?? "…" : collectLabel ?? "Collect"}
          </button>
        ) : null}
      </div>
    ) : ownerUnlocked && (onDownloadCertificate || expertUrl) ? (
      <div className="relative z-[2] mt-3 flex flex-col gap-2 sm:flex-row sm:justify-center sm:gap-3">
        {onDownloadCertificate && (
          <button
            type="button"
            onClick={onDownloadCertificate}
            className="tactical-phosphor border-2 border-cyan-400/55 bg-cyan-950/40 px-3 py-2 text-[9px] font-bold uppercase tracking-widest text-cyan-100 shadow-[0_0_14px_rgba(34,211,238,0.2)] transition-colors hover:border-cyan-300 hover:bg-cyan-900/45 hover:text-white"
          >
            {labels.downloadCertificate}
          </button>
        )}
        {expertUrl && expertLabel && (
          <a
            href={expertUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="tactical-phosphor inline-flex items-center justify-center border-2 border-cyan-400/55 bg-cyan-950/35 px-3 py-2 text-[9px] font-bold uppercase tracking-widest text-cyan-100 shadow-[0_0_14px_rgba(34,211,238,0.2)] transition-colors hover:border-cyan-300 hover:bg-cyan-900/40 hover:text-white"
          >
            {expertLabel}
          </a>
        )}
      </div>
    ) : null

  const lightbox =
    mounted &&
    lightboxOpen &&
    renderedImgSrc &&
    createPortal(
      <div
        className="fixed inset-0 z-[500] flex items-center justify-center bg-black/92 p-3 sm:p-6"
        role="dialog"
        aria-modal="true"
        aria-labelledby={lightboxTitleId}
        onClick={closeLightbox}
      >
        <div
          className="relative flex max-h-[92vh] max-w-[min(96vw,1200px)] flex-col items-center gap-3"
          onClick={(e) => e.stopPropagation()}
        >
          <p id={lightboxTitleId} className="sr-only">
            {labels.expandPreview}
          </p>
          <button
            type="button"
            onClick={closeLightbox}
            className="tactical-phosphor absolute -top-1 right-0 z-[2] border border-violet-500/50 bg-violet-950/80 px-3 py-1.5 font-mono text-[9px] font-bold uppercase tracking-widest text-violet-200 hover:bg-violet-900/90 sm:right-1"
          >
            {labels.closePreview}
          </button>
          <div className="relative inline-block max-w-full">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={renderedImgSrc}
              alt=""
              className={cn(
                "max-h-[min(88vh,900px)] max-w-full object-contain shadow-[0_0_40px_rgba(139,92,246,0.12)] transition-[filter] duration-500",
                usePixelTreatment && "phase-artifact-img-pixel",
                useBlurOnArt && "blur-[7px] sm:blur-[6px]",
                eligibleForDecrypt && !decrypting && "blur-0",
                eligibleForDecrypt && decrypting && "blur-[4px] brightness-90",
              )}
              loading="eager"
              referrerPolicy="no-referrer"
            />
            {eligibleForDecrypt && decrypting && (
              <div
                className="phase-artifact-decrypt-overlay pointer-events-none absolute inset-0 z-[3] flex items-center justify-center bg-black/30"
                aria-hidden
              >
                <span className="text-center font-mono text-lg font-bold uppercase tracking-[0.32em] text-cyan-300 tactical-phosphor sm:text-xl">
                  {labels.decryptingImage}
                </span>
              </div>
            )}
            {!isOwner && protectArt && (
              <div
                className="pointer-events-none absolute inset-0 z-[4] flex items-center justify-center overflow-hidden"
                aria-hidden
              >
                <span className="max-w-[90%] px-3 text-center font-mono text-sm font-bold uppercase leading-snug tracking-[0.15em] text-white mix-blend-overlay opacity-95 [transform:rotate(45deg)] sm:text-base sm:tracking-[0.22em]">
                  {labels.pendingOwnershipVerification}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>,
      document.body,
    )

  return (
    <div
      className={cn(
        chamberDockFrameless
          ? "relative flex min-h-0 h-full w-full min-w-0 flex-1 flex-col justify-start overflow-visible rounded-lg border-0 bg-transparent p-0 pt-0.5 shadow-none"
          : chamberMinimal
            ? "relative overflow-visible rounded-xl border border-violet-500/20 bg-transparent px-3 py-4 sm:px-4 sm:py-5"
            : "tactical-frame relative overflow-hidden rounded-sm border-2 px-3 py-3 sm:px-4",
        !chamberMinimal && frameClass,
        className,
      )}
      aria-label={labels.ariaLabel}
      suppressHydrationWarning
    >
      {lightbox}

      {showArtFirst ? (
        <>
          {holoBlock}
          {!stripBannerForChamber && bannerEl}
          {showAsciiBlock && asciiBlock}
        </>
      ) : stripBannerForChamber ? (
        <>
          {holoBlock}
          {!chamberMetaPanelExternal ? (
            <>
              {chamberCaptionEl}
              {footerOwnerActions}
            </>
          ) : null}
        </>
      ) : (
        <>
          {bannerEl}
          {holoBlock}
          {showAsciiBlock && asciiBlock}
          {footerOwnerActions}
        </>
      )}
    </div>
  )
}
