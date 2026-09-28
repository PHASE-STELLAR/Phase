/**
 * Bulk-listing wizard with CSV import
 * Isolated module for batch listing operations on large collections
 * Eliminates manual one-by-one listing workflow
 */

import { z } from "zod"

// ── Configuration ──────────────────────────────────────────────────────────

export const MAX_BULK_LISTINGS = 1000
export const MAX_CSV_SIZE_BYTES = 5 * 1024 * 1024 // 5MB
export const BATCH_SIZE = 50 // Process in batches to avoid memory issues

// ── Type definitions ───────────────────────────────────────────────────────

export const BulkListingItemSchema = z.object({
  tokenId: z.number().int().positive().or(z.string().regex(/^\d+$/).transform(Number)),
  name: z.string().min(1).max(256),
  description: z.string().max(2000).optional(),
  price: z.string().regex(/^\d+$/), // stroops
  imageUri: z.string().url().optional(),
  collectionId: z.number().int().min(0).optional(),
  metadata: z.record(z.unknown()).optional(),
})

export type BulkListingItem = z.infer<typeof BulkListingItemSchema>

export const BulkListingBatchSchema = z.object({
  creator: z.string().length(56).regex(/^G[A-Z2-7]{55}$/),
  items: z.array(BulkListingItemSchema).min(1).max(MAX_BULK_LISTINGS),
  dryRun: z.boolean().default(false),
})

export type BulkListingBatch = z.infer<typeof BulkListingBatchSchema>

export const BulkListingResultSchema = z.object({
  success: z.boolean(),
  totalItems: z.number().int().min(0),
  successCount: z.number().int().min(0),
  failureCount: z.number().int().min(0),
  skippedCount: z.number().int().min(0),
  results: z.array(z.object({
    tokenId: z.number().int(),
    success: z.boolean(),
    error: z.string().nullable(),
    skipped: z.boolean().default(false),
  })),
  batchId: z.string(),
  createdAt: z.number().int().positive(),
})

export type BulkListingResult = z.infer<typeof BulkListingResultSchema>

// ── CSV parsing ────────────────────────────────────────────────────────────

export interface CSVParseResult {
  success: boolean
  data: BulkListingItem[]
  errors: Array<{ row: number; field: string; error: string }>
  warnings: Array<{ row: number; field: string; warning: string }>
}

/**
 * Expected CSV headers (case-insensitive)
 */
export const CSV_HEADERS = {
  tokenId: ["token_id", "tokenid", "id"],
  name: ["name", "title"],
  description: ["description", "desc"],
  price: ["price", "amount"],
  imageUri: ["image_uri", "imageuri", "image", "url"],
  collectionId: ["collection_id", "collectionid", "collection"],
} as const

/**
 * Parse CSV string to bulk listing items
 */
export function parseCSV(csvContent: string): CSVParseResult {
  const errors: CSVParseResult["errors"] = []
  const warnings: CSVParseResult["warnings"] = []
  const data: BulkListingItem[] = []

  // Basic validation
  if (!csvContent || csvContent.trim().length === 0) {
    return { success: false, data: [], errors: [{ row: 0, field: "csv", error: "CSV content is empty" }], warnings: [] }
  }

  if (csvContent.length > MAX_CSV_SIZE_BYTES) {
    return {
      success: false,
      data: [],
      errors: [{ row: 0, field: "csv", error: `CSV size exceeds maximum ${MAX_CSV_SIZE_BYTES} bytes` }],
      warnings: [],
    }
  }

  // Split into lines
  const lines = csvContent.split(/\r?\n/).filter((line) => line.trim().length > 0)
  
  if (lines.length < 2) {
    return { success: false, data: [], errors: [{ row: 0, field: "csv", error: "CSV must have header row and at least one data row" }], warnings: [] }
  }

  // Parse header
  const headerLine = lines[0]!.trim()
  const headers = headerLine.split(",").map((h) => h.trim().toLowerCase().replace(/['"]/g, ""))

  // Find column indices
  const findColumnIndex = (aliases: readonly string[]): number => {
    return headers.findIndex((h) => aliases.includes(h))
  }

  const tokenIdIdx = findColumnIndex(CSV_HEADERS.tokenId)
  const nameIdx = findColumnIndex(CSV_HEADERS.name)
  const descIdx = findColumnIndex(CSV_HEADERS.description)
  const priceIdx = findColumnIndex(CSV_HEADERS.price)
  const imageIdx = findColumnIndex(CSV_HEADERS.imageUri)
  const collectionIdx = findColumnIndex(CSV_HEADERS.collectionId)

  // Validate required columns
  if (tokenIdIdx === -1) {
    errors.push({ row: 0, field: "header", error: `Required column 'token_id' not found. Expected one of: ${CSV_HEADERS.tokenId.join(", ")}` })
  }
  if (nameIdx === -1) {
    errors.push({ row: 0, field: "header", error: `Required column 'name' not found. Expected one of: ${CSV_HEADERS.name.join(", ")}` })
  }
  if (priceIdx === -1) {
    errors.push({ row: 0, field: "header", error: `Required column 'price' not found. Expected one of: ${CSV_HEADERS.price.join(", ")}` })
  }

  if (errors.length > 0) {
    return { success: false, data: [], errors, warnings }
  }

  // Parse data rows
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (line.length === 0) continue

    const values = line.split(",").map((v) => v.trim().replace(/^["']|["']$/g, ""))
    const rowNum = i + 1

    try {
      const item: BulkListingItem = {
        tokenId: Number(values[tokenIdIdx] || "0"),
        name: values[nameIdx] || "",
        description: descIdx !== -1 ? values[descIdx] : undefined,
        price: values[priceIdx] || "0",
        imageUri: imageIdx !== -1 && values[imageIdx] ? values[imageIdx] : undefined,
        collectionId: collectionIdx !== -1 && values[collectionIdx] ? parseInt(values[collectionIdx]!, 10) : undefined,
      }

      // Validate item
      const parsed = BulkListingItemSchema.safeParse(item)
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          errors.push({ row: rowNum, field: issue.path.join("."), error: issue.message })
        }
      } else {
        data.push(parsed.data)

        // Add warnings for optional fields
        if (!item.imageUri) {
          warnings.push({ row: rowNum, field: "imageUri", warning: "Image URI not provided" })
        }
        if (!item.description) {
          warnings.push({ row: rowNum, field: "description", warning: "Description not provided" })
        }
      }
    } catch (e) {
      errors.push({ row: rowNum, field: "row", error: e instanceof Error ? e.message : String(e) })
    }

    if (data.length >= MAX_BULK_LISTINGS) {
      warnings.push({ row: rowNum, field: "csv", warning: `Maximum ${MAX_BULK_LISTINGS} listings reached. Remaining rows ignored.` })
      break
    }
  }

  return {
    success: errors.length === 0,
    data,
    errors,
    warnings,
  }
}

/**
 * Generate sample CSV template
 */
export function generateCSVTemplate(): string {
  const headers = ["token_id", "name", "description", "price", "image_uri", "collection_id"]
  const sample1 = ["1", "Phase Artifact #1", "Rare digital artifact", "10000000", "https://example.com/artifact1.png", "0"]
  const sample2 = ["2", "Phase Artifact #2", "Legendary collectible", "50000000", "https://example.com/artifact2.png", "0"]
  
  return [
    headers.join(","),
    sample1.join(","),
    sample2.join(","),
  ].join("\n")
}

// ── Batch processing ───────────────────────────────────────────────────────

/**
 * Split items into processing batches
 */
export function splitIntoBatches<T>(items: T[], batchSize: number = BATCH_SIZE): T[][] {
  const batches: T[][] = []
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize))
  }
  return batches
}

/**
 * Validate bulk listing batch
 */
export function validateBulkListingBatch(
  batch: BulkListingBatch
): { valid: true } | { valid: false; error: string; code: string } {
  const parsed = BulkListingBatchSchema.safeParse(batch)
  if (!parsed.success) {
    return {
      valid: false,
      error: parsed.error.message,
      code: "VALIDATION_FAILED",
    }
  }

  if (batch.items.length === 0) {
    return {
      valid: false,
      error: "Batch must contain at least one item",
      code: "EMPTY_BATCH",
    }
  }

  if (batch.items.length > MAX_BULK_LISTINGS) {
    return {
      valid: false,
      error: `Batch size ${batch.items.length} exceeds maximum ${MAX_BULK_LISTINGS}`,
      code: "BATCH_TOO_LARGE",
    }
  }

  // Check for duplicate token IDs within batch
  const tokenIds = new Set<number>()
  const duplicates: number[] = []

  for (const item of batch.items) {
    const id = typeof item.tokenId === "string" ? parseInt(item.tokenId, 10) : item.tokenId
    if (tokenIds.has(id)) {
      duplicates.push(id)
    }
    tokenIds.add(id)
  }

  if (duplicates.length > 0) {
    return {
      valid: false,
      error: `Duplicate token IDs found: ${duplicates.join(", ")}`,
      code: "DUPLICATE_TOKEN_IDS",
    }
  }

  return { valid: true }
}

/**
 * Estimate bulk listing cost
 */
export function estimateBulkListingCost(items: BulkListingItem[]): {
  totalItems: number
  estimatedFees: string
  estimatedTime: string
} {
  const totalItems = items.length
  // Rough estimate: 0.001 XLM per listing = 10000 stroops
  const feePerItem = BigInt(10000)
  const estimatedFees = (feePerItem * BigInt(totalItems)).toString()
  
  // Estimate: ~2 seconds per item
  const estimatedSeconds = totalItems * 2
  const minutes = Math.floor(estimatedSeconds / 60)
  const seconds = estimatedSeconds % 60
  const estimatedTime = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`

  return {
    totalItems,
    estimatedFees,
    estimatedTime,
  }
}

// ── Progress tracking ──────────────────────────────────────────────────────

export interface BulkListingProgress {
  batchId: string
  status: "pending" | "processing" | "completed" | "failed"
  totalItems: number
  processedItems: number
  successCount: number
  failureCount: number
  currentBatch: number
  totalBatches: number
  startedAt: number
  completedAt: number | null
  errors: Array<{ tokenId: number; error: string }>
}

/**
 * Calculate progress percentage
 */
export function calculateProgress(progress: BulkListingProgress): number {
  if (progress.totalItems === 0) return 0
  return Math.round((progress.processedItems / progress.totalItems) * 100)
}

// ── Export utilities ───────────────────────────────────────────────────────

/**
 * Export bulk listing results to CSV
 */
export function exportResultsToCSV(result: BulkListingResult): string {
  const headers = ["token_id", "status", "error"]
  const rows = result.results.map((r) => [
    r.tokenId.toString(),
    r.success ? "success" : r.skipped ? "skipped" : "failed",
    r.error || "",
  ])

  return [
    headers.join(","),
    ...rows.map((row) => row.map((cell) => `"${cell}"`).join(",")),
  ].join("\n")
}

// ── Export configuration ───────────────────────────────────────────────────

export const BULK_LISTING_CONFIG = {
  maxListings: MAX_BULK_LISTINGS,
  maxCSVSize: MAX_CSV_SIZE_BYTES,
  batchSize: BATCH_SIZE,
} as const

/**
 * Audit bulk listing wiring for diagnostics
 */
export function auditBulkListingWiring(): { ok: boolean; note: string } {
  try {
    const template = generateCSVTemplate()
    const parsed = parseCSV(template)

    if (!parsed.success || parsed.data.length !== 2) {
      return { ok: false, note: "[bulk-listing] CSV parsing failed for sample template" }
    }

    const batch: BulkListingBatch = {
      creator: "G" + "A".repeat(55),
      items: parsed.data,
      dryRun: true,
    }

    const validation = validateBulkListingBatch(batch)
    if (!validation.valid) {
      return { ok: false, note: `[bulk-listing] Batch validation failed: ${validation.error}` }
    }

    return {
      ok: true,
      note: `[bulk-listing] Bulk listing wizard OK (max ${MAX_BULK_LISTINGS} items, ${BATCH_SIZE} per batch)`,
    }
  } catch (e) {
    return {
      ok: false,
      note: `[bulk-listing] Bulk listing error: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}
