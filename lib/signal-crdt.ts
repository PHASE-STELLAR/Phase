/**
 * Issue #207 (phase-141): CRDT-collaborative lore drafting for signals.
 *
 * This module is the *client-safe* half of the collaborative layer: it only
 * imports `yjs`, never `node:sqlite`, so the browser bundle and the server
 * routes can share one definition of the document. Persistence lives in
 * `lib/signal-crdt-store.ts`.
 *
 * ## Why a CRDT at all, and why it is not the signal row
 *
 * A signal's committed lore is a versioned, audited record. Every accepted edit
 * snapshots the previous title/body into `signal_versions` so it stays
 * revertible, which is exactly what a last-writer-wins JSON store cannot
 * provide. Folding concurrent edits straight into `signals.title` /
 * `signals.body` would give up that audit trail.
 *
 * So the CRDT owns a *draft*: a Yjs document that any number of co-authors
 * converge on, and which is only promoted to a committed revision through the
 * existing compare-and-swap path (`PUT /api/signals/[id]`, `If-Match`
 * required). Merging is therefore never destructive — the merge target is
 * draft state, and history stays append-only.
 *
 * ## Document shape
 *
 *     root (Y.Doc)
 *      └─ "lore" (Y.Map)
 *          ├─ "title" (Y.Text)
 *          └─ "body"  (Y.Text)
 *
 * Both fields are `Y.Text` rather than plain strings on purpose. A `Y.Map` set
 * is last-writer-wins per key: two co-authors saving a whole title each would
 * still lose one of them. `Y.Text` splits edits into character-level insert and
 * delete operations, which are commutative, so concurrent edits interleave
 * instead of overwriting.
 *
 * ## Transport
 *
 * The issue asked for `yjs` over WebSocket. This repo deploys to Vercel
 * serverless (`vercel.json`), which cannot hold a long-lived WebSocket, so the
 * same Yjs sync protocol is spoken over plain HTTP: `GET` returns a state
 * vector plus the operations a caller is missing, `POST` submits an update and
 * returns the merged result. See `docs/spikes/207-signal-crdt-benchmark.md` for
 * the measurement behind that call.
 */
import * as Y from "yjs"

/** Root map name inside the Y.Doc. */
export const SIGNAL_LORE_ROOT = "lore"
export const SIGNAL_LORE_FIELDS = ["title", "body"] as const
export type SignalLoreField = (typeof SIGNAL_LORE_FIELDS)[number]
export type SignalLoreSnapshot = { title: string; body: string }

export const EMPTY_LORE: SignalLoreSnapshot = { title: "", body: "" }

/** A Yjs update as it crosses the wire: base64, so JSON payloads stay text. */
export type SignalLoreUpdate = string

export function createSignalLoreDoc(): Y.Doc {
  const doc = new Y.Doc()
  doc.getMap<Y.Text>(SIGNAL_LORE_ROOT)
  return doc
}

/** The `lore` root map, created on first access. */
export function signalLoreRoot(doc: Y.Doc): Y.Map<Y.Text> {
  return doc.getMap<Y.Text>(SIGNAL_LORE_ROOT)
}

function signalLoreText(doc: Y.Doc, field: SignalLoreField): Y.Text {
  const root = signalLoreRoot(doc)
  let text = root.get(field)
  if (!text) {
    text = new Y.Text()
    root.set(field, text)
  }
  return text
}

export function readSignalLore(doc: Y.Doc): SignalLoreSnapshot {
  const root = signalLoreRoot(doc)
  return {
    title: root.get("title")?.toString() ?? "",
    body: root.get("body")?.toString() ?? "",
  }
}

/**
 * Seeds a document's text for a field when it is still empty. Refuses to touch
 * a field that already has content, so seeding a replica that has already
 * received a peer's edits can never clobber them.
 *
 * @returns true when the seed was applied.
 */
export function seedSignalLoreField(
  doc: Y.Doc,
  field: SignalLoreField,
  value: string,
): boolean {
  const text = signalLoreText(doc, field)
  if (text.length > 0) return false
  if (value.length > 0) text.insert(0, value)
  return true
}

export function seedSignalLore(doc: Y.Doc, snapshot: Partial<SignalLoreSnapshot>): void {
  for (const field of SIGNAL_LORE_FIELDS) {
    const value = snapshot[field]
    if (typeof value === "string") seedSignalLoreField(doc, field, value)
  }
}

/**
 * Applies a textarea edit as the *minimal* change to the underlying `Y.Text`
 * rather than replacing the whole value.
 *
 * This is the reason the draft survives concurrent editing. If two co-authors
 * each typed into their own stale copy of the body and both then called
 * `ytext.delete(0, ytext.length); ytext.insert(0, next)`, the second delete
 * would cancel the first author's inserted characters and the merge would be a
 * coin flip. Instead this diffs the common prefix and suffix and touches only
 * the span in between, so two appends become two independent inserts that both
 * survive the merge.
 *
 * @returns true when the document changed.
 */
export function editSignalLoreField(
  doc: Y.Doc,
  field: SignalLoreField,
  next: string,
): boolean {
  const text = signalLoreText(doc, field)
  const current = text.toString()
  if (current === next) return false

  const maxPrefix = Math.min(current.length, next.length)
  let prefix = 0
  while (prefix < maxPrefix && current[prefix] === next[prefix]) prefix++

  // Cap the suffix so the two spans can never overlap.
  const maxSuffix = Math.min(current.length - prefix, next.length - prefix)
  let suffix = 0
  while (
    suffix < maxSuffix &&
    current[current.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix++
  }

  const removeFrom = prefix
  const removeTo = current.length - suffix
  if (removeTo > removeFrom) text.delete(removeFrom, removeTo - removeFrom)
  const insertFrom = prefix
  const insertTo = next.length - suffix
  if (insertTo > insertFrom) text.insert(insertFrom, next.slice(insertFrom, insertTo))
  return true
}

// ── Encoding ───────────────────────────────────────────────────────────────
// Base64 so the payload stays JSON-safe and survives `Headers`/logging. Both
// `btoa`/`atob` (browser and Node ≥16) are used directly; the chunked spread
// keeps long documents from blowing the argument limit.

const CHUNK = 0x8000

export function encodeSignalLoreBytes(bytes: Uint8Array): SignalLoreUpdate {
  let binary = ""
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

export function decodeSignalLoreBytes(value: SignalLoreUpdate): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function encodeSignalLoreUpdate(update: Uint8Array): SignalLoreUpdate {
  return encodeSignalLoreBytes(update)
}

export function decodeSignalLoreUpdate(value: SignalLoreUpdate): Uint8Array {
  return decodeSignalLoreBytes(value)
}

/** Full document state as a single update — the bootstrap a new replica loads. */
export function encodeSignalLoreDoc(doc: Y.Doc): SignalLoreUpdate {
  return encodeSignalLoreBytes(Y.encodeStateAsUpdate(doc))
}

/** The doc's state vector: a compact "which operations do I already have" digest. */
export function encodeSignalLoreStateVector(doc: Y.Doc): SignalLoreUpdate {
  return encodeSignalLoreBytes(Y.encodeStateVector(doc))
}

export function applySignalLoreUpdateBytes(doc: Y.Doc, update: Uint8Array): void {
  Y.applyUpdate(doc, update)
}

export function applySignalLoreUpdate(doc: Y.Doc, update: SignalLoreUpdate): void {
  Y.applyUpdate(doc, decodeSignalLoreUpdate(update))
}

export function encodeSignalLoreUpdates(updates: Uint8Array[]): SignalLoreUpdate {
  return encodeSignalLoreBytes(Y.mergeUpdates(updates))
}

/** Collapses many updates into one. Merge is commutative, so order is irrelevant. */
export function mergeSignalLoreUpdates(updates: SignalLoreUpdate[]): SignalLoreUpdate {
  return encodeSignalLoreUpdates(updates.map(decodeSignalLoreUpdate))
}

/**
 * Applies a textarea edit and returns the Yjs update it produced, or `null` when
 * the document was unchanged.
 *
 * The update is captured by diffing the state vector from before the edit against
 * the state after it, rather than by subscribing to `doc.on("update")`. That
 * means callers never need a reference to the `yjs` namespace, so the editor can
 * `await import()` this module and keep Yjs out of the initial page bundle when
 * phase-141 is off.
 */
export function captureSignalLoreEdit(
  doc: Y.Doc,
  field: SignalLoreField,
  next: string,
): SignalLoreUpdate | null {
  const before = Y.encodeStateVector(doc);
  if (!editSignalLoreField(doc, field, next)) return null;
  return encodeSignalLoreBytes(Y.encodeStateAsUpdate(doc, before));
}

// ── Convergence ────────────────────────────────────────────────────────────

/**
 * True when `doc` already holds every operation in `update` — i.e. applying
 * `update` to `doc` would teach it nothing.
 *
 * The update is applied to a *clone of `doc`* rather than to an empty document,
 * which matters: a Yjs update is only meaningful relative to the operations
 * that precede it, and applying a delta to a document that lacks that base
 * silently drops the insert instead of reporting the gap. Cloning keeps the
 * check honest for both full-state updates and bare deltas.
 */
export function signalLoreIsUpToDate(doc: Y.Doc, update: Uint8Array): boolean {
  const probe = new Y.Doc();
  Y.applyUpdate(probe, Y.encodeStateAsUpdate(doc));
  const before = Y.decodeStateVector(Y.encodeStateVector(doc));
  Y.applyUpdate(probe, update);
  const after = Y.decodeStateVector(Y.encodeStateVector(probe));
  for (const [client, clock] of after) {
    if ((before.get(client) ?? 0) < clock) return false;
  }
  return true;
}

/**
 * Exchanges everything both ways and reports whether the two replicas ended up
 * with identical rendered lore. Used by the concurrency tests as the definition
 * of "no lost writes".
 *
 * The two sides apply the pair in *opposite* orders on purpose. Yjs merges are
 * commutative, so a correct implementation converges either way; a
 * last-writer-wins layer would order the two updates by arrival and produce
 * different text on each side, which is exactly the bug the issue reports.
 */
export function signalLoreConverges(left: Y.Doc, right: Y.Doc): boolean {
  const forward = new Y.Doc();
  Y.applyUpdate(forward, Y.encodeStateAsUpdate(left));
  Y.applyUpdate(forward, Y.encodeStateAsUpdate(right));

  const reversed = new Y.Doc();
  Y.applyUpdate(reversed, Y.encodeStateAsUpdate(right));
  Y.applyUpdate(reversed, Y.encodeStateAsUpdate(left));

  const a = readSignalLore(forward);
  const b = readSignalLore(reversed);
  return a.title === b.title && a.body === b.body;
}
