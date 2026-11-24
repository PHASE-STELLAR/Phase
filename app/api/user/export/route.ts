import { NextRequest, NextResponse } from "next/server";
import {
  isPortability167Enabled,
  exportUserDataBundle,
  DataPortabilityError,
} from "@/lib/data-portability";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isPortability167Enabled()) {
    return NextResponse.json(
      { error: "Data portability export is disabled (set NEXT_PUBLIC_FEATURE_PHASE_167=1)" },
      { status: 404 },
    );
  }

  const wallet = request.nextUrl.searchParams.get("wallet")?.trim();
  if (!wallet || wallet.length < 10) {
    return NextResponse.json(
      { error: "wallet query parameter is required" },
      { status: 400 },
    );
  }

  // Authorization check: if acting_wallet or x-wallet-address header is present, ensure match or admin
  const actingWallet =
    request.headers.get("x-wallet-address")?.trim() ||
    request.headers.get("acting_wallet")?.trim();
  const adminKey = process.env.PHASE_ADMIN_KEY?.trim();
  const providedAdminKey = request.headers.get("x-admin-key")?.trim();

  if (actingWallet && actingWallet !== wallet && providedAdminKey !== adminKey) {
    return NextResponse.json(
      { error: "Unauthorized: caller wallet does not match export target" },
      { status: 403 },
    );
  }

  try {
    const bundle = await exportUserDataBundle(wallet);
    const filename = `phase-data-export-${wallet}-${Date.now()}.json`;

    return new NextResponse(JSON.stringify(bundle, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "X-Portability-Checksum": bundle.manifest.bundle_checksum,
      },
    });
  } catch (err) {
    if (err instanceof DataPortabilityError) {
      const status =
        err.code === "FLAG_DISABLED"
          ? 404
          : err.code === "UNAUTHORIZED"
            ? 403
            : 400;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    return NextResponse.json(
      { error: "Internal server error", detail: String(err) },
      { status: 500 },
    );
  }
}
