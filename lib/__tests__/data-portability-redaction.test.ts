import { describe, it, expect } from "vitest";
import { redactTextPii, redactPii } from "@/lib/data-portability";

const USER_WALLET = "GBZXN7PIRZGNMHGA728RGRTDGBLRYSPI7N5Z4DK22JWYC7SVQUC65BKU";
const OTHER_WALLET = "GCOZ2Q7JUGZ3R6XGND6PMR7W7U6IOGV3CVD4BWW7UCRUS2C2366XJ264";
const SECRET_KEY = "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("data portability third-party PII redaction", () => {
  it("preserves user wallet while redacting third-party public keys in text", () => {
    const text = `Signal authored by ${USER_WALLET} replying to ${OTHER_WALLET} in thread`;
    const redacted = redactTextPii(text, USER_WALLET);

    expect(redacted).toContain(USER_WALLET);
    expect(redacted).not.toContain(OTHER_WALLET);
    expect(redacted).toContain("[REDACTED_THIRD_PARTY_WALLET]");
  });

  it("redacts secret keys matching Stellar pattern", () => {
    const text = `Exporting config with secret ${SECRET_KEY} leaked`;
    const redacted = redactTextPii(text, USER_WALLET);

    expect(redacted).not.toContain(SECRET_KEY);
    expect(redacted).toContain("[REDACTED_SECRET]");
  });

  it("recursively redacts nested data structures", () => {
    const data = {
      user: USER_WALLET,
      seller_wallet: OTHER_WALLET,
      thread: [
        {
          author: OTHER_WALLET,
          comment: `Great post by ${USER_WALLET}, thanks from ${OTHER_WALLET}!`,
        },
      ],
      meta: {
        last_buyer: OTHER_WALLET,
      },
    };

    const redacted = redactPii(data, USER_WALLET);

    expect(redacted.user).toBe(USER_WALLET);
    expect(redacted.seller_wallet).toBe("[REDACTED_THIRD_PARTY_WALLET]");
    expect(redacted.thread[0].author).toBe("[REDACTED_THIRD_PARTY_WALLET]");
    expect(redacted.thread[0].comment).toContain(USER_WALLET);
    expect(redacted.thread[0].comment).not.toContain(OTHER_WALLET);
    expect(redacted.meta.last_buyer).toBe("[REDACTED_THIRD_PARTY_WALLET]");
  });
});
