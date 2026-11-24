import { NextResponse, type NextRequest } from "next/server"
import { StrKey } from "@stellar/stellar-sdk"
import { buildPhaseTokenMetadataJson } from "@/lib/phase-nft-metadata-build"
import {
  fetchOwnedPhaseTokenIdsForWallet,
  phaseProtocolContractIdForServer,
} from "@/lib/phase-protocol"
import { mercuryConfigured, fetchTokenIdsOwnedByMercury } from "@/lib/mercury-classic"
import {
  getCachedWalletNftIndex,
  setCachedWalletNftIndex,
  isWalletNftIndexEntryFresh,
  isWalletNftIndexCacheEnabled,
  logWalletNftIndexScan,
} from "@/lib/wallet-nft-index-cache"

export const dynamic = "force-dynamic"

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim()
  const n = raw ? parseInt(raw, 10) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  async function worker() {
    for (;;) {
      const idx = i++
      if (idx >= items.length) return
      out[idx] = await fn(items[idx]!)
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker())
  await Promise.all(workers)
  return out
}

export async function GET(request: NextRequest) {
  const address = request.nextUrl.searchParams.get("address")?.trim() ?? ""
  if (!StrKey.isValidEd25519PublicKey(address)) {
    return NextResponse.json({ error: "invalid address" }, { status: 400 })
  }

  let contractId: string
  try {
    contractId = phaseProtocolContractIdForServer()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: "contract config", detail: msg }, { status: 500 })
  }

  const scanCap = intEnv("PHASE_NFT_WALLET_SCAN_CAP", 5000, 1, 50_000)
  const scanConc = intEnv("PHASE_NFT_WALLET_SCAN_CONCURRENCY", 8, 1, 16)
  const metaConc = intEnv("PHASE_NFT_WALLET_METADATA_CONCURRENCY", 4, 1, 12)

  // phase-135: serve from the wallet NFT index cache when fresh, and fall
  // back to stale cached data (instead of a 503) if every live path fails.
  const cacheOn = isWalletNftIndexCacheEnabled()
  const cached = cacheOn ? getCachedWalletNftIndex(contractId, address) : null
  const scanStart = Date.now()

  let tokenIds: number[]
  let indexedVia: string
  let cacheHit = false

  if (cacheOn && cached && isWalletNftIndexEntryFresh(cached)) {
    tokenIds = cached.tokenIds
    indexedVia = cached.indexedVia
    cacheHit = true
  } else {
    const runLiveScan = async (): Promise<{ tokenIds: number[]; indexedVia: string }> => {
      // Mercury Classic es más rápido que RPC scan — úsalo si está configurado
      if (mercuryConfigured()) {
        try {
          return { tokenIds: await fetchTokenIdsOwnedByMercury(contractId, address), indexedVia: "mercury-classic" }
        } catch {
          const ids = await fetchOwnedPhaseTokenIdsForWallet(address, {
            contractId,
            maxTokenIdCap: scanCap,
            concurrency: scanConc,
          })
          return { tokenIds: ids, indexedVia: "soroban-rpc-fallback" }
        }
      }
      const ids = await fetchOwnedPhaseTokenIdsForWallet(address, {
        contractId,
        maxTokenIdCap: scanCap,
        concurrency: scanConc,
      })
      return { tokenIds: ids, indexedVia: "soroban-rpc" }
    }

    if (!cacheOn) {
      const live = await runLiveScan()
      tokenIds = live.tokenIds
      indexedVia = live.indexedVia
    } else {
      try {
        const live = await runLiveScan()
        tokenIds = live.tokenIds
        indexedVia = live.indexedVia
        setCachedWalletNftIndex(contractId, address, tokenIds, indexedVia)
      } catch (e) {
        if (cached) {
          // Every live path failed — degrade to the last-known-good index
          // instead of surfacing a 503 to the wallet/Explore UI.
          tokenIds = cached.tokenIds
          indexedVia = `${cached.indexedVia}-stale`
          cacheHit = true
        } else {
          logWalletNftIndexScan({
            contractId,
            address,
            indexedVia: "unavailable",
            durationMs: Date.now() - scanStart,
            tokenCount: 0,
            cacheHit: false,
          })
          return NextResponse.json(
            {
              contractId,
              owner: address,
              tokenIds: [],
              items: [],
              indexedVia: "unavailable",
              error: e instanceof Error ? e.message : String(e),
            },
            {
              status: 200,
              headers: {
                "Content-Type": "application/json; charset=utf-8",
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "private, no-store",
              },
            },
          )
        }
      }
    }
  }

  if (cacheOn) {
    logWalletNftIndexScan({
      contractId,
      address,
      indexedVia,
      durationMs: Date.now() - scanStart,
      tokenCount: tokenIds.length,
      cacheHit,
    })
  }

  const items = await mapWithConcurrency(tokenIds, metaConc, async (tokenId) => {
    const meta = await buildPhaseTokenMetadataJson(contractId, tokenId)
    if (!meta) {
      return {
        tokenId,
        name: `Phase Artifact #${tokenId}`,
        description: "",
        image: "",
        collectionId: null as number | null,
      }
    }
    const { name, description, image, collectionId } = meta
    return { tokenId, name, description, image, collectionId }
  })

  return NextResponse.json(
    {
      contractId,
      owner: address,
      tokenIds,
      items,
      indexedVia,
    },
    {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "private, no-store",
      },
    },
  )
}
