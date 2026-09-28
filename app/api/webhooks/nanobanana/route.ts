/**
 * POST /api/webhooks/nanobanana
 *
 * Receives async image-generation callbacks from NanoBanana API.
 *
 * Security:
 *  - HMAC-SHA256 signature verified against NANOBANANA_WEBHOOK_SECRET
 *    using the raw request body and the `x-nanobanana-signature` header.
 *  - Requests without a valid signature are rejected (401) and logged to the DLQ.
 *
 * Success flow:
 *  1. Parse taskId + result image URL from the payload.
 *  2. Look up the generation job by taskId.
 *  3. Mark job as `webhook_received` and record the image URL.
 *  4. Trigger the remaining pipeline steps (lore → IPFS → mint) in the background.
 *
 * Failure flow:
 *  - Any error during processing appends an entry to the dead-letter queue.
 *  - Always returns 200 to NanoBanana to prevent webhook retry storms.
 *    (Retries are handled by the DLQ / polling fallback.)
 */

import { NextRequest, NextResponse } from "next/server"
import { createHmac, timingSafeEqual } from "node:crypto"
import {
  getGenerationJobByTaskId,
  updateGenerationJob,
  appendGenerationDlq,
} from "@/lib/generation-job-store"
import { generateLoreStep } from "@/lib/forge/ai-pipeline"
import { publishIpfsStep } from "@/lib/forge/ipfs-publisher"
import { mintNftStep } from "@/lib/forge/pipeline"
import { normalizeForgeImageStyleMode, normalizeForgeOutputLang } from "@/lib/forge/prompt-builder"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// ─── Signature verification ───────────────────────────────────────────────────

function getWebhookSecret(): string | null {
  return process.env.NANOBANANA_WEBHOOK_SECRET?.trim() || null
}

/**
 * Verifies the HMAC-SHA256 signature on the raw body.
 * NanoBanana sends the signature as `x-nanobanana-signature: sha256=<hex>`.
 */
function verifyWebhookSignature(rawBody: string, signatureHeader: string | null): boolean {
  const secret = getWebhookSecret()
  if (!secret) {
    // No secret configured — skip signature check (development / initial setup)
    console.warn("[nanobanana-webhook] NANOBANANA_WEBHOOK_SECRET not set; skipping signature check")
    return true
  }
  if (!signatureHeader) return false

  // Strip "sha256=" prefix if present
  const receivedHex = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice(7)
    : signatureHeader

  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")

  try {
    return timingSafeEqual(Buffer.from(receivedHex, "hex"), Buffer.from(expected, "hex"))
  } catch {
    return false
  }
}

// ─── Payload types ────────────────────────────────────────────────────────────

type NanobananaWebhookPayload = {
  taskId?: string
  successFlag?: number // 1 = success, 2/3 = failure
  errorMessage?: string
  response?: {
    resultImageUrl?: string
    originImageUrl?: string
  }
  // Some versions nest under data
  data?: {
    taskId?: string
    successFlag?: number
    errorMessage?: string
    response?: {
      resultImageUrl?: string
      originImageUrl?: string
    }
  }
}

function extractFromPayload(payload: NanobananaWebhookPayload) {
  const root = payload.data ?? payload
  return {
    taskId: (root.taskId ?? "").trim(),
    successFlag: root.successFlag,
    errorMessage: root.errorMessage?.trim() ?? "",
    imageUrl:
      root.response?.resultImageUrl?.trim() ||
      root.response?.originImageUrl?.trim() ||
      "",
  }
}

// ─── Background pipeline continuation ────────────────────────────────────────

/**
 * After the webhook delivers the image URL, run lore generation + IPFS + mint
 * to complete the pipeline. This runs fire-and-forget; the job status is updated
 * in the store so the polling endpoint reflects progress.
 */
async function continueForgeAfterWebhook(jobId: string, jobSnapshot: {
  prompt: string
  imageUrl: string
  imageStyleMode?: string
  lang?: string
  payerAddress?: string
  collectionId?: number
}): Promise<void> {
  try {
    const styleMode = normalizeForgeImageStyleMode(jobSnapshot.imageStyleMode)
    const outputLang = normalizeForgeOutputLang(jobSnapshot.lang)

    // Generate lore
    const lore = await generateLoreStep({
      prompt: jobSnapshot.prompt,
      styleMode,
      outputLang,
      recentLores: [],
    })

    // Publish to IPFS
    const { metadataUri, cid } = await publishIpfsStep({
      imageUrl: jobSnapshot.imageUrl,
      lore,
      prompt: jobSnapshot.prompt,
      imageSource: "nanobanana_api",
      payerAddress: jobSnapshot.payerAddress,
      collectionId: jobSnapshot.collectionId,
    })

    // Mint NFT (best-effort, non-blocking)
    await mintNftStep({
      payerAddress: jobSnapshot.payerAddress,
      metadataUri,
      collectionId: jobSnapshot.collectionId,
    })

    await updateGenerationJob(jobId, {
      status: "completed",
      result: {
        imageUrl: jobSnapshot.imageUrl,
        image_url: jobSnapshot.imageUrl,
        lore,
        metadataStandard: "SEP-41/50",
        image_source: "nanobanana_api",
        metadataUri,
        cid,
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await updateGenerationJob(jobId, { status: "failed", error: msg })
    await appendGenerationDlq({
      jobId,
      source: "continueForgeAfterWebhook",
      errorType: "pipeline_failed",
      errorMessage: msg,
    }).catch(() => {})
  }
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<NextResponse> {
  let rawBody = ""
  try {
    rawBody = await request.text()
  } catch {
    // Always return 200 to prevent NanoBanana retry storms
    return new NextResponse(null, { status: 200 })
  }

  const signatureHeader = request.headers.get("x-nanobanana-signature")

  // Verify signature
  if (!verifyWebhookSignature(rawBody, signatureHeader)) {
    console.error("[nanobanana-webhook] Invalid webhook signature", {
      signatureHeader,
      bodyPrefix: rawBody.slice(0, 120),
    })
    void appendGenerationDlq({
      source: "webhook_signature_check",
      errorType: "webhook_sig_invalid",
      errorMessage: `Invalid signature. Header: ${signatureHeader ?? "(none)"}`,
      rawPayload: rawBody.slice(0, 1000),
    }).catch(() => {})
    // Return 401 only when secret IS configured (otherwise log and proceed)
    if (getWebhookSecret()) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 })
    }
  }

  // Parse payload
  let payload: NanobananaWebhookPayload
  try {
    payload = JSON.parse(rawBody) as NanobananaWebhookPayload
  } catch {
    void appendGenerationDlq({
      source: "webhook_parse",
      errorType: "webhook_parse_error",
      errorMessage: "Failed to parse JSON body",
      rawPayload: rawBody.slice(0, 1000),
    }).catch(() => {})
    return new NextResponse(null, { status: 200 })
  }

  const { taskId, successFlag, errorMessage, imageUrl } = extractFromPayload(payload)

  if (!taskId) {
    void appendGenerationDlq({
      source: "webhook_no_taskid",
      errorType: "webhook_parse_error",
      errorMessage: "Webhook payload missing taskId",
      rawPayload: payload,
    }).catch(() => {})
    return new NextResponse(null, { status: 200 })
  }

  // Look up the generation job
  const job = await getGenerationJobByTaskId(taskId).catch(() => null)

  if (!job) {
    // No matching job — may have already been cleaned up or was from a different instance
    console.warn("[nanobanana-webhook] No generation job found for taskId:", taskId)
    return new NextResponse(null, { status: 200 })
  }

  const now = Date.now()

  // Mark webhook received
  await updateGenerationJob(job.id, {
    lastWebhookAt: now,
    webhookDeliveries: (job.webhookDeliveries ?? 0) + 1,
  }).catch(() => {})

  // Handle failure from NanoBanana
  if (successFlag === 2 || successFlag === 3) {
    const errMsg = errorMessage || `NanoBanana task failed (successFlag=${successFlag ?? "unknown"})`
    console.error("[nanobanana-webhook] Task failed:", { taskId, errMsg })
    await updateGenerationJob(job.id, { status: "failed", error: errMsg }).catch(() => {})
    await appendGenerationDlq({
      jobId: job.id,
      txHash: job.txHash,
      taskId,
      source: "nanobanana_task_failure",
      errorType: "pipeline_failed",
      errorMessage: errMsg,
      rawPayload: payload,
    }).catch(() => {})
    return new NextResponse(null, { status: 200 })
  }

  // Handle success
  if (successFlag === 1 && imageUrl) {
    await updateGenerationJob(job.id, {
      status: "webhook_received",
      imageUrl,
    }).catch(() => {})

    // Continue pipeline async — lore, IPFS, mint
    void continueForgeAfterWebhook(job.id, {
      prompt: job.prompt,
      imageUrl,
      imageStyleMode: job.imageStyleMode,
      lang: job.lang,
      payerAddress: job.payerAddress,
      collectionId: job.collectionId,
    }).catch((err) => {
      console.error("[nanobanana-webhook] continueForgeAfterWebhook unhandled", err)
    })

    return new NextResponse(null, { status: 200 })
  }

  // successFlag === 0 or undefined — still processing, NanoBanana is pinging for progress
  console.log("[nanobanana-webhook] Task still processing:", { taskId, successFlag })
  return new NextResponse(null, { status: 200 })
}
