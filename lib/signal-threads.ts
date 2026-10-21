/**
 * phase-81: Nested reply threads to signals with depth limiting
 * Isolated module for threaded signal discussions with configurable depth
 * Flag: NEXT_PUBLIC_FEATURE_PHASE_81 / FEATURE_PHASE_81
 * Rollback: unset flag to disable threading, flat discussion mode
 */

import { z } from "zod"

// ── Feature flag ───────────────────────────────────────────────────────────

export function isPhase81Enabled(): boolean {
  const v = (process.env.NEXT_PUBLIC_FEATURE_PHASE_81 ?? process.env.FEATURE_PHASE_81 ?? "").trim().toLowerCase()
  return v === "1" || v === "true" || v === "yes" || v === "on"
}

export function flag81RollbackNote(): string {
  return "Rollback phase-81: unset NEXT_PUBLIC_FEATURE_PHASE_81 / FEATURE_PHASE_81 or set to 0/false. Signals return to flat discussion mode."
}

// ── Configuration ──────────────────────────────────────────────────────────

export const DEFAULT_MAX_THREAD_DEPTH = 5
export const DEFAULT_PAGE_SIZE = 20
export const MAX_THREAD_DEPTH_LIMIT = 10

// ── Type definitions ───────────────────────────────────────────────────────

export const SignalThreadSchema = z.object({
  id: z.string().min(1).max(128),
  parentId: z.string().min(1).max(128).nullable(),
  signalId: z.string().min(1).max(128),
  author: z.string().length(56).regex(/^G[A-Z2-7]{55}$/),
  content: z.string().min(1).max(5000),
  depth: z.number().int().min(0).max(MAX_THREAD_DEPTH_LIMIT),
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive().nullable(),
  replyCount: z.number().int().min(0),
  isDeleted: z.boolean(),
})

export type SignalThread = z.infer<typeof SignalThreadSchema>

export const CreateThreadReplySchema = z.object({
  parentId: z.string().min(1).max(128),
  signalId: z.string().min(1).max(128),
  author: z.string().length(56).regex(/^G[A-Z2-7]{55}$/),
  content: z.string().min(1).max(5000),
})

export type CreateThreadReply = z.infer<typeof CreateThreadReplySchema>

export const ThreadQueryOptionsSchema = z.object({
  signalId: z.string().min(1).max(128),
  parentId: z.string().min(1).max(128).nullable().optional(),
  depth: z.number().int().min(0).max(MAX_THREAD_DEPTH_LIMIT).optional(),
  page: z.number().int().min(0).default(0),
  pageSize: z.number().int().min(1).max(100).default(DEFAULT_PAGE_SIZE),
})

export type ThreadQueryOptions = z.infer<typeof ThreadQueryOptionsSchema>

// ── Error handling ─────────────────────────────────────────────────────────

export class SignalThreadError extends Error {
  code: "FLAG_DISABLED" | "MAX_DEPTH_EXCEEDED" | "PARENT_NOT_FOUND" | "VALIDATION_FAILED" | "SIGNAL_NOT_FOUND"
  details?: unknown

  constructor(code: SignalThreadError["code"], message: string, details?: unknown) {
    super(message)
    this.name = "SignalThreadError"
    this.code = code
    this.details = details
  }
}

// ── Thread operations ──────────────────────────────────────────────────────

/**
 * Calculate thread depth from parent thread
 * Prevents infinite nesting beyond configured maximum
 */
export function calculateThreadDepth(parentThread: SignalThread | null, maxDepth: number = DEFAULT_MAX_THREAD_DEPTH): number {
  if (!parentThread) return 0
  const newDepth = parentThread.depth + 1
  
  if (newDepth > maxDepth) {
    throw new SignalThreadError(
      "MAX_DEPTH_EXCEEDED",
      `Thread depth ${newDepth} exceeds maximum allowed depth of ${maxDepth}`
    )
  }
  
  return newDepth
}

/**
 * Validate thread reply creation
 * Checks feature flag, schema validation, and depth limits
 */
export function validateThreadReply(
  reply: CreateThreadReply,
  parentThread: SignalThread | null,
  maxDepth: number = DEFAULT_MAX_THREAD_DEPTH
): { valid: true; depth: number } | { valid: false; error: string; code: string } {
  if (!isPhase81Enabled()) {
    return {
      valid: false,
      error: "Threaded replies are disabled (phase-81 flag off)",
      code: "FLAG_DISABLED",
    }
  }

  const parsed = CreateThreadReplySchema.safeParse(reply)
  if (!parsed.success) {
    return {
      valid: false,
      error: parsed.error.message,
      code: "VALIDATION_FAILED",
    }
  }

  if (reply.parentId && !parentThread) {
    return {
      valid: false,
      error: `Parent thread ${reply.parentId} not found`,
      code: "PARENT_NOT_FOUND",
    }
  }

  try {
    const depth = calculateThreadDepth(parentThread, maxDepth)
    return { valid: true, depth }
  } catch (e) {
    if (e instanceof SignalThreadError) {
      return { valid: false, error: e.message, code: e.code }
    }
    return { valid: false, error: String(e), code: "VALIDATION_FAILED" }
  }
}

/**
 * Build thread tree structure from flat array
 * Groups replies by parent for hierarchical display
 */
export function buildThreadTree(
  threads: SignalThread[],
  parentId: string | null = null
): SignalThread[] {
  return threads
    .filter((t) => t.parentId === parentId && !t.isDeleted)
    .sort((a, b) => a.createdAt - b.createdAt)
}

/**
 * Get thread ancestry path (breadcrumb trail)
 * Returns array from root to current thread
 */
export function getThreadPath(
  threadId: string,
  allThreads: SignalThread[]
): SignalThread[] {
  const path: SignalThread[] = []
  let current = allThreads.find((t) => t.id === threadId)

  while (current) {
    path.unshift(current)
    if (!current.parentId) break
    current = allThreads.find((t) => t.id === current!.parentId)
  }

  return path
}

/**
 * Count total replies in thread (including nested)
 */
export function countThreadReplies(
  threadId: string,
  allThreads: SignalThread[]
): number {
  const direct = allThreads.filter((t) => t.parentId === threadId && !t.isDeleted)
  let count = direct.length

  for (const child of direct) {
    count += countThreadReplies(child.id, allThreads)
  }

  return count
}

/**
 * Flatten thread tree to array (depth-first traversal)
 */
export function flattenThreadTree(
  threads: SignalThread[],
  parentId: string | null = null,
  depth: number = 0
): Array<SignalThread & { _depth: number }> {
  const result: Array<SignalThread & { _depth: number }> = []
  const children = buildThreadTree(threads, parentId)

  for (const thread of children) {
    result.push({ ...thread, _depth: depth })
    result.push(...flattenThreadTree(threads, thread.id, depth + 1))
  }

  return result
}

/**
 * Get thread statistics for a signal
 */
export function getThreadStatistics(signalId: string, threads: SignalThread[]): {
  totalThreads: number
  maxDepth: number
  totalReplies: number
  uniqueAuthors: number
} {
  const signalThreads = threads.filter((t) => t.signalId === signalId && !t.isDeleted)
  const rootThreads = signalThreads.filter((t) => !t.parentId)
  
  const depths = signalThreads.map((t) => t.depth)
  const authors = new Set(signalThreads.map((t) => t.author))
  
  return {
    totalThreads: signalThreads.length,
    maxDepth: depths.length > 0 ? Math.max(...depths) : 0,
    totalReplies: signalThreads.filter((t) => t.parentId).length,
    uniqueAuthors: authors.size,
  }
}

/**
 * Paginate thread replies
 */
export function paginateThreads(
  threads: SignalThread[],
  page: number = 0,
  pageSize: number = DEFAULT_PAGE_SIZE
): {
  threads: SignalThread[]
  page: number
  pageSize: number
  totalPages: number
  total: number
} {
  const start = page * pageSize
  const end = start + pageSize
  const paginated = threads.slice(start, end)

  return {
    threads: paginated,
    page,
    pageSize,
    totalPages: Math.ceil(threads.length / pageSize),
    total: threads.length,
  }
}

// ── Export configuration ───────────────────────────────────────────────────

export const THREAD_CONFIG = {
  maxDepth: DEFAULT_MAX_THREAD_DEPTH,
  pageSize: DEFAULT_PAGE_SIZE,
  maxContentLength: 5000,
  flag: "phase-81",
} as const

/**
 * Audit thread wiring for diagnostics
 */
export function auditSignalThreadWiring(): { ok: boolean; note: string } {
  if (!isPhase81Enabled()) {
    return {
      ok: true,
      note: "[phase-81] Signal threading disabled; flat discussion mode. " + flag81RollbackNote(),
    }
  }

  try {
    const probe: SignalThread = {
      id: "test-1",
      parentId: null,
      signalId: "signal-1",
      author: "G" + "A".repeat(55),
      content: "Test thread",
      depth: 0,
      createdAt: Date.now(),
      updatedAt: null,
      replyCount: 0,
      isDeleted: false,
    }

    const parsed = SignalThreadSchema.safeParse(probe)
    if (!parsed.success) {
      return { ok: false, note: `[phase-81] Schema validation failed: ${parsed.error.message}` }
    }

    const depth = calculateThreadDepth(null)
    if (depth !== 0) {
      return { ok: false, note: "[phase-81] Depth calculation error for root thread" }
    }

    return {
      ok: true,
      note: `[phase-81] Signal threading OK (max depth: ${DEFAULT_MAX_THREAD_DEPTH}). ` + flag81RollbackNote(),
    }
  } catch (e) {
    return {
      ok: false,
      note: `[phase-81] Thread wiring error: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}
