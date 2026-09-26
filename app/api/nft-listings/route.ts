import { randomUUID } from "crypto"
import { promises as fs } from "fs"
import path from "path"
import { NextRequest, NextResponse } from "next/server"
import { StrKey } from "@stellar/stellar-sdk"
import { serverDataJsonPath } from "@/lib/server-data-paths"

type Listing = {
  id: string
  seller: string
  collectionId: number
  tokenId: number
  priceStroops: string
  createdAt: string
  active: boolean
}

function dataPath() {
  return serverDataJsonPath("nftListings")
}

async function readListings(): Promise<Listing[]> {
  try {
    const raw = await fs.readFile(dataPath(), "utf8")
    const j = JSON.parse(raw) as { listings?: Listing[] }
    return Array.isArray(j.listings) ? j.listings : []
  } catch {
    return []
  }
}

async function writeListings(listings: Listing[]) {
  const p = dataPath()
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, JSON.stringify({ listings }, null, 2), "utf8")
}

function validG(addr: string) {
  const t = addr.trim()
  return t.length === 56 && t.startsWith("G") && StrKey.isValidEd25519PublicKey(t)
}

/** Listados públicos de venta (testnet / demo). El pago PHASELQ es P2P; la transferencia NFT es on-chain vía `transfer_phase_nft`. */
export async function GET(req: NextRequest) {
  const limit = Math.min(100, Math.max(1, Number(req.nextUrl.searchParams.get("limit") ?? 50) || 50))
  const cursor = Math.max(0, Number(req.nextUrl.searchParams.get("cursor") ?? 0) || 0)
  const active = (await readListings()).filter((l) => l.active)
  const listings = active.slice(cursor, cursor + limit)
  return NextResponse.json({ listings, nextCursor: cursor + listings.length < active.length ? cursor + listings.length : null })
}

export async function POST(req: NextRequest) {
  const contentType = req.headers.get("content-type")?.toLowerCase() ?? ""
  if (contentType.includes("application/x-ndjson")) {
    const raw = await req.text()
    if (raw.length > 20 * 1024 * 1024) return NextResponse.json({ ok: false, error: "NDJSON body too large" }, { status: 413 })
    const rows = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    if (rows.length === 0 || rows.length > 100_000) return NextResponse.json({ ok: false, error: "NDJSON must contain 1-100000 listings" }, { status: 400 })
    let parsed: Array<Partial<{ seller: string; collectionId: number; tokenId: number; priceStroops: string }>>
    try {
      parsed = rows.map((line) => JSON.parse(line))
    } catch {
      return NextResponse.json({ ok: false, error: "Invalid NDJSON" }, { status: 400 })
    }
    const all = await readListings()
    const created: Listing[] = []
    for (const item of parsed) {
      const seller = typeof item.seller === "string" ? item.seller.trim() : ""
      const collectionId = Number(item.collectionId)
      const tokenId = Number(item.tokenId)
      const priceStroops = String(item.priceStroops ?? "").trim() || "0"
      if (!validG(seller) || !Number.isInteger(collectionId) || collectionId < 0 || !Number.isInteger(tokenId) || tokenId < 1 || !/^\d+$/.test(priceStroops)) {
        return NextResponse.json({ ok: false, error: "Invalid listing in NDJSON batch" }, { status: 400 })
      }
      for (let i = all.length - 1; i >= 0; i--) if (all[i]!.active && all[i]!.seller === seller && all[i]!.tokenId === tokenId && all[i]!.collectionId === collectionId) all[i]!.active = false
      created.push({ id: randomUUID(), seller, collectionId, tokenId, priceStroops, createdAt: new Date().toISOString(), active: true })
    }
    await writeListings([...all, ...created])
    return NextResponse.json({ ok: true, accepted: created.length }, { status: 202 })
  }
  const body = (await req.json().catch(() => null)) as Partial<{
    seller: string
    collectionId: number
    tokenId: number
    priceStroops: string
    cancelId: string
  }> | null
  if (!body) return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 })

  const cancelId = typeof body.cancelId === "string" ? body.cancelId.trim() : ""
  if (cancelId) {
    const all = await readListings()
    const next = all.map((l) => (l.id === cancelId ? { ...l, active: false } : l))
    await writeListings(next)
    return NextResponse.json({ ok: true })
  }

  const seller = body.seller?.trim() ?? ""
  const collectionId = Number(body.collectionId)
  const tokenId = Number(body.tokenId)
  const priceStroops = String(body.priceStroops ?? "").trim() || "0"

  if (!validG(seller)) {
    return NextResponse.json({ ok: false, error: "Invalid seller address" }, { status: 400 })
  }
  if (!Number.isFinite(collectionId) || collectionId < 0) {
    return NextResponse.json({ ok: false, error: "Invalid collectionId" }, { status: 400 })
  }
  if (!Number.isFinite(tokenId) || tokenId < 1) {
    return NextResponse.json({ ok: false, error: "Invalid tokenId" }, { status: 400 })
  }
  try {
    if (BigInt(priceStroops) < BigInt(0)) throw new Error("neg")
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid priceStroops" }, { status: 400 })
  }

  const all = await readListings()
  const deactivated = all.map((l) => {
    if (l.active && l.seller === seller && l.tokenId === tokenId && l.collectionId === collectionId) {
      return { ...l, active: false }
    }
    return l
  })
  const listing: Listing = {
    id: randomUUID(),
    seller,
    collectionId,
    tokenId,
    priceStroops,
    createdAt: new Date().toISOString(),
    active: true,
  }
  await writeListings([...deactivated, listing])
  return NextResponse.json({ ok: true, listing })
}
