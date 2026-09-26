import { NextRequest, NextResponse } from "next/server"
import { phaseProtocolContractIdForServer } from "@/lib/phase-protocol"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function mercuryRestBase(): string {
  return (
    process.env.MERCURY_REST_URL?.trim() ??
    "https://api.mercurydata.app/rest"
  )
}

/**
 * POST /api/nft-index/subscribe
 *
 * Registra un webhook en Mercury para recibir eventos del contrato PHASE en tiempo real.
 * Body JSON: { "webhookUrl": "https://tu-dominio.com/api/webhooks/mercury" }
 * Requiere header `x-admin-key` igual a `PHASE_ADMIN_KEY` si está definida.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const adminKey = process.env.PHASE_ADMIN_KEY?.trim()
  if (adminKey) {
    const provided = req.headers.get("x-admin-key")?.trim()
    if (provided !== adminKey) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 })
    }
  }

  const jwt = process.env.MERCURY_JWT?.trim()
  if (!jwt) {
    return NextResponse.json({ error: "MERCURY_JWT not configured." }, { status: 503 })
  }

  const contractId = (() => {
    try {
      return phaseProtocolContractIdForServer()
    } catch {
      return null
    }
  })()

  if (!contractId) {
    return NextResponse.json(
      { error: "PHASE contract not configured (NEXT_PUBLIC_PHASE_PROTOCOL_ID)." },
      { status: 503 },
    )
  }

  let body: { webhookUrl?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 })
  }

  const webhookUrl = body.webhookUrl?.trim()
  if (!webhookUrl) {
    return NextResponse.json(
      { error: "Missing required field: webhookUrl" },
      { status: 400 },
    )
  }

  // Issue #228: an NFT-index webhook receives every transfer event for the
  // indexed contract, so a subscription pointed at an attacker host is a
  // standing exfiltration channel. Validate the URL and prove the challenge
  // echo before we register anything with Mercury.
  const urlCheck = validateWebhookUrl(webhookUrl)
  if (!urlCheck.ok) {
    console.warn(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "warn",
        event: "nft_index_subscribe_spoof",
        reason: urlCheck.reason,
      }),
    )
    return NextResponse.json({ error: urlCheck.error }, { status: 400 })
  }

  const challenge = crypto.randomUUID()
  const challengeOk = await verifyWebhookChallenge(webhookUrl, challenge)
  if (!challengeOk) {
    console.warn(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "warn",
        event: "webhook_challenge_failed",
        webhookUrl,
      }),
    )
    return NextResponse.json(
      { error: "Webhook Challenge Failed" },
      { status: 400 },
    )
  }

  const res = await fetch(`${mercuryRestBase()}/webhooks/new`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({
      webhook_endpoint: webhookUrl,
      contract_id: contractId,
    }),
  })

  const json = await res.json().catch(() => null)

  if (!res.ok) {
    return NextResponse.json(
      { error: "Mercury webhook registration failed.", detail: json, status: res.status },
      { status: 502 },
    )
  }

  return NextResponse.json({
    ok: true,
    contractId,
    webhookUrl,
    verified: true,
    mercury: json,
    note: "Guardá el 'secret' que devuelve Mercury — solo se muestra una vez.",
  })
}

/**
 * Issue #228: webhook URL validation.
 *
 * A subscription fans out full NFT transfer payloads, so only https endpoints
 * on public hosts are accepted. Anything that could reach loopback, link-local
 * or a private network is refused, which also blocks the classic
 * "subscribe to 169.254.169.254 and read the response" SSRF variant.
 */
export function validateWebhookUrl(
  raw: string,
): { ok: true; url: URL } | { ok: false; error: string; reason: string } {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, error: "webhookUrl must be a valid absolute URL", reason: "malformed" }
  }
  if (url.protocol !== "https:") {
    return { ok: false, error: "webhookUrl must use https", reason: "insecure_protocol" }
  }
  if (url.username || url.password) {
    return { ok: false, error: "webhookUrl must not embed credentials", reason: "credentials" }
  }
  const host = url.hostname.toLowerCase()
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    return { ok: false, error: "webhookUrl host is not routable", reason: "loopback" }
  }
  if (/^\d+$/.test(host) || /^\[/.test(host) || host.includes(":")) {
    return { ok: false, error: "webhookUrl must use a public hostname", reason: "ip_literal" }
  }
  if (host === "169.254.169.254" || host.startsWith("10.") || host.startsWith("192.168.")) {
    return { ok: false, error: "webhookUrl must use a public hostname", reason: "private_network" }
  }
  return { ok: true, url }
}

const CHALLENGE_TIMEOUT_MS = 5_000

/**
 * Issue #228: prove we can actually reach the endpoint before registering it
 * (the Stripe webhook-verification shape). The challenge must come back
 * verbatim in the response body within 5s.
 */
export async function verifyWebhookChallenge(
  webhookUrl: string,
  challenge: string,
  timeoutMs = CHALLENGE_TIMEOUT_MS,
): Promise<boolean> {
  try {
    const target = new URL(webhookUrl)
    target.searchParams.set("challenge", challenge)
    const res = await fetch(target.toString(), {
      method: "GET",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "X-Phase-Challenge": challenge },
    })
    if (!res.ok) return false
    const text = (await res.text()).trim()
    return text.includes(challenge)
  } catch {
    return false
  }
}

/**
 * GET /api/nft-index/subscribe
 * Lista los webhooks registrados en Mercury para esta cuenta.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminKey = process.env.PHASE_ADMIN_KEY?.trim()
  if (adminKey) {
    const provided = req.headers.get("x-admin-key")?.trim()
    if (provided !== adminKey) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 })
    }
  }

  const jwt = process.env.MERCURY_JWT?.trim()
  if (!jwt) {
    return NextResponse.json({ error: "MERCURY_JWT not configured." }, { status: 503 })
  }

  const res = await fetch(`${mercuryRestBase()}/webhooks/list`, {
    headers: { Authorization: `Bearer ${jwt}` },
    cache: "no-store",
  })

  const json = await res.json().catch(() => null)
  return NextResponse.json(json, { status: res.status })
}
