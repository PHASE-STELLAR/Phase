import { incSecurityCounter } from "@/lib/security-counters";

export type FocalPoint = {
  x: number; // 0.0 (left) to 1.0 (right)
  y: number; // 0.0 (top) to 1.0 (bottom)
};

export type ImageDimensions = {
  width: number;
  height: number;
};

export type CropRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ImageVariantName =
  | "thumbnail"
  | "preview"
  | "og"
  | "banner"
  | "portrait"
  | "landscape"
  | "square";

export type ImageVariantSpec = {
  name: ImageVariantName;
  width: number;
  height: number;
  aspect: number;
};

export const STANDARD_IMAGE_VARIANTS: Record<ImageVariantName, ImageVariantSpec> = {
  thumbnail: { name: "thumbnail", width: 256, height: 256, aspect: 1.0 },
  preview: { name: "preview", width: 512, height: 512, aspect: 1.0 },
  square: { name: "square", width: 1024, height: 1024, aspect: 1.0 },
  og: { name: "og", width: 1200, height: 630, aspect: 1200 / 630 },
  banner: { name: "banner", width: 1500, height: 500, aspect: 3.0 },
  portrait: { name: "portrait", width: 800, height: 1000, aspect: 0.8 },
  landscape: { name: "landscape", width: 1280, height: 720, aspect: 16 / 9 },
};

function clamp(v: number, min: number, max: number): number {
  if (Number.isNaN(v)) return min;
  return Math.min(Math.max(v, min), max);
}

/**
 * Normalizes focal point coordinates into [0.0, 1.0] range.
 * Defaults to center (0.5, 0.5) if undefined or invalid.
 */
export function normalizeFocalPoint(focal?: Partial<FocalPoint> | null): FocalPoint {
  if (!focal) return { x: 0.5, y: 0.5 };
  const x = typeof focal.x === "number" ? clamp(focal.x, 0.0, 1.0) : 0.5;
  const y = typeof focal.y === "number" ? clamp(focal.y, 0.0, 1.0) : 0.5;
  return { x, y };
}

/**
 * Content-grounded heuristic to estimate initial focal point from prompt or description text.
 */
export function estimateFocalPointFromKeywords(text?: string): FocalPoint {
  if (!text) return { x: 0.5, y: 0.5 };
  const lower = text.toLowerCase();
  let x = 0.5;
  let y = 0.5;

  if (lower.includes("portrait") || lower.includes("face") || lower.includes("avatar") || lower.includes("headshot")) {
    y = 0.35; // portraits generally have faces in top-center third
  } else if (lower.includes("sky") || lower.includes("celestial") || lower.includes("stars") || lower.includes("clouds")) {
    y = 0.3;
  } else if (lower.includes("ground") || lower.includes("floor") || lower.includes("terrain") || lower.includes("boots")) {
    y = 0.7;
  }

  if (lower.includes("left side") || lower.includes("on the left")) {
    x = 0.3;
  } else if (lower.includes("right side") || lower.includes("on the right")) {
    x = 0.7;
  }

  incSecurityCounter("image_crop_focal_computed");
  return { x, y };
}

/**
 * Calculates focal-point-preserving bounding box for a crop matching target aspect ratio.
 */
export function calculateFocalCrop(
  src: ImageDimensions,
  targetAspect: number,
  focal?: Partial<FocalPoint> | null,
): CropRect {
  const fp = normalizeFocalPoint(focal);
  const srcW = Math.max(1, Math.round(src.width));
  const srcH = Math.max(1, Math.round(src.height));
  const srcAspect = srcW / srcH;

  let cropW: number;
  let cropH: number;

  if (srcAspect > targetAspect) {
    // Source is wider than target aspect ratio -> fit height, crop width
    cropH = srcH;
    cropW = Math.max(1, Math.min(srcW, Math.round(cropH * targetAspect)));
  } else {
    // Source is taller than target aspect ratio -> fit width, crop height
    cropW = srcW;
    cropH = Math.max(1, Math.min(srcH, Math.round(cropW / targetAspect)));
  }

  // Position crop box centered on focal point coordinates in pixels
  const focalPixelX = srcW * fp.x;
  const focalPixelY = srcH * fp.y;

  let cropX = Math.round(focalPixelX - cropW / 2);
  let cropY = Math.round(focalPixelY - cropH / 2);

  // Constrain crop rectangle within source image boundaries
  cropX = clamp(cropX, 0, srcW - cropW);
  cropY = clamp(cropY, 0, srcH - cropH);

  incSecurityCounter("image_crop_focal_computed");
  return { x: cropX, y: cropY, width: cropW, height: cropH };
}

/**
 * Builds responsive variant URL with query transform parameters.
 */
export function buildVariantUrl(
  baseUri: string,
  variant: ImageVariantName | { width: number; height: number; fit?: string },
  focal?: Partial<FocalPoint>,
): string {
  const fp = normalizeFocalPoint(focal);
  const [cleanUri, queryStr] = baseUri.split("?");
  const params = new URLSearchParams(queryStr ?? "");

  if (typeof variant === "string") {
    const spec = STANDARD_IMAGE_VARIANTS[variant] ?? STANDARD_IMAGE_VARIANTS.thumbnail;
    params.set("variant", spec.name);
    params.set("w", String(spec.width));
    params.set("h", String(spec.height));
  } else {
    params.set("w", String(variant.width));
    params.set("h", String(variant.height));
    if (variant.fit) params.set("fit", variant.fit);
  }

  params.set("fit", "crop");
  params.set("fx", fp.x.toFixed(2));
  params.set("fy", fp.y.toFixed(2));

  incSecurityCounter("image_variant_generated");
  return `${cleanUri}?${params.toString()}`;
}

/**
 * Parses image transform query parameters from request query.
 */
export function parseTransformParams(
  query: URLSearchParams | Record<string, string | string[] | undefined>,
): {
  variant?: ImageVariantName;
  width?: number;
  height?: number;
  fit?: string;
  focal: FocalPoint;
} {
  const getVal = (k: string): string | undefined => {
    if (query instanceof URLSearchParams) return query.get(k) ?? undefined;
    const v = query[k];
    return Array.isArray(v) ? v[0] : v;
  };

  const variantStr = getVal("variant");
  const variant = (variantStr && variantStr in STANDARD_IMAGE_VARIANTS)
    ? (variantStr as ImageVariantName)
    : undefined;

  let width = getVal("w") ? parseInt(getVal("w")!, 10) : undefined;
  let height = getVal("h") ? parseInt(getVal("h")!, 10) : undefined;

  if (variant && (!width || !height)) {
    const spec = STANDARD_IMAGE_VARIANTS[variant];
    width = spec.width;
    height = spec.height;
  }

  const fx = getVal("fx") ? parseFloat(getVal("fx")!) : 0.5;
  const fy = getVal("fy") ? parseFloat(getVal("fy")!) : 0.5;

  return {
    variant,
    width: width && !Number.isNaN(width) && width > 0 ? width : undefined,
    height: height && !Number.isNaN(height) && height > 0 ? height : undefined,
    fit: getVal("fit") ?? "crop",
    focal: normalizeFocalPoint({ x: fx, y: fy }),
  };
}

/**
 * Generates multi-aspect metadata variants suitable for artifact JSON.
 */
export function generateArtifactVariants(
  imageUri: string,
  dimensions: Partial<ImageDimensions> = {},
  focal?: Partial<FocalPoint>,
): Record<string, { uri: string; width: number; height: number; crop: CropRect }> {
  const dims: ImageDimensions = {
    width: dimensions.width ?? 2048,
    height: dimensions.height ?? 2048,
  };
  const fp = normalizeFocalPoint(focal);
  const out: Record<string, { uri: string; width: number; height: number; crop: CropRect }> = {};

  for (const [key, spec] of Object.entries(STANDARD_IMAGE_VARIANTS)) {
    const crop = calculateFocalCrop(dims, spec.aspect, fp);
    const variantUri = buildVariantUrl(imageUri, spec.name, fp);
    out[key] = {
      uri: variantUri,
      width: spec.width,
      height: spec.height,
      crop,
    };
  }

  return out;
}
