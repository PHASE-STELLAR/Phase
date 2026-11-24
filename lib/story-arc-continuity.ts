import { GoogleGenerativeAI, HarmBlockThreshold, HarmCategory } from "@google/generative-ai"
import { z } from "zod"

// ─── phase-107: AI story-arc continuity validator across artifacts ─────────
// Isolated, flag-gated. Generated arcs could contradict earlier established
// lore in the same world with no check. When enabled, a newly generated
// narrative is checked against the world's most recent narratives using the
// same Gemini client already wired for narration (app/api/narrator/route.ts).
// On any config/parse error the check is skipped (fail-open) — it never
// blocks generation, it only flags an explicit contradiction.
// When flag off, checkNarrativeContinuity() is not called (zero regression).
// Rollback: unset NEXT_PUBLIC_FEATURE_PHASE_107 / FEATURE_PHASE_107.

export function isPhase107Enabled(): boolean {
  const v = (process.env.NEXT_PUBLIC_FEATURE_PHASE_107 ?? process.env.FEATURE_PHASE_107 ?? "").trim().toLowerCase()
  return v === "1" || v === "true" || v === "yes" || v === "on"
}

export function flag107RollbackNote(): string {
  return "Rollback phase-107: unset NEXT_PUBLIC_FEATURE_PHASE_107 / FEATURE_PHASE_107 and restart. No data migration to revert."
}

const ContinuityCheckResultSchema = z.object({
  consistent: z.boolean(),
  reason: z.string().max(400),
})

export type ContinuityCheckResult = z.infer<typeof ContinuityCheckResultSchema>

function continuityGeminiApiKey(): string | null {
  const studio = process.env.GOOGLE_AI_STUDIO_API_KEY?.trim().replace(/^["']|["']$/g, "")
  const legacy = process.env.GEMINI_API_KEY?.trim().replace(/^["']|["']$/g, "")
  const key = studio?.startsWith("AIza") && studio.length >= 35 ? studio : legacy
  return key && key.length >= 35 ? key : null
}

function continuityModelId(): string {
  const fromEnv = process.env.GEMINI_MODEL?.trim().replace(/^models\//i, "").trim()
  if (fromEnv && fromEnv.length > 0 && !fromEnv.startsWith("gemini-1.5")) return fromEnv
  return "gemini-2.0-flash"
}

const SAFETY_SETTINGS = (
  [
    HarmCategory.HARM_CATEGORY_HATE_SPEECH,
    HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
    HarmCategory.HARM_CATEGORY_HARASSMENT,
    HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
    HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY,
  ] as const
).map((category) => ({ category, threshold: HarmBlockThreshold.BLOCK_NONE }))

function extractJson(text: string): unknown {
  const match = text.match(/\{[\s\S]*\}/)
  return JSON.parse(match ? match[0] : text)
}

/**
 * Checks whether a newly generated narrative contradicts the world's most
 * recent narratives (established lore). Returns null when the flag is off,
 * the AI client is unconfigured, or the check itself fails — callers should
 * treat null as "skip check" and proceed, never as a block.
 */
export async function checkNarrativeContinuity(
  worldName: string,
  newNarrative: string,
  previousNarratives: string[],
): Promise<ContinuityCheckResult | null> {
  if (!isPhase107Enabled()) return null
  if (previousNarratives.length === 0) return null

  const apiKey = continuityGeminiApiKey()
  if (!apiKey) return null

  const prompt =
    `You are a continuity checker for the narrative world "${worldName}". ` +
    `Established lore (most recent first):\n${previousNarratives.map((n, i) => `${i + 1}. ${n}`).join("\n")}\n\n` +
    `New artifact narrative to check:\n"${newNarrative}"\n\n` +
    `Does the new narrative directly contradict a specific fact stated in the established lore ` +
    `(e.g. a name, event, or outcome asserted differently)? Ignore stylistic or tonal differences. ` +
    `Respond with ONLY a JSON object, no markdown: {"consistent": boolean, "reason": string}`

  try {
    const genAI = new GoogleGenerativeAI(apiKey)
    const model = genAI.getGenerativeModel(
      { model: continuityModelId(), safetySettings: SAFETY_SETTINGS },
      { apiVersion: "v1beta" },
    )
    const result = await model.generateContent(prompt)
    const text = result.response.text().trim()
    const parsed = ContinuityCheckResultSchema.parse(extractJson(text))
    return parsed
  } catch {
    // Fail-open: AI unavailable or response unparseable — never block generation.
    return null
  }
}
