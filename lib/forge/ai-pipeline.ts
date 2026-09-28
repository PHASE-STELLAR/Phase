import { GoogleGenerativeAI, HarmBlockThreshold, HarmCategory } from "@google/generative-ai"
import { generateForgeImageUrlViaNanobananaApi, nanobananaApiKeyConfigured } from "@/lib/forge-nanobanana"
import { buildLoreSystemInstruction, buildPollinationsImageUrl, composeForgeImagePrompt, type ForgeImageStyleMode } from "@/lib/forge/prompt-builder"
import type { WorldNarrativeData } from "@/lib/narrative-world-store"

// ── constants ────────────────────────────────────────────────────────────────
const FORGE_GEMINI_SAFETY_SETTINGS = (
  [HarmCategory.HARM_CATEGORY_HATE_SPEECH, HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, HarmCategory.HARM_CATEGORY_HARASSMENT, HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY] as const
).map((c) => ({ category: c, threshold: HarmBlockThreshold.BLOCK_NONE }))

const GEMINI_KNOWN_FALLBACK_MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash"] as const

function looksLikeGoogleGeminiApiKey(raw: string | undefined): boolean {
  const k = raw?.trim().replace(/^["']|["']$/g, "") ?? ""
  return k.startsWith("AIza") && k.length >= 35
}

export function forgeGoogleAiApiKey(): string | null {
  const studio = process.env.GOOGLE_AI_STUDIO_API_KEY?.trim()
  const legacy = process.env.GEMINI_API_KEY?.trim().replace(/^["']|["']$/g, "")
  if (looksLikeGoogleGeminiApiKey(studio)) return studio!.trim().replace(/^["']|["']$/g, "")
  if (looksLikeGoogleGeminiApiKey(legacy)) return legacy!
  return null
}

function cleanGeminiModelId(raw: string): string { return raw.trim().replace(/^models\//i, "").trim() }
function geminiModelId(): string {
  const e = process.env.GEMINI_MODEL?.trim()
  return e ? cleanGeminiModelId(e) : "gemini-3-flash"
}
function forgeGeminiImageModelId(): string {
  const e = process.env.GEMINI_IMAGE_MODEL?.trim()
  return e ? cleanGeminiModelId(e) : "gemini-3.1-flash-image-preview"
}
function geminiGenerateRequestOptions(): { apiVersion: "v1" | "v1beta" } {
  const raw = process.env.GEMINI_API_VERSION?.trim().toLowerCase()
  if (raw === "v1" || raw === "v1beta") return { apiVersion: raw }
  return { apiVersion: "v1beta" }
}
function geminiModelCandidates(): string[] {
  const primary = geminiModelId()
  const seen = new Set<string>(); const out: string[] = []
  const add = (id: string) => { const t = cleanGeminiModelId(id); if (!t || seen.has(t)) return; seen.add(t); out.push(t) }
  add(primary); for (const m of GEMINI_KNOWN_FALLBACK_MODELS) add(m)
  return out
}
function isGeminiNonRetryableAcrossModels(error: unknown): boolean {
  const e = error as { status?: number; message?: string }
  const msg = (typeof e?.message === "string" ? e.message : String(error ?? "")).toLowerCase()
  if (typeof e?.status === "number" && (e.status === 401 || e.status === 403)) return true
  return /api key not valid|invalid api key|permission denied|unauthenticated|forbidden\b/i.test(msg)
}
export function isNanoBananaCoreOverloadError(error: unknown): boolean {
  const e = error as { status?: number; message?: string; code?: number | string }
  const msg = (typeof e?.message === "string" ? e.message : String(error ?? "")).toLowerCase()
  if (e?.status === 429 || e?.code === 429 || e?.status === 503 || e?.status === 529) return true
  return /\b429\b|\b503\b|quota|resource_exhausted|rate.?limit|too many requests|billing|credit|exhausted|overload|capacity/i.test(msg)
}
export function forgePollinationsFallbackEnabled(): boolean {
  const v = process.env.FORGE_DISABLE_POLLINATIONS_FALLBACK?.trim().toLowerCase()
  return v !== "1" && v !== "true" && v !== "yes"
}

// ── timeout wrapper — zero synchronous blockage ────────────────────────────
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label}_TIMEOUT: exceeded ${ms}ms`)), ms)
  })
  try { return await Promise.race([promise, timeout]) }
  finally { if (timer) clearTimeout(timer) }
}

const LORE_TIMEOUT_MS = Number(process.env.FORGE_LORE_TIMEOUT_MS ?? 25_000)
const IMAGE_TIMEOUT_MS = Number(process.env.FORGE_IMAGE_TIMEOUT_MS ?? 55_000)

// ── lore step ───────────────────────────────────────────────────────────────
export type GenerateLoreStepInput = {
  prompt: string
  styleMode: ForgeImageStyleMode
  worldPrompt?: string
  outputLang: "en" | "es"
  recentLores?: WorldNarrativeData[]
}

export async function generateLoreStep(input: GenerateLoreStepInput): Promise<string> {
  const trimmed = input.prompt.trim()
  if (!trimmed) throw new Error("EMPTY_PROMPT")
  const apiKey = forgeGoogleAiApiKey()
  if (!apiKey) throw new Error("MISSING_GOOGLE_AI_KEY")
  const genAI = new GoogleGenerativeAI(apiKey)
  const systemInstruction = buildLoreSystemInstruction(trimmed, input.styleMode, input.worldPrompt, input.outputLang, input.recentLores ?? [])
  const candidates = geminiModelCandidates()

  let lastError: unknown
  for (let i = 0; i < candidates.length; i++) {
    const modelId = candidates[i]!
    try {
      const model = genAI.getGenerativeModel(
        { model: modelId, safetySettings: FORGE_GEMINI_SAFETY_SETTINGS },
        geminiGenerateRequestOptions(),
      )
      const res = await withTimeout(model.generateContent(systemInstruction), LORE_TIMEOUT_MS, "LORE")
      const lore = (res.response.text() ?? "").trim()
      if (!lore) throw new Error("GEMINI_EMPTY_LORE: el modelo no devolvió texto")
      return lore
    } catch (e) {
      lastError = e
      const msg = e instanceof Error ? e.message : String(e)
      // timeout or overload → no retry other model if fallback disabled? still retry other models
      if (isGeminiNonRetryableAcrossModels(e)) throw new Error(`GEMINI_GENERATE_FAILED: ${msg}`)
      if (i === candidates.length - 1) throw new Error(`GEMINI_GENERATE_FAILED: ${msg}`)
    }
  }
  throw new Error(`GEMINI_GENERATE_FAILED: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

// ── image step — Nano Banana → Gemini → Pollinations cascade ─────────────
type GeminiPart = { inlineData?: { mimeType?: string; data?: string }; inline_data?: { mime_type?: string; data?: string }; text?: string }
function extractImageDataUrlFromGeminiResponse(response: { candidates?: { content?: { parts?: GeminiPart[] } }[] }): string | null {
  const parts = response.candidates?.[0]?.content?.parts
  if (!parts?.length) return null
  for (const part of parts) {
    const id = part.inlineData ?? part.inline_data
    if (!id?.data) continue
    const mime = part.inlineData?.mimeType ?? part.inline_data?.mime_type ?? "image/png"
    if (mime.startsWith("image/")) return `data:${mime};base64,${id.data}`
  }
  return null
}

async function generateForgeImageDataUrl(genAI: GoogleGenerativeAI, imagePrompt: string): Promise<string> {
  const imageModelId = forgeGeminiImageModelId()
  const model = genAI.getGenerativeModel(
    {
      model: imageModelId, safetySettings: FORGE_GEMINI_SAFETY_SETTINGS,
      generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "1:1", imageSize: "2K" } } as import("@google/generative-ai").GenerationConfig,
    },
    geminiGenerateRequestOptions(),
  )
  let res: Awaited<ReturnType<typeof model.generateContent>>
  try { res = await withTimeout(model.generateContent(imagePrompt.trim()), IMAGE_TIMEOUT_MS, "GEMINI_IMAGE") }
  catch (e) { if (isNanoBananaCoreOverloadError(e)) throw new Error("NANO_BANANA_CORE_OVERLOAD"); throw e }
  const dataUrl = extractImageDataUrlFromGeminiResponse(res.response as unknown as { candidates?: { content?: { parts?: GeminiPart[] } }[] })
  if (!dataUrl) throw new Error("GEMINI_IMAGE_EMPTY: el modelo no devolvió datos de imagen")
  return dataUrl
}

export type GenerateImageStepInput = {
  prompt: string
  styleMode: ForgeImageStyleMode
  nanobananaCallBackUrl: string
}

export type GenerateImageStepResult = {
  imageUrl: string
  image_source: "nanobanana_api" | "gemini" | "pollinations_fallback"
}

export async function generateImageStep(input: GenerateImageStepInput): Promise<GenerateImageStepResult> {
  const imagePromptForApis = composeForgeImagePrompt(input.prompt, input.styleMode)
  const apiKey = forgeGoogleAiApiKey()
  const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null

  const tryPollinationsOnOverload = (e: unknown): boolean => {
    const overload = (e instanceof Error && e.message === "NANO_BANANA_CORE_OVERLOAD") || isNanoBananaCoreOverloadError(e)
    if (!overload) return false
    if (!forgePollinationsFallbackEnabled()) throw new Error("NANO_BANANA_CORE_OVERLOAD")
    return true
  }

  // 1) Nano Banana API (with timeout guard)
  if (nanobananaApiKeyConfigured()) {
    try {
      const url = await withTimeout(
        generateForgeImageUrlViaNanobananaApi({ prompt: imagePromptForApis, callBackUrl: input.nanobananaCallBackUrl }),
        IMAGE_TIMEOUT_MS,
        "NANOBANANA",
      )
      return { imageUrl: url, image_source: "nanobanana_api" }
    } catch (e) {
      if (tryPollinationsOnOverload(e)) {
        return { imageUrl: buildPollinationsImageUrl(input.prompt, input.styleMode), image_source: "pollinations_fallback" }
      }
      // Nano timeout falls through to Gemini, not immediate Pollinations — clean cascade
      const isTimeout = e instanceof Error && e.message.includes("TIMEOUT")
      if (isTimeout) {
        // timeout is treated as overload-like for graceful fallback after Gemini attempt
        // fall through
      }
    }
  }

  // 2) Gemini image — with timeout
  if (genAI) {
    try {
      const url = await generateForgeImageDataUrl(genAI, imagePromptForApis)
      return { imageUrl: url, image_source: "gemini" }
    } catch (e) {
      if (tryPollinationsOnOverload(e)) {
        return { imageUrl: buildPollinationsImageUrl(input.prompt, input.styleMode), image_source: "pollinations_fallback" }
      }
      // timeout fallback → pollinations if enabled
      if (e instanceof Error && e.message.includes("TIMEOUT") && forgePollinationsFallbackEnabled()) {
        return { imageUrl: buildPollinationsImageUrl(input.prompt, input.styleMode), image_source: "pollinations_fallback" }
      }
      const msg = e instanceof Error ? e.message : String(e)
      throw new Error(`GEMINI_IMAGE_FAILED: ${msg}`)
    }
  }

  // 3) Final fallback — Pollinations (never blocks, instant URL)
  if (forgePollinationsFallbackEnabled()) {
    return { imageUrl: buildPollinationsImageUrl(input.prompt, input.styleMode), image_source: "pollinations_fallback" }
  }
  throw new Error("GEMINI_IMAGE_FAILED: no provider available and fallback disabled")
}
