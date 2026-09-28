import type { WorldNarrativeData } from "@/lib/narrative-world-store"

export const FORGE_IMAGE_STYLE_BLOCK =
  " Visual style: cyber-brutalist, isometric 3D, technical blueprint schematic, glowing neon cyan accents on deep black, high fidelity, sharp edges, minimal glitch accents."

export const POLLINATIONS_STYLE_SUFFIX =
  ", dark cyber-brutalist aesthetic, glowing neon cyan, minimalist glitch art, isometric 3d blueprint schematic, high detail"

export type ForgeImageStyleMode = "adaptive" | "cyber"

export function normalizeForgeImageStyleMode(raw: unknown): ForgeImageStyleMode {
  if (typeof raw !== "string") return "adaptive"
  const v = raw.trim().toLowerCase()
  if (v === "cyber" || v === "ai_cyber" || v === "ai-cyber") return "cyber"
  return "adaptive"
}

export function normalizeForgeOutputLang(raw: unknown): "en" | "es" {
  if (typeof raw !== "string") return "en"
  const v = raw.trim().toLowerCase()
  if (v === "es" || v === "spa" || v === "spanish") return "es"
  return "en"
}

export function buildLoreSystemInstruction(
  userPromptTrimmed: string,
  styleMode: ForgeImageStyleMode,
  worldPrompt: string | undefined,
  outputLang: "en" | "es",
  recentLores: WorldNarrativeData[] = [],
): string {
  const worldPrefix =
    outputLang === "es"
      ? worldPrompt ? `Contexto del mundo narrativo: ${worldPrompt}\n\n` : ""
      : worldPrompt ? `Narrative world context: ${worldPrompt}\n\n` : ""

  const loresBlock =
    recentLores.length > 0
      ? outputLang === "es"
        ? `Artefactos previos forjados en este mundo (para mantener coherencia narrativa):\n${recentLores.map((l, i) => `${i + 1}. ${l.narrative}`).join("\n")}\n\n`
        : `Previously forged artifacts in this world (for narrative continuity):\n${recentLores.map((l, i) => `${i + 1}. ${l.narrative}`).join("\n")}\n\n`
      : ""

  const contextBlock = worldPrefix + loresBlock
  const cyber =
    outputLang === "es"
      ? `${contextBlock}Eres el Arquitecto del Protocolo PHASE. Escribe una descripción de máximo 2 oraciones técnicas, oscuras, ciberpunk y enigmáticas sobre el siguiente artefacto forjado por el usuario: ${userPromptTrimmed}`
      : `${contextBlock}You are the PHASE Protocol Architect. Write at most 2 sentences — technical, dark, cyberpunk, and enigmatic — describing the following user-forged artifact: ${userPromptTrimmed}`

  const adaptive =
    outputLang === "es"
      ? `${contextBlock}Eres el Arquitecto del Protocolo PHASE. Escribe una descripción breve (máximo 2 oraciones) alineada a la idea exacta del usuario, sin imponer estética cyber por defecto: ${userPromptTrimmed}`
      : `${contextBlock}You are the PHASE Protocol Architect. Write a brief description (at most 2 sentences) aligned with the user's exact idea, without imposing a cyber aesthetic by default: ${userPromptTrimmed}`

  const base = styleMode === "cyber" ? cyber : adaptive
  const langLine =
    outputLang === "es"
      ? "\n\nResponde únicamente en español. Sin prefijos ni comillas."
      : "\n\nReply in English only. No prefixes or quotation marks."

  return base + langLine
}

export function composeForgeImagePrompt(userPrompt: string, styleMode: ForgeImageStyleMode): string {
  const trimmed = userPrompt.trim()
  if (!trimmed) return ""
  if (styleMode === "cyber") return `${trimmed}.${FORGE_IMAGE_STYLE_BLOCK}`
  return trimmed
}

export function buildPollinationsImageUrl(userPrompt: string, styleMode: ForgeImageStyleMode): string {
  const basePrompt = userPrompt.trim()
  const imagePrompt = styleMode === "cyber" ? `${basePrompt}${POLLINATIONS_STYLE_SUFFIX}` : basePrompt
  return `https://image.pollinations.ai/prompt/${encodeURIComponent(imagePrompt)}?width=1024&height=1024&nologo=true`
}
