"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import {
  parseScannedQrPayload,
  diagnoseCameraError,
  type ParsedQrPayload,
  type CameraErrorDiagnosis,
} from "@/lib/qr-code"

export type QrScannerModalProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onScan: (result: ParsedQrPayload) => void
  title?: string
}

export function QrScannerModal({
  open,
  onOpenChange,
  onScan,
  title = "◈ SCAN QR CODE",
}: QrScannerModalProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [cameraActive, setCameraActive] = useState(false)
  const [errorDiagnosis, setErrorDiagnosis] = useState<CameraErrorDiagnosis | null>(null)
  const [manualInput, setManualInput] = useState("")

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop()
      }
      streamRef.current = null
    }
    setCameraActive(false)
  }, [])

  const startCamera = useCallback(async () => {
    setErrorDiagnosis(null)
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setErrorDiagnosis({
        code: "UNSUPPORTED",
        message: "Camera scanning is not supported on this browser or platform.",
        retryable: false,
        userAction: "Paste or type the address manually.",
      })
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }
      setCameraActive(true)
    } catch (err: unknown) {
      const diagnosis = diagnoseCameraError(err)
      setErrorDiagnosis(diagnosis)
      stopCamera()
    }
  }, [stopCamera])

  useEffect(() => {
    if (open) {
      void startCamera()
    } else {
      stopCamera()
    }
    return () => {
      stopCamera()
    }
  }, [open, startCamera, stopCamera])

  function handleManualSubmit() {
    if (!manualInput.trim()) return
    const parsed = parseScannedQrPayload(manualInput.trim())
    onScan(parsed)
    onOpenChange(false)
    setManualInput("")
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton
        className="max-w-md w-full p-0 border border-violet-800/30 bg-[#0d0d14] text-zinc-100 overflow-hidden rounded-none"
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>

        <div className="px-5 pt-4 pb-3 border-b border-violet-800/20">
          <p className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-violet-400">
            {title}
          </p>
        </div>

        <div className="p-5 flex flex-col items-center gap-4">
          {/* Viewfinder Video Area */}
          <div className="relative w-full aspect-square max-w-[280px] bg-black/80 rounded-lg overflow-hidden border border-violet-800/40 flex items-center justify-center">
            <video
              ref={videoRef}
              playsInline
              muted
              className={`w-full h-full object-cover ${cameraActive ? "block" : "hidden"}`}
            />

            {/* Target Reticle Overlay */}
            {cameraActive && (
              <div className="absolute inset-8 border-2 border-violet-500/80 rounded-lg pointer-events-none animate-pulse">
                <div className="absolute -top-1 -left-1 w-4 h-4 border-t-2 border-l-2 border-violet-400" />
                <div className="absolute -top-1 -right-1 w-4 h-4 border-t-2 border-r-2 border-violet-400" />
                <div className="absolute -bottom-1 -left-1 w-4 h-4 border-b-2 border-l-2 border-violet-400" />
                <div className="absolute -bottom-1 -right-1 w-4 h-4 border-b-2 border-r-2 border-violet-400" />
              </div>
            )}

            {!cameraActive && !errorDiagnosis && (
              <div className="text-center font-mono text-xs text-zinc-500 px-4">
                Starting camera...
              </div>
            )}

            {errorDiagnosis && (
              <div className="text-center p-4">
                <p className="font-mono text-xs text-red-400 font-bold mb-1">
                  Camera Unavailable
                </p>
                <p className="font-mono text-[10px] text-zinc-400 mb-2 leading-relaxed">
                  {errorDiagnosis.message}
                </p>
                <p className="font-mono text-[9px] text-zinc-500">
                  {errorDiagnosis.userAction}
                </p>
                {errorDiagnosis.retryable && (
                  <button
                    type="button"
                    onClick={() => void startCamera()}
                    className="mt-3 px-3 py-1 font-mono text-[10px] uppercase tracking-wider border border-violet-700/50 bg-violet-950/30 text-violet-300 hover:border-violet-400 rounded"
                  >
                    Retry Camera
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Manual Input Fallback */}
          <div className="w-full space-y-2 pt-2 border-t border-zinc-800/80">
            <label className="font-mono text-[9px] uppercase tracking-widest text-zinc-500 block">
              Or paste address / referral code manually:
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={manualInput}
                onChange={(e) => setManualInput(e.target.value)}
                placeholder="G... or referral URL"
                className="flex-1 h-8 border border-zinc-800 bg-zinc-900 px-2 font-mono text-xs text-zinc-200 placeholder:text-zinc-700 focus:outline-none focus:border-violet-600"
              />
              <button
                type="button"
                onClick={handleManualSubmit}
                disabled={!manualInput.trim()}
                className="px-3 h-8 font-mono text-[10px] uppercase tracking-widest border border-violet-700/40 bg-violet-950/20 text-violet-300 hover:border-violet-500 disabled:opacity-40"
              >
                Submit
              </button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
