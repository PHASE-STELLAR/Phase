"use client"

import { useCallback, useEffect, useState } from "react"
import {
  BiometricUnlockError,
  biometricLockState,
  isPlatformAuthenticatorAvailable,
  readLockMeta,
  unlockWithBiometric,
} from "@/lib/biometric-unlock"
import type { BiometricLockState, BiometricSessionPayload } from "@/lib/types/biometric-unlock"

/**
 * Client state wrapper around the biometric unlock flow (spike 628).
 * All crypto/storage logic lives in `lib/biometric-unlock.ts` (unit-tested);
 * this hook only manages React state and cooldown bookkeeping.
 */
export function useBiometricUnlock() {
  const [available, setAvailable] = useState<boolean | null>(null)
  const [state, setState] = useState<BiometricLockState>(() => biometricLockState())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lockedOutUntil, setLockedOutUntil] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    void isPlatformAuthenticatorAvailable().then((ok) => {
      if (!cancelled) setAvailable(ok)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const refreshState = useCallback(() => {
    const next = biometricLockState()
    setState(next)
    return next
  }, [])

  const unlock = useCallback(async (): Promise<BiometricSessionPayload> => {
    setBusy(true)
    setError(null)
    try {
      const payload = await unlockWithBiometric()
      setState("unlocked")
      return payload
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
      setState(biometricLockState())
      if (e instanceof BiometricUnlockError && e.code === "LOCKED_OUT") {
        setLockedOutUntil(readLockMeta().locked_until)
      }
      throw e
    } finally {
      setBusy(false)
    }
  }, [])

  return {
    available,
    state,
    busy,
    error,
    lockedOutUntil,
    refreshState,
    unlock,
  }
}
