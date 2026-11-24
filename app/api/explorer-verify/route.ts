import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { isFeatureEnabled } from "@/lib/feature-flags"
import {
  computeExplorerMetadataDigest,
  fetchExplorerMetadata,
  type ExplorerMetadataStatus,
} from "@/lib/explorer-metadata"

interface ExplorerVerifyResponse {
  collection_id: number
  name: string
  external_url: string
  verified: boolean
  stale: boolean
  status: ExplorerMetadataStatus
  digest?: string
  verified_at?: number
  stellar_expert_url?: string
  error?: string
}

const RegisterExplorerSchema = z.object({
  collection_id: z.number().int().positive(),
  name: z.string().min(1).max(256),
  external_url: z.string().url().max(1024),
})

/**
 * GET /api/explorer-verify?collection_id=...&digest=...
 * Get explorer metadata and verification status for a collection
 */
export async function GET(request: NextRequest) {
  if (!isFeatureEnabled("phase-250")) {
    return NextResponse.json(
      { error: "Explorer metadata verification disabled (phase-250 flag off)." },
      { status: 404 },
    )
  }

  try {
    const collection_id = request.nextUrl.searchParams.get("collection_id")
    if (!collection_id) {
      return NextResponse.json(
        { error: "Missing collection_id parameter" },
        { status: 400 },
      )
    }

    const collectionIdNum = Number.parseInt(collection_id, 10)
    if (!Number.isFinite(collectionIdNum) || collectionIdNum <= 0) {
      return NextResponse.json(
        { error: "Invalid collection_id" },
        { status: 400 },
      )
    }

    const committedDigest = request.nextUrl.searchParams.get("digest")?.trim() || undefined
    if (committedDigest && !/^[a-f0-9]{64}$/i.test(committedDigest)) {
      return NextResponse.json(
        { error: "Invalid digest format" },
        { status: 400 },
      )
    }

    const result = await fetchExplorerMetadata(collectionIdNum, committedDigest?.toLowerCase())

    const response: ExplorerVerifyResponse = {
      collection_id: collectionIdNum,
      name: result.metadata?.name ?? "Unknown Collection",
      external_url: result.metadata?.externalUrl ?? "",
      verified: result.showVerifiedBadge,
      stale: result.stale,
      status: result.status,
      digest: result.metadata?.digest,
      verified_at: result.showVerifiedBadge ? result.metadata?.fetchedAt : undefined,
      error: result.error,
    }

    return NextResponse.json(response, {
      headers: { "Cache-Control": "private, no-store" },
    })
  } catch (error) {
    return NextResponse.json(
      { error: "Explorer verification failed", details: String(error) },
      { status: 500 },
    )
  }
}

/**
 * POST /api/explorer-verify
 * Register collection metadata with explorer
 */
export async function POST(request: NextRequest) {
  if (!isFeatureEnabled("phase-250")) {
    return NextResponse.json(
      { error: "Explorer metadata verification disabled (phase-250 flag off)." },
      { status: 404 },
    )
  }

  try {
    const raw = await request.json()
    const parsed = RegisterExplorerSchema.safeParse(raw)
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Missing or invalid fields: collection_id, name, external_url" },
        { status: 400 },
      )
    }

    const digest = computeExplorerMetadataDigest({
      collectionId: parsed.data.collection_id,
      name: parsed.data.name,
      externalUrl: parsed.data.external_url,
    })

    const response: ExplorerVerifyResponse = {
      collection_id: parsed.data.collection_id,
      name: parsed.data.name,
      external_url: parsed.data.external_url,
      verified: false,
      stale: false,
      status: "unverified",
      digest,
    }

    return NextResponse.json(response, { status: 201 })
  } catch (error) {
    return NextResponse.json(
      { error: "Explorer registration failed", details: String(error) },
      { status: 500 },
    )
  }
}
