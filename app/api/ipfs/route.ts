import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import {
  computeSha256Hex,
  isPhase120Enabled,
  parseAndValidateChecksumHeader,
  pinFileToIpfsWithRetry,
  resolveRetryConfig,
} from "@/lib/ipfs-upload-retry"

const PinataRetryQuerySchema = z.object({
  retries: z.coerce.number().int().min(0).max(6).optional(),
  baseDelayMs: z.coerce.number().int().min(100).max(10_000).optional(),
})

function pinataJwt(): string | undefined {
  const a = process.env.PINATA_JWT?.trim()
  if (a) return a
  const b = process.env.PINATA_API_JWT?.trim()
  if (b) return b
  return undefined
}

/** Returns whether server-side file upload is available (no secrets exposed). */
export async function GET() {
  const configured = Boolean(pinataJwt())
  return NextResponse.json({ configured })
}

/** Accepts multipart `file`; stores via configured provider. JWT never sent to the client.
 *  phase-120: when flag enabled, uses exponential backoff + checksum verification.
 *  Fallback (flag off): legacy single-shot path (no retry).
 */
export async function POST(req: NextRequest) {
  const jwt = pinataJwt()
  if (!jwt) {
    return NextResponse.json({ error: "La subida de imágenes no está configurada en el servidor." }, { status: 503 })
  }

  // Optional checksum header (client can send sha256 of original bytes)
  const incomingChecksum = parseAndValidateChecksumHeader(req.headers.get("x-checksum-sha256") ?? req.headers.get("X-Checksum-Sha256"))
  const url = new URL(req.url)
  const qRetries = PinataRetryQuerySchema.safeParse({
    retries: url.searchParams.get("retries") ?? undefined,
    baseDelayMs: url.searchParams.get("baseDelayMs") ?? undefined,
  })

  let formData: FormData
  try {
    formData = await req.formData()
  } catch {
    return NextResponse.json({ error: "Cuerpo multipart inválido." }, { status: 400 })
  }

  const file = formData.get("file")
  if (!file || typeof file === "string" || !(file instanceof Blob)) {
    return NextResponse.json({ error: "Falta el campo file." }, { status: 400 })
  }

  // phase-120 gated retry path
  if (isPhase120Enabled()) {
    const retryOverrides: Record<string, number> = {}
    if (qRetries.success) {
      if (qRetries.data.retries != null) retryOverrides["maxRetries"] = qRetries.data.retries
      if (qRetries.data.baseDelayMs != null) retryOverrides["baseDelayMs"] = qRetries.data.baseDelayMs
    }
    const config = resolveRetryConfig(retryOverrides)

    // Server-side checksum of received bytes (integrity check before pin)
    let serverChecksum: string | null = null
    try {
      const ab = await (file as Blob).arrayBuffer()
      serverChecksum = computeSha256Hex(ab)
      // If client supplied checksum, verify immediately
      if (incomingChecksum && serverChecksum !== incomingChecksum) {
        return NextResponse.json(
          { error: "Checksum mismatch: uploaded bytes do not match X-Checksum-Sha256 header.", code: "CHECKSUM_MISMATCH" },
          { status: 400 },
        )
      }
      // Re-create Blob for pin (arrayBuffer may have consumed? use bytes copy)
      const verifiedBlob = new Blob([ab], { type: (file as Blob).type || "application/octet-stream" })
      const result = await pinFileToIpfsWithRetry(verifiedBlob, jwt, {
        config,
        expectedChecksum: serverChecksum,
        fileName: (file as File).name ?? "phase-asset.bin",
      })
      return NextResponse.json(
        { uri: result.uri, checksum: result.checksum.hex, verified: true, attempts: result.attempts },
        { headers: { "X-Checksum-Sha256": result.checksum.hex, "X-Phase120-Attempts": String(result.attempts) } },
      )
    } catch (e) {
      const err = e as Error & { code?: string; attempts?: number; perAttempt?: unknown }
      const code = (err as { code?: string }).code ?? "UPLOAD_FAILED"
      const status =
        code === "CHECKSUM_MISMATCH" ? 400 : code === "VALIDATION_FAILED" ? 400 : code === "NOT_CONFIGURED" ? 503 : 502
      return NextResponse.json(
        {
          error: err.message || "Upload failed",
          code,
          attempts: (err as { attempts?: number }).attempts ?? 1,
          perAttempt: (err as { perAttempt?: unknown }).perAttempt,
          checksum: serverChecksum,
        },
        { status },
      )
    }
  }

  // Legacy single-shot (flag off) — preserved for rollback / zero regression
  const uploadForm = new FormData()
  uploadForm.append("file", file)

  const pinRes = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: uploadForm,
  })

  const rawText = await pinRes.text()
  let parsed: { IpfsHash?: string; error?: { reason?: string } | string } = {}
  try {
    parsed = JSON.parse(rawText) as typeof parsed
  } catch {
    /* ignore */
  }

  if (!pinRes.ok) {
    const msg =
      typeof parsed.error === "object" && parsed.error?.reason
        ? parsed.error.reason
        : typeof parsed.error === "string"
          ? parsed.error
          : rawText.slice(0, 200) || `Upload service ${pinRes.status}`
    return NextResponse.json({ error: msg }, { status: 502 })
  }

  const hash = parsed.IpfsHash
  if (!hash || typeof hash !== "string") {
    return NextResponse.json({ error: "La subida no devolvió un identificador válido." }, { status: 502 })
  }

  return NextResponse.json({ uri: `ipfs://${hash}` })
}

export const runtime = "nodejs"
