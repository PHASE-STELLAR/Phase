/**
 * Dynamic i18n Dictionary Loader (Issue #44)
 * Replaces monolithic lib/phase-copy.ts with modular JSON dictionaries
 * 
 * Benefits:
 * - Reduces initial bundle size by ~80KB
 * - Enables on-demand loading of language dictionaries
 * - Supports dynamic language addition without rebuild
 * - Provides fallback mechanism for missing translations
 */

import type { AppLang } from "@/components/lang-context"

export type TranslationDomain =
  | "common"
  | "chamber"
  | "artifacts"
  | "forge"
  | "profile"
  | "signals"
  | "marketplace"
  | "wallet"

type TranslationDictionary = Record<string, string | Record<string, string>>

// In-memory cache for loaded translations
const translationCache = new Map<string, TranslationDictionary>()

// Track loading state to prevent duplicate fetches
const loadingPromises = new Map<string, Promise<TranslationDictionary>>()

/**
 * Load a translation dictionary for a specific domain and language
 * Uses caching to avoid redundant network requests
 */
export async function loadTranslations(
  domain: TranslationDomain,
  lang: AppLang,
): Promise<TranslationDictionary> {
  const cacheKey = `${lang}:${domain}`

  // Return cached version if available
  if (translationCache.has(cacheKey)) {
    return translationCache.get(cacheKey)!
  }

  // Return in-flight promise if already loading
  if (loadingPromises.has(cacheKey)) {
    return loadingPromises.get(cacheKey)!
  }

  // Start new load
  const loadPromise = (async () => {
    try {
      const response = await fetch(`/locales/${lang}/${domain}.json`, {
        cache: "force-cache", // Aggressive caching for immutable content
      })

      if (!response.ok) {
        throw new Error(`Failed to load ${lang}/${domain}: ${response.status}`)
      }

      const data = await response.json()
      translationCache.set(cacheKey, data)
      return data
    } catch (error) {
      console.error(`[i18n] Failed to load translations for ${cacheKey}:`, error)
      
      // Return empty object as fallback to prevent app crashes
      const fallback: TranslationDictionary = {}
      translationCache.set(cacheKey, fallback)
      return fallback
    } finally {
      loadingPromises.delete(cacheKey)
    }
  })()

  loadingPromises.set(cacheKey, loadPromise)
  return loadPromise
}

/**
 * Get a translated string with fallback support
 * Automatically loads the dictionary if not in cache
 */
export async function translate(
  key: string,
  domain: TranslationDomain,
  lang: AppLang,
  fallback?: string,
): Promise<string> {
  const translations = await loadTranslations(domain, lang)
  
  // Support nested keys (e.g., "wallet.connect.label")
  const keys = key.split(".")
  let value: any = translations
  
  for (const k of keys) {
    if (value && typeof value === "object" && k in value) {
      value = value[k]
    } else {
      // Key not found - log in development and return fallback
      if (process.env.NODE_ENV === "development") {
        console.warn(`[i18n] Missing translation: ${domain}.${key} (${lang})`)
      }
      return fallback || key
    }
  }
  
  return typeof value === "string" ? value : (fallback || key)
}

/**
 * Preload translations for a specific language
 * Useful for optimizing perceived performance on language switch
 */
export async function preloadLanguage(
  lang: AppLang,
  domains: TranslationDomain[] = ["common"],
): Promise<void> {
  await Promise.all(domains.map(domain => loadTranslations(domain, lang)))
}

/**
 * Clear translation cache (useful for testing or forced refresh)
 */
export function clearTranslationCache(): void {
  translationCache.clear()
  loadingPromises.clear()
}

/**
 * Get cache statistics for monitoring bundle size reduction
 */
export function getTranslationCacheStats(): {
  cachedDomains: number
  totalKeys: number
  memoryEstimate: string
} {
  let totalKeys = 0
  let totalBytes = 0

  for (const [key, dict] of translationCache.entries()) {
    const keyCount = countKeys(dict)
    totalKeys += keyCount
    totalBytes += JSON.stringify(dict).length
  }

  return {
    cachedDomains: translationCache.size,
    totalKeys,
    memoryEstimate: `${(totalBytes / 1024).toFixed(2)} KB`,
  }
}

function countKeys(obj: any): number {
  if (typeof obj !== "object" || obj === null) return 0
  let count = 0
  for (const key in obj) {
    count++
    if (typeof obj[key] === "object") {
      count += countKeys(obj[key])
    }
  }
  return count
}

/**
 * Hook-friendly synchronous getter (requires translations to be preloaded)
 * Returns the translation if cached, otherwise returns the key or fallback
 */
export function getTranslationSync(
  key: string,
  domain: TranslationDomain,
  lang: AppLang,
  fallback?: string,
): string {
  const cacheKey = `${lang}:${domain}`
  const translations = translationCache.get(cacheKey)
  
  if (!translations) {
    if (process.env.NODE_ENV === "development") {
      console.warn(`[i18n] Domain ${domain} not loaded for ${lang}. Call loadTranslations() first.`)
    }
    return fallback || key
  }
  
  const keys = key.split(".")
  let value: any = translations
  
  for (const k of keys) {
    if (value && typeof value === "object" && k in value) {
      value = value[k]
    } else {
      return fallback || key
    }
  }
  
  return typeof value === "string" ? value : (fallback || key)
}
