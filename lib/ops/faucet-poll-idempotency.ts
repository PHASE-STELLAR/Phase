/**
 * Pure, non-destructive guard for the faucetPending mid-poll window.
 *
 * A claim that is already pending for the same reward must never trigger a
 * second issuance while the poll is in flight. A different reward is blocked
 * until the pending entry expires. No I/O happens here: the caller supplies
 * the hash factory so the drill can count issuances deterministically.
 */

export const FAUCET_PENDING_TTL_MS = 5 * 60 * 1000;

export interface FaucetPending {
  readonly hash: string;
  readonly reward: string;
  readonly at: number;
}

export interface FaucetPollRow {
  readonly faucetPending?: FaucetPending;
}

export type FaucetPollDecision =
  | { readonly action: "start" | "renew"; readonly pending: FaucetPending }
  | { readonly action: "return"; readonly pending: FaucetPending }
  | { readonly action: "blocked"; readonly blockingReward: string };

export interface FaucetPollResult {
  readonly row: FaucetPollRow;
  readonly decision: FaucetPollDecision;
}

export function isPendingExpired(pending: FaucetPending, now: number, ttlMs = FAUCET_PENDING_TTL_MS): boolean {
  return now - pending.at > ttlMs;
}

export function applyFaucetPoll(
  row: FaucetPollRow,
  reward: string,
  now: number,
  issueHash: () => string,
  ttlMs = FAUCET_PENDING_TTL_MS,
): FaucetPollResult {
  const pending = row.faucetPending;
  if (pending === undefined) {
    const next: FaucetPending = { hash: issueHash(), reward, at: now };
    return { row: { faucetPending: next }, decision: { action: "start", pending: next } };
  }

  if (isPendingExpired(pending, now, ttlMs)) {
    const next: FaucetPending = { hash: issueHash(), reward, at: now };
    return { row: { faucetPending: next }, decision: { action: "renew", pending: next } };
  }

  if (pending.reward === reward) {
    return { row, decision: { action: "return", pending } };
  }

  return { row, decision: { action: "blocked", blockingReward: pending.reward } };
}

export function clearFaucetPoll(row: FaucetPollRow): FaucetPollRow {
  const { faucetPending: _discarded, ...rest } = row;
  return rest;
}
