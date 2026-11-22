"use client"

import type React from "react"
import { useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import {
  DesignStudioEditor,
  type DesignStudioEditorHandle,
  STUDIO_H,
  STUDIO_W,
} from "@/components/design-studio-editor"
import { DesignStudioMetadataPanel } from "@/components/design-studio-metadata-panel"
import { LangToggle } from "@/components/lang-toggle"
import { useLang } from "@/components/lang-context"
import { isFeatureEnabled } from "@/lib/feature-flags"
import type { PhaseTokenMetadataJson } from "@/lib/phase-nft-metadata-build"
import { pickCopy } from "@/lib/phase-copy"
import { cn } from "@/lib/utils"

export type DesignStudioModalProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSeal: (blob: Blob) => void
  tokenId?: number
  contractId?: string
  onMetadataCommitted?: (metadata: PhaseTokenMetadataJson) => void
}

function Win95Menu({
  label,
  children,
  className,
}: {
  label: string
  children: (close: () => void) => React.ReactNode
  className?: string
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setMenuOpen(false), [])

  useEffect(() => {
    if (!menuOpen) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener("mousedown", onDoc)
    return () => document.removeEventListener("mousedown", onDoc)
  }, [menuOpen])

  return (
    <div ref={ref} className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setMenuOpen((o) => !o)}
        className={cn(
          "px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-widest transition-colors",
          menuOpen ? "bg-cyan-500/25 text-cyan-50" : "text-cyan-200/90 hover:bg-cyan-500/15 hover:text-cyan-50",
        )}
      >
        {label}
      </button>
      {menuOpen && (
        <div
          className="absolute left-0 top-[calc(100%+2px)] z-[300] min-w-[240px] border-2 border-cyan-400 bg-[#050a0a] py-1"
          style={{
            boxShadow:
              "inset 1px 1px 0 rgba(0,255,255,0.35), inset -1px -1px 0 #000, 4px 4px 16px rgba(0,255,255,0.12)",
          }}
        >
          {children(close)}
        </div>
      )}
    </div>
  )
}

function MenuItem({
  onClick,
  children,
  danger,
}: {
  onClick: () => void
  children: React.ReactNode
  danger?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "block w-full px-3 py-2.5 text-left font-mono text-[11px] font-medium leading-snug tracking-wide",
        danger
          ? "text-red-300 hover:bg-red-950/50"
          : "text-cyan-100 hover:bg-cyan-500/15 hover:text-white",
      )}
    >
      {children}
    </button>
  )
}

export function DesignStudioModal({
  open,
  onOpenChange,
  onSeal,
  tokenId,
  contractId,
  onMetadataCommitted,
}: DesignStudioModalProps) {
  const { lang } = useLang()
  const m = pickCopy(lang).studioModal
  const editorRef = useRef<DesignStudioEditorHandle>(null)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  const handleCancel = useCallback(() => {
    onOpenChange(false)
  }, [onOpenChange])

  const handleClear = useCallback(() => {
    editorRef.current?.clear()
  }, [])

  const handleSeal = useCallback(async () => {
    const blob = await editorRef.current?.exportPngBlob()
    if (!blob || blob.size < 64) return
    onSeal(blob)
    onOpenChange(false)
  }, [onSeal, onOpenChange])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleCancel()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, handleCancel])

  if (!mounted || !open) return null

  const overlay = (
    <div
      className="fixed inset-0 z-[240] flex flex-col bg-[#000000] font-mono text-cyan-100"
      role="dialog"
      aria-modal="true"
      aria-labelledby="design-studio-title"
      style={{
        boxShadow: "inset 0 0 120px rgba(0,255,136,0.05)",
      }}
    >
      <div
        className="flex shrink-0 items-center justify-between gap-3 border-b-4 border-double border-cyan-400 px-3 py-2.5 md:px-4"
        style={{
          background: "linear-gradient(90deg, #003333 0%, #006666 45%, #004848 100%)",
          boxShadow: "inset 0 1px 0 rgba(0,255,255,0.4), inset 0 -1px 0 rgba(0,0,0,0.5)",
        }}
      >
        <div className="min-w-0 flex items-center gap-2">
          <span className="shrink-0 text-cyan-200" aria-hidden>
            ■
          </span>
          <h2
            id="design-studio-title"
            className="truncate text-[11px] font-bold uppercase tracking-[0.15em] text-white md:text-[12px]"
          >
            {m.windowTitle}
          </h2>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="hidden text-[10px] font-medium uppercase tracking-widest text-cyan-100/90 sm:block">
            {STUDIO_W}×{STUDIO_H} {m.canvasMeta}
          </span>
          <LangToggle variant="phosphor" />
        </div>
      </div>

      <div
        className="flex shrink-0 flex-wrap items-center gap-1 border-b-2 border-cyan-600/40 bg-[#0c1612] px-1 py-1"
        style={{
          boxShadow: "inset 0 1px 0 rgba(0,255,255,0.14)",
        }}
      >
        <Win95Menu label={m.file}>
          {(close) => (
            <>
              <MenuItem
                onClick={() => {
                  void handleSeal().catch(() => {})
                  close()
                }}
              >
                {m.saveSeal}
              </MenuItem>
              <MenuItem
                onClick={() => {
                  handleClear()
                  close()
                }}
              >
                {m.newCanvas}
              </MenuItem>
              <MenuItem
                danger
                onClick={() => {
                  handleCancel()
                  close()
                }}
              >
                {m.exitDiscard}
              </MenuItem>
            </>
          )}
        </Win95Menu>
        <Win95Menu label={m.edit}>
          {(close) => (
            <>
              <MenuItem
                onClick={() => {
                  editorRef.current?.undo()
                  close()
                }}
              >
                {m.undo}
              </MenuItem>
              <MenuItem
                onClick={() => {
                  editorRef.current?.closePolygon()
                  close()
                }}
              >
                {m.closePolygon}
              </MenuItem>
            </>
          )}
        </Win95Menu>
        <Win95Menu label={m.view}>
          {(close) => (
            <>
              <MenuItem
                onClick={() => {
                  editorRef.current?.zoomIn()
                  close()
                }}
              >
                {m.zoomIn}
              </MenuItem>
              <MenuItem
                onClick={() => {
                  editorRef.current?.zoomOut()
                  close()
                }}
              >
                {m.zoomOut}
              </MenuItem>
              <MenuItem
                onClick={() => {
                  editorRef.current?.zoomReset()
                  close()
                }}
              >
                {m.zoom100}
              </MenuItem>
            </>
          )}
        </Win95Menu>
        <span className="ml-auto hidden px-2 text-[9px] font-medium uppercase tracking-widest text-cyan-400/80 lg:block">
          {m.refLine}{" "}
          <a
            href="https://github.com/1j01/jspaint"
            target="_blank"
            rel="noopener noreferrer"
            className="text-cyan-200 underline-offset-2 hover:text-white hover:underline"
          >
            jspaint
          </a>
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden px-2 py-2 md:px-4 md:py-3">
        <div
          className="mx-auto flex h-full max-w-[1400px] flex-col border-4 border-double border-emerald-400/55 bg-[#050808] p-2 md:p-3"
          style={{
            boxShadow:
              "inset 1px 1px 0 rgba(0,255,255,0.22), inset -2px -2px 0 rgba(0,0,0,0.6), 0 0 24px rgba(0,255,136,0.08)",
          }}
        >
          <div className="flex min-h-0 flex-1 flex-col gap-3 md:flex-row">
            <DesignStudioEditor ref={editorRef} className="min-h-0 flex-1" />
            {isFeatureEnabled("phase-258") && (
              <DesignStudioMetadataPanel
                tokenId={tokenId}
                contractId={contractId}
                onCommitted={onMetadataCommitted}
              />
            )}
          </div>
        </div>
      </div>

      <footer
        className="flex shrink-0 flex-col gap-2 border-t-4 border-double border-cyan-600/45 bg-[#060a08] px-3 py-3 md:flex-row md:items-center md:justify-center md:gap-4 md:px-8"
        style={{
          boxShadow: "inset 0 1px 0 rgba(0,255,255,0.1)",
        }}
      >
        <button
          type="button"
          onClick={handleCancel}
          className="min-h-[50px] flex-1 rounded-sm border-4 border-double border-red-800/60 bg-red-950/35 py-3 text-[11px] font-bold uppercase tracking-[0.15em] text-red-100 hover:bg-red-950/50 md:max-w-[220px]"
        >
          {m.cancel}
        </button>
        <button
          type="button"
          onClick={handleClear}
          className="min-h-[50px] flex-1 rounded-sm border-4 border-double border-emerald-500/55 bg-emerald-950/25 py-3 text-[11px] font-bold uppercase tracking-[0.15em] text-emerald-200 hover:bg-emerald-950/40 md:max-w-[220px]"
        >
          {m.clear}
        </button>
        <button
          type="button"
          onClick={() => void handleSeal().catch(() => {})}
          className="design-studio-seal-pulse min-h-[50px] flex-[1.2] rounded-sm border-4 border-double border-cyan-400 bg-cyan-500/15 py-3 text-[11px] font-bold uppercase tracking-[0.18em] text-cyan-50 hover:bg-cyan-500/25 md:max-w-[340px]"
        >
          {m.seal}
        </button>
      </footer>
    </div>
  )

  return createPortal(overlay, document.body)
}
