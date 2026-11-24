import { NextRequest, NextResponse } from "next/server"
import {
  isExperimentationEnabled,
  resolveChamberExperiment,
  resolveForgeExperimentCopyKey,
  resolveForgeRequiredAmountStroops,
} from "@/lib/experiments"
import { forgePriceDisplay } from "@/lib/forge/payment-verifier"
import { pickForgeExperimentCopy } from "@/lib/phase-copy"

export const dynamic = "force-dynamic"

/**
 * GET /api/experiments/forge — spike 612 / #706 (phase-174).
 *
 * Public, read-only view of the forge/chamber price & copy experiment for a
 * subject. The wallet is hashed server-side and never echoed or stored raw;
 * the sticky assignment store is only touched through the resolver. 404 when
 * the flag is off so the route is invisible in the zero-regression path.
 */
export async function GET(request: NextRequest) {
  if (!isExperimentationEnabled()) {
    return NextResponse.json({ error: "phase-174 flag disabled" }, { status: 404 })
  }
  const wallet = request.nextUrl.searchParams.get("wallet")?.trim() || undefined
  const lang = request.nextUrl.searchParams.get("lang")?.trim()
  const surface = request.nextUrl.searchParams.get("surface")?.trim() === "chamber" ? "chamber" : "forge"

  if (surface === "chamber") {
    const chamber = await resolveChamberExperiment(wallet)
    const variantCopy = pickForgeExperimentCopy(lang, chamber.copyKey)
    return NextResponse.json({
      surface: "chamber",
      experimentId: chamber.experimentId,
      variantId: chamber.variantId,
      copyKey: chamber.copyKey,
      amountStroops: chamber.amountStroops,
      priceDisplay: forgePriceDisplay(chamber.amountStroops),
      label: variantCopy.label,
      copy: {
        paymentGateExplainer: variantCopy.paymentGateExplainer,
        paymentGateHint: variantCopy.paymentGateHint,
        chamberBanner: variantCopy.chamberBanner,
        chamberCta: variantCopy.chamberCta,
      },
    })
  }

  const [price, copyKey] = await Promise.all([
    resolveForgeRequiredAmountStroops(wallet),
    resolveForgeExperimentCopyKey(wallet),
  ])
  const variantCopy = pickForgeExperimentCopy(lang, copyKey)

  return NextResponse.json({
    surface: "forge",
    experimentId: price.experimentId,
    variantId: price.variantId,
    copyKey,
    amountStroops: price.amountStroops,
    priceDisplay: forgePriceDisplay(price.amountStroops),
    label: variantCopy.label,
    copy: {
      // `{amount}` is left intact: the forge page substitutes the variant
      // price, the chamber substitutes its on-chain collection price.
      paymentGateExplainer: variantCopy.paymentGateExplainer,
      paymentGateHint: variantCopy.paymentGateHint,
      chamberBanner: variantCopy.chamberBanner,
      chamberCta: variantCopy.chamberCta,
    },
  })
}
