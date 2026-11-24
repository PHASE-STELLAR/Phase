import { NextResponse, type NextRequest } from "next/server";

import { defaultSubjectHash, runSep50Check } from "@/lib/adapters/sep50/adapter";
import { HttpSep50Provider } from "@/lib/adapters/sep50/http-provider";
import {
  createTestnetSep50MockProvider,
  Sep50MockProviderFenceError,
} from "@/lib/adapters/sep50/mock-provider";
import type { Sep50Provider } from "@/lib/adapters/sep50/types";
import { isFlagEnabled } from "@/lib/flags/registry";

export const dynamic = "force-dynamic";

interface Sep50RequestBody {
  homeDomain?: unknown;
  account?: unknown;
  sep10Token?: unknown;
  expiresAt?: unknown;
}

function parseBody(body: Sep50RequestBody) {
  const homeDomain = typeof body.homeDomain === "string" ? body.homeDomain.trim() : "";
  const account = typeof body.account === "string" ? body.account.trim() : "";
  const token = typeof body.sep10Token === "string" ? body.sep10Token.trim() : "";
  const expiresAt =
    typeof body.expiresAt === "number" && Number.isFinite(body.expiresAt)
      ? body.expiresAt
      : NaN;
  if (!homeDomain || !account || !token || !Number.isFinite(expiresAt)) return null;
  return { homeDomain, account, token, expiresAt };
}

export async function POST(request: NextRequest) {
  if (!isFlagEnabled("phase-217")) {
    return NextResponse.json({ ok: false, error: "adapter_disabled" }, { status: 404 });
  }

  let raw: Sep50RequestBody;
  try {
    raw = (await request.json()) as Sep50RequestBody;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }
  const input = parseBody(raw);
  if (input === null) {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }

  const isMock = process.env.PHASE_SEP50_MOCK === "1";
  let provider: Sep50Provider;
  if (isMock) {
    const issuer = process.env.PHASE_SEP50_ISSUER?.trim() ?? "";
    if (!issuer) {
      return NextResponse.json(
        { ok: false, error: "mock_issuer_missing" },
        { status: 503, headers: { "Retry-After": "30" } },
      );
    }
    try {
      provider = createTestnetSep50MockProvider({
        homeDomain: input.homeDomain,
        issuerAccount: issuer,
        subjectHash: defaultSubjectHash(input.account, issuer),
        issuedAt: Date.now() - 1_000,
        expiresAt: Math.min(input.expiresAt, Date.now() + 60_000),
      });
    } catch (error) {
      if (error instanceof Sep50MockProviderFenceError) {
        return NextResponse.json({ ok: false, error: "mock_fenced" }, { status: 403 });
      }
      throw error;
    }
  } else {
    const discoveryUrl = process.env.PHASE_SEP50_DISCOVERY_URL?.trim();
    if (!discoveryUrl) {
      return NextResponse.json(
        { ok: false, error: "adapter_not_configured" },
        { status: 503, headers: { "Retry-After": "300" } },
      );
    }
    provider = new HttpSep50Provider(discoveryUrl);
  }

  const outcome = await runSep50Check(
    {
      homeDomain: input.homeDomain,
      session: {
        account: input.account,
        homeDomain: input.homeDomain,
        token: input.token,
        expiresAt: input.expiresAt,
      },
    },
    { provider, now: () => Date.now(), isMockProvider: isMock },
  );

  if (outcome.status === "ok") {
    return NextResponse.json({ ok: true, subjectHash: outcome.subjectHash });
  }
  if (outcome.status === "unavailable") {
    return NextResponse.json(
      { ok: false, error: outcome.reason },
      { status: 503, headers: { "Retry-After": String(outcome.retryAfter) } },
    );
  }
  return NextResponse.json(
    { ok: false, error: outcome.reason },
    { status: outcome.reason === "invalid_session" ? 400 : 422 },
  );
}
