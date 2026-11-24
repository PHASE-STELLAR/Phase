import { NextRequest, NextResponse } from "next/server"
import {
  LoreVersionConflictError,
  LoreVersionNotFoundError,
  commitLoreEdit,
  diffLoreVersions,
  getLoreVersions,
  isLoreRollbackVersioningEnabled,
  isLoreVersioningEnabled,
  rollbackLoreVersion,
} from "@/lib/lore-versioning"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ token_id: string }> },
) {
  if (!isLoreVersioningEnabled()) {
    return NextResponse.json({ error: "lore versioning flag disabled" }, { status: 404 })
  }

  const { token_id } = await context.params
  const tokenId = Number(token_id)
  if (!Number.isInteger(tokenId) || tokenId <= 0) {
    return NextResponse.json({ error: "token_id inválido" }, { status: 400 })
  }

  const versions = await getLoreVersions(tokenId)
  const latest = versions[versions.length - 1]
  const currentVersion = latest?.version ?? 0
  const currentEtag = latest?.etag ?? '"v0"'

  const fromRaw = request.nextUrl.searchParams.get("from")
  const toRaw = request.nextUrl.searchParams.get("to")
  let diff = null
  if (fromRaw && toRaw) {
    diff = await diffLoreVersions(tokenId, Number(fromRaw), Number(toRaw))
  }

  return NextResponse.json(
    { versions, currentVersion, currentEtag, diff },
    { headers: { ETag: currentEtag, "Cache-Control": "no-store" } },
  )
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ token_id: string }> },
) {
  if (!isLoreRollbackVersioningEnabled()) {
    return NextResponse.json({ error: "phase-257 flag disabled" }, { status: 404 })
  }

  const { token_id } = await context.params
  const tokenId = Number(token_id)
  if (!Number.isInteger(tokenId) || tokenId <= 0) {
    return NextResponse.json({ error: "token_id inválido" }, { status: 400 })
  }

  let body: {
    action?: "commit" | "rollback"
    narrative?: string
    lore_input?: string
    target_version?: number
    author?: string
    author_proof?: string
    expected_version?: string | number
  }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 })
  }

  const ifMatch =
    request.headers.get("if-match") ??
    (body.expected_version !== undefined ? String(body.expected_version) : null)

  try {
    if (body.action === "rollback") {
      const targetVersion = Number(body.target_version)
      if (!Number.isInteger(targetVersion) || targetVersion <= 0) {
        return NextResponse.json({ error: "target_version must be a positive integer" }, { status: 400 })
      }
      const entry = await rollbackLoreVersion(tokenId, targetVersion, {
        author: body.author,
        author_proof: body.author_proof,
        ifMatch,
      })
      if (!entry) {
        return NextResponse.json({ error: "phase-257 flag disabled" }, { status: 404 })
      }
      return NextResponse.json(
        { entry, currentVersion: entry.version, currentEtag: entry.etag },
        { status: 201, headers: { ETag: entry.etag ?? `"v${entry.version}"` } },
      )
    }

    const narrative = typeof body.narrative === "string" ? body.narrative.trim() : ""
    const loreInput = typeof body.lore_input === "string" ? body.lore_input : ""
    if (!narrative) {
      return NextResponse.json({ error: "narrative is required" }, { status: 400 })
    }
    const res = await commitLoreEdit(
      tokenId,
      { narrative, lore_input: loreInput, author: body.author, author_proof: body.author_proof },
      { ifMatch },
    )
    if (res.legacyOverwrite) {
      return NextResponse.json({ error: "phase-257 flag disabled" }, { status: 404 })
    }
    return NextResponse.json(
      { entry: res.entry, currentVersion: res.entry.version, currentEtag: res.entry.etag },
      { status: 201, headers: { ETag: res.entry.etag ?? `"v${res.entry.version}"` } },
    )
  } catch (err) {
    if (err instanceof LoreVersionConflictError) {
      return NextResponse.json(
        {
          error: err.message,
          code: "VERSION_CONFLICT",
          currentVersion: err.currentVersion,
          currentEtag: err.currentEtag,
        },
        { status: 409, headers: { ETag: err.currentEtag } },
      )
    }
    if (err instanceof LoreVersionNotFoundError) {
      return NextResponse.json({ error: err.message, code: "VERSION_NOT_FOUND" }, { status: 404 })
    }
    return NextResponse.json({ error: "lore versioning error" }, { status: 500 })
  }
}
