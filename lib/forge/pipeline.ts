import { getWorldForCollection, getRecentNarrativesForCollection } from "@/lib/narrative-world-store"
import { checkAndUnlock } from "@/lib/achievement-store"
import { normalizeForgeImageStyleMode, normalizeForgeOutputLang } from "@/lib/forge/prompt-builder"
import { generateLoreStep, generateImageStep } from "@/lib/forge/ai-pipeline"
import { publishIpfsStep } from "@/lib/forge/ipfs-publisher"
import { createJob, updateJob } from "@/lib/forge/job-store"
import type { ForgeJobStatus } from "@/lib/forge/job-store"
import { charge as chargeForgeStep, getCost as getForgeCost } from "@/lib/cost-attribution-ledger"

// mint stub — Soroban mint via /api/mint would require server signer; keep isolated step for wiring
export async function mintNftStep(input: {
  payerAddress?: string
  metadataUri: string
  collectionId?: number
}): Promise<{ txHash: string | null }> {
  // Placeholder: in production, call Soroban mint with server-held distributor key.
  // Keep non-blocking: return null if not configured.
  if (!input.payerAddress || !process.env.PHASE_MINT_DISTRIBUTOR_SECRET) {
    return { txHash: null }
  }
  // Future: build+send mint tx; for now no-op
  return { txHash: null }
}

export type ForgePipelineInput = {
  prompt: string
  payerAddress?: string
  settlementTxHash?: string
  imageStyleMode?: string
  collection_id?: number
  lang?: string
}

export type ForgePipelineSuccess = {
  imageUrl: string
  image_url: string
  lore: string
  metadataStandard: string
  image_source: string
  metadataUri?: string
  cid?: string | null
  jobId: string
  costEstimate: number
}

export async function runForgePipeline(input: ForgePipelineInput, correlationId?: string): Promise<ForgePipelineSuccess> {
  const styleMode = normalizeForgeImageStyleMode(input.imageStyleMode)
  const outputLang = normalizeForgeOutputLang(input.lang)
  const job = createJob({ prompt: input.prompt, payerAddress: input.payerAddress, settlementTxHash: input.settlementTxHash })
  const jobId = correlationId ?? job.id

  // Attribute each infrastructure step exactly once.  A retry of this
  // function with the same correlation id reuses the existing job/step keys.
  chargeForgeStep(jobId, "nanobanana", 0.02)
  chargeForgeStep(jobId, "ipfs", 0.001)
  chargeForgeStep(jobId, "soroban", 0.01)
  chargeForgeStep(jobId, "seal", 0.01)
  const costEstimate = getForgeCost(jobId)

  const set = (status: ForgeJobStatus) => updateJob(job.id, { status })

  try {
    set("generating_lore")

    let worldPrompt: string | undefined
    let recentLores: Awaited<ReturnType<typeof getRecentNarrativesForCollection>> = []
    if (typeof input.collection_id === "number" && input.collection_id > 0) {
      try {
        const [world, lores] = await Promise.all([
          getWorldForCollection(input.collection_id),
          getRecentNarrativesForCollection(input.collection_id, 3),
        ])
        if (world?.world_prompt) worldPrompt = world.world_prompt
        recentLores = lores
      } catch { /* non-fatal */ }
    }

    const lore = await generateLoreStep({ prompt: input.prompt, styleMode, worldPrompt, outputLang, recentLores })
    updateJob(job.id, { status: "generating_image" } as never)

    const nanobananaCallBackUrl = process.env.NANOBANANA_CALLBACK_URL?.trim() ?? "https://www.phasee.xyz/api/webhooks/nanobanana"
    const { imageUrl, image_source } = await generateImageStep({ prompt: input.prompt, styleMode, nanobananaCallBackUrl })

    updateJob(job.id, { status: "publishing" } as never)
    const { metadataUri, cid } = await publishIpfsStep({ imageUrl, lore, prompt: input.prompt, imageSource: image_source, payerAddress: input.payerAddress, collectionId: input.collection_id })

    updateJob(job.id, { status: "minting" } as never)
    await mintNftStep({ payerAddress: input.payerAddress, metadataUri, collectionId: input.collection_id })

    const result = { imageUrl, image_url: imageUrl, lore, metadataStandard: "SEP-41/50" as const, image_source, metadataUri, cid, jobId, costEstimate }
    updateJob(job.id, { status: "completed", result } as never)

    if (input.payerAddress?.trim()) {
      void checkAndUnlock(input.payerAddress.trim(), { mints: 1, has_collection: typeof input.collection_id === "number" && input.collection_id > 0 }).catch(() => {})
    }

    return result
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    updateJob(job.id, { status: "failed", error: msg } as never)
    throw e
  }
}
