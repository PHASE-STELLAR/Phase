"use client"

import { useState } from "react"
import { useBiometricUnlock } from "@/hooks/useBiometricUnlock"
import { useLang } from "@/components/lang-context"
import { biometricCopy } from "@/lib/biometric-unlock"
import type { BiometricSessionPayload } from "@/lib/types/biometric-unlock"

/**
 * Wallet lock screen (spike 628 / issue #491).
 *
 * The tap-to-unlock middle state: when the phase-172 flag is on and a sealed
 * biometric envelope exists, the wallet layer holds auto-restore and renders
 * this overlay instead. Unlocking runs the OS biometric gate and restores the
 * cached session; "Reconnect wallet" clears the envelope and falls back to
 * the legacy full-reconnect flow. Renders nothing when no lock is required.
 */
export function WalletLockScreen({
  onUnlocked,
  onSkip,
}: {
  onUnlocked: (payload: BiometricSessionPayload) => void
  onSkip: () => void
}) {
  const { lang } = useLang()
  const { available, busy, error, lockedOutUntil, unlock } = useBiometricUnlock()
  const [skipping, setSkipping] = useState(false)
  const t = biometricCopy(lang)

  const handleUnlock = () => {
    void unlock()
      .then(onUnlocked)
      .catch(() => {
        // Error copy is rendered from hook state; nothing else to do.
      })
  }

  const handleSkip = () => {
    setSkipping(true)
    onSkip()
  }

  const lockedOut = lockedOutUntil != null && Date.now() < lockedOutUntil

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t.title}
      className="fixed inset-0 z-[500] flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
    >
      <div className="w-full max-w-sm rounded-md border border-violet-700/40 bg-violet-950/30 p-6 text-center shadow-2xl">
        <p className="text-3xl" aria-hidden>
          🔒
        </p>
        <h2 className="mt-3 font-mono text-sm font-bold uppercase tracking-widest text-violet-200">
          {t.title}
        </h2>
        <p className="mt-2 text-xs leading-relaxed text-foreground/80">
          {available === false ? t.unsupported : t.body}
        </p>

        {error && !lockedOut ? (
          <p className="mt-3 break-words font-mono text-[10px] leading-snug text-destructive">
            {error}
          </p>
        ) : null}
        {lockedOut ? (
          <p className="mt-3 font-mono text-[10px] leading-snug text-amber-400">{t.lockedOut}</p>
        ) : null}

        {available !== false ? (
          <button
            type="button"
            onClick={handleUnlock}
            disabled={busy || lockedOut || skipping}
            className="mt-4 w-full border-2 border-violet-500/60 bg-violet-500/15 px-3 py-2.5 font-mono text-[11px] font-bold uppercase tracking-widest text-violet-100 transition-colors hover:bg-violet-500/25 disabled:opacity-50"
          >
            {busy ? t.retry : t.unlock}
          </button>
        ) : null}

        <button
          type="button"
          onClick={handleSkip}
          disabled={skipping}
          className="mt-2 w-full px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
        >
          {t.skip}
        </button>
      </div>
    </div>
  )
}
