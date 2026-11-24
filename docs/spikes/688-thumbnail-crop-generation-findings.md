# Spike 688 — AI Thumbnail & Crop Generation with Focal-Point-Aware Variants Findings (Issue #551)

## What the issue claimed

The issue asserted that the image pipeline requests fixed 1:1 2K aspect masters only, publisher metadata has only a single image URL slot with no variant fields, IPFS byte-serving proxy ignores transform query params, and browser CSS-crops 2K masters for grid cells burning bandwidth.

## What the code actually did at spike time

- `lib/forge/ai-pipeline.ts` and `prompt-builder.ts` indeed generated single high-resolution masters (`2048x2048` or 1:1) with no multi-aspect variations.
- `lib/forge/ipfs-publisher.ts` published metadata with a single top-level `image` field and no pre-computed aspect ratios or focal point metadata.
- `app/api/ipfs/[...cid]/route.ts` served raw content without query parameter processing or content-aware transform hints.
- `components/ipfs-display-img.tsx` loaded the raw master image URI into the `<img>` tag across all viewports and grid cells.

## The gap that was real

Client browsers were downloading full 2K master images for small grid cells and preview cards, and cropping naively to standard aspect ratios (e.g., 16:9 banner, 4:5 portrait) often cut off the visual subject or focal point of the artwork.

## Delivered specification (phase-142)

1. **Focal crop math (`lib/focal-crop.ts`)**:
   - `calculateFocalCrop(src, targetAspect, focal)`: Computes the maximum crop box constrained within source bounds centered on focal point coordinates `(fx, fy)` in `[0.0, 1.0]`.
   - `estimateFocalPointFromKeywords(prompt)`: Heuristic keyword-grounded focal detection for prompt tags.
   - `STANDARD_IMAGE_VARIANTS`: Standardized dimensions for `thumbnail` (256x256), `preview` (512x512), `og` (1200x630), `banner` (1500x500), `portrait` (800x1000), `landscape` (1280x720).
2. **Metadata enrichment (`lib/forge/ipfs-publisher.ts`)**:
   - Generates `properties.variants` mapping variant names to URLs and crop bounding boxes.
3. **Route & Component integration**:
   - `app/api/ipfs/[...cid]/route.ts` parses `variant`, `w`, `h`, `fx`, `fy` and sets `X-Phase-Image-Variant` and `X-Phase-Focal-Crop` headers.
   - `components/ipfs-display-img.tsx` supports `variant` and `focalPoint` props to request optimized variant paths.

## Decision & Rollback

- Enabled behind feature flag `phase-142` (`NEXT_PUBLIC_FEATURE_PHASE_142` / `FEATURE_PHASE_142`).
- Default off; zero regression when flag is disabled.
- Rollback: unset environment variable and restart.
