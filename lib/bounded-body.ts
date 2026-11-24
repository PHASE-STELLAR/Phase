export class BoundedBodyError extends Error {
  constructor(readonly code: "BODY_TOO_LARGE" | "BODY_READ_TIMEOUT" | "BODY_READ_FAILED") {
    super(code)
    this.name = "BoundedBodyError"
  }
}

/** Bound memory even when Content-Length is absent or dishonest. */
export async function readBoundedBytes(
  message: Request | Response,
  maxBytes: number,
  timeoutMs = 10_000,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("maxBytes must be a non-negative integer")
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new RangeError("timeoutMs must be a positive integer")
  const reader = message.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let size = 0
  const deadline = Date.now() + timeoutMs
  try {
    while (true) {
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) throw new BoundedBodyError("BODY_READ_TIMEOUT")
      let timeout: ReturnType<typeof setTimeout> | undefined
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new BoundedBodyError("BODY_READ_TIMEOUT")), remainingMs)
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout)
      })
      if (next.done) break
      size += next.value.byteLength
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new BoundedBodyError("BODY_TOO_LARGE")
      }
      chunks.push(next.value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    if (error instanceof BoundedBodyError) throw error
    throw new BoundedBodyError("BODY_READ_FAILED")
  } finally {
    reader.releaseLock()
  }

  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

export async function readBoundedBody(
  message: Request | Response,
  maxBytes: number,
  timeoutMs = 10_000,
): Promise<string> {
  const bytes = await readBoundedBytes(message, maxBytes, timeoutMs)
  return new TextDecoder().decode(bytes)
}
