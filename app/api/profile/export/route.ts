import { NextRequest } from "next/server";
import { GET as userExportGET } from "@/app/api/user/export/route";

export const dynamic = "force-dynamic";

/**
 * GET /api/profile/export?wallet=...
 *
 * Profile export alias redirecting directly into the GDPR Article 20 data portability pipeline.
 */
export async function GET(request: NextRequest) {
  return userExportGET(request);
}
