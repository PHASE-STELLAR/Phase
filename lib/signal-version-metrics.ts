/**
 * Issue #207: `signal_version_conflicts` observability.
 *
 * Concurrent writers on one signal are no longer invisible: before the
 * compare-and-swap guard landed, a lost update simply overwrote a peer's write
 * and nothing was recorded. `docs/TECHNICAL.md` §5.3 documents the
 * `signals.version_conflict` log event, but a log line is not a rate — you
 * cannot alert on "conflicts per minute" or tell a traffic spike from a
 * regression that has started rejecting honest writes.
 *
 * These counters are process-local, matching `lib/security-counters.ts`: this
 * repo has no metrics dependency and its observability story is structured
 * `console` logging. `snapshotSignalVersionMetrics()` is what a health endpoint
 * or log line reads; `resetSignalVersionMetrics()` exists for tests.
 *
 * Label values come from closed sets (`SIGNAL_CONFLICT_SURFACES`,
 * `SIGNAL_CRDT_OUTCOMES`) and are never derived from a signal id or a wallet —
 * a caller could otherwise inflate series cardinality just by varying one.
 */

/** Where a stale version was detected. Mirrors the CAS guards in `lib/signal-store.ts`. */
export const SIGNAL_CONFLICT_SURFACES = ["upvote", "edit", "reply", "put"] as const;
export type SignalConflictSurface = (typeof SIGNAL_CONFLICT_SURFACES)[number];

/** Outcome of a CRDT draft commit, which still has to clear the CAS guard. */
export const SIGNAL_CRDT_OUTCOMES = ["committed", "conflicted", "rejected"] as const;
export type SignalCrdtOutcome = (typeof SIGNAL_CRDT_OUTCOMES)[number];

export type SignalVersionMetricName =
  /** Stale-version rejections, summed across every surface. */
  | "signal_version_conflicts"
  /** An internal CAS write that matched zero rows and had to be recomputed. */
  | "signal_version_conflict_retries"
  /** Yjs updates folded into a signal's collaborative draft. */
  | "signal_crdt_merges"
  /** Merges that arrived carrying operations the stored draft had not yet seen. */
  | "signal_crdt_concurrent_merges"
  /** Replicas still missing operations after a full two-way exchange. */
  | "signal_crdt_divergences"
  /** Collaborative drafts committed through the audited CAS path. */
  | "signal_crdt_commits"
  /** Draft commits rejected because the author's `If-Match` was stale. */
  | "signal_crdt_commits_conflicted";

const METRIC_NAMES: SignalVersionMetricName[] = [
  "signal_version_conflicts",
  "signal_version_conflict_retries",
  "signal_crdt_merges",
  "signal_crdt_concurrent_merges",
  "signal_crdt_divergences",
  "signal_crdt_commits",
  "signal_crdt_commits_conflicted",
];

export type SignalVersionMetrics = {
  bySurface: Record<SignalConflictSurface, number>;
  crdtCommitsByOutcome: Record<SignalCrdtOutcome, number>;
} & Record<SignalVersionMetricName, number>;

const counters = new Map<SignalVersionMetricName, number>();
const bySurface = new Map<SignalConflictSurface, number>();
const crdtCommitsByOutcome = new Map<SignalCrdtOutcome, number>();

export function incSignalVersionMetric(name: SignalVersionMetricName, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

export function getSignalVersionMetric(name: SignalVersionMetricName): number {
  return counters.get(name) ?? 0;
}

/**
 * Records a rejected stale write. `retried` separates "the client offered a
 * version it had actually read, so a peer really did land first" from "an
 * internal CAS attempt lost the race and recomputed" — only the first kind is
 * user-visible contention, and the two mean different things operationally.
 */
export function recordSignalVersionConflict(
  surface: SignalConflictSurface,
  opts: { retried?: boolean } = {},
): void {
  incSignalVersionMetric("signal_version_conflicts");
  bySurface.set(surface, (bySurface.get(surface) ?? 0) + 1);
  if (opts.retried) incSignalVersionMetric("signal_version_conflict_retries");
}

export function recordSignalCrdtMerge(concurrency: boolean): void {
  incSignalVersionMetric("signal_crdt_merges");
  if (concurrency) incSignalVersionMetric("signal_crdt_concurrent_merges");
}

export function recordSignalCrdtDivergence(): void {
  incSignalVersionMetric("signal_crdt_divergences");
}

export function recordSignalCrdtCommit(outcome: SignalCrdtOutcome): void {
  incSignalVersionMetric("signal_crdt_commits");
  crdtCommitsByOutcome.set(outcome, (crdtCommitsByOutcome.get(outcome) ?? 0) + 1);
  if (outcome === "conflicted") incSignalVersionMetric("signal_crdt_commits_conflicted");
}

export function snapshotSignalVersionMetrics(): SignalVersionMetrics {
  const out = {
    bySurface: {} as Record<SignalConflictSurface, number>,
    crdtCommitsByOutcome: {} as Record<SignalCrdtOutcome, number>,
  } as SignalVersionMetrics;
  for (const name of METRIC_NAMES) out[name] = counters.get(name) ?? 0;
  for (const surface of SIGNAL_CONFLICT_SURFACES) out.bySurface[surface] = bySurface.get(surface) ?? 0;
  for (const outcome of SIGNAL_CRDT_OUTCOMES) out.crdtCommitsByOutcome[outcome] = crdtCommitsByOutcome.get(outcome) ?? 0;
  return out;
}

export function resetSignalVersionMetrics(): void {
  counters.clear();
  bySurface.clear();
  crdtCommitsByOutcome.clear();
}
