/**
 * Spike 596 — pure tally logic for token-weighted polls with delegation and quorum.
 *
 * Polls today are one wallet, one vote (`SignalPollOption.voters: string[]`).
 * This module computes what a weighted poll *would* report, from a weight
 * snapshot, the votes cast and a delegation graph. It performs no I/O and is
 * not wired to any route yet, so it changes no behaviour until a flag-gated
 * consumer is added (see docs/spikes/596-*-findings.md).
 *
 * Design rules:
 *  - Weights come only from a snapshot taken at poll creation, never from live
 *    balances, so buying tokens after a proposal cannot buy votes.
 *  - All arithmetic is BigInt (stroop balances exceed 2^53); every number in
 *    the result is a base-10 string, so it survives JSON.
 *  - A wallet that votes directly always counts for its own choice; a
 *    delegation can never double-count it.
 *  - Output is deterministic: wallets are processed in sorted order.
 */

export type WeightStrategy = "one_wallet" | "token_balance";

export type WeightSnapshot = {
  /** Ledger sequence the balances were read at. */
  ledger: number;
  /** Wall-clock ms when the snapshot was taken. */
  takenAt: number;
  /** wallet -> balance in stroops, as a base-10 string. */
  balances: Record<string, string>;
};

export type Quorum =
  | { kind: "none" }
  | { kind: "absolute"; minWeight: string }
  | { kind: "supply_bps"; bps: number };

export type TallyInput = {
  /** Same shape as the stored poll: each option lists the wallets that chose it. */
  options: { id: string; voters: string[] }[];
  snapshot: WeightSnapshot;
  strategy: WeightStrategy;
  /** `from` lets `to` cast `from`'s weight if `from` does not vote directly. */
  delegations?: { from: string; to: string }[];
  quorum?: Quorum;
  /** Cap on the weight one final voter may count, in bps of total snapshot weight. */
  whaleCapBps?: number;
  /** Longest delegation chain followed (default 5). */
  maxDelegationDepth?: number;
};

export type ExclusionReason =
  | "no_snapshot_weight"
  | "duplicate_vote"
  | "self_delegation"
  | "multiple_delegations"
  | "delegation_cycle"
  | "delegation_too_deep"
  | "delegate_did_not_vote";

export type TallyResult = {
  status: "passed" | "tied" | "no_quorum" | "no_votes";
  winner: string | null;
  tied: string[];
  totals: Record<string, string>;
  /** Weight actually counted, after delegation and the cap. */
  participatingWeight: string;
  /** Total weight in the snapshot under the chosen strategy. */
  totalWeight: string;
  quorum: { reached: boolean; required: string };
  excluded: { wallet: string; reason: ExclusionReason; weight: string }[];
  capped: { wallet: string; from: string; to: string }[];
};

const DEFAULT_MAX_DEPTH = 5;
const BPS = 10_000n;

function parseBalance(wallet: string, raw: string): bigint {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new RangeError(`Invalid snapshot balance for ${wallet}`);
  }
  return BigInt(raw);
}

export function computeWeightedTally(input: TallyInput): TallyResult {
  const maxDepth = input.maxDelegationDepth ?? DEFAULT_MAX_DEPTH;
  const weightOf = new Map<string, bigint>();
  let totalWeight = 0n;
  for (const wallet of Object.keys(input.snapshot.balances).sort()) {
    const balance = parseBalance(wallet, input.snapshot.balances[wallet]);
    const weight = input.strategy === "one_wallet" ? (balance > 0n ? 1n : 0n) : balance;
    weightOf.set(wallet, weight);
    totalWeight += weight;
  }

  const excluded: TallyResult["excluded"] = [];
  const exclude = (wallet: string, reason: ExclusionReason) =>
    excluded.push({ wallet, reason, weight: (weightOf.get(wallet) ?? 0n).toString() });

  // 1. Direct votes: a wallet may appear under one option only.
  const chosen = new Map<string, string>();
  const seenIn = new Map<string, number>();
  for (const option of input.options) {
    for (const wallet of option.voters) seenIn.set(wallet, (seenIn.get(wallet) ?? 0) + 1);
  }
  for (const option of input.options) {
    for (const wallet of [...option.voters].sort()) {
      if ((seenIn.get(wallet) ?? 0) > 1) continue;
      if ((weightOf.get(wallet) ?? 0n) === 0n) continue;
      chosen.set(wallet, option.id);
    }
  }
  for (const wallet of [...seenIn.keys()].sort()) {
    if ((seenIn.get(wallet) ?? 0) > 1) exclude(wallet, "duplicate_vote");
    else if ((weightOf.get(wallet) ?? 0n) === 0n) exclude(wallet, "no_snapshot_weight");
  }

  // 2. Delegation edges: at most one outgoing edge per wallet, no self-edges.
  const edgeCount = new Map<string, number>();
  for (const edge of input.delegations ?? []) {
    edgeCount.set(edge.from, (edgeCount.get(edge.from) ?? 0) + 1);
  }
  const delegateOf = new Map<string, string>();
  for (const edge of [...(input.delegations ?? [])].sort((a, b) => a.from.localeCompare(b.from))) {
    if (edge.from === edge.to) {
      exclude(edge.from, "self_delegation");
    } else if ((edgeCount.get(edge.from) ?? 0) > 1) {
      if (!excluded.some((e) => e.wallet === edge.from && e.reason === "multiple_delegations")) {
        exclude(edge.from, "multiple_delegations");
      }
    } else {
      delegateOf.set(edge.from, edge.to);
    }
  }

  // 3. Effective weight per final voter: own weight, plus every delegator
  //    whose chain ends at them. A direct vote always wins over a delegation.
  const effective = new Map<string, bigint>();
  for (const wallet of chosen.keys()) effective.set(wallet, weightOf.get(wallet) ?? 0n);

  for (const delegator of [...delegateOf.keys()].sort()) {
    const weight = weightOf.get(delegator) ?? 0n;
    if (weight === 0n || chosen.has(delegator)) continue;

    const visited = new Set<string>([delegator]);
    let current = delegator;
    let landed: string | null = null;
    let failure: ExclusionReason | null = null;
    for (let depth = 0; ; depth++) {
      const next = delegateOf.get(current);
      if (next === undefined) {
        failure = "delegate_did_not_vote";
        break;
      }
      if (visited.has(next)) {
        failure = "delegation_cycle";
        break;
      }
      if (depth + 1 > maxDepth) {
        failure = "delegation_too_deep";
        break;
      }
      if (chosen.has(next)) {
        landed = next;
        break;
      }
      visited.add(next);
      current = next;
    }
    if (landed) effective.set(landed, (effective.get(landed) ?? 0n) + weight);
    else exclude(delegator, failure ?? "delegate_did_not_vote");
  }

  // 4. Anti-whale cap on the final, delegation-inclusive weight.
  const capped: TallyResult["capped"] = [];
  if (input.whaleCapBps !== undefined) {
    if (!Number.isInteger(input.whaleCapBps) || input.whaleCapBps < 1 || input.whaleCapBps > 10_000) {
      throw new RangeError("whaleCapBps must be an integer between 1 and 10000");
    }
    const cap = (totalWeight * BigInt(input.whaleCapBps)) / BPS;
    for (const wallet of [...effective.keys()].sort()) {
      const weight = effective.get(wallet) as bigint;
      if (weight > cap) {
        capped.push({ wallet, from: weight.toString(), to: cap.toString() });
        effective.set(wallet, cap);
      }
    }
  }

  // 5. Totals, quorum and outcome.
  const totals = new Map<string, bigint>(input.options.map((o) => [o.id, 0n]));
  let participating = 0n;
  for (const [wallet, weight] of effective) {
    const optionId = chosen.get(wallet) as string;
    totals.set(optionId, (totals.get(optionId) ?? 0n) + weight);
    participating += weight;
  }

  const quorum = input.quorum ?? { kind: "none" };
  let required = 0n;
  if (quorum.kind === "absolute") required = parseBalance("quorum", quorum.minWeight);
  else if (quorum.kind === "supply_bps") {
    if (!Number.isInteger(quorum.bps) || quorum.bps < 0 || quorum.bps > 10_000) {
      throw new RangeError("quorum bps must be an integer between 0 and 10000");
    }
    // Round up, so a fractional requirement is never met by a smaller weight.
    required = (totalWeight * BigInt(quorum.bps) + BPS - 1n) / BPS;
  }
  const reached = participating >= required;

  let max = 0n;
  for (const weight of totals.values()) if (weight > max) max = weight;
  const leaders = [...totals.entries()].filter(([, w]) => w === max).map(([id]) => id).sort();

  let status: TallyResult["status"];
  let winner: string | null = null;
  let tied: string[] = [];
  if (max === 0n) status = "no_votes";
  else if (!reached) status = "no_quorum";
  else if (leaders.length > 1) {
    status = "tied";
    tied = leaders;
  } else {
    status = "passed";
    winner = leaders[0];
  }

  return {
    status,
    winner,
    tied,
    totals: Object.fromEntries([...totals].map(([id, w]) => [id, w.toString()])),
    participatingWeight: participating.toString(),
    totalWeight: totalWeight.toString(),
    quorum: { reached, required: required.toString() },
    excluded: excluded.sort((a, b) => a.wallet.localeCompare(b.wallet) || a.reason.localeCompare(b.reason)),
    capped,
  };
}
