import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Combines clsx class definitions with tailwind-merge to safely resolve
 * conflicting Tailwind CSS classes across Tailwind v3 and v4 syntax.
 */
export function cn(...inputs: ClassValue[]): string {
  try {
    const formatted = clsx(inputs)
    if (!formatted) return ''
    return twMerge(formatted)
  } catch {
    try {
      return clsx(inputs)
    } catch {
      return ''
    }
  }
}

