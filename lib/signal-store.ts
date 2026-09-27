import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { nanoid } from "nanoid"
import { serverDataJsonPath } from "@/lib/server-data-paths"

export type Signal = {
  id: string
  author_wallet: string
  author_display: string
  channel: "general" | "showcase" | string
  title: string
  body: string
  nft_token_id?: number
  nft_collection_id?: number
  nft_name?: string
  nft_image?: string
  upvotes: string[]
  /** Bumped on every mutation. Clients send it back as If-Match for CAS. */
  version: number
  created_at: number
  signature: string
}

export type SignalReply = {
  id: string
  signal_id: string
  author_wallet: string
  author_display: string
  body: string
  upvotes: string[]
  created_at: number
  signature: string
}

/** Thrown when a caller's expected_version is behind the stored version. */
export class VersionConflictError extends Error {
  readonly currentVersion: number

  constructor(currentVersion: number) {
    super("Signal version conflict")
    this.name = "VersionConflictError"
    this.currentVersion = currentVersion
  }
}

export function signalETag(version: number): string {
  return `"${version}"`
}

/** Parses an If-Match / ETag value. Returns null when present but malformed. */
export function parseVersionHeader(raw: string): number | null {
  const trimmed = raw.trim()
  const unquoted =
    trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
      ? trimmed.slice(1, -1)
      : trimmed
  const parsed = Number(unquoted)
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : null
}

type SignalsStore = Record<string, Signal>
type SignalRepliesStore = Record<string, SignalReply>

/**
 * Serializes read-modify-write cycles per file within this process, so two
 * concurrent mutations can never both read the same snapshot and clobber each
 * other. Does not span processes — see docs/TECHNICAL.md for the residual
 * cross-instance limitation.
 */
const fileQueues = new Map<string, Promise<unknown>>()

function withFileLock<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const previous = fileQueues.get(filePath) ?? Promise.resolve()
  const next = previous.then(task, task)
  fileQueues.set(
    filePath,
    next.then(
      () => undefined,
      () => undefined,
    ),
  )
  return next
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === code
  )
}

async function readJsonStore<T extends object>(filePath: string): Promise<T> {
  let raw: string
  try {
    raw = await readFile(filePath, "utf8")
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return {} as T
    throw error
  }
  try {
    return JSON.parse(raw) as T
  } catch (error) {
    // Never degrade a parse failure to {}: the next write would overwrite
    // every existing record. Fail loudly instead.
    throw new Error(`Corrupt JSON store at ${filePath}: ${String(error)}`)
  }
}

/** Write to a sibling temp file then rename, so readers never see a torn file. */
async function writeJsonStore<T extends object>(filePath: string, data: T): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.${nanoid(8)}.tmp`
  try {
    await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf8")
    await rename(tmpPath, filePath)
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined)
    throw error
  }
}

async function mutateJsonStore<T extends object, R>(
  filePath: string,
  mutate: (store: T) => Promise<R> | R,
): Promise<R> {
  return withFileLock(filePath, async () => {
    const store = await readJsonStore<T>(filePath)
    const result = await mutate(store)
    await writeJsonStore(filePath, store)
    return result
  })
}

function normalizeSignal(signal: Signal): Signal {
  return {
    ...signal,
    upvotes: Array.isArray(signal.upvotes) ? signal.upvotes : [],
    version: Number.isInteger(signal.version) ? signal.version : 1,
  }
}

function normalizeReply(reply: SignalReply): SignalReply {
  return { ...reply, upvotes: Array.isArray(reply.upvotes) ? reply.upvotes : [] }
}

/** hot = upvotes + recency weighted (upvotes * 3 + created_at/1000) */
function hotScore(s: Signal): number {
  return s.upvotes.length * 3 + s.created_at / 1000
}

export async function getSignals(
  channel?: string,
  sort: "hot" | "new" | "top" = "hot",
): Promise<Signal[]> {
  const store = await readJsonStore<SignalsStore>(serverDataJsonPath("signals"))
  let items = Object.values(store).map(normalizeSignal)
  if (channel && channel !== "all") {
    items = items.filter((s) => s.channel === channel)
  }
  if (sort === "new") {
    items.sort((a, b) => b.created_at - a.created_at)
  } else if (sort === "top") {
    items.sort((a, b) => b.upvotes.length - a.upvotes.length)
  } else {
    items.sort((a, b) => hotScore(b) - hotScore(a))
  }
  return items
}

export async function getSignal(id: string): Promise<Signal | null> {
  const store = await readJsonStore<SignalsStore>(serverDataJsonPath("signals"))
  const signal = store[id]
  return signal ? normalizeSignal(signal) : null
}

export async function createSignal(
  data: Omit<Signal, "id" | "created_at" | "version">,
): Promise<Signal> {
  const filePath = serverDataJsonPath("signals")
  const signal: Signal = {
    ...data,
    id: nanoid(10),
    version: 1,
    created_at: Date.now(),
  }
  return mutateJsonStore<SignalsStore, Signal>(filePath, (store) => {
    store[signal.id] = signal
    return signal
  })
}

/**
 * Toggle a wallet's upvote. Pass `expectedVersion` to make the toggle a
 * compare-and-swap: a stale version throws VersionConflictError instead of
 * silently discarding a concurrent writer's change.
 */
export async function upvoteSignal(
  id: string,
  wallet: string,
  expectedVersion?: number,
): Promise<Signal> {
  const filePath = serverDataJsonPath("signals")
  return mutateJsonStore<SignalsStore, Signal>(filePath, (store) => {
    const current = store[id]
    if (!current) throw new Error("Signal not found")
    const signal = normalizeSignal(current)
    if (expectedVersion !== undefined && signal.version !== expectedVersion) {
      throw new VersionConflictError(signal.version)
    }
    const idx = signal.upvotes.indexOf(wallet)
    if (idx === -1) {
      signal.upvotes.push(wallet)
    } else {
      signal.upvotes.splice(idx, 1)
    }
    signal.version += 1
    store[id] = signal
    return signal
  })
}

export async function getReplies(signal_id: string): Promise<SignalReply[]> {
  const store = await readJsonStore<SignalRepliesStore>(serverDataJsonPath("signalReplies"))
  return Object.values(store)
    .filter((r) => r.signal_id === signal_id)
    .map(normalizeReply)
    .sort((a, b) => a.created_at - b.created_at)
}

/**
 * Append a reply. Pass `parentVersion` to reject a reply composed against a
 * stale view of the parent signal.
 */
export async function createReply(
  data: Omit<SignalReply, "id" | "created_at">,
  parentVersion?: number,
): Promise<SignalReply> {
  const signalsStore = await readJsonStore<SignalsStore>(serverDataJsonPath("signals"))
  const parent = signalsStore[data.signal_id]
  if (!parent) throw new Error("Signal not found")
  const currentVersion = normalizeSignal(parent).version
  if (parentVersion !== undefined && currentVersion !== parentVersion) {
    throw new VersionConflictError(currentVersion)
  }

  const filePath = serverDataJsonPath("signalReplies")
  const reply: SignalReply = { ...data, id: nanoid(10), created_at: Date.now() }
  return mutateJsonStore<SignalRepliesStore, SignalReply>(filePath, (store) => {
    store[reply.id] = reply
    return reply
  })
}

export async function getSignalChannelStats(
  worldNames: Record<string, string>,
): Promise<Array<{ id: string; label: string; count: number }>> {
  const store = await readJsonStore<SignalsStore>(serverDataJsonPath("signals"))
  const counts: Record<string, number> = {}
  for (const s of Object.values(store)) {
    counts[s.channel] = (counts[s.channel] ?? 0) + 1
  }
  const total = Object.values(store).length

  const channels: Array<{ id: string; label: string; count: number }> = [
    { id: "all", label: "All signals", count: total },
    { id: "showcase", label: "NFT showcase", count: counts["showcase"] ?? 0 },
    { id: "general", label: "General", count: counts["general"] ?? 0 },
  ]
  for (const [id, label] of Object.entries(worldNames)) {
    channels.push({ id, label, count: counts[id] ?? 0 })
  }
  return channels
}
