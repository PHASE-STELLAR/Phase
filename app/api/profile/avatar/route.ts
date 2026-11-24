import { NextRequest } from "next/server"
import { DEFAULT_PROFILE_LOCALE, getProfile, isProfilePinningRedundancyEnabled, isPhase137Enabled, localizeAvatarName, normalizeProfileLocale, ProfileError, ProfileVersionConflictError, saveProfile, resolveAvatarWithFallback, toProfileErrorResponse, BatchAvatarQuerySchema, getAvatarsForWallets } from "@/lib/profile-store"
import { isNftGridVirtualizationEnabled } from "@/lib/nft-grid-virtualization"
import { StrKey } from "@stellar/stellar-sdk"
import { createApiRequestContext } from "@/lib/api-observability"
import { z } from "zod"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { BoundedBodyError, readBoundedBody, readBoundedBytes } from "@/lib/bounded-body"
import { pickCopy } from "@/lib/phase-copy"
import {
  isProfile2faV2Enabled,
  requireSep10SessionForWallet,
  verifySessionBound2faChallenge,
} from "@/lib/profile-2fa"

/** phase-137: emit a structured error body when the taxonomy flag is on, else the legacy generic 500. */
function respondWithProfileError(
  api: ReturnType<typeof createApiRequestContext>,
  error: unknown,
  event: string,
  legacyStatus = 500,
) {
  if (isPhase137Enabled()) {
    const { body, status } = toProfileErrorResponse(error)
    return api.json(body, { status, event, metadata: { code: body.code, category: body.category, retryable: body.retryable } })
  }
  return api.errorJson(error, legacyStatus, event)
}

export const dynamic = "force-dynamic"

function matchesAvatarMime(bytes: Uint8Array, mime: string): boolean {
  if (mime === "image/png") {
    return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
  }
  if (mime === "image/jpeg") return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  if (mime === "image/gif") {
    const signature = new TextDecoder().decode(bytes.subarray(0, 6))
    return signature === "GIF87a" || signature === "GIF89a"
  }
  if (mime === "image/webp") {
    return bytes.length >= 12 &&
      new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" &&
      new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP"
  }
  return false
}

// ??? phase-117: multi-gateway redundancy ????????????????????????????????????
// Single gateway outage previously dropped metadata. When flag enabled, avatar
// reads use gateway rotation + checksum verification; pins require quorum.

const AvatarQuerySchema = z.object({
  wallet: z.string().trim().min(10).max(56),
})

export async function GET(request: NextRequest) {
  const api = createApiRequestContext(request, "/api/profile/avatar")

  // phase-157 (Module #57): batch avatar fetch for a virtualized grid window.
  // `?wallets=G...,G...` returns many avatars in one round-trip so a 10k-token
  // grid does not fan out thousands of requests. No-op unless the flag is on.
  const rawWallets = request.nextUrl.searchParams.get("wallets")
  if (rawWallets) {
    if (!isNftGridVirtualizationEnabled()) {
      return api.json(
        { error: "Batch avatar fetch disabled (phase-157 flag off)" },
        { status: 404, event: "profile.avatar.batch_disabled" },
      )
    }
    const parsedBatch = BatchAvatarQuerySchema.safeParse({
      wallets: rawWallets.split(",").map((w) => w.trim()).filter(Boolean),
    })
    if (!parsedBatch.success) {
      return api.json(
        { error: "Invalid wallets list", details: parsedBatch.error.flatten() },
        { status: 400, event: "profile.avatar.batch_validation_failed" },
      )
    }
    try {
      const avatars = await getAvatarsForWallets(parsedBatch.data.wallets)
      return api.json(
        { avatars },
        {
          event: "profile.avatar.batch_loaded",
          metadata: { count: avatars.length },
          headers: { "Cache-Control": "private, max-age=30", "X-Phase157": "enabled" },
        },
      )
    } catch (error) {
      return api.errorJson(error, 500, "profile.avatar.batch_failed")
    }
  }

  const rawWallet = request.nextUrl.searchParams.get("wallet")?.trim() ?? ""
  const parsedQ = AvatarQuerySchema.safeParse({ wallet: rawWallet })
  const wallet = parsedQ.success ? parsedQ.data.wallet : rawWallet

  if (!wallet || !StrKey.isValidEd25519PublicKey(wallet)) {
    if (isPhase137Enabled()) {
      const err = new ProfileError("INVALID_WALLET", "Wallet address is not a valid ed25519 public key")
      return api.json(
        { avatar: null, ...err.toResponse() },
        { status: err.status, event: "profile.avatar.validation_failed", metadata: { reason: "wallet", code: err.code } },
      )
    }
    return api.json(
      { avatar: null },
      { status: 400, event: "profile.avatar.validation_failed", metadata: { reason: "wallet" } },
    )
  }

  try {
    const profile = await getProfile(wallet)

    if (!profile?.avatar_token_id) {
      return api.json({ avatar: null }, { event: "profile.avatar.empty", metadata: { wallet } })
    }

    const preferredLocale = normalizeProfileLocale(profile.locale) ?? DEFAULT_PROFILE_LOCALE

    // phase-117: when enabled, rewrite image URL through verified gateway fallback
    let imageOut = profile.avatar_image_url ?? ""
    let gatewayMeta: string | null = null
    if (isProfilePinningRedundancyEnabled() && imageOut) {
      try {
        const resolved = await resolveAvatarWithFallback(imageOut)
        if (resolved.ok) {
          imageOut = resolved.url
          gatewayMeta = resolved.gateway
        }
      } catch {
        // fall back to original URL (zero regression)
      }
    }

    return api.json(
      {
        avatar: {
          tokenId: profile.avatar_token_id,
          image: imageOut,
          name: localizeAvatarName(profile.avatar_token_id, preferredLocale),
          locale: preferredLocale,
        },
        ...(isProfilePinningRedundancyEnabled()
          ? { redundancy: { enabled: true, gateway: gatewayMeta ?? "legacy" } }
          : {}),
      },
      {
        event: "profile.avatar.loaded",
        metadata: {
          wallet,
          token_id: profile.avatar_token_id,
          ...(gatewayMeta ? { gateway: gatewayMeta } : {}),
          phase117: isProfilePinningRedundancyEnabled(),
          locale: preferredLocale,
        },
        headers: {
          "Cache-Control": "private, max-age=30",
          "X-Phase-Locale": preferredLocale,
          ...(isProfilePinningRedundancyEnabled() ? { "X-Phase117": "enabled", ...(gatewayMeta ? { "X-Phase-Gateway": gatewayMeta } : {}) } : {}),
          ...(isNftGridVirtualizationEnabled() ? { "X-Phase157": "enabled" } : {}),
        },
      },
    )
  } catch (error) {
    return respondWithProfileError(api, error, "profile.avatar.load_failed")
  }
}

// POST ? pin avatar with redundancy (phase-117 gated)
// Preserves existing GET; adds opt-in pin path for clients that want quorum
export async function POST(request: NextRequest) {
  const api = createApiRequestContext(request, "/api/profile/avatar")
  const phase262Enabled = isFeatureEnabled("phase-262")
  if (!isProfilePinningRedundancyEnabled() && !phase262Enabled) {
    return api.json({ error: "Multi-gateway pinning disabled (phase-117 flag off)" }, { status: 404, event: "profile.avatar.redundancy_disabled" })
  }
  let body: { wallet?: unknown; imageUrl?: unknown; imageBlob?: unknown; quorum?: unknown; signature?: unknown; expected_version?: unknown }
  try {
    const parsed: unknown = JSON.parse(
      phase262Enabled ? await readBoundedBody(request, 16 * 1024, 5_000) : await request.text(),
    )
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return api.json({ error: "JSON object body required" }, { status: 400, event: "profile.avatar.invalid_body" })
    }
    body = parsed as typeof body
  } catch (error) {
    if (error instanceof BoundedBodyError && error.code === "BODY_TOO_LARGE") {
      return api.json({ error: "Request body exceeds the allowed size", code: error.code }, { status: 413, event: "profile.avatar.body_too_large" })
    }
    if (error instanceof BoundedBodyError && error.code === "BODY_READ_TIMEOUT") {
      return api.json({ error: "Request body read timed out", code: error.code }, { status: 408, event: "profile.avatar.body_timeout" })
    }
    return api.json({ error: "Invalid JSON" }, { status: 400, event: "profile.avatar.invalid_json" })
  }
  const wallet = typeof body.wallet === "string" ? body.wallet.trim() : ""
  if (!wallet || !StrKey.isValidEd25519PublicKey(wallet)) {
    return api.json({ error: "Invalid wallet" }, { status: 400, event: "profile.avatar.validation_failed", metadata: { reason: "wallet" } })
  }
  const language = request.headers.get("accept-language")?.split(",")[0]?.split("-")[0]

  if (isProfile2faV2Enabled(wallet)) {
    const session = await requireSep10SessionForWallet(request, wallet, language)
    if (!session.ok) {
      return api.json(
        { error: session.error, code: session.reason },
        { status: session.status, event: "profile.avatar.session_rejected" },
      )
    }
    const confirmationCode = typeof (body as { confirmation_code?: unknown }).confirmation_code === "string"
      ? (body as { confirmation_code: string }).confirmation_code
      : undefined
    const check = verifySessionBound2faChallenge(
      wallet,
      session.sessionHash,
      body as Record<string, unknown>,
      confirmationCode,
      language,
    )
    if (!check.ok) {
      return api.json(
        { error: check.error, code: check.reason },
        {
          status: check.status,
          event: "profile.avatar.2fa_rejected",
          headers: check.retryAfterSeconds ? { "Retry-After": String(check.retryAfterSeconds) } : undefined,
        },
      )
    }
  }
  const expectedVersion = typeof body.expected_version === "number" ? body.expected_version : undefined
  if (phase262Enabled && (
    typeof body.expected_version !== "number" ||
    !Number.isSafeInteger(body.expected_version) ||
    body.expected_version < 0
  )) {
    return api.json(
      { error: pickCopy(language).profileCompleteness.staleProfile, code: "PROFILE_VERSION_CONFLICT" },
      { status: 409, event: "profile.avatar.version_conflict" },
    )
  }

  // Issue #226: proving wallet ownership. Without this, anyone can POST
  // { wallet: <victim>, imageUrl: <attacker> } and overwrite a victim's
  // avatar — a persistent, CDN-cached phishing vector. The caller signs a
  // SEP-53 message binding wallet + imageUrl (the exact bytes that will be
  // fetched and pinned); the server verifies it with the claimed keypair.
  const signature = typeof (body as { signature?: unknown }).signature === "string"
    ? ((body as { signature: string }).signature).trim()
    : ""
  if (!signature) {
    return api.json(
      { error: "signature required: sign { wallet, imageUrl } to prove wallet ownership" },
      { status: 401, event: "profile.avatar.signature_required" },
    )
  }
  // For this route we accept imageUrl and fetch server-side for pinning (signing boundary preserved)
  const imageUrl = typeof body.imageUrl === "string" ? body.imageUrl.trim() : ""
  if (!imageUrl) return api.json({ error: "imageUrl required" }, { status: 400, event: "profile.avatar.validation_failed" })

  const ownershipOk = await verifyAvatarOwnershipSignature(wallet, imageUrl, signature)
  if (!ownershipOk) {
    api.log("warn", "avatar_forgery_attempt", { wallet, reason: "invalid_signature" })
    return api.json(
      { error: "Invalid signature: request not signed by the wallet being updated" },
      { status: 403, event: "profile.avatar.invalid_signature" },
    )
  }

  const quorum = typeof body.quorum === "number" && Number.isFinite(body.quorum) ? Math.max(1, Math.min(3, Math.trunc(body.quorum))) : 1

  try {
    // fetch image bytes server-side (with timeout)
    const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(8000) })
    if (!imgRes.ok) {
      if (isPhase137Enabled()) {
        const err = new ProfileError(imgRes.status >= 500 ? "GATEWAY_5XX" : "GATEWAY_4XX", `Failed to fetch image (${imgRes.status})`, { status: imgRes.status })
        return api.json(err.toResponse(), { status: err.status, event: "profile.avatar.fetch_failed", metadata: { code: err.code } })
      }
      return api.json({ error: `Failed to fetch image (${imgRes.status})` }, { status: 502, event: "profile.avatar.fetch_failed" })
    }
    const contentType = imgRes.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? ""
    const maxAvatarBytes = 5 * 1024 * 1024
    const declaredImageSize = Number(imgRes.headers.get("content-length"))
    const avatarMimeTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"])
    if (phase262Enabled && (
      !avatarMimeTypes.has(contentType) ||
      (Number.isFinite(declaredImageSize) && declaredImageSize > maxAvatarBytes)
    )) {
      return api.json(
        { error: pickCopy(language).profileCompleteness.invalidAvatar, code: "INVALID_AVATAR" },
        { status: Number.isFinite(declaredImageSize) && declaredImageSize > maxAvatarBytes ? 413 : 415, event: "profile.avatar.validation_failed" },
      )
    }

    let imageBytes: Uint8Array
    try {
      imageBytes = phase262Enabled
        ? await readBoundedBytes(imgRes, maxAvatarBytes, 8_000)
        : new Uint8Array(await imgRes.arrayBuffer())
    } catch (error) {
      if (error instanceof BoundedBodyError && error.code === "BODY_TOO_LARGE") {
        return api.json(
          { error: pickCopy(language).profileCompleteness.invalidAvatar, code: "AVATAR_TOO_LARGE" },
          { status: 413, event: "profile.avatar.validation_failed" },
        )
      }
      if (error instanceof BoundedBodyError && error.code === "BODY_READ_TIMEOUT") {
        return api.json({ error: "Avatar download timed out", code: error.code }, { status: 408, event: "profile.avatar.download_timeout" })
      }
      throw error
    }
    if (phase262Enabled && !matchesAvatarMime(imageBytes, contentType)) {
      return api.json(
        { error: pickCopy(language).profileCompleteness.invalidAvatar, code: "INVALID_AVATAR" },
        { status: 415, event: "profile.avatar.validation_failed" },
      )
    }
    const imageBuffer = imageBytes.buffer.slice(imageBytes.byteOffset, imageBytes.byteOffset + imageBytes.byteLength)
    const blob = new Blob([imageBuffer], { type: phase262Enabled ? contentType : contentType || "image/png" })

    const { pinAvatarWithRedundancy } = await import("@/lib/profile-store")
    const imageExtension = contentType === "image/jpeg" ? "jpg" : contentType.split("/")[1] || "png"
    const fileName = phase262Enabled
      ? `avatar-${wallet.slice(0, 6)}.${imageExtension}`
      : `avatar-${wallet.slice(0, 6)}.png`
    const result = await pinAvatarWithRedundancy(blob, { quorum, fileName })
    if (!result.ok) {
      if (isPhase137Enabled()) {
        const err = new ProfileError(result.code === "NOT_CONFIGURED" ? "NOT_CONFIGURED" : "PIN_QUORUM_FAILED", result.error, { pinCode: result.code, quorum: result.quorum, achieved: result.achieved })
        return api.json(err.toResponse(), { status: err.status, event: "profile.avatar.pin_failed", metadata: { code: err.code } })
      }
      return api.json({ error: result.error, code: result.code, quorum: result.quorum, achieved: result.achieved }, { status: 502, event: "profile.avatar.pin_failed" })
    }
    // Issue #226: bind the pinned content to the CID it is served under before
    // persisting it. The pin result carries the gateway checksum; a mismatch
    // means the bytes we are about to store are not the bytes that CID names.
    try {
      const { verifyCID, CidIntegrityError } = await import("@/lib/cid-cache")
      const expectedSha = typeof result.checksum === "string" && /^[a-f0-9]{64}$/i.test(result.checksum)
        ? result.checksum
        : undefined
      verifyCID(imageBytes, result.cid, expectedSha)
    } catch (e) {
      if (e instanceof Error && e.name === "CidIntegrityError") {
        api.log("warn", "avatar_cid_mismatch", { wallet, cid: result.cid, code: (e as { code?: string }).code })
        return api.json(
          { error: "Pinned content failed CID verification", code: "CID_MISMATCH" },
          { status: 400, event: "profile.avatar.cid_mismatch" },
        )
      }
      throw e
    }

    // Persist new avatar_image_url as verified gateway URL
    const profile = await getProfile(wallet)
    try {
      if (phase262Enabled || profile) {
        await saveProfile(
          wallet,
          { ...(profile ?? {}), avatar_image_url: result.uri },
          {
            expectedVersion: phase262Enabled
              ? expectedVersion
              : profile?.version ?? 0,
          },
        )
      }
    } catch (error) {
      if (error instanceof ProfileVersionConflictError) {
        return api.json(
          {
            error: pickCopy(language).profileCompleteness.staleProfile,
            code: "PROFILE_VERSION_CONFLICT",
            current_version: error.currentVersion,
          },
          { status: 409, event: "profile.avatar.version_conflict" },
        )
      }
      throw error
    }
    return api.json(
      { ok: true, cid: result.cid, uri: result.uri, checksum: result.checksum, quorum: result.quorum, achieved: result.achieved },
      { status: 201, event: "profile.avatar.pinned", metadata: { wallet, cid: result.cid }, headers: { "Cache-Control": "private, no-store" } },
    )
  } catch (error) {
    return respondWithProfileError(api, error, "profile.avatar.pin_failed")
  }
}

/**
 * Issue #226: SEP-53 wallet-ownership proof for avatar updates.
 *
 * Signs a canonical message binding { wallet, imageUrl } so the signature
 * cannot be lifted from another request or replayed against a different image.
 * Same SEP-53 construction as lib/viewer-signature.ts.
 */
export async function verifyAvatarOwnershipSignature(
  wallet: string,
  imageUrl: string,
  signatureBase64: string,
): Promise<boolean> {
  const { sha256Hex, verifySep53Signature } = await import("@/lib/viewer-signature")
  const message = `phase-avatar:v1:${await sha256Hex(JSON.stringify({ wallet, imageUrl }))}`
  return verifySep53Signature(wallet, message, signatureBase64)
}