import { NextRequest, NextResponse } from "next/server";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { listMcpTools, handleMcpRpc } from "@/lib/mcp-server";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!isFeatureEnabled("phase-152")) {
    return NextResponse.json({ error: "Feature phase-152 disabled" }, { status: 404 });
  }

  return NextResponse.json({
    name: "phase-mcp-server",
    version: "1.0.0",
    protocolVersion: "2024-11-05",
    tools: listMcpTools(),
  });
}

export async function POST(req: NextRequest) {
  if (!isFeatureEnabled("phase-152")) {
    return NextResponse.json({ error: "Feature phase-152 disabled" }, { status: 404 });
  }

  try {
    const payload = await req.json();
    const response = await handleMcpRpc(payload);
    return NextResponse.json(response);
  } catch (err: any) {
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error: " + (err.message || "Invalid JSON") },
      },
      { status: 400 },
    );
  }
}
