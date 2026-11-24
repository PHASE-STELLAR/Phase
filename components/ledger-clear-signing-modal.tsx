"use client"

import React, { useState } from "react"
import {
  DecodedSorobanInvocation,
  recordLedgerClearSigningApproved,
  recordLedgerClearSigningRejected,
  recordLedgerClearSigningReviewed,
} from "@/lib/ledger-soroban-decoder"

interface LedgerClearSigningModalProps {
  isOpen: boolean
  decoded: DecodedSorobanInvocation | null
  onApprove: () => void
  onCancel: () => void
}

export function LedgerClearSigningModal({
  isOpen,
  decoded,
  onApprove,
  onCancel,
}: LedgerClearSigningModalProps) {
  const [acknowledged, setAcknowledged] = useState(false)

  if (!isOpen || !decoded) return null

  // Record review telemetry once on render
  React.useEffect(() => {
    recordLedgerClearSigningReviewed()
  }, [])

  const hasGate13Risk = decoded.isSelfTransferRisk || decoded.preflightErrors.length > 0

  const handleApprove = () => {
    if (hasGate13Risk) return
    recordLedgerClearSigningApproved()
    onApprove()
  }

  const handleCancel = () => {
    recordLedgerClearSigningRejected()
    onCancel()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg rounded-xl border border-sky-500/30 bg-zinc-950 p-6 shadow-2xl shadow-sky-950/40 text-zinc-100 animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 pb-4 mb-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-500/10 text-sky-400 border border-sky-500/30">
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="4" y="2" width="16" height="20" rx="2" />
                <circle cx="12" cy="14" r="3" />
                <line x1="12" y1="6" x2="12.01" y2="6" strokeWidth="3" />
              </svg>
            </div>
            <div>
              <h3 className="font-mono text-sm font-semibold text-zinc-100 flex items-center gap-2">
                Ledger Clear-Signing Review
                <span className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-300 border border-sky-500/30">
                  Preflight
                </span>
              </h3>
              <p className="font-mono text-[11px] text-zinc-400">
                Inspect call parameters before transmitting payload to hardware
              </p>
            </div>
          </div>
          <button
            onClick={handleCancel}
            type="button"
            className="text-zinc-500 hover:text-zinc-300 transition-colors p-1"
          >
            ✕
          </button>
        </div>

        {/* Gate #13 Alert if self-transfer or preflight error */}
        {hasGate13Risk && (
          <div className="mb-4 rounded-lg border border-red-500/40 bg-red-950/40 p-3.5 text-red-200">
            <div className="flex items-start gap-2.5">
              <span className="text-red-400 text-base">⚠️</span>
              <div className="text-xs">
                <p className="font-bold text-red-300 mb-1">Contract Execution Blocked (Gate #13 Pre-empted)</p>
                <ul className="list-disc list-inside space-y-0.5 text-red-200/90 text-[11px]">
                  {decoded.preflightErrors.map((err, i) => (
                    <li key={i}>{err}</li>
                  ))}
                </ul>
                <p className="mt-2 text-[10px] text-red-300/80">
                  This transaction would fail post-submit with Phase error #13. Signing on device has been blocked.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Call Summary */}
        <div className="space-y-3 mb-5 font-mono text-xs">
          <div className="rounded-lg bg-zinc-900/80 border border-zinc-800/80 p-3 space-y-2">
            <div className="flex justify-between items-center text-[11px]">
              <span className="text-zinc-400">Target Contract</span>
              <span className="font-semibold text-sky-300">{decoded.contractLabel}</span>
            </div>
            <div className="flex justify-between items-center text-[10px] text-zinc-400">
              <span className="truncate max-w-[200px]">{decoded.contractId}</span>
              <button
                type="button"
                onClick={() => navigator.clipboard?.writeText(decoded.contractId)}
                className="text-zinc-500 hover:text-zinc-300 underline"
              >
                copy ID
              </button>
            </div>
            <div className="flex justify-between items-center text-[11px] border-t border-zinc-800/60 pt-2">
              <span className="text-zinc-400">Host Function</span>
              <span className="font-bold text-emerald-400 bg-emerald-950/40 px-2 py-0.5 rounded border border-emerald-800/40">
                {decoded.functionName}()
              </span>
            </div>
          </div>

          {/* Decoded Parameters */}
          <div className="rounded-lg bg-zinc-900/80 border border-zinc-800/80 p-3 space-y-1.5 text-[11px]">
            <p className="text-[10px] uppercase font-bold text-zinc-500 tracking-wider mb-1">Decoded Parameters</p>
            {Object.entries(decoded.namedArgs).length === 0 ? (
              <p className="text-zinc-500 italic">No parameters</p>
            ) : (
              Object.entries(decoded.namedArgs).map(([key, val]) => (
                <div key={key} className="flex justify-between items-center py-0.5 border-b border-zinc-800/30 last:border-0">
                  <span className="text-zinc-400">{key}:</span>
                  <span className="text-zinc-200 font-medium truncate max-w-[260px]">{String(val)}</span>
                </div>
              ))
            )}
            <div className="flex justify-between items-center pt-1 text-zinc-400 text-[10px]">
              <span>Max Fee:</span>
              <span className="text-zinc-300">{decoded.fee} stroops</span>
            </div>
          </div>

          {/* Verification Code */}
          <div className="rounded-lg bg-sky-950/20 border border-sky-800/40 p-3 flex items-center justify-between">
            <div>
              <p className="text-[10px] uppercase font-bold text-sky-400 tracking-wider">Ledger Verification Code</p>
              <p className="text-[10px] text-zinc-400">Match with on-device hash pre-image</p>
            </div>
            <div className="text-right">
              <span className="font-mono text-sm font-bold text-sky-300 tracking-wider bg-sky-900/40 px-2.5 py-1 rounded border border-sky-700/50">
                {decoded.verificationCode}
              </span>
            </div>
          </div>
        </div>

        {/* Checkbox Acknowledgment */}
        {!hasGate13Risk && (
          <label className="flex items-center gap-2 mb-5 cursor-pointer text-xs text-zinc-300">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="rounded border-zinc-700 bg-zinc-900 text-sky-500 focus:ring-sky-500"
            />
            <span>I have verified the contract ID and parameters match my intent</span>
          </label>
        )}

        {/* Actions */}
        <div className="flex gap-3">
          <button
            type="button"
            onClick={handleCancel}
            className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-xs font-semibold text-zinc-300 hover:bg-zinc-800 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={hasGate13Risk || !acknowledged}
            onClick={handleApprove}
            className="flex-1 rounded-lg bg-sky-600 px-4 py-2 text-xs font-semibold text-white hover:bg-sky-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-sky-900/30"
          >
            Verify & Send to Device
          </button>
        </div>
      </div>
    </div>
  )
}
