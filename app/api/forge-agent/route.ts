import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "node:crypto"
import { warnPhaserLiqSacMismatchOnce } from "@/lib/phaser-liq-sac-warn"
import { forgeGoogleAiApiKey } from "@/lib/forge/ai-pipeline"
import {
  buildOfficialPaymentRequirements,
  verifyPaymentStep,
  extractSettlementReceiptTxHash,
  buildLegacyChallenge,
  forgePriceDisplay,
  X402_NETWORK,
} from "@/lib/forge/payment-verifier"
import { runForgePipeline } from "@/lib/forge/pipeline"
import { tokenContractIdForServer, REQUIRED_AMOUNT } from "@/lib/phase-protocol"
import { isSettlementUsed, markSettlementUsedIfUnused } from "@/lib/settlement-store"
import {
  nanobananaApiKeyConfigured,
  nanobananaAsyncWebhookEnabled,
  submitForgeImageTaskViaNanobananaApi,
} from "@/lib/forge-nanobanana"
import { createGenerationJob } from "@/lib/generation-job-store"
import { generateLoreStep } from "@/lib/forge/ai-pipeline"
import { normalizeForgeImageStyleMode, normalizeForgeOutputLang } from "@/lib/forge/prompt-builder"

export const runtime = "nodejs"
export const maxDuration = 120
export const dynamic = "force-dynamic"

const PHASE_LIQ_TOKEN_CONTRACT = tokenContractIdForServer()
const ERR_SETTLEMENT_REJECTED = "[ ERROR: SETTLEMENT_REJECTED_BY_FACILITATOR ]"

function paymentRequiredResponse(request: NextRequest) {
  const origin = request.nextUrl.origin
  const challenge = buildLegacyChallenge(origin, request.nextUrl.pathname)
  const paymentRequirements = buildOfficialPaymentRequirements(origin)
  const b64 = Buffer.from(JSON.stringify(challenge)).toString("base64")
  const body: Record<string, unknown> = {
    success: false,
    error: "Payment Required",
    priceDisplay: forgePriceDisplay(),
    message:
      "Se requiere pago en PHASELQ. Tras confirmar on-chain, reintenta con Authorization o settlementTxHash.",
    challenge,
  }
  if (paymentRequirements) body.paymentRequirements = paymentRequirements
  return NextResponse.json(body, {
    status: 402,
    headers: {
      "WWW-Authenticate": `x402 token="${b64}", amount="${challenge.amount}", facilitator="${challenge.facilitator}", network="${X402_NETWORK}"`,
      "X-Required-Amount": REQUIRED_AMOUNT,
      "X-Token-Address": PHASE_LIQ_TOKEN_CONTRACT,
      "X-Facilitator": challenge.facilitator,
      "X-X402-Network": X402_NETWORK,
    },
  })
}

export async function POST(request: NextRequest) {
  const correlationId = request.headers.get("x-correlation-id")?.trim() || randomUUID()
  let body: {
    prompt?: string
    settlementTxHash?: string
    payerAddress?: string
    imageStyleMode?: string
    collection_id?: number
    lang?: string
  }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json(
      { success: false, error: "JSON inválido" },
      { status: 400, headers: { "x-correlation-id": correlationId } },
    )
  }

  if (!forgeGoogleAiApiKey()) {
    return NextResponse.json(
      { success: false, error: "GOOGLE_AI_STUDIO_API_KEY (o GEMINI_API_KEY) no configurada." },
      { status: 503, headers: { "x-correlation-id": correlationId } },
    )
  }
  warnPhaserLiqSacMismatchOnce(PHASE_LIQ_TOKEN_CONTRACT, "forge-agent")

  const paymentRequirements = buildOfficialPaymentRequirements(request.nextUrl.origin)
  const auth = request.headers.get("authorization")
  const receipt = extractSettlementReceiptTxHash(auth, body)

  const resolution = await verifyPaymentStep({ authHeader: auth, body, paymentRequirements })
  if (resolution === "facilitator_rejected") {
    return NextResponse.json(
      { success: false, error: ERR_SETTLEMENT_REJECTED },
      { status: 403, headers: { "x-correlation-id": correlationId } },
    )
  }
  if (resolution === "missing") return paymentRequiredResponse(request)

  if (receipt) {
    if (await isSettlementUsed(receipt)) {
      return NextResponse.json(
        { success: false, error: "Settlement already used" },
        { status: 409, headers: { "x-correlation-id": correlationId } },
      )
    }
    const marked = await markSettlementUsedIfUnused(receipt)
    if (!marked) {
      return NextResponse.json(
        { success: false, error: "Settlement already used" },
        { status: 409, headers: { "x-correlation-id": correlationId } },
      )
    }
  }

  if (typeof body.prompt !== "string") {
    return NextResponse.json(
      { success: false, error: "Falta prompt (string)" },
      { status: 400, headers: { "x-correlation-id": correlationId } },
    )
  }

  const txHash = receipt ?? body.settlementTxHash?.trim() ?? ""

  // ── Async mode: NanoBanana webhook enabled ──────────────────────────────────
  // When NANOBANANA_WEBHOOK_SECRET + NANOBANANA_CALLBACK_URL are both set,
  // submit the image generation task and return immediately with a jobId.
  // The client polls /api/jobs/[txHash] until status === 'completed'.
  if (nanobananaApiKeyConfigured() && nanobananaAsyncWebhookEnabled() && txHash) {
    try {
      const callBackUrl =
        process.env.NANOBANANA_CALLBACK_URL?.trim() ??
        `${request.nextUrl.origin}/api/webhooks/nanobanana`

      const prompt = body.prompt.trim()
      if (!prompt) {
        return NextResponse.json(
          { success: false, error: "prompt vacío o inválido" },
          { status: 400, headers: { "x-correlation-id": correlationId } },
        )
      }

      // Submit image generation task — returns immediately with taskId
      const { taskId } = await submitForgeImageTaskViaNanobananaApi({ prompt, callBackUrl })

      // Register the generation job so the webhook and polling endpoint can track it
      const job = await createGenerationJob({
        taskId,
        txHash,
        prompt,
        payerAddress: body.payerAddress,
        imageStyleMode: body.imageStyleMode,
        collectionId: body.collection_id,
        lang: body.lang,
      })

      // Start lore generation in the background while image is being generated
      // (lore is independent of image and typically finishes in 3–10s)
      void (async () => {
        try {
          const styleMode = normalizeForgeImageStyleMode(body.imageStyleMode)
          const outputLang = normalizeForgeOutputLang(body.lang)
          await generateLoreStep({ prompt, styleMode, outputLang, recentLores: [] })
          // Lore is stored in-flight; the webhook handler will pick it up from the prompt
          // when it runs the full pipeline continuation.
        } catch {
          // non-fatal — webhook handler will generate lore when it fires
        }
      })()

      return NextResponse.json(
        {
          success: true,
          async: true,
          jobId: job.id,
          txHash,
          status: job.status,
          message: "Image generation submitted. Poll /api/jobs/" + encodeURIComponent(txHash) + " for status.",
        },
        { headers: { "x-correlation-id": correlationId } },
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg === "NANO_BANANA_CORE_OVERLOAD") {
        // Fall through to synchronous pipeline
        console.warn("[forge-agent] NanaBanana overloaded during async submit, falling back to sync")
      } else {
        return NextResponse.json(
          { success: false, error: "Fallo al enviar tarea a NanaBanana.", detail: process.env.NODE_ENV === "development" ? msg : undefined },
          { status: 500, headers: { "x-correlation-id": correlationId } },
        )
      }
    }
  }

  // ── Synchronous mode: standard pipeline (legacy) ────────────────────────────
  try {
    const result = await runForgePipeline(
      { ...body, prompt: body.prompt as string },
      correlationId,
    )
    return NextResponse.json(result, { headers: { "x-correlation-id": correlationId } })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg === "EMPTY_PROMPT") {
      return NextResponse.json(
        { success: false, error: "prompt vacío o inválido" },
        { status: 400, headers: { "x-correlation-id": correlationId } },
      )
    }
    if (msg === "MISSING_GOOGLE_AI_KEY") {
      return NextResponse.json(
        { success: false, error: "GOOGLE_AI_STUDIO_API_KEY no configurada." },
        { status: 503, headers: { "x-correlation-id": correlationId } },
      )
    }
    if (msg === "NANO_BANANA_CORE_OVERLOAD") {
      return NextResponse.json(
        { success: false, error: "[ ERROR: NANO_BANANA_CORE_OVERLOAD ]" },
        { status: 503, headers: { "x-correlation-id": correlationId } },
      )
    }
    if (msg.startsWith("GEMINI_")) {
      return NextResponse.json(
        {
          success: false,
          error: "Fallo al generar lore con Gemini.",
          detail: process.env.NODE_ENV === "development" ? msg : undefined,
        },
        { status: 500, headers: { "x-correlation-id": correlationId } },
      )
    }
    return NextResponse.json(
      {
        success: false,
        error: "Fallo del agente IA (Gemini).",
        detail: process.env.NODE_ENV === "development" ? msg : undefined,
      },
      { status: 500, headers: { "x-correlation-id": correlationId } },
    )
  }
}
