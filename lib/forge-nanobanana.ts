/**
 * Cliente para https://api.nanobananaapi.ai (docs: docs.nanobananaapi.ai).
 *
 * Two modes:
 *  - generateForgeImageUrlViaNanobananaApi — synchronous polling mode (legacy):
 *      submits a task and blocks until successFlag === 1 or timeout (110s).
 *      Used as fallback when async webhooks are not configured.
 *
 *  - submitForgeImageTaskViaNanobananaApi — async submit mode (new):
 *      submits a task and returns the taskId immediately without polling.
 *      The caller registers a generation job and waits for the webhook callback
 *      from app/api/webhooks/nanobanana to deliver the result.
 */

import { fetchWithRetry } from "@/lib/pipeline-retry"

const NANOBANANA_BASE = "https://api.nanobananaapi.ai"

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

type NanobananaEnvelope<T> = {
  code?: number
  msg?: string
  data?: T
}

export function nanobananaApiKeyConfigured(): boolean {
  const k = process.env.NANOBANANA_API_KEY?.trim()
  return Boolean(k && k.length > 0)
}

function nanobananaApiKey(): string {
  const k = process.env.NANOBANANA_API_KEY?.trim()
  if (!k) throw new Error("NANOBANANA_API_KEY_MISSING")
  return k
}

function isNanobananaOverloadLike(code: number | undefined, msg: string): boolean {
  const m = msg.toLowerCase()
  if (code === 401 || code === 429) return true
  return /credit|quota|balance|insufficient|rate|limit|overload|exhausted|billing/i.test(m)
}

/**
 * Returns true when async webhook mode is available.
 * Requires NANOBANANA_WEBHOOK_SECRET and a resolvable NANOBANANA_CALLBACK_URL.
 */
export function nanobananaAsyncWebhookEnabled(): boolean {
  const secret = process.env.NANOBANANA_WEBHOOK_SECRET?.trim()
  const url = process.env.NANOBANANA_CALLBACK_URL?.trim()
  return Boolean(secret && secret.length >= 8 && url && url.startsWith("http"))
}

// ─── Shared submit helper ─────────────────────────────────────────────────────

async function submitGenerateTask(prompt: string, callBackUrl: string): Promise<string> {
  const apiKey = nanobananaApiKey()
  const body = {
    prompt,
    type: "TEXTTOIAMGE" as const,
    numImages: 1,
    image_size: "1:1" as const,
    callBackUrl,
  }

  const genRes = await fetchWithRetry(`${NANOBANANA_BASE}/api/v1/nanobanana/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })

  const genText = await genRes.text()
  let genJson: NanobananaEnvelope<{ taskId?: string }>
  try {
    genJson = JSON.parse(genText) as NanobananaEnvelope<{ taskId?: string }>
  } catch {
    throw new Error(`NANOBANANA_GENERATE_PARSE: ${genText.slice(0, 200)}`)
  }

  const outerCode = genJson.code ?? (genRes.ok ? 200 : genRes.status)
  if (outerCode !== 200 || !genJson.data?.taskId) {
    const msg = genJson.msg ?? genText.slice(0, 300)
    if (isNanobananaOverloadLike(outerCode, msg)) {
      throw new Error("NANO_BANANA_CORE_OVERLOAD")
    }
    throw new Error(`NANOBANANA_GENERATE_FAILED: ${msg}`)
  }

  return genJson.data.taskId
}

// ─── Async submit — returns taskId immediately ────────────────────────────────

export type SubmitForgeImageTaskResult = {
  taskId: string
  callBackUrl: string
}

/**
 * Submits an image generation task to NanoBanana and returns the taskId
 * immediately without polling. The webhook at `callBackUrl` will receive
 * the result once NanoBanana finishes (may take up to several minutes).
 */
export async function submitForgeImageTaskViaNanobananaApi(options: {
  prompt: string
  callBackUrl: string
}): Promise<SubmitForgeImageTaskResult> {
  const taskId = await submitGenerateTask(options.prompt, options.callBackUrl)
  return { taskId, callBackUrl: options.callBackUrl }
}

// ─── Synchronous polling — legacy / fallback ──────────────────────────────────

/**
 * Crea tarea TEXTTOIAMGE y hace poll hasta successFlag === 1 o error.
 * @returns URL https de imagen (resultImageUrl preferida sobre originImageUrl).
 */
export async function generateForgeImageUrlViaNanobananaApi(options: {
  prompt: string
  callBackUrl: string
  pollIntervalMs?: number
  maxWaitMs?: number
}): Promise<string> {
  const { prompt, callBackUrl } = options
  const pollIntervalMs = options.pollIntervalMs ?? 2000
  const maxWaitMs = options.maxWaitMs ?? 110_000
  const apiKey = nanobananaApiKey()

  const taskId = await submitGenerateTask(prompt, callBackUrl)
  const deadline = Date.now() + maxWaitMs

  while (Date.now() < deadline) {
    await sleep(pollIntervalMs)

    const infoRes = await fetchWithRetry(
      `${NANOBANANA_BASE}/api/v1/nanobanana/record-info?taskId=${encodeURIComponent(taskId)}`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
      },
    )

    const infoText = await infoRes.text()
    let infoJson: NanobananaEnvelope<{
      successFlag?: number
      errorMessage?: string
      response?: { resultImageUrl?: string; originImageUrl?: string }
    }>
    try {
      infoJson = JSON.parse(infoText) as typeof infoJson
    } catch {
      continue
    }

    if (infoJson.code !== 200) {
      const msg = infoJson.msg ?? infoText.slice(0, 200)
      if (isNanobananaOverloadLike(infoJson.code, msg)) {
        throw new Error("NANO_BANANA_CORE_OVERLOAD")
      }
      throw new Error(`NANOBANANA_RECORD_FAILED: ${msg}`)
    }

    const flag = infoJson.data?.successFlag
    if (flag === 1) {
      const url =
        infoJson.data?.response?.resultImageUrl?.trim() ||
        infoJson.data?.response?.originImageUrl?.trim()
      if (url) return url
      throw new Error("NANOBANANA_IMAGE_EMPTY: success sin URL de imagen")
    }
    if (flag === 2 || flag === 3) {
      const em = infoJson.data?.errorMessage?.trim() || "task failed"
      if (isNanobananaOverloadLike(undefined, em)) {
        throw new Error("NANO_BANANA_CORE_OVERLOAD")
      }
      throw new Error(`NANOBANANA_TASK_FAILED: ${em}`)
    }
  }

  throw new Error("NANOBANANA_TIMEOUT: la generación no terminó a tiempo")
}
