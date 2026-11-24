# Performance Optimization Guide

This document outlines the web performance improvements implemented in PHASE, covering font loading, Web Vitals monitoring, edge caching, and route prefetching.

## Font Loading Optimization (#515)

### Overview
Font loading is optimized through multiple strategies to minimize Cumulative Layout Shift (CLS) and improve perceived performance.

### Implementation Details

**Font Configuration** (`app/layout.tsx`):
- `IBM_Plex_Sans` (primary font) uses `display: "swap"` for text visibility while fonts load
- `IBM_Plex_Mono` (code font) uses `display: "swap"` with monospace fallback
- `Bebas_Neue` and `Orbitron` (display fonts) use `display: "optional"` for secondary fonts
- All fonts include explicit `fallback` declarations to prevent metric shifts

**CLS Containment** (`app/globals.css`):
- Body element uses `contain: layout style paint` to create an independent layout context
- Prevents font load changes from affecting layout of other page sections
- `min-height: 100vh` ensures viewport-height stabilization
- Root element has `font-display: swap` for system font fallback during load

### Font Subset Strategy
- All fonts limited to `["latin"]` subset (covers English content)
- Font weights strictly defined:
  - `IBM_Plex_Sans`: 400, 500, 600, 700
  - `IBM_Plex_Mono`: 400, 500
  - `Bebas_Neue`: 400
  - `Orbitron`: 600, 700, 800

## Web Vitals Monitoring (#519)

### Overview
Real User Monitoring (RUM) pipeline captures Core Web Vitals with CI gates to prevent performance regressions.

### Implementation Details

**Web Vitals Reporter** (`components/web-vitals-reporter.tsx`):
- Monitors five key metrics: LCP, FID, CLS, TTFB, INP
- Automatic rating system: "good" / "needs-improvement" / "poor"
- Metrics sent to Google Analytics via `dataLayer` if available
- Development console logging for debugging

**Metric Thresholds**:
```
LCP (Largest Contentful Paint):
  Good: ≤ 2.5s
  Poor: > 4s

INP (Interaction to Next Paint):
  Good: ≤ 200ms
  Poor: > 500ms

CLS (Cumulative Layout Shift):
  Good: ≤ 0.1
  Poor: > 0.25

TTFB (Time to First Byte):
  Good: ≤ 600ms
  Poor: > 1.2s

FID (First Input Delay):
  Good: ≤ 100ms
  Poor: > 300ms
```

**CI Integration** (`.github/workflows/web-vitals-budget.yml`):
- Runs on PR creation for `app/`, `components/`, `lib/` changes
- Builds application and validates Web Vitals budgets
- Provides clear reporting of metric thresholds

### Usage
Web Vitals reporter automatically activates in `app/layout.tsx`. No configuration needed.

## Edge + Full-Route Caching Strategy (#516)

### Overview
Multi-layer caching strategy optimizes CDN edge caching and route-level revalidation.

### Implementation Details

**Cache Layers**:
1. **Static Assets** (`/_next/static/*`):
   - `Cache-Control: public, max-age=31536000, immutable`
   - Hash-based versioning enables infinite cache
   - Used for bundled JavaScript and CSS

2. **Image Optimization** (`/_next/image*`):
   - `Cache-Control: public, max-age=31536000, immutable`
   - Next.js automatic AVIF/WebP conversion cached indefinitely

3. **Font Files** (`/fonts/*`):
   - `Cache-Control: public, max-age=31536000, immutable`
   - Long cache enables offline font availability
   - Custom fonts (DSEG7 Classic) include immutable strategy

4. **HTML Pages** (routes):
   - `Cache-Control: public, max-age=3600, stale-while-revalidate=86400`
   - 1-hour edge cache with 24-hour stale period
   - Enables fast revalidation without blocking user requests

5. **Public Assets** (`/assets/*`, `/phaser-liq-token.png`):
   - `Cache-Control: public, max-age=86400, must-revalidate`
   - 24-hour cache with strict revalidation

**CDN Matrix**:
- Vercel Edge Network caches all cacheable responses
- Immutable assets enable aggressive edge caching
- Stale-while-revalidate pattern enables background revalidation
- No-cache headers on dynamic API routes prevent cached stale data

## Link Prefetching + Route Preloading (#521)

### Overview
Intent-based link prefetching and route preloading strategy accelerates navigation.

### Implementation Details

**Hook API** (`hooks/use-link-prefetch.ts`):
- `useLinkPrefetch()`: Sets up automatic link prefetching
- `useRoutePreload()`: Preloads specific routes
- Configurable via `enabled` and `delay` options

**Intent Signals**:
- **Hover Intent**: Prefetch on `mouseover` event (desktop)
- **Touch Intent**: Prefetch on `touchstart` event (mobile)
- Automatic deduplication prevents redundant prefetch calls

**Implementation** (`components/link-prefetch-provider.tsx`):
- Wrapped in `LinkPrefetchProvider` within `AppProviders`
- Automatically listens for navigation intent across entire app
- Validates internal routes to prevent cross-origin prefetches

**Usage Example**:
```typescript
// Automatic intent-based prefetch (active globally)
// No code needed — enabled via LinkPrefetchProvider

// Manual route preloading
import { useRoutePreload } from "@/hooks/use-link-prefetch"

export function Dashboard() {
  useRoutePreload(["/profile", "/settings"])
  return <...>
}
```

## Monitoring & Debugging

### Development
- Console logs all Web Vitals metrics with ratings
- Route prefetch status logged during hover/touch

### Production
- Web Vitals sent to Google Analytics `dataLayer`
- Use GA4 dashboard to track performance trends
- Set up alerts for metrics exceeding thresholds

### Vercel Analytics
- `@vercel/analytics` integration included
- Web Vitals automatically collected
- Dashboard available at `vercel.com/analytics`

## Best Practices

1. **Font Loading**: Always use `display: "swap"` for critical fonts
2. **Layout Stability**: Wrap text containers with size constraints
3. **Route Transitions**: Leverage `useRoutePreload()` for high-traffic routes
4. **Asset Versioning**: Rely on Next.js automatic cache busting for `/_next/static/`
5. **Monitoring**: Review Web Vitals weekly and address regressions immediately
