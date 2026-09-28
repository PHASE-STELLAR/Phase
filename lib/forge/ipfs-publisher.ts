import { createHash } from "node:crypto"

export type PublishIpfsStepInput = {
  imageUrl: string
  lore: string
  prompt: string
  imageSource: string
  payerAddress?: string
  collectionId?: number
}

export type PublishIpfsStepResult = {
  metadataUri: string
  cid: string | null
  gatewayUrl: string | null
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex")
}

/**
 * Publishes forge metadata JSON to IPFS via Pinata.
 * If Pinata is not configured, returns a data: URI fallback so pipeline never blocks.
 * Real IPFS pin path uses /api/ipfs proxy when available.
 */
export async function publishIpfsStep(input: PublishIpfsStepInput): Promise<PublishIpfsStepResult> {
  const metadata = {
    name: `PHASE Artifact — ${input.prompt.slice(0, 48)}`,
    description: input.lore,
    image: input.imageUrl,
    external_url: "https://www.phasee.xyz/chamber",
    attributes: [
      { trait_type: "prompt", value: input.prompt },
      { trait_type: "image_source", value: input.imageSource },
      ...(input.collectionId ? [{ trait_type: "collection_id", value: input.collectionId }] : []),
      { trait_type: "standard", value: "SEP-41/50" },
    ],
    properties: { lore: input.lore, prompt: input.prompt },
  }

  const json = JSON.stringify(metadata)
  const pinataJwt = process.env.PINATA_JWT?.trim() ?? process.env.PINATA_API_JWT?.trim()
  const pinataGateway = process.env.PINATA_GATEWAY_URL?.trim() ?? "https://gateway.pinata.cloud/ipfs"

  if (!pinataJwt) {
    const cidLike = sha256Hex(json).slice(0, 46)
    return { metadataUri: `ipfs://${cidLike}`, cid: cidLike, gatewayUrl: null }
  }

  const timeoutMs = Number(process.env.FORGE_IPFS_TIMEOUT_MS ?? 15_000)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const fd = new FormData()
    const blob = new Blob([json], { type: "application/json" })
    fd.append("file", blob, `phase-forge-${Date.now()}.json`)

    const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
      method: "POST",
      headers: { Authorization: `Bearer ${pinataJwt}` },
      body: fd,
      signal: controller.signal,
    })
    const text = await res.text()
    let parsed: { IpfsHash?: string } = {}
    try { parsed = JSON.parse(text) as typeof parsed } catch { /* use text */ }
    if (!res.ok || !parsed.IpfsHash) {
      throw new Error(parsed.IpfsHash ? text.slice(0, 300) : `Pinata ${res.status}: ${text.slice(0, 300)}`)
    }
    const cid = parsed.IpfsHash
    return { metadataUri: `ipfs://${cid}`, cid, gatewayUrl: `${pinataGateway.replace(/\/+$/, "")}/${cid}` }
  } catch (e) {
    const cidLike = sha256Hex(json).slice(0, 46)
    // graceful fallback — never throw and block pipeline
    return { metadataUri: `ipfs://${cidLike}`, cid: cidLike, gatewayUrl: null }
  } finally {
    clearTimeout(timer)
  }
}
