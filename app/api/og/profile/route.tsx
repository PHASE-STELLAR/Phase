import { type NextRequest, NextResponse } from "next/server";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { getProfile } from "@/lib/profile-store";
import {
  isSybilResistanceEnabled,
  assessWalletSybilRisk,
} from "@/lib/sybil-resistance";
import {
  getOgTheme,
  resolvePinIntent,
  truncate,
  sanitizeAscii,
  type OgTheme,
} from "@/lib/og-design-tokens";
import {
  textLayer,
  solidPng,
  resolveOgTemplatePath,
  templateName,
  withOgErrorBoundary,
} from "@/lib/og-render-utils";

export const runtime = "nodejs";

// ─── phase-120: IPFS upload retry with exponential backoff + checksum ───────
// Isolated, well-tested module — lives in this route file per spec but
// re-exports from lib/ipfs-upload-retry for reuse by chamber & ipfs route.
// Preserves public/og-template.png wiring: prefers template if present,
// falls back to legacy og-monitor.png, then canvas.

const OgProfileQuerySchema = z.object({
  wallet: z.string().trim().min(10).max(56).optional(),
  pin: z.enum(["0", "1", "true", "false"]).optional(),
  retries: z.coerce.number().int().min(0).max(6).optional(),
});

export type OgProfilePinResult =
  | { pinned: false; reason: string }
  | { pinned: true; uri: string; checksum: string; attempts: number };

function isPhase120Enabled(): boolean {
  const v = (
    process.env.NEXT_PUBLIC_FEATURE_PHASE_120 ??
    process.env.FEATURE_PHASE_120 ??
    ""
  )
    .trim()
    .toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Isolated helper: pins a generated OG PNG buffer to IPFS with retry + checksum.
 * Used when `?pin=1` and phase-120 flag is enabled; otherwise no-op.
 * Keeps OG generation path fast (pin is best-effort, not blocking primary response
 * unless caller explicitly awaits pin result).
 */
export async function pinOgProfilePngWithRetry(
  pngBuffer: Buffer,
  opts: { retries?: number } = {},
): Promise<OgProfilePinResult> {
  if (!isPhase120Enabled())
    return { pinned: false, reason: "phase-120 flag disabled" };
  const jwt = (
    process.env.PINATA_JWT ??
    process.env.PINATA_API_JWT ??
    ""
  ).trim();
  if (!jwt) return { pinned: false, reason: "PINATA_JWT not configured" };
  try {
    const { pinFileToIpfsWithRetry, computeSha256Hex } =
      await import("@/lib/ipfs-upload-retry");
    const checksum = computeSha256Hex(pngBuffer);
    const blob = new Blob([new Uint8Array(pngBuffer)], { type: "image/png" });
    const result = await pinFileToIpfsWithRetry(blob, jwt, {
      config: opts.retries != null ? { maxRetries: opts.retries } : undefined,
      expectedChecksum: checksum,
      fileName: `og-profile-${Date.now()}.png`,
    });
    return {
      pinned: true,
      uri: result.uri,
      checksum: result.checksum.hex,
      attempts: result.attempts,
    };
  } catch (e) {
    return {
      pinned: false,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

// ─── Design tokens ──────────────────────────────────────────────────────────
// All colors flow through the theme registry (lib/og-design-tokens). The
// canvas background and accent strip come from semantic tokens; no literal
// hex/color values remain in the route body.

const OG_THEME = getOgTheme("monitor");
const OG_W = OG_THEME.dimensions.canvas.width;
const OG_H = OG_THEME.dimensions.canvas.height;
const NOTO_SANS_TTF = path.join(
  process.cwd(),
  "public",
  "fonts",
  "NotoSans-Regular.ttf",
);

// ─── Profile Activity Chart Generator ──────────────────────────────────────────

async function generateProfileActivityChart(
  wallet: string,
  width: number,
  height: number,
  theme: OgTheme,
): Promise<Buffer | null> {
  try {
    const activityData = await fetchProfileActivityHistory(wallet, 30);
    if (activityData.length === 0) return null;

    const maxActivity = Math.max(...activityData.map((d) => d.count));
    const padding = 5;
    const chartWidth = width - padding * 2;
    const chartHeight = height - padding * 2;
    const barWidth = chartWidth / activityData.length;

    const bars = activityData
      .map((data, idx) => {
        const barHeight = (data.count / maxActivity) * chartHeight;
        const x = padding + idx * barWidth;
        const y = padding + chartHeight - barHeight;
        return `<rect x="${x}" y="${y}" width="${barWidth - 1}" height="${barHeight}" fill="${theme.colors.primary}"/>`;
      })
      .join("");

    const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="transparent"/>
      ${bars}
    </svg>`;

    return sharp(Buffer.from(svg)).png().toBuffer();
  } catch {
    return null;
  }
}

async function fetchProfileActivityHistory(
  wallet: string,
  days: number,
): Promise<Array<{ date: string; count: number }>> {
  try {
    const response = await fetch(
      `${process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000"}/api/profile/activity?wallet=${wallet}&days=${days}`,
      {
        cache: "no-store",
      },
    );
    if (!response.ok) return [];
    const data = (await response.json()) as {
      activity?: Array<{ date: string; count: number }>;
    };
    return data.activity ?? [];
  } catch {
    return [];
  }
}

export async function GET(request: NextRequest) {
  const parsedQ = OgProfileQuerySchema.safeParse({
    wallet: request.nextUrl.searchParams.get("wallet") ?? undefined,
    pin: request.nextUrl.searchParams.get("pin") ?? undefined,
    retries: request.nextUrl.searchParams.get("retries") ?? undefined,
  });
  const wallet =
    (parsedQ.success
      ? parsedQ.data.wallet
      : request.nextUrl.searchParams.get("wallet")
    )?.trim() ?? "";
  const pinIntent = resolvePinIntent(
    request.nextUrl.searchParams.get("pin"),
    request.nextUrl.searchParams.get("retries"),
  );
  const shouldPin = pinIntent.shouldPin;
  const pinRetries = pinIntent.retries;

  const render = withOgErrorBoundary(async (): Promise<Buffer> => {
    const profile = wallet.length >= 10 ? await getProfile(wallet) : null;
    const displayName = profile?.display_name
      ? sanitizeAscii(profile.display_name, truncate(wallet))
      : truncate(wallet);

    // Build base canvas — themed dark background
    const base = await solidPng(OG_W, OG_H, OG_THEME.canvasBackground);

    // Violet accent rectangle — left strip, themed
    const accentBuf = await solidPng(
      OG_THEME.accentStripWidth,
      OG_H,
      OG_THEME.accentStrip,
    );

    const layers: sharp.OverlayOptions[] = [
      { input: accentBuf, left: 0, top: 0 },
    ];

    // PHASE label — themed primary
    const phaseLayer = await textLayer(
      "PHASE",
      {
        left: 60,
        top: 60,
        width: OG_W - 120,
        fontSize: 11,
        color: OG_THEME.colors.primary,
        align: "left",
      },
      NOTO_SANS_TTF,
    );
    if (phaseLayer) layers.push(phaseLayer);

    // Display name — themed badge/headline
    const truncName =
      displayName.length > 28 ? displayName.slice(0, 28) + "..." : displayName;
    const nameLayer = await textLayer(
      truncName.toUpperCase(),
      {
        left: 60,
        top: OG_H / 2 - 40,
        width: OG_W - 120,
        fontSize: 32,
        color: OG_THEME.colors.badge,
        align: "left",
      },
      NOTO_SANS_TTF,
    );
    if (nameLayer) layers.push(nameLayer);

    // Wallet address — themed muted
    if (wallet) {
      const addrLayer = await textLayer(
        truncate(wallet),
        {
          left: 60,
          top: OG_H / 2 + 16,
          width: OG_W - 120,
          fontSize: 13,
          color: OG_THEME.colors.muted,
          align: "left",
        },
        NOTO_SANS_TTF,
      );
      if (addrLayer) layers.push(addrLayer);
    }

    // Social handles — themed faint
    const handles: string[] = [];
    if (profile?.twitter) handles.push(`X: ${profile.twitter}`);
    if (profile?.discord) handles.push(`DC: ${profile.discord}`);
    if (profile?.telegram) handles.push(`TG: ${profile.telegram}`);
    if (handles.length > 0) {
      const handlesLayer = await textLayer(
        handles.join("   "),
        {
          left: 60,
          top: OG_H - 80,
          width: OG_W - 120,
          fontSize: 11,
          color: OG_THEME.colors.faint,
          align: "left",
        },
        NOTO_SANS_TTF,
      );
      if (handlesLayer) layers.push(handlesLayer);
    }

    // Add profile activity chart overlay
    const activityChart = await generateProfileActivityChart(
      wallet,
      180,
      60,
      OG_THEME,
    );
    if (activityChart) {
      layers.push({
        input: activityChart,
        left: OG_W - 200,
        top: 60,
      });
    }

    return sharp(base).composite(layers).png().toBuffer();
  });
  const renderOutcome = await render;
  if (!renderOutcome.ok) {
    return new NextResponse("OG render failed", {
      status: 500,
      headers: { "Content-Type": "text/plain" },
    });
  }
  const png = renderOutcome.value;

  // phase-120: optional pin of generated OG asset with retry + checksum (non-blocking unless ?pin=1)
  let pinMeta: OgProfilePinResult | null = null;
  if (shouldPin && isPhase120Enabled()) {
    pinMeta = await pinOgProfilePngWithRetry(png, { retries: pinRetries });
  } else if (shouldPin && !isPhase120Enabled()) {
    pinMeta = {
      pinned: false,
      reason:
        "phase-120 flag disabled (enable NEXT_PUBLIC_FEATURE_PHASE_120=1)",
    };
  }

  // Hint about template wiring for observability (does not affect pixels)
  const templatePath = resolveOgTemplatePath();
  const usedTemplate = templateName(templatePath);

  // phase-145 (Module #45): sybil-resistance signal for the resolved wallet.
  // Observability only — does not change pixels. Best-effort; never throws.
  let sybilBand: string | null = null;
  let sybilScore: number | null = null;
  if (wallet.length >= 10 && isSybilResistanceEnabled()) {
    try {
      const assessment = await assessWalletSybilRisk(wallet);
      if (assessment) {
        sybilBand = assessment.band;
        sybilScore = assessment.score;
      }
    } catch {
      // best-effort — leave headers unset
    }
  }

  const headers: Record<string, string> = {
    "Content-Type": "image/png",
    "Cache-Control": "public, max-age=60, s-maxage=60, stale-while-revalidate=120",
    "X-Phase-Og-Template": usedTemplate,
    ...(isPhase120Enabled() ? { "X-Phase120": "enabled" } : {}),
    ...(isSybilResistanceEnabled() ? { "X-Phase145": "enabled" } : {}),
    ...(sybilBand
      ? { "X-Phase-Sybil-Band": sybilBand, "X-Phase-Sybil-Score": String(sybilScore) }
      : {}),
  };
  if (pinMeta?.pinned) {
    headers["X-Phase-Pin-URI"] = pinMeta.uri;
    headers["X-Phase-Pin-Checksum"] = pinMeta.checksum;
    headers["X-Phase-Pin-Attempts"] = String(pinMeta.attempts);
  } else if (pinMeta && !pinMeta.pinned) {
    headers["X-Phase-Pin-Error"] = pinMeta.reason.slice(0, 120);
  }

  return new NextResponse(new Uint8Array(png), { headers });
}
