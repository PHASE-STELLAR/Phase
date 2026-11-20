import { timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { checkAdminKey } from "@/lib/admin-key";
import {
  ALL_FEATURE_FLAGS,
  FeatureFlagOpsError,
  type FeatureFlagRule,
  activateFlagKillSwitch,
  evaluateFeatureFlag,
  exportFeatureFlagRulesSnapshot,
  featureFlagOpsCacheState,
  getKillSwitchDrillHistory,
  isFeatureFlagOpsEnabled,
   isValidPhaseFeatureFlag,
  liftFlagKillSwitch,
  listFeatureFlagRules,
  refreshFeatureFlagOpsCache,
  removeFeatureFlagRule,
  runKillSwitchDrill,
  setFeatureFlagRule,
} from "@/lib/feature-flags";
import { readJsonFile, updateStore } from "@/lib/json-store";
import { serverDataJsonPath } from "@/lib/server-data-paths";
import { auditAdminAction, requiresConfirmation, validateAdminAction, getAuditLog } from "@/lib/admin-console";
import { incSecurityCounter } from "@/lib/security-counters";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type FlagOpsStore = Record<string, FeatureFlagRule>;

function isAuthorizedAdmin(req: NextRequest): boolean {
  if (checkAdminKey(req) === "ok") return true;
  const adminToken = process.env.ADMIN_API_TOKEN?.trim();
  const authHeader = req.headers.get("authorization");
  if (!adminToken || !authHeader?.startsWith("Bearer ")) return false;
  const provided = authHeader.slice(7).trim();
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(adminToken, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function getOperatorIdentity(req: NextRequest): string {
  return req.headers.get("x-operator-id") || req.headers.get("x-admin-key")?.slice(0, 8) || "unknown";
}

async function hydrateFromSidecar() {
  return refreshFeatureFlagOpsCache(() =>
    readJsonFile<FlagOpsStore>(serverDataJsonPath("featureFlagOps"), {}),
  );
}

export async function GET(req: NextRequest) {
  if (!isFeatureFlagOpsEnabled()) {
    return NextResponse.json(
      { error: "feature-flag ops disabled", code: "FLAG_DISABLED" },
      { status: 404 },
    );
  }
  if (!isAuthorizedAdmin(req)) {
    incSecurityCounter("admin_unauthorized_access")
    return NextResponse.json(
      { error: "Unauthorized — valid admin key or token required", code: "UNAUTHORIZED" },
      { status: 401 },
    );
  }

  await hydrateFromSidecar();
  const wallet = req.nextUrl.searchParams.get("wallet")?.trim() || null;
  const evaluations = ALL_FEATURE_FLAGS.map((flag) =>
    evaluateFeatureFlag(flag, { wallet, runtimeOnly: true }),
  );

  const operator = getOperatorIdentity(req);
  incSecurityCounter("admin_feature_flags_accessed")

  return NextResponse.json({
    ok: true,
    operator,
    cacheState: featureFlagOpsCacheState(),
    rules: listFeatureFlagRules(),
    evaluations,
    drills: getKillSwitchDrillHistory(),
    auditLog: getAuditLog(50),
  });
}

export async function POST(req: NextRequest) {
  if (!isFeatureFlagOpsEnabled()) {
    return NextResponse.json(
      { error: "feature-flag ops disabled", code: "FLAG_DISABLED" },
      { status: 404 },
    );
  }
  if (!isAuthorizedAdmin(req)) {
    incSecurityCounter("admin_unauthorized_access")
    return NextResponse.json(
      { error: "Unauthorized — valid admin key or token required", code: "UNAUTHORIZED" },
      { status: 401 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    incSecurityCounter("admin_bad_json")
    return NextResponse.json({ error: "Invalid JSON body", code: "BAD_JSON" }, { status: 400 });
  }

  const operator = getOperatorIdentity(req);
  const reason = typeof body.reason === "string" ? body.reason : undefined;
  const confirmed = body.confirmed === true || body.confirmed === "true";

  await hydrateFromSidecar();
  const action = typeof body.action === "string" ? body.action.trim() : "set_rule";
  const flag = body.flag as string | undefined;

  if (action === "kill_switch" && requiresConfirmation("feature_flag_kill_switch")) {
    if (!confirmed) {
      incSecurityCounter("admin_destructive_action_unconfirmed")
      return NextResponse.json(
        { error: "Destructive action requires confirmation. Set confirmed: true", code: "CONFIRMATION_REQUIRED" },
        { status: 409 },
      );
    }
  }

  try {
    if (action === "run_drill") {
      auditAdminAction({
        id: randomUUID(),
        action: "feature_flag_kill_switch",
        operator,
        timestamp: Date.now(),
        resourceId: "kill_switch",
        resourceType: "drill",
        reason,
        confirmed,
        success: true,
      })
      const report = await runKillSwitchDrill();
      return NextResponse.json({ ok: report.passed, drill: report }, { status: report.passed ? 200 : 500 });
    }

    if (!isValidPhaseFeatureFlag(flag)) {
      auditAdminAction({
        id: randomUUID(),
        action: "feature_flag_toggle",
        operator,
        timestamp: Date.now(),
        resourceId: String(flag),
        resourceType: "feature_flag",
        reason,
        confirmed,
        success: false,
        error: "Invalid flag",
      })
      return NextResponse.json(
        { error: "Valid PhaseFeatureFlag required", code: "INVALID_FLAG" },
        { status: 400 },
      );
    }

    const ifMatchHeader = req.headers.get("if-match")?.replace(/"/g, "").trim();
    const expectedVersion =
      typeof body.expectedVersion === "number"
        ? body.expectedVersion
        : ifMatchHeader && /^\d+$/.test(ifMatchHeader)
          ? Number(ifMatchHeader)
          : undefined;

    if (action === "remove_rule") {
      await updateStore<FlagOpsStore, boolean>("featureFlagOps", (store) => {
        delete store[flag];
        return removeFeatureFlagRule(flag);
      });
      auditAdminAction({
        id: randomUUID(),
        action: "feature_flag_toggle",
        operator,
        timestamp: Date.now(),
        resourceId: flag,
        resourceType: "feature_flag",
        reason,
        confirmed,
        success: true,
      })
      return NextResponse.json({ ok: true, flag, removed: true });
    }

    const rule = await updateStore<FlagOpsStore, FeatureFlagRule>("featureFlagOps", (store) => {
      // Sync in-memory cache with locked store before applying CAS update
      for (const [k, v] of Object.entries(store)) {
        if (isValidPhaseFeatureFlag(k) && v) {
          setFeatureFlagRule({
            flag: k,
            killSwitch: v.killSwitch,
            overrideEnabled: v.overrideEnabled,
            rolloutBps: v.rolloutBps,
            allowWallets: v.allowWallets,
            denyWallets: v.denyWallets,
            updatedBy: v.updatedBy,
            reason: v.reason,
          });
        }
      }

      let updated: FeatureFlagRule;
      if (action === "kill_switch") {
        const active = body.killSwitch !== false;
        updated = active
          ? activateFlagKillSwitch(flag, {
              updatedBy: typeof body.updatedBy === "string" ? body.updatedBy : undefined,
              reason: typeof body.reason === "string" ? body.reason : undefined,
              expectedVersion,
            })
          : liftFlagKillSwitch(flag, {
              updatedBy: typeof body.updatedBy === "string" ? body.updatedBy : undefined,
              reason: typeof body.reason === "string" ? body.reason : undefined,
              expectedVersion,
            });
      } else {
        updated = setFeatureFlagRule({
          flag,
          killSwitch: typeof body.killSwitch === "boolean" ? body.killSwitch : undefined,
          overrideEnabled:
            body.overrideEnabled === null || typeof body.overrideEnabled === "boolean"
              ? body.overrideEnabled
              : undefined,
          rolloutBps:
            body.rolloutBps === null || typeof body.rolloutBps === "number"
              ? body.rolloutBps
              : undefined,
          allowWallets: Array.isArray(body.allowWallets)
            ? body.allowWallets.filter((w): w is string => typeof w === "string")
            : undefined,
          denyWallets: Array.isArray(body.denyWallets)
            ? body.denyWallets.filter((w): w is string => typeof w === "string")
            : undefined,
          updatedBy: typeof body.updatedBy === "string" ? body.updatedBy : undefined,
          reason: typeof body.reason === "string" ? body.reason : undefined,
          expectedVersion,
        });
      }

      const snapshot = exportFeatureFlagRulesSnapshot();
      for (const k of Object.keys(store)) delete store[k];
      Object.assign(store, snapshot);
      return updated;
    });

    auditAdminAction({
      id: randomUUID(),
      action: action === "kill_switch" ? "feature_flag_kill_switch" : "feature_flag_toggle",
      operator,
      timestamp: Date.now(),
      resourceId: flag,
      resourceType: "feature_flag",
      reason,
      confirmed,
      success: true,
    })

    const res = NextResponse.json({
      ok: true,
      rule,
      evaluation: evaluateFeatureFlag(flag, { runtimeOnly: true }),
      operator,
      auditLog: getAuditLog(50),
    });
    res.headers.set("ETag", `"${rule.version}"`);
    return res;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Feature flag operation failed";
    auditAdminAction({
      id: randomUUID(),
      action: action === "kill_switch" ? "feature_flag_kill_switch" : "feature_flag_toggle",
      operator,
      timestamp: Date.now(),
      resourceId: flag || "unknown",
      resourceType: "feature_flag",
      reason,
      confirmed,
      success: false,
      error: errorMsg,
    })

    if (err instanceof FeatureFlagOpsError) {
      const status =
        err.code === "VERSION_CONFLICT"
          ? 409
          : err.code === "FLAG_DISABLED" || err.code === "NOT_FOUND"
            ? 404
            : 400;
      return NextResponse.json(
        { error: err.message, code: err.code, details: err.details },
        { status },
      );
    }
    return NextResponse.json(
      { error: errorMsg },
      { status: 500 },
    );
  }
}
