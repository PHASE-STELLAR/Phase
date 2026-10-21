const MAX_EDGE = 2048
const JPEG_QUALITY = 0.86

/**
 * Reduce imágenes grandes antes de subir (Vercel suele cortar con 413 si el body supera ~4.5 MB).
 */
export async function shrinkImageBlobForUpload(blob: Blob): Promise<Blob> {
  if (typeof window === "undefined" || !blob.type.startsWith("image/")) {
    return blob
  }
  if (blob.size < 2_400_000) {
    return blob
  }
  try {
    const bmp = await createImageBitmap(blob)
    try {
      let w = bmp.width
      let h = bmp.height
      if (w > MAX_EDGE || h > MAX_EDGE) {
        const scale = MAX_EDGE / Math.max(w, h)
        w = Math.max(1, Math.round(w * scale))
        h = Math.max(1, Math.round(h * scale))
      }
      const canvas = document.createElement("canvas")
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext("2d")
      if (!ctx) return blob
      ctx.drawImage(bmp, 0, 0, w, h)
      const out = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), "image/jpeg", JPEG_QUALITY),
      )
      if (out && out.size > 0 && out.size < blob.size) {
        return out
      }
      return blob
    } finally {
      bmp.close()
    }
  } catch {
    return blob
  }
}

/** `true` if the server exposes a configured upload endpoint (checked via GET, no secrets leaked). */
export async function isIpfsUploadConfigured(): Promise<boolean> {
  try {
    const res = await fetch("/api/ipfs", { method: "GET", cache: "no-store" })
    if (!res.ok) return false
    const data = (await res.json()) as { configured?: boolean }
    return Boolean(data.configured)
  } catch {
    return false
  }
}

/**
 * Uploads a `Blob` or `File` via `POST /api/ipfs`. Returns a content URI for `create_collection`.
 * Legacy path — single attempt. For retry + checksum, use `uploadToIPFSWithRetry`.
 */
export async function uploadToIPFS(fileOrBlob: Blob | File): Promise<string> {
  const prepared = await shrinkImageBlobForUpload(fileOrBlob)
  const fd = new FormData()
  const baseName = fileOrBlob instanceof File ? fileOrBlob.name.replace(/\.[^.]+$/, "") : "phase-art"
  const name = prepared.type === "image/jpeg" ? `${baseName}.jpg` : fileOrBlob instanceof File ? fileOrBlob.name : "phase-art.png"
  fd.append("file", prepared, name)

  const res = await fetch("/api/ipfs", { method: "POST", body: fd })
  let data: { uri?: string; error?: string } = {}
  try {
    data = (await res.json()) as typeof data
  } catch {
    /* ignore */
  }

  if (!res.ok) {
    throw new Error(data.error || `Subida falló (${res.status})`)
  }
  if (typeof data.uri !== "string" || !data.uri.startsWith("ipfs://")) {
    throw new Error("Respuesta de subida inválida.")
  }
  return data.uri
}

// ─── phase-120: retry + checksum wrapper (isolated, flag-gated) ─────────────
// Re-export for convenience; keeps lib/ipfs-upload as single import surface
// for UI components while new logic lives in lib/ipfs-upload-retry.ts
export {
  isPhase120Enabled,
  computeSha256Hex,
  computeChecksumForBlob,
  verifyChecksum,
  exponentialBackoffMs,
  pinFileToIpfsWithRetry,
  uploadToIpfsWithRetry,
  type IpfsUploadRetryConfig,
  type IpfsUploadResult,
  type ChecksumRecord,
} from "@/lib/ipfs-upload-retry"

/**
 * Feature-flag aware uploader:
 *  - flag off → legacy single attempt (zero regression)
 *  - flag on  → retry with exponential backoff + checksum verification
 */
export async function uploadToIPFSWithFlag(fileOrBlob: Blob | File): Promise<string> {
  // dynamic import to avoid bundling node:crypto in client when flag off
  try {
    const mod = await import("@/lib/ipfs-upload-retry")
    if (mod.isPhase120Enabled()) {
      const res = await mod.uploadToIpfsWithRetry(fileOrBlob)
      return res.uri
    }
  } catch {
    // fall through to legacy
  }
  return uploadToIPFS(fileOrBlob)
}
