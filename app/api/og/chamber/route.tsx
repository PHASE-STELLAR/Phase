import { type NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import {
  fetchCollectionInfo,
  extractIpfsGatewaySubpath,
  fetchTokenUriString,
  fetchTokenMetadataDisplay,
} from "@/lib/phase-protocol";
import { publicPhaseSiteBaseUrl } from "@/lib/phase-nft-metadata-build";
import {
  getOgTheme,
  resolvePinIntent,
  type OgTheme,
} from "@/lib/og-design-tokens";
import {
  resolveOgTemplatePath,
  templateName,
  textLayer,
  fetchImageBuffer,
  safeDisplayName,
  withOgErrorBoundary,
} from "@/lib/og-render-utils";
import { isSybilResistanceEnabled } from "@/lib/sybil-resistance";

export const runtime = "nodejs";

// ─── phase-120: shared retry wiring (chamber also benefits) ────────────────
// Preserves public/og-template.png wiring; prefers template over legacy monitor.
// Chamber and profile share the same retry+checksum helper via lib/ipfs-upload-retry.

const OgChamberQuerySchema = z.object({
  token_id: z.coerce.number().int().min(1).optional(),
  token: z.coerce.number().int().min(1).optional(),
  collection: z.coerce.number().int().min(1).optional(),
  pin: z.enum(["0", "1", "true", "false"]).optional(),
  retries: z.coerce.number().int().min(0).max(6).optional(),
});

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

function resolveChamberTemplatePath(): string {
  return resolveOgTemplatePath();
}

export async function pinOgChamberPngWithRetry(
  pngBuffer: Buffer,
  opts: { retries?: number } = {},
): Promise<{
  pinned: boolean;
  uri?: string;
  checksum?: string;
  attempts?: number;
  error?: string;
}> {
  if (!isPhase120Enabled())
    return { pinned: false, error: "phase-120 flag disabled" };
  const jwt = (
    process.env.PINATA_JWT ??
    process.env.PINATA_API_JWT ??
    ""
  ).trim();
  if (!jwt) return { pinned: false, error: "PINATA_JWT not configured" };
  try {
    const { pinFileToIpfsWithRetry, computeSha256Hex } =
      await import("@/lib/ipfs-upload-retry");
    const checksum = computeSha256Hex(pngBuffer);
    const blob = new Blob([new Uint8Array(pngBuffer)], { type: "image/png" });
    const result = await pinFileToIpfsWithRetry(blob, jwt, {
      config: opts.retries != null ? { maxRetries: opts.retries } : undefined,
      expectedChecksum: checksum,
      fileName: `og-chamber-${Date.now()}.png`,
    });
    return {
      pinned: true,
      uri: result.uri,
      checksum: result.checksum.hex,
      attempts: result.attempts,
    };
  } catch (e) {
    return { pinned: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ─── Design tokens ──────────────────────────────────────────────────────────
// All colors/dimensions flow through the theme registry (lib/og-design-tokens).
// The chamber renderer uses the monitor theme for geometry; colors are the
// themed badge/headline tokens.

const OG_THEME = getOgTheme("monitor");

function resolveImageUrl(uri: string, base: string): string | null {
  if (!uri) return null;
  if (/^https?:\/\//i.test(uri)) return uri;
  const ipfsPath = extractIpfsGatewaySubpath(uri);
  return ipfsPath ? `${base}/api/ipfs/${ipfsPath}` : null;
}

// ─── Price History Chart Generator ────────────────────────────────────────────

async function generatePriceHistoryChart(
  tokenId: number,
  width: number,
  height: number,
  theme: OgTheme,
): Promise<Buffer | null> {
  try {
    // Fetch on-chain price history from market store
    const priceHistory = await fetchTokenPriceHistory(tokenId, 30);
    if (priceHistory.length === 0) return null;

    // Create SVG chart with price trend visualization
    const maxPrice = Math.max(...priceHistory.map((p) => p.price));
    const minPrice = Math.min(...priceHistory.map((p) => p.price));
    const priceRange = maxPrice - minPrice || 1;
    const padding = 10;
    const chartWidth = width - padding * 2;
    const chartHeight = height - padding * 2;

    const points = priceHistory
      .map((point, idx) => {
        const x = padding + (idx / (priceHistory.length - 1)) * chartWidth;
        const y =
          padding +
          chartHeight -
          ((point.price - minPrice) / priceRange) * chartHeight;
        return `${x},${y}`;
      })
      .join(" ");

    const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="${theme.canvasBackground}"/>
      <polyline points="${points}" fill="none" stroke="${theme.colors.primary}" stroke-width="2"/>
    </svg>`;

    return sharp(Buffer.from(svg)).png().toBuffer();
  } catch {
    return null;
  }
}

async function fetchTokenPriceHistory(
  tokenId: number,
  days: number,
): Promise<Array<{ timestamp: number; price: number }>> {
  try {
    const response = await fetch(
      `${publicPhaseSiteBaseUrl()}/api/market/${tokenId}/price-history?days=${days}`,
      {
        cache: "no-store",
      },
    );
    if (!response.ok) return [];
    const data = (await response.json()) as {
      history?: Array<{ timestamp: number; price: number }>;
    };
    return data.history ?? [];
  } catch {
    return [];
  }
}

// ─── Token-level OG renderer ──────────────────────────────────────────────────

async function renderTokenOg(
  tokenId: number,
  base: string,
  theme: OgTheme,
): Promise<Buffer> {
  const monitorBuf = await readFile(resolveChamberTemplatePath());
  const baseBuf = await sharp(monitorBuf)
    .resize(theme.dimensions.canvas.width, theme.dimensions.canvas.height, {
      fit: "cover",
      position: "centre",
    })
    .toBuffer();

  const layers: sharp.OverlayOptions[] = [];
  let nftName = "PHASE ARTIFACT";

  const fetchResult = await withOgErrorBoundary(async () => {
    const tokenUri = await fetchTokenUriString(tokenId);
    if (!tokenUri) return;
    const meta = await fetchTokenMetadataDisplay(tokenUri);
    if (meta.name) nftName = meta.name;

    const imageUri = meta.image ?? "";
    const nftUrl = resolveImageUrl(imageUri, base);
    if (nftUrl) {
      const nftBuf = await fetchImageBuffer(nftUrl);
      if (nftBuf) {
        const resized = await sharp(nftBuf)
          .resize(theme.dimensions.nftWidth, theme.dimensions.nftHeight, {
            fit: "cover",
            position: "centre",
          })
          .toBuffer();
        layers.push({
          input: resized,
          left: theme.dimensions.nftLeft,
          top: theme.dimensions.nftTop,
        });
      }
    }
  });
  if (!fetchResult.ok) {
    // render monitor-only on any metadata failure
  }

  // Add price history chart overlay if available
  const priceChart = await generatePriceHistoryChart(tokenId, 200, 80, theme);
  if (priceChart) {
    layers.push({
      input: priceChart,
      left: theme.dimensions.canvas.width - 220,
      top: theme.dimensions.canvas.height - 100,
    });
  }

  // Token ID badge — top-right of PHASE text, themed badge color
  const badgeLayer = await textLayer(`#${tokenId}`, {
    left: theme.dimensions.badgeLeft,
    top: theme.dimensions.badgeTop,
    width: 160,
    height: theme.dimensions.badgeFontSize + 6,
    fontSize: theme.dimensions.badgeFontSize,
    color: theme.colors.badge,
    align: "left",
  });
  if (badgeLayer) layers.push(badgeLayer);

  // NFT name — centered horizontally in the full canvas, themed headline color
  const displayName = safeDisplayName(
    nftName,
    `PHASE ARTIFACT #${tokenId}`,
    theme,
  );
  const nameLayer = await textLayer(displayName, {
    left: 0,
    top: theme.dimensions.nameTop,
    width: theme.dimensions.canvas.width,
    height: 28,
    fontSize: theme.dimensions.nameFontSize,
    color: theme.colors.headline,
    align: "center",
    letterSpacing: 3,
  });
  if (nameLayer) layers.push(nameLayer);

  return sharp(baseBuf).composite(layers).png().toBuffer();
}

// ─── Collection-level OG renderer (og-monitor.png) ───────────────────────────

async function renderCollectionOg(
  collectionId: number,
  base: string,
  theme: OgTheme,
): Promise<Buffer> {
  const monitorBuf = await readFile(resolveChamberTemplatePath());
  const baseBuf = await sharp(monitorBuf)
    .resize(theme.dimensions.canvas.width, theme.dimensions.canvas.height, {
      fit: "cover",
      position: "centre",
    })
    .toBuffer();

  const layers: sharp.OverlayOptions[] = [];
  let displayName: string | null = null;
  let imageUri = "";

  const fetchResult = await withOgErrorBoundary(async () => {
    const collection = await fetchCollectionInfo(collectionId);
    imageUri = collection?.imageUri?.trim() ?? "";
    displayName = collection?.name?.trim() || null;
  });
  if (!fetchResult.ok) {
    // fall through with whatever we resolved so far
  }

  // NFT image layer — same screen coordinates as the token flow
  if (imageUri) {
    const nftUrl = resolveImageUrl(imageUri, base);
    if (nftUrl) {
      const nftBuf = await fetchImageBuffer(nftUrl);
      if (nftBuf) {
        const resized = await sharp(nftBuf)
          .resize(theme.dimensions.nftWidth, theme.dimensions.nftHeight, {
            fit: "cover",
            position: "centre",
          })
          .toBuffer();
        layers.push({
          input: resized,
          left: theme.dimensions.nftLeft,
          top: theme.dimensions.nftTop,
        });
      }
    }
  }

  // Badge #collectionId
  const badgeLayer = await textLayer(`#${collectionId}`, {
    left: theme.dimensions.badgeLeft,
    top: theme.dimensions.badgeTop,
    width: 160,
    height: theme.dimensions.badgeFontSize + 6,
    fontSize: theme.dimensions.badgeFontSize,
    color: theme.colors.badge,
    align: "left",
  });
  if (badgeLayer) layers.push(badgeLayer);

  // Name — centered at nameTop; only if resolved
  if (displayName) {
    const nameLayer = await textLayer(
      safeDisplayName(displayName, `PHASE COLLECTION #${collectionId}`, theme),
      {
        left: 0,
        top: theme.dimensions.nameTop,
        width: theme.dimensions.canvas.width,
        height: 32,
        fontSize: theme.dimensions.nameFontSize,
        color: theme.colors.headline,
        align: "center",
        letterSpacing: 3,
      },
    );
    if (nameLayer) layers.push(nameLayer);
  }

  return sharp(baseBuf).composite(layers).png().toBuffer();
}

// ─── Response helpers ─────────────────────────────────────────────────────────

function ogHeaders(
  tplName: "og-template.png" | "og-monitor.png",
): Record<string, string> {
  return {
    "Content-Type": "image/png",
    // OG output can contain private collection/token metadata.  Do not let a
    // shared CDN cache expose it or mix variants between callers.
    "Cache-Control": "private, no-store, must-revalidate",
    Vary: "Accept-Language, Authorization, X-Phase-Lang",
    "X-Phase-Og-Template": tplName,
    ...(isPhase120Enabled() ? { "X-Phase120": "enabled" } : {}),
  };
}

function pngResponse(
  buffer: Buffer,
  extra: Record<string, string> = {},
): NextResponse {
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      ...ogHeaders(templateName(resolveChamberTemplatePath())),
      ...extra,
    },
  });
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const base = publicPhaseSiteBaseUrl();
  const { searchParams } = request.nextUrl;

  const parsed = OgChamberQuerySchema.safeParse({
    token_id: searchParams.get("token_id") ?? undefined,
    token: searchParams.get("token") ?? undefined,
    collection: searchParams.get("collection") ?? undefined,
    pin: searchParams.get("pin") ?? undefined,
    retries: searchParams.get("retries") ?? undefined,
  });
  const pinIntent = resolvePinIntent(
    searchParams.get("pin"),
    searchParams.get("retries"),
  );
  const shouldPin = pinIntent.shouldPin;
  const pinRetries = pinIntent.retries;

  const maybePin = async (resp: NextResponse): Promise<NextResponse> => {
    if (!shouldPin) return resp;
    if (!isPhase120Enabled()) {
      resp.headers.set("X-Phase-Pin-Error", "phase-120 flag disabled");
      return resp;
    }
    const buf = Buffer.from(await resp.clone().arrayBuffer());
    const pinned = await pinOgChamberPngWithRetry(buf, { retries: pinRetries });
    if (pinned.pinned) {
      resp.headers.set("X-Phase-Pin-URI", pinned.uri!);
      resp.headers.set("X-Phase-Pin-Checksum", pinned.checksum!);
      resp.headers.set("X-Phase-Pin-Attempts", String(pinned.attempts!));
    } else {
      resp.headers.set(
        "X-Phase-Pin-Error",
        (pinned.error ?? "pin failed").slice(0, 120),
      );
    }
    return resp;
  };

  // phase-145 (Module #45): attach a sybil-resistance signal when a wallet is
  // supplied (e.g. the profile that owns/shares this chamber). Header-only,
  // best-effort, does not change pixels.
  const walletParam = searchParams.get("wallet")?.trim() ?? "";
  const finalize = async (resp: NextResponse): Promise<NextResponse> => {
    const piped = await maybePin(resp);
    if (isSybilResistanceEnabled()) {
      piped.headers.set("X-Phase145", "enabled");
      if (/^G[A-Z2-7]{55}$/.test(walletParam)) {
        try {
          const { assessWalletSybilRisk } = await import("@/lib/sybil-resistance");
          const assessment = await assessWalletSybilRisk(walletParam);
          if (assessment) {
            piped.headers.set("X-Phase-Sybil-Band", assessment.band);
            piped.headers.set("X-Phase-Sybil-Score", String(assessment.score));
          }
        } catch {
          // best-effort
        }
      }
    }
    return piped;
  };

  // Token-level OG (individual NFT)
  const rawToken = searchParams.get("token_id") ?? searchParams.get("token");
  const tokenId = rawToken ? parseInt(rawToken, 10) : NaN;
  if (Number.isFinite(tokenId) && tokenId > 0) {
    const result = await withOgErrorBoundary(() =>
      renderTokenOg(tokenId, base, OG_THEME),
    );
    if (!result.ok) {
      return new NextResponse("OG render failed", {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      });
    }
    return finalize(pngResponse(result.value));
  }

  // Collection-level OG — monitor frame with best-effort token metadata
  const rawCollection = searchParams.get("collection");
  const collectionId = rawCollection ? parseInt(rawCollection, 10) : NaN;

  if (!Number.isFinite(collectionId) || collectionId <= 0) {
    // No params — serve the bare monitor as fallback (template-aware)
    const monitorPath = resolveChamberTemplatePath();
    const monitorBuf = await readFile(monitorPath);
    const pngBuffer = await sharp(monitorBuf)
      .resize(
        OG_THEME.dimensions.canvas.width,
        OG_THEME.dimensions.canvas.height,
        { fit: "cover", position: "centre" },
      )
      .png()
      .toBuffer();
    return finalize(pngResponse(pngBuffer));
  }

  const result = await withOgErrorBoundary(() =>
    renderCollectionOg(collectionId, base, OG_THEME),
  );
  if (!result.ok) {
    return new NextResponse("OG render failed", {
      status: 500,
      headers: { "Content-Type": "text/plain" },
    });
  }
  return finalize(pngResponse(result.value));
}
