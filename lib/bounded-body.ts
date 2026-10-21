/** Bound memory even when Content-Length is absent or dishonest. */
export async function readBoundedBody(message: Request | Response, maxBytes: number): Promise<string> {
  const reader = message.body?.getReader()
  if (!reader) return ""
  const decoder = new TextDecoder()
  let size = 0, text = ""
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > maxBytes) { await reader.cancel(); throw new Error("BODY_TOO_LARGE") }
      text += decoder.decode(next.value, { stream: true })
    }
    return text + decoder.decode()
  } finally { reader.releaseLock() }
}
