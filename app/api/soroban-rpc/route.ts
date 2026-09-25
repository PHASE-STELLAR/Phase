import { NextRequest, NextResponse } from "next/server"

/** Upstream Soroban JSON-RPC (solo servidor; el navegador llama a esta ruta en el mismo origen). */
const DEFAULT_SOROBAN_TESTNET_RPC = "https://soroban-testnet.stellar.org"

/**
 * `simulateTransaction` / `getLedgerEntries` al RPC público suelen tardar >10s; 10s provocaba timeouts
 * en cadena y fallos en cadena aunque el upstream respondiera bien después.
 * Override: `SOROBAN_PROXY_FETCH_TIMEOUT_MS` (Vercel Hobby ~10s de función → bajar a 8000 y aceptar más fallos, o subir plan).
 */
function proxyFetchTimeoutMs(): number {
  const raw = process.env.SOROBAN_PROXY_FETCH_TIMEOUT_MS?.trim()
  const n = raw ? Number.parseInt(raw, 10) : NaN
  if (Number.isFinite(n) && n >= 5_000 && n <= 120_000) return n
  // En local el RPC público suele ir justo; 60s reduce timeouts espúreos.
  if (process.env.NODE_ENV === "development") return 60_000
  return 45_000
}

function attemptsPerUrl(): number {
  // En dev el RPC público de testnet suele fallar en ráfaga; un intento extra ayuda sin alargar demasiado prod.
  return process.env.NODE_ENV === "development" ? 3 : 2
}

/** Pausa entre reintentos al mismo upstream: 1s, 2s, 4s… (no saturar con 503). */
function proxyRetryBackoffMs(attemptIndex: number): number {
  const i = Math.max(0, Math.min(attemptIndex, 8))
  return 1000 * 2 ** i
}

/** HTTP que suelen ser transitorios en el RPC público de testnet. */
const RETRYABLE_HTTP = new Set([502, 503, 504, 429])

/** Debe cubrir varias URLs × reintentos × timeout (p. ej. 3×2×45s); Vercel Pro permite hasta 300s. */
export const maxDuration = 300

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Orden fijo (rotación): primero `STELLAR_RPC_URL` (o default SDF), luego cada entrada de
 * `STELLAR_RPC_FALLBACK_URLS` en orden, y al final el default SDF si no estaba ya en la lista.
 * Tras agotar los reintentos de una URL, el proxy pasa a la siguiente (backoff también entre URLs).
 */
function sorobanUpstreamCandidates(): string[] {
  const primary = process.env.STELLAR_RPC_URL?.trim() || DEFAULT_SOROBAN_TESTNET_RPC
  const extra = (process.env.STELLAR_RPC_FALLBACK_URLS ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s))
  const out: string[] = [primary, ...extra]
  if (!out.includes(DEFAULT_SOROBAN_TESTNET_RPC)) {
    out.push(DEFAULT_SOROBAN_TESTNET_RPC)
  }
  return [...new Set(out)]
}

/**
 * Cuando el upstream falla del todo, respondemos **HTTP 200** + JSON-RPC `error`.
 * Si usáramos 503, Axios del SDK lanza antes de leer el cuerpo → solo "Request failed with status code 503".
 */
function jsonRpcUpstreamError(message: string, rpcId: string | number | null): NextResponse {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    error: { code: -32603, message },
    id: rpcId,
  })
  return new NextResponse(body, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

function parseJsonRpcId(rawBody: string): string | number | null {
  try {
    const j = JSON.parse(rawBody) as { id?: unknown }
    const id = j?.id
    if (typeof id === "number" || typeof id === "string") return id
  } catch {
    /* ignore */
  }
  return null
}

// ── Circuit Breaker & Rate Limiter (Issue #164) ──────────────────────────────
type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN"

interface CircuitStatus {
  state: CircuitState
  failures: number
  nextAttempt: number
}

const upstreamCircuits = new Map<string, CircuitStatus>()
const CIRCUIT_COOLDOWN_MS = 15_000
const FAILURE_THRESHOLD = 3

export function getUpstreamCircuitStatus(url: string): CircuitStatus {
  let status = upstreamCircuits.get(url)
  if (!status) {
    status = { state: "CLOSED", failures: 0, nextAttempt: 0 }
    upstreamCircuits.set(url, status)
  }
  if (status.state === "OPEN" && Date.now() >= status.nextAttempt) {
    status.state = "HALF_OPEN"
  }
  return status
}

export function recordUpstreamSuccess(url: string) {
  const status = getUpstreamCircuitStatus(url)
  status.state = "CLOSED"
  status.failures = 0
}

export function recordUpstreamFailure(url: string, is429: boolean = false) {
  const status = getUpstreamCircuitStatus(url)
  status.failures += 1
  if (is429 || status.failures >= FAILURE_THRESHOLD) {
    status.state = "OPEN"
    status.nextAttempt = Date.now() + CIRCUIT_COOLDOWN_MS
  }
}

/** Rate Limiting: 60 requests / minute per client identifier */
const clientRateLimitMap = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT_WINDOW_MS = 60_000
const MAX_REQUESTS_PER_WINDOW = 60

export function checkProxyRateLimit(clientIp: string): boolean {
  const now = Date.now()
  const record = clientRateLimitMap.get(clientIp)
  if (!record || now >= record.resetAt) {
    clientRateLimitMap.set(clientIp, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return true
  }
  if (record.count >= MAX_REQUESTS_PER_WINDOW) {
    return false
  }
  record.count += 1
  return true
}

export async function POST(req: NextRequest) {
  const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "global"
  if (!checkProxyRateLimit(clientIp)) {
    return jsonRpcUpstreamError("Rate limit exceeded for Soroban RPC proxy. Please retry later.", null)
  }

  let body: string
  try {
    body = await req.text()
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 })
  }
  if (body.length > 2_000_000) {
    return NextResponse.json({ error: "body too large" }, { status: 413 })
  }

  const fetchTimeoutMs = proxyFetchTimeoutMs()
  const rpcId = parseJsonRpcId(body)
  const candidates = sorobanUpstreamCandidates().slice(0, 5)
  // Filter candidates using Circuit Breaker (keep HALF_OPEN or CLOSED)
  let urls = candidates.filter((url) => getUpstreamCircuitStatus(url).state !== "OPEN")
  if (urls.length === 0) {
    // If all circuits are OPEN, fall back to testing the primary candidate
    urls = [candidates[0] || DEFAULT_SOROBAN_TESTNET_RPC]
  }

  const perUrl = attemptsPerUrl()
  let lastFailure = "unknown"

  for (let urlIdx = 0; urlIdx < urls.length; urlIdx++) {
    const url = urls[urlIdx]!
    if (urlIdx > 0) {
      await sleep(proxyRetryBackoffMs(urlIdx - 1))
    }
    for (let attempt = 0; attempt < perUrl; attempt++) {
      try {
        const upstream = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body,
          signal: AbortSignal.timeout(fetchTimeoutMs),
        })

        const text = await upstream.text()
        const ct = upstream.headers.get("Content-Type") || "application/json"

        if (upstream.ok) {
          recordUpstreamSuccess(url)
          return new NextResponse(text, {
            status: upstream.status,
            headers: { "Content-Type": ct },
          })
        }

        if (RETRYABLE_HTTP.has(upstream.status)) {
          lastFailure = `${url} → HTTP ${upstream.status}`
          recordUpstreamFailure(url, upstream.status === 429)
          if (attempt + 1 < perUrl) {
            await sleep(proxyRetryBackoffMs(attempt))
            continue
          }
          break
        }

        recordUpstreamSuccess(url)
        return new NextResponse(text, {
          status: upstream.status,
          headers: { "Content-Type": ct },
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        lastFailure = `${url} → ${msg}`
        recordUpstreamFailure(url, false)
        if (attempt + 1 < perUrl) {
          await sleep(proxyRetryBackoffMs(attempt))
          continue
        }
        break
      }
    }
  }

  if (process.env.NODE_ENV === "development") {
    // eslint-disable-next-line no-console
    console.error("[soroban-rpc] all upstream attempts failed", {
      lastFailure,
      timeoutMs: fetchTimeoutMs,
      urlsTried: urls.length,
    })
  }

  return jsonRpcUpstreamError(
    `Soroban RPC no disponible tras reintentos (${lastFailure}). ` +
      `Si ves timeouts, sube SOROBAN_PROXY_FETCH_TIMEOUT_MS (p. ej. 90000) en local; en Vercel hace falta plan con funciones >10s o un RPC más rápido. ` +
      `También puedes fijar STELLAR_RPC_URL / STELLAR_RPC_FALLBACK_URLS.`,
    rpcId,
  )
}

export async function GET() {
  return new NextResponse("Method Not Allowed — use POST (Soroban JSON-RPC).", {
    status: 405,
    headers: { Allow: "POST" },
  })
}
