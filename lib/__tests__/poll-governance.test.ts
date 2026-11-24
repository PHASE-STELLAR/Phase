import { describe, expect, it } from "vitest"
import { computeWeightedTally, type TallyInput } from "@/lib/poll-governance"

const A = "GA", B = "GB", C = "GC", D = "GD", E = "GE", F = "GF"

function base(over: Partial<TallyInput> = {}): TallyInput {
  return {
    options: [
      { id: "yes", voters: [] },
      { id: "no", voters: [] },
    ],
    snapshot: { ledger: 100, takenAt: 1, balances: {} },
    strategy: "token_balance",
    ...over,
  }
}

const balances = (o: Record<string, string>) => ({ ledger: 100, takenAt: 1, balances: o })

describe("computeWeightedTally (spike 596)", () => {
  it("one_wallet matches today's one-wallet-one-vote counts for snapshot holders", () => {
    const r = computeWeightedTally(
      base({
        strategy: "one_wallet",
        snapshot: balances({ [A]: "5", [B]: "900", [C]: "1" }),
        options: [{ id: "yes", voters: [A, B] }, { id: "no", voters: [C] }],
      }),
    )
    expect(r.totals).toEqual({ yes: "2", no: "1" })
    expect(r.winner).toBe("yes")
    expect(r.status).toBe("passed")
  })

  it("weights by snapshot balance and ignores wallets that were not holders at the snapshot", () => {
    const r = computeWeightedTally(
      base({
        snapshot: balances({ [A]: "100", [B]: "300" }),
        options: [{ id: "yes", voters: [A] }, { id: "no", voters: [B, C] }], // C bought after the snapshot
      }),
    )
    expect(r.totals).toEqual({ yes: "100", no: "300" })
    expect(r.excluded).toEqual([{ wallet: C, reason: "no_snapshot_weight", weight: "0" }])
  })

  it("sums stroop balances above 2^53 exactly", () => {
    const big = "9007199254740993" // 2^53 + 1, not representable as a Number
    const r = computeWeightedTally(
      base({
        snapshot: balances({ [A]: big, [B]: big }),
        options: [{ id: "yes", voters: [A, B] }, { id: "no", voters: [] }],
      }),
    )
    expect(r.totals.yes).toBe("18014398509481986")
    expect(Number(big)).toBe(Number("9007199254740992")) // a plain Number cannot tell these apart
  })

  it("counts a delegated weight for the delegate's choice, and a direct vote overrides the delegation", () => {
    const snap = balances({ [A]: "10", [B]: "20", [C]: "5" })
    const r = computeWeightedTally(
      base({
        snapshot: snap,
        options: [{ id: "yes", voters: [B] }, { id: "no", voters: [C] }],
        delegations: [{ from: A, to: B }],
      }),
    )
    expect(r.totals).toEqual({ yes: "30", no: "5" }) // A's 10 follows B

    const direct = computeWeightedTally(
      base({
        snapshot: snap,
        options: [{ id: "yes", voters: [B] }, { id: "no", voters: [A, C] }],
        delegations: [{ from: A, to: B }],
      }),
    )
    expect(direct.totals).toEqual({ yes: "20", no: "15" }) // A voted itself: counted once
    expect(direct.participatingWeight).toBe("35")
  })

  it("follows chains up to the depth limit and excludes longer ones", () => {
    const snap = balances({ [A]: "1", [B]: "1", [C]: "1", [D]: "10" })
    const input = base({
      snapshot: snap,
      options: [{ id: "yes", voters: [D] }, { id: "no", voters: [] }],
      delegations: [{ from: A, to: B }, { from: B, to: C }, { from: C, to: D }],
    })
    expect(computeWeightedTally(input).totals.yes).toBe("13")
    const short = computeWeightedTally({ ...input, maxDelegationDepth: 2 })
    expect(short.totals.yes).toBe("12") // C -> D (1 hop) and B -> C -> D (2 hops) land; A needs 3
    expect(short.excluded).toEqual([{ wallet: A, reason: "delegation_too_deep", weight: "1" }])
  })

  it("excludes delegation cycles and delegations to wallets that never vote", () => {
    const r = computeWeightedTally(
      base({
        snapshot: balances({ [A]: "1", [B]: "1", [C]: "7", [D]: "3" }),
        options: [{ id: "yes", voters: [D] }, { id: "no", voters: [] }],
        delegations: [{ from: A, to: B }, { from: B, to: A }, { from: C, to: E }],
      }),
    )
    expect(r.totals.yes).toBe("3")
    expect(r.excluded).toEqual([
      { wallet: A, reason: "delegation_cycle", weight: "1" },
      { wallet: B, reason: "delegation_cycle", weight: "1" },
      { wallet: C, reason: "delegate_did_not_vote", weight: "7" },
    ])
  })

  it("rejects self-delegation and ambiguous (multiple) delegations", () => {
    const r = computeWeightedTally(
      base({
        snapshot: balances({ [A]: "1", [B]: "1", [C]: "4", [D]: "2" }),
        options: [{ id: "yes", voters: [C] }, { id: "no", voters: [D] }],
        delegations: [{ from: A, to: A }, { from: B, to: C }, { from: B, to: D }],
      }),
    )
    expect(r.totals).toEqual({ yes: "4", no: "2" })
    expect(r.excluded.map((e) => [e.wallet, e.reason])).toEqual([
      [A, "self_delegation"],
      [B, "multiple_delegations"],
    ])
  })

  it("excludes a wallet that appears under two options", () => {
    const r = computeWeightedTally(
      base({
        snapshot: balances({ [A]: "5", [B]: "5" }),
        options: [{ id: "yes", voters: [A, B] }, { id: "no", voters: [A] }],
      }),
    )
    expect(r.totals).toEqual({ yes: "5", no: "0" })
    expect(r.excluded).toEqual([{ wallet: A, reason: "duplicate_vote", weight: "5" }])
  })

  it("caps a whale's delegation-inclusive weight and reports it", () => {
    const r = computeWeightedTally(
      base({
        snapshot: balances({ [A]: "800", [B]: "100", [C]: "100" }),
        options: [{ id: "yes", voters: [A] }, { id: "no", voters: [B, C] }],
        whaleCapBps: 2500, // 25% of 1000 = 250
      }),
    )
    expect(r.totals).toEqual({ yes: "250", no: "200" })
    expect(r.capped).toEqual([{ wallet: A, from: "800", to: "250" }])
    expect(() => computeWeightedTally(base({ whaleCapBps: 0 }))).toThrow(RangeError)
  })

  it("evaluates quorum exactly at the boundary (absolute and as a share of supply)", () => {
    const snap = balances({ [A]: "40", [B]: "60" })
    const opts = [{ id: "yes", voters: [A] }, { id: "no", voters: [] }]
    const at = (quorum: TallyInput["quorum"]) => computeWeightedTally(base({ snapshot: snap, options: opts, quorum }))

    expect(at({ kind: "absolute", minWeight: "40" }).quorum).toEqual({ reached: true, required: "40" })
    expect(at({ kind: "absolute", minWeight: "41" }).status).toBe("no_quorum")
    expect(at({ kind: "supply_bps", bps: 4000 }).quorum.reached).toBe(true) // 40% of 100
    const miss = at({ kind: "supply_bps", bps: 4001 })
    expect(miss.quorum).toEqual({ reached: false, required: "41" }) // 40.01 rounds up
    expect(miss.winner).toBeNull()
  })

  it("reports ties and empty polls without inventing a winner", () => {
    const tie = computeWeightedTally(
      base({
        snapshot: balances({ [A]: "5", [B]: "5" }),
        options: [{ id: "yes", voters: [A] }, { id: "no", voters: [B] }],
      }),
    )
    expect(tie).toMatchObject({ status: "tied", winner: null, tied: ["no", "yes"] })
    expect(computeWeightedTally(base({ snapshot: balances({ [A]: "5" }) })).status).toBe("no_votes")
  })

  it("is deterministic regardless of input order, and JSON-serialisable", () => {
    const snap = balances({ [A]: "3", [B]: "5", [C]: "7", [D]: "11" })
    const make = (voters1: string[], voters2: string[], edges: { from: string; to: string }[]) =>
      computeWeightedTally(
        base({
          snapshot: snap,
          options: [{ id: "yes", voters: voters1 }, { id: "no", voters: voters2 }],
          delegations: edges,
          whaleCapBps: 5000,
          quorum: { kind: "supply_bps", bps: 1000 },
        }),
      )
    const one = make([A, B], [C], [{ from: D, to: C }, { from: E, to: F }])
    const two = make([B, A], [C], [{ from: E, to: F }, { from: D, to: C }])
    expect(JSON.stringify(one)).toBe(JSON.stringify(two))
    expect(() => JSON.stringify(one)).not.toThrow()
  })

  it("rejects malformed balances", () => {
    for (const bad of ["-1", "1.5", "abc", ""]) {
      expect(() => computeWeightedTally(base({ snapshot: balances({ [A]: bad }) }))).toThrow(RangeError)
    }
  })
})
