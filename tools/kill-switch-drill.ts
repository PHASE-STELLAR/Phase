/**
 * Non-destructive kill-switch drill.
 *
 * No network calls, no secrets, no env mutation, no chain writes. All state is
 * in memory and every check is repeatable.
 *
 * Run with: npm run drill:kill-switch
 */
import { isFlagEnabled } from "../lib/flags/registry.ts";
import {
  assertAutoRefillAllowed,
  AutoRefillHaltedError,
  parseKillSwitch,
} from "../lib/ops/kill-switch.ts";
import {
  applyFaucetPoll,
  clearFaucetPoll,
  FAUCET_PENDING_TTL_MS,
  type FaucetPollRow,
} from "../lib/ops/faucet-poll-idempotency.ts";

const failures: string[] = [];

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures.push(label);
    console.error(`  FAIL  ${label}`);
  }
}

function makeHashFactory(): { next: () => string; count: () => number } {
  let issued = 0;
  return {
    next: () => `drill-hash-${++issued}`,
    count: () => issued,
  };
}

function runDrills(): void {
  console.log("Kill-switch drill (non-destructive, in-memory)");

  console.log("\n[1] distributor auto-refill halt");
  const halted = parseKillSwitch("auto_refill");
  const haltedAll = parseKillSwitch("all");
  const open = parseKillSwitch("none");

  let caught = 0;
  try {
    assertAutoRefillAllowed(halted);
  } catch (error) {
    if (error instanceof AutoRefillHaltedError) caught++;
  }
  try {
    assertAutoRefillAllowed(haltedAll);
  } catch (error) {
    if (error instanceof AutoRefillHaltedError) caught++;
  }
  check("auto_refill and all snapshots both halt the distributor", caught === 2);

  let openPassed = false;
  try {
    assertAutoRefillAllowed(open);
    openPassed = true;
  } catch {
    openPassed = false;
  }
  check("snapshot with no kill switch allows auto-refill", openPassed);
  check(
    "parseKillSwitch ignores unknown targets",
    parseKillSwitch("bogus,auto_refill").has("auto_refill"),
  );

  console.log("\n[2] faucetPending mid-poll idempotency");
  const hashes = makeHashFactory();
  const now = 1_700_000_000_000;

  const first = applyFaucetPoll({}, "daily", now, hashes.next);
  check("first poll starts a claim and issues exactly one hash", first.decision.action === "start" && hashes.count() === 1);

  const firstHash = first.row.faucetPending?.hash ?? "";
  const midPoll = applyFaucetPoll(first.row, "daily", now + 1_500, hashes.next);
  check(
    "mid-poll re-poll returns the same hash without a second issuance",
    midPoll.decision.action === "return" &&
      midPoll.decision.pending.hash === firstHash &&
      hashes.count() === 1,
  );

  const conflicting = applyFaucetPoll(first.row, "quest", now + 2_000, hashes.next);
  check(
    "different reward is blocked while a poll is pending",
    conflicting.decision.action === "blocked" && hashes.count() === 1,
  );

  const expired = applyFaucetPoll(
    first.row,
    "daily",
    now + FAUCET_PENDING_TTL_MS + 1,
    hashes.next,
  );
  check(
    "after TTL the poll renews with a fresh hash",
    expired.decision.action === "renew" && hashes.count() === 2,
  );

  const cleared = clearFaucetPoll(expired.row);
  check("clearing pending removes only the pending field", cleared.faucetPending === undefined);
  const afterClear = applyFaucetPoll(cleared, "daily", now + FAUCET_PENDING_TTL_MS + 2, hashes.next);
  check("a cleared claim can start a new poll", afterClear.decision.action === "start" && hashes.count() === 3);

  console.log("\n[3] kill switch does not corrupt pending state");
  const frozenRow: FaucetPollRow = first.row;
  let haltedIssuances = 0;
  try {
    assertAutoRefillAllowed(halted);
    applyFaucetPoll(frozenRow, "daily", now + 3_000, () => {
      haltedIssuances++;
      return "should-not-happen";
    });
  } catch (error) {
    check("halted distributor never reaches the issuance path", error instanceof AutoRefillHaltedError);
  }
  check("halted drill performed zero issuances", haltedIssuances === 0);
  check("pending row is unchanged by the halted path", frozenRow.faucetPending?.hash === "drill-hash-1");
}

if (!isFlagEnabled("phase-174")) {
  console.log("Kill-switch drill skipped: PHASE_FLAG_KILL_SWITCH_DRILLS is off.");
} else {
  runDrills();
  if (failures.length > 0) {
    console.error(`\nDRILL FAILED (${failures.length} check(s)).`);
    process.exit(1);
  }
  console.log("\nDRILL PASSED: no funds moved, no state persisted outside memory.");
}
