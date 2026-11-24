"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { SignalLoreSnapshot, SignalLoreUpdate } from "@/lib/signal-crdt"
import { recordSignalCrdtDivergence } from "@/lib/signal-version-metrics"

/**
 * Issue #207 (phase-141): `useSignalCRDT` — the client half of collaborative
 * lore drafting for a signal.
 *
 * Each tab holds a real `Y.Doc` replica. A keystroke becomes a minimal `Y.Text`
 * insert/delete, is pushed to the server on a debounce, and the server's reply
 * (a diff against this replica's own state vector, not the whole document) is
 * folded back in. Peers are picked up by a short poll, standing in for the
 * `y-websocket` provider the issue originally proposed: a serverless function
 * cannot hold a socket open. The measurements behind that trade-off are in
 * `docs/spikes/207-signal-crdt-benchmark.md`.
 *
 * The Yjs-dependent module is loaded with `await import()` *after* the flag
 * check, so a project with phase-141 off never downloads Yjs at all.
 */

const FLAG_ENV = "NEXT_PUBLIC_FEATURE_PHASE_141"
const PUSH_DEBOUNCE_MS = 400
const POLL_INTERVAL_MS = 3_000

export type SignalCrdtStatus = "disabled" | "connecting" | "synced" | "offline" | "error"

export type SignalCrdtCommitResult =
  | { ok: true; version: number }
  | { ok: false; status: number; error: string; currentVersion?: number }

export type UseSignalCRDT = {
  enabled: boolean
  /** The draft is editable only with a connected wallet, since every update is attributed to one. */
  canEdit: boolean
  status: SignalCrdtStatus
  title: string
  body: string
  /** Wallets that have contributed to the draft, oldest contribution first. */
  contributors: Array<{ wallet: string; updates: number }>
  /** Local edits not yet acknowledged by the server. */
  pending: number
  error: string | null
  setTitle: (next: string) => void
  setBody: (next: string) => void
  refresh: () => Promise<void>
  /**
   * Promotes the draft to a committed revision through `PUT /api/signals/[id]`.
   * Still an `If-Match`-guarded, author-only, revertible write — the CRDT only
   * ever *proposes* lore, it never writes the signal row.
   */
  commit: () => Promise<SignalCrdtCommitResult>
}

type DraftResponse = {
  snapshot?: SignalLoreSnapshot
  update?: string
  stateVector?: string
  contributors?: Array<{ wallet: string; updates: number }>
  version?: number
  error?: string
  current_version?: number
}

function isFlagOn(): boolean {
  const v = (
    typeof process !== "undefined" ? (process.env as Record<string, string | undefined>)[FLAG_ENV] : undefined
  )
    ?.trim()
    .toLowerCase()
  return v === "1" || v === "true" || v === "yes" || v === "on"
}

export function useSignalCRDT(
  signalId: string,
  opts: { initialVersion: number; wallet: string | null },
): UseSignalCRDT {
  const enabled = isFlagOn()
  const { initialVersion, wallet } = opts

  const [status, setStatus] = useState<SignalCrdtStatus>(enabled ? "connecting" : "disabled")
  const [snapshot, setSnapshot] = useState<SignalLoreSnapshot>({ title: "", body: "" })
  const [contributors, setContributors] = useState<Array<{ wallet: string; updates: number }>>([])
  const [pending, setPending] = useState(0)
  const [error, setError] = useState<string | null>(null)

  // The Yjs module is resolved once per mount; every helper below is reached
  // through it, so nothing in this file needs a static yjs import.
  const crdtRef = useRef<typeof import("@/lib/signal-crdt") | null>(null)
  const docRef = useRef<import("yjs").Doc | null>(null)
  const stateVectorRef = useRef<string | null>(null)
  const versionRef = useRef(initialVersion)
  const queueRef = useRef<Array<{ update: SignalLoreUpdate }>>([])
  const pushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const bootRef = useRef<string | null>(null)

  const applyDraft = useCallback((data: DraftResponse) => {
    const crdt = crdtRef.current
    const doc = docRef.current
    if (!crdt || !doc || !data.update) return
    crdt.applySignalLoreUpdate(doc, data.update)
    if (data.stateVector) stateVectorRef.current = data.stateVector
    if (data.contributors) setContributors(data.contributors)
    if (typeof data.version === "number") versionRef.current = data.version

    const rendered = crdt.readSignalLore(doc)
    // The reply is a diff against our own state vector, so applying it must land
    // us exactly on the server's rendered draft. Anything else means an
    // operation was dropped in the round trip, which is worth recording.
    if (data.snapshot && (rendered.title !== data.snapshot.title || rendered.body !== data.snapshot.body)) {
      recordSignalCrdtDivergence()
    }
    setSnapshot(rendered)
  }, [])

  const sync = useCallback(
    async (bootstrap: boolean) => {
      const stateVector = bootstrap ? null : stateVectorRef.current
      const query = stateVector ? `?state_vector=${encodeURIComponent(stateVector)}` : ""
      try {
        const res = await fetch(`/api/signals/${signalId}/crdt${query}`, { cache: "no-store" })
        const data = (await res.json().catch(() => ({}))) as DraftResponse
        if (!res.ok) {
          setStatus(res.status === 404 ? "disabled" : "error")
          setError(data.error ?? "Sync failed")
          return
        }
        applyDraft(data)
        setStatus("synced")
        setError(null)
      } catch {
        setStatus("offline")
      }
    },
    [signalId, applyDraft],
  )

  const flush = useCallback(async () => {
    const crdt = crdtRef.current
    if (!crdt || queueRef.current.length === 0) return
    const queued = queueRef.current
    queueRef.current = []
    setPending(0)

    for (const item of queued) {
      try {
        const res = await fetch(`/api/signals/${signalId}/crdt`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            update: item.update,
            wallet,
            state_vector: stateVectorRef.current,
          }),
        })
        const data = (await res.json().catch(() => ({}))) as DraftResponse
        if (!res.ok) {
          // Requeue rather than drop: Yjs updates are idempotent, so resending
          // is safe, whereas discarding would lose the keystroke.
          queueRef.current.unshift(item)
          setPending(queueRef.current.length)
          setStatus("offline")
          setError(data.error ?? "Push failed")
          return
        }
        applyDraft(data)
        setStatus("synced")
        setError(null)
      } catch {
        queueRef.current.unshift(item)
        setPending(queueRef.current.length)
        setStatus("offline")
        return
      }
    }
  }, [signalId, wallet, applyDraft])

  useEffect(() => {
    if (!enabled || bootRef.current === signalId) return
    bootRef.current = signalId
    let cancelled = false

    void (async () => {
      const crdt = await import("@/lib/signal-crdt")
      if (cancelled) return
      crdtRef.current = crdt
      docRef.current = crdt.createSignalLoreDoc()
      await sync(true)
      if (cancelled) return
      pollTimerRef.current = setInterval(() => {
        if (typeof document !== "undefined" && document.visibilityState === "visible") void sync(false)
      }, POLL_INTERVAL_MS)
    })()

    return () => {
      cancelled = true
      if (pushTimerRef.current) clearTimeout(pushTimerRef.current)
      if (pollTimerRef.current) clearInterval(pollTimerRef.current)
      docRef.current?.destroy()
      docRef.current = null
      crdtRef.current = null
      bootRef.current = null
    }
  }, [enabled, signalId, sync])

  const edit = useCallback(
    (field: "title" | "body", next: string) => {
      const crdt = crdtRef.current
      const doc = docRef.current
      if (!crdt || !doc) return
      const update = crdt.captureSignalLoreEdit(doc, field, next)
      setSnapshot(crdt.readSignalLore(doc))
      if (!update) return
      queueRef.current.push({ update })
      setPending(queueRef.current.length)
      if (pushTimerRef.current) clearTimeout(pushTimerRef.current)
      pushTimerRef.current = setTimeout(() => void flush(), PUSH_DEBOUNCE_MS)
    },
    [flush],
  )

  const commit = useCallback(async (): Promise<SignalCrdtCommitResult> => {
    const crdt = crdtRef.current
    const doc = docRef.current
    if (!crdt || !doc) return { ok: false, status: 0, error: "Draft not ready" }
    if (!wallet) return { ok: false, status: 401, error: "Connect a wallet to commit" }
    // Never commit a revision the server has not seen all of.
    if (queueRef.current.length > 0) await flush()
    const rendered = crdt.readSignalLore(doc)
    try {
      const res = await fetch(`/api/signals/${signalId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "If-Match": String(versionRef.current) },
        // `from_draft` tells the server this PUT is committing a merged CRDT
        // draft, so it counts the commit and clears the scratch state.
        body: JSON.stringify({
          wallet,
          title: rendered.title,
          body: rendered.body,
          from_draft: true,
        }),
      })
      const data = (await res.json().catch(() => ({}))) as {
        signal?: { version: number }
        error?: string
        current_version?: number
      }
      if (res.status === 409) {
        if (typeof data.current_version === "number") versionRef.current = data.current_version
        return {
          ok: false,
          status: 409,
          error: "Signal changed since this draft was started",
          currentVersion: data.current_version,
        }
      }
      if (!res.ok || !data.signal) return { ok: false, status: res.status, error: data.error ?? "Commit failed" }
      versionRef.current = data.signal.version
      return { ok: true, version: data.signal.version }
    } catch {
      return { ok: false, status: 0, error: "Commit failed" }
    }
  }, [signalId, wallet, flush])

  const noop = useCallback(() => {}, [])
  // The server rejects an update without a wallet, so gate the setters on
  // canEdit rather than on the flag — otherwise a reader could type into the
  // draft and watch every keystroke fail with a 400.
  const canEdit = enabled && Boolean(wallet)

  return {
    enabled,
    canEdit,
    status,
    title: snapshot.title,
    body: snapshot.body,
    contributors,
    pending,
    error,
    setTitle: canEdit ? (next: string) => edit("title", next) : noop,
    setBody: canEdit ? (next: string) => edit("body", next) : noop,
    refresh: useCallback(() => sync(false), [sync]),
    commit,
  }
}
