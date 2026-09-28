import { GoogleGenerativeAI, HarmBlockThreshold, HarmCategory } from "@google/generative-ai"
import { NextRequest, NextResponse } from "next/server"
import {
  getWorldForCollection,
  getRecentNarrativesForCollection,
  saveNarrativeForToken,
  getNarrativeForToken,
} from "@/lib/narrative-world-store"
import { createNotification } from "@/lib/notification-store"
import { checkNarrativeContinuity } from "@/lib/story-arc-continuity"
import { isLoreVersioningEnabled, recordLoreVersion } from "@/lib/lore-versioning"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

const SAFETY_SETTINGS = (
  [
    HarmCategory.HARM_CATEGORY_HATE_SPEECH,
    HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
    HarmCategory.HARM_CATEGORY_HARASSMENT,
    HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
    HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY,
  ] as const
).map((category) => ({ category, threshold: HarmBlockThreshold.BLOCK_NONE }))

function narratorGeminiApiKey(): string | null {
  const studio = process.env.GOOGLE_AI_STUDIO_API_KEY?.trim().replace(/^["']|["']$/g, "")
  const legacy = process.env.GEMINI_API_KEY?.trim().replace(/^["']|["']$/g, "")
  const key = studio?.startsWith("AIza") && studio.length >= 35 ? studio : legacy
  return key && key.length >= 35 ? key : null
}

function narratorModelId(): string {
  const fromEnv = process.env.GEMINI_MODEL?.trim().replace(/^models\//i, "").trim()
  // Avoid gemini-1.5-* — many accounts return 404 in v1beta
  if (fromEnv && fromEnv.length > 0 && !fromEnv.startsWith("gemini-1.5")) return fromEnv
  return "gemini-2.0-flash"
}

type NarratorBody = {
  token_id?: unknown
  collection_id?: unknown
  lore?: unknown
  creator_wallet?: unknown
}

export async function POST(request: NextRequest) {
  let body: NarratorBody
  try {
    body = (await request.json()) as NarratorBody
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 })
  }

  const tokenId = Number(body.token_id)
  const collectionId = Number(body.collection_id)

  if (!Number.isInteger(tokenId) || tokenId <= 0) {
    return NextResponse.json({ error: "token_id inválido" }, { status: 400 })
  }
  if (!Number.isInteger(collectionId) || collectionId <= 0) {
    return NextResponse.json({ error: "collection_id inválido" }, { status: 400 })
  }

  // Idempotent: if narrative already exists, return it without re-generating.
  const existing = await getNarrativeForToken(tokenId)
  if (existing) {
    return NextResponse.json({ ok: true, narrative: existing.narrative, cached: true })
  }

  const world = await getWorldForCollection(collectionId)
  if (!world) {
    return NextResponse.json(
      { error: "Esta colección no tiene mundo narrativo activo" },
      { status: 404 },
    )
  }

  const apiKey = narratorGeminiApiKey()
  if (!apiKey) {
    return NextResponse.json({ error: "GOOGLE_AI_STUDIO_API_KEY no configurada" }, { status: 503 })
  }

  const toneInstructions: Record<string, string> = {
    enigmatic:  "Tone: dark, literary, mysterious. Use evocative metaphors.",
    epic:       "Tone: heroic, grand, mythological. Use powerful declarative sentences.",
    scientific: "Tone: analytical, precise, cold. Use clinical observation language.",
    folkloric:  "Tone: oral tradition, poetic, ancient. Use storytelling cadence.",
  }
  const tone = toneInstructions[world.narrator_tone ?? "enigmatic"] ?? toneInstructions["enigmatic"]

  const loreInput = typeof body.lore === "string" ? body.lore.trim() : ""
  const recentNarratives = await getRecentNarrativesForCollection(collectionId, 5)
  const previousContext =
    recentNarratives.length > 0
      ? `\n\nPrevious narrative connections in this world:\n${recentNarratives.map((n, i) => `${i + 1}. ${n.narrative}`).join("\n")}`
      : ""

  const systemPrompt =
    `You are the Narrator of the world "${world.world_name}". ` +
    `World context: ${world.world_prompt}` +
    previousContext +
    `\n\nA new artifact has just been forged in this world` +
    (loreInput ? `: "${loreInput}"` : ".") +
    ` Write exactly 2-3 sentences connecting this artifact to the narrative world. ` +
    `${tone} No headers or markdown.`

  const genAI = new GoogleGenerativeAI(apiKey)
  const model = genAI.getGenerativeModel(
    {
      model: narratorModelId(),
      safetySettings: SAFETY_SETTINGS,
    },
    { apiVersion: "v1beta" },
  )

  let narrative: string
  try {
    const result = await model.generateContent(systemPrompt)
    narrative = result.response.text().trim()
    if (!narrative) {
      return NextResponse.json({ error: "Gemini no devolvió texto" }, { status: 500 })
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[narrator] Gemini failed", { tokenId, collectionId, msg })
    return NextResponse.json({ error: `Gemini error: ${msg}` }, { status: 500 })
  }

  const continuity = await checkNarrativeContinuity(
    world.world_name,
    narrative,
    recentNarratives.map((n) => n.narrative),
  )
  if (continuity && !continuity.consistent) {
    return NextResponse.json(
      { error: `Continuity check failed: ${continuity.reason}`, code: "CONTINUITY_CONTRADICTION" },
      { status: 409 },
    )
  }

  await saveNarrativeForToken(tokenId, {
    narrative,
    collection_id: collectionId,
    lore_input: loreInput,
  })

  // phase-106 (spike): record an additive version-history entry, fire-and-forget
  if (isLoreVersioningEnabled()) {
    void recordLoreVersion(tokenId, { narrative, lore_input: loreInput }).catch(() => { /* silent */ })
  }

  // Notify world creator if provided (fire-and-forget)
  const creatorWallet = typeof body.creator_wallet === "string" ? body.creator_wallet.trim() : ""
  if (creatorWallet) {
    void createNotification(creatorWallet, "narrator_generated", {
      collection_id: collectionId,
      world_name: world.world_name,
      token_id: tokenId,
    }).catch(() => { /* silent */ })
  }

  return NextResponse.json({ ok: true, narrative })
}
