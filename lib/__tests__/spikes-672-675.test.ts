import { describe, it, expect } from "vitest";
import {
  editionBadge,
  validateEditionFields,
  dropStatusForListing,
  currentDutchPrice,
  computeCollabSplits,
} from "@/lib/market-store";
import {
  editionLabel,
  dutchQuoteAt,
  isDutchQuoteStale,
  isDropLive,
  validateSplitPayees,
  spikeContractErrorCode,
} from "@/lib/phase-protocol";
import { editionWindowKey } from "@/lib/wash-trading";
import { washScreenReasonForEdition } from "@/lib/wash-screening";
import { contributorEntriesToSplitPayees } from "@/lib/contributor-ledger";
import { previewEscrowFanOut } from "@/lib/escrow-settlement";
import { lobbyAdmissionForBand } from "@/lib/sybil-resistance";

const G1 = "G" + "A".repeat(55);
const G2 = "G" + "B".repeat(55);

describe("spikes 672-675 flag-gated pure helpers", () => {
  it("673: edition badge + validation", () => {
    expect(editionBadge({ edition_number: 3, edition_size: 100 })).toBe("Edition 3/100");
    expect(editionBadge({ is_artist_proof: true })).toBe("Artist Proof");
    expect(editionBadge({})).toBeNull();
    expect(editionLabel({ edition_number: 1, edition_size: 10 })).toBe("Edition 1/10");
    expect(validateEditionFields({ edition_number: 11, edition_size: 10 }).valid).toBe(false);
    expect(validateEditionFields({ is_artist_proof: true }).valid).toBe(false);
    expect(editionWindowKey(7, 3)).toBe("7:e3");
    expect(washScreenReasonForEdition({ edition_number: 2 }, "circular")).toBe("circular:edition_2");
  });

  it("674: N-way splits sum to amount, dust to last payee", () => {
    const splits = computeCollabSplits(100, [
      { wallet: G1, bps: 7000 },
      { wallet: G2, bps: 3000 },
    ]);
    const total = splits.reduce((a, s) => a + s.amount_phaselq, 0);
    expect(Math.abs(total - 100)).toBeLessThan(1e-6);
    expect(() => computeCollabSplits(100, [{ wallet: G1, bps: 6000 }, { wallet: G2, bps: 5000 }])).toThrow();
    expect(validateSplitPayees([{ wallet: G1, bps: 10000 }]).valid).toBe(true);
    expect(contributorEntriesToSplitPayees([{ wallet: G1, shareBps: 5000 }])).toEqual([{ wallet: G1, bps: 5000 }]);
    expect(previewEscrowFanOut(100, [{ wallet: G1, bps: 5000 }, { wallet: G2, bps: 5000 }])).toHaveLength(2);
    expect(spikeContractErrorCode("Error(Contract, #18)")).toBe("EDITION_SUPPLY_EXHAUSTED");
    expect(spikeContractErrorCode("Error(Contract, #13)")).toBeNull();
  });

  it("672: drop window state machine", () => {
    const now = Date.now();
    expect(dropStatusForListing({ drop_start_at: now + 60000 }, now)).toBe("upcoming");
    expect(dropStatusForListing({ drop_end_at: now - 1000 }, now)).toBe("ended");
    expect(dropStatusForListing({}, now)).toBe("live");
    expect(isDropLive(now + 1000, undefined, now)).toBe(false);
    expect(lobbyAdmissionForBand("suspect")).toBe("deny");
    expect(lobbyAdmissionForBand("trusted")).toBe("admit");
  });

  it("675: dutch decay + staleness", () => {
    const listed_at = 1000;
    const end_at = 2000;
    // flag off → fixed price; flag on path tested via dutchQuoteAt pure mirror
    expect(dutchQuoteAt({ start_price: 100, floor_price: 40, listed_at, end_at }, 1000)).toBe(100);
    expect(dutchQuoteAt({ start_price: 100, floor_price: 40, listed_at, end_at }, 2000)).toBe(40);
    const mid = dutchQuoteAt({ start_price: 100, floor_price: 40, listed_at, end_at }, 1500);
    expect(mid).toBeGreaterThan(40);
    expect(mid).toBeLessThan(100);
    expect(isDutchQuoteStale(Date.now() - 120000)).toBe(true);
    expect(isDutchQuoteStale(Date.now())).toBe(false);
    const l = { price_phaselq: 100, listed_at, dutch_start_price: 100, dutch_floor_price: 40, dutch_end_at: end_at } as Parameters<typeof currentDutchPrice>[0];
    expect(currentDutchPrice(l, 1500)).toBeGreaterThanOrEqual(40);
  });
});
