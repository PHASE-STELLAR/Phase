"use client"

import { useCallback, useMemo, useState } from "react"
import { useLang } from "@/components/lang-context"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { pickCopy } from "@/lib/phase-copy"
import {
  PhaseTokenMetadataJsonSchema,
  type PhaseTokenMetadataJson,
} from "@/lib/phase-nft-metadata-build"
import { cn } from "@/lib/utils"

export type DesignStudioMetadataPanelProps = {
  tokenId?: number
  contractId?: string
  initialMetadata?: Partial<PhaseTokenMetadataJson>
  onCommitted?: (metadata: PhaseTokenMetadataJson) => void
  className?: string
}

export function DesignStudioMetadataPanel({
  tokenId = 1,
  contractId,
  initialMetadata,
  onCommitted,
  className,
}: DesignStudioMetadataPanelProps) {
  const { lang } = useLang()
  const mc = pickCopy(lang).studioMetadata
  const enabled = isFeatureEnabled("phase-258")

  const [name, setName] = useState(initialMetadata?.name ?? "Phase Artifact #1")
  const [description, setDescription] = useState(
    initialMetadata?.description ?? "Created in PHASE Design Studio.",
  )
  const [image, setImage] = useState(
    initialMetadata?.image ?? "https://www.phasee.xyz/og-phase.png",
  )
  const [externalUrl, setExternalUrl] = useState(
    initialMetadata?.external_url ?? "https://www.phasee.xyz",
  )
  const [collectionIdRaw, setCollectionIdRaw] = useState(
    initialMetadata?.collectionId != null ? String(initialMetadata.collectionId) : "",
  )
  const [attributes, setAttributes] = useState<
    Array<{ trait_type: string; value: string }>
  >(
    (initialMetadata?.attributes ?? []).map((a) => ({
      trait_type: a.trait_type,
      value: String(a.value),
    })),
  )

  const [etag, setEtag] = useState<string>('"v0"')
  const [version, setVersion] = useState<number>(0)
  const [showPreview, setShowPreview] = useState(false)
  const [busy, setBusy] = useState(false)
  const [statusMessage, setStatusMessage] = useState<{
    kind: "ok" | "error"
    text: string
  } | null>(null)

  const candidatePayload = useMemo(() => {
    const trimmedCol = collectionIdRaw.trim()
    const parsedCol =
      trimmedCol.length > 0 && /^\d+$/.test(trimmedCol) ? Number(trimmedCol) : null
    return {
      name,
      description,
      image,
      external_url: externalUrl,
      attributes: attributes
        .filter((a) => a.trait_type.trim() || a.value.trim())
        .map((a) => ({ trait_type: a.trait_type, value: a.value })),
      collectionId: parsedCol,
    }
  }, [name, description, image, externalUrl, attributes, collectionIdRaw])

  const validation = useMemo(
    () => PhaseTokenMetadataJsonSchema.safeParse(candidatePayload),
    [candidatePayload],
  )

  const handleSaveDraft = useCallback(async () => {
    if (!validation.success) {
      setStatusMessage({ kind: "error", text: mc.validationFailed })
      return
    }
    setBusy(true)
    setStatusMessage(null)
    try {
      const res = await fetch(`/api/metadata/${tokenId}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "If-Match": etag,
        },
        body: JSON.stringify({
          contractId,
          metadata: validation.data,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (res.status === 409) {
        setStatusMessage({ kind: "error", text: mc.staleConflict })
        return
      }
      if (!res.ok) {
        setStatusMessage({
          kind: "error",
          text: typeof json.error === "string" ? json.error : mc.validationFailed,
        })
        return
      }
      const nextEtag = res.headers.get("etag") ?? json?.draft?.etag ?? etag
      const nextVersion = typeof json?.draft?.version === "number" ? json.draft.version : version + 1
      setEtag(nextEtag)
      setVersion(nextVersion)
      setStatusMessage({ kind: "ok", text: `${mc.draftSaved} (v${nextVersion})` })
    } finally {
      setBusy(false)
    }
  }, [validation, tokenId, etag, contractId, version, mc])

  const handleCommit = useCallback(async () => {
    if (!validation.success) {
      setStatusMessage({ kind: "error", text: mc.validationFailed })
      return
    }
    setBusy(true)
    setStatusMessage(null)
    try {
      const res = await fetch(`/api/metadata/${tokenId}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "If-Match": etag,
        },
        body: JSON.stringify({
          contractId,
          metadata: validation.data,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (res.status === 409) {
        setStatusMessage({ kind: "error", text: mc.staleConflict })
        return
      }
      if (!res.ok) {
        setStatusMessage({
          kind: "error",
          text: typeof json.error === "string" ? json.error : mc.validationFailed,
        })
        return
      }
      const nextEtag = res.headers.get("etag") ?? json?.draft?.etag ?? etag
      const nextVersion = typeof json?.draft?.version === "number" ? json.draft.version : version + 1
      setEtag(nextEtag)
      setVersion(nextVersion)
      setStatusMessage({ kind: "ok", text: `${mc.committed} (v${nextVersion})` })
      if (json?.metadata) {
        onCommitted?.(json.metadata as PhaseTokenMetadataJson)
      }
    } finally {
      setBusy(false)
    }
  }, [validation, tokenId, etag, contractId, version, mc, onCommitted])

  if (!enabled) return null

  return (
    <aside
      className={cn(
        "flex w-full flex-col gap-2 border-4 border-double border-cyan-500/45 bg-[#070d0d] p-3 font-mono text-xs text-cyan-100 md:w-[340px] md:shrink-0 md:overflow-y-auto",
        className,
      )}
    >
      <div className="flex items-center justify-between border-b border-cyan-500/30 pb-1.5">
        <span className="text-[11px] font-bold uppercase tracking-widest text-cyan-200">
          {mc.panelTitle}
        </span>
        <span className="text-[10px] text-cyan-400">
          {mc.versionLabel} {version}
        </span>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wider text-cyan-300">{mc.nameLabel}</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="border border-cyan-600/50 bg-black/80 px-2 py-1 text-xs text-cyan-50 outline-none focus:border-cyan-400"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wider text-cyan-300">
          {mc.descriptionLabel}
        </span>
        <textarea
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="border border-cyan-600/50 bg-black/80 px-2 py-1 text-xs text-cyan-50 outline-none focus:border-cyan-400"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wider text-cyan-300">{mc.imageLabel}</span>
        <input
          value={image}
          onChange={(e) => setImage(e.target.value)}
          className="border border-cyan-600/50 bg-black/80 px-2 py-1 text-xs text-cyan-50 outline-none focus:border-cyan-400"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wider text-cyan-300">
          {mc.externalUrlLabel}
        </span>
        <input
          value={externalUrl}
          onChange={(e) => setExternalUrl(e.target.value)}
          className="border border-cyan-600/50 bg-black/80 px-2 py-1 text-xs text-cyan-50 outline-none focus:border-cyan-400"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wider text-cyan-300">
          {mc.collectionIdLabel}
        </span>
        <input
          value={collectionIdRaw}
          onChange={(e) => setCollectionIdRaw(e.target.value)}
          className="border border-cyan-600/50 bg-black/80 px-2 py-1 text-xs text-cyan-50 outline-none focus:border-cyan-400"
        />
      </label>

      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wider text-cyan-300">
            {mc.attributesLabel}
          </span>
          <button
            type="button"
            onClick={() => setAttributes((a) => [...a, { trait_type: "", value: "" }])}
            className="border border-cyan-500/40 px-1.5 py-0.5 text-[10px] text-cyan-200 hover:bg-cyan-500/20"
          >
            + {mc.addAttribute}
          </button>
        </div>
        {attributes.map((attr, idx) => (
          <div key={idx} className="flex gap-1">
            <input
              placeholder={mc.traitTypePlaceholder}
              value={attr.trait_type}
              onChange={(e) =>
                setAttributes((prev) =>
                  prev.map((row, i) => (i === idx ? { ...row, trait_type: e.target.value } : row)),
                )
              }
              className="w-1/2 border border-cyan-600/50 bg-black/80 px-1.5 py-1 text-[11px] text-cyan-50"
            />
            <input
              placeholder={mc.traitValuePlaceholder}
              value={attr.value}
              onChange={(e) =>
                setAttributes((prev) =>
                  prev.map((row, i) => (i === idx ? { ...row, value: e.target.value } : row)),
                )
              }
              className="w-1/2 border border-cyan-600/50 bg-black/80 px-1.5 py-1 text-[11px] text-cyan-50"
            />
          </div>
        ))}
      </div>

      {!validation.success && (
        <div className="border border-red-500/50 bg-red-950/40 p-2 text-[10px] text-red-200">
          {mc.validationFailed}: {validation.error.issues[0]?.message ?? "invalid"}
        </div>
      )}

      {statusMessage && (
        <div
          className={cn(
            "border p-2 text-[10px]",
            statusMessage.kind === "ok"
              ? "border-emerald-500/50 bg-emerald-950/35 text-emerald-200"
              : "border-red-500/50 bg-red-950/40 text-red-200",
          )}
        >
          {statusMessage.text}
        </div>
      )}

      <div className="flex flex-wrap gap-1.5 pt-1">
        <button
          type="button"
          onClick={() => setShowPreview((p) => !p)}
          className="border border-cyan-500/50 bg-cyan-950/30 px-2 py-1 text-[10px] uppercase tracking-wider text-cyan-200 hover:bg-cyan-900/40"
        >
          {mc.previewToggle}
        </button>
        <button
          type="button"
          disabled={busy || !validation.success}
          onClick={() => void handleSaveDraft()}
          className="border border-emerald-500/60 bg-emerald-950/30 px-2 py-1 text-[10px] uppercase tracking-wider text-emerald-200 hover:bg-emerald-900/40 disabled:opacity-40"
        >
          {mc.saveDraft}
        </button>
        <button
          type="button"
          disabled={busy || !validation.success}
          onClick={() => void handleCommit()}
          className="border border-cyan-400 bg-cyan-500/20 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-white hover:bg-cyan-500/30 disabled:opacity-40"
        >
          {mc.commitMetadata}
        </button>
      </div>

      {showPreview && validation.success && (
        <div className="mt-1 border border-cyan-500/40 bg-black/90 p-2">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-cyan-300">
            {mc.previewTitle}
          </div>
          <pre className="max-h-40 overflow-auto text-[10px] text-emerald-300">
            {JSON.stringify(validation.data, null, 2)}
          </pre>
        </div>
      )}
    </aside>
  )
}
