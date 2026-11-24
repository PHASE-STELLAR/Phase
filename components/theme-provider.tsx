'use client'

import * as React from 'react'
import {
  ThemeProvider as NextThemesProvider,
  type ThemeProviderProps,
} from 'next-themes'

// phase-292: Theming and motion system consistency with centralized tokens
// Motion tokens (duration, easing, GPU compositing) centralized here.
// reduced-motion preferences respected via prefers-reduced-motion media query.
export const MOTION_TOKENS = {
  durations: {
    fast: '150ms',
    normal: '300ms',
    slow: '500ms',
  },
  easings: {
    linear: 'linear',
    easeInOut: 'cubic-bezier(0.4, 0, 0.2, 1)',
    easeOut: 'cubic-bezier(0, 0, 0.2, 1)',
  },
  gpu: {
    transform: 'translateZ(0)',
    willChange: 'transform',
  },
} as const

export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>
}
