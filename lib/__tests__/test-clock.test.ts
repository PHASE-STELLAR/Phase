/**
 * Deterministic test clock — demonstrates time-sensitive test patterns (issue #737).
 * Run: npm run test
 */
import { describe, it, afterEach } from "vitest";
import assert from "node:assert/strict";
import { TestClock, resetTestClock } from "@/lib/test-clock";

describe("TestClock", () => {
  afterEach(() => {
    resetTestClock();
  });

  it("tracks time deterministically", () => {
    const clock = new TestClock(1000000);
    assert.equal(clock.now(), 1000000);

    clock.advance(5000);
    assert.equal(clock.now(), 1005000);

    clock.advance(3000);
    assert.equal(clock.now(), 1008000);
  });

  it("freezes and unfreezes time", () => {
    const clock = new TestClock(1000000);
    clock.freeze();

    clock.advance(1000); // advance is ignored while frozen
    assert.equal(clock.now(), 1000000);

    clock.unfreeze();
    clock.advance(1000);
    assert.equal(clock.now(), 1001000);
  });

  it("mocks global Date.now()", () => {
    const clock = new TestClock(2000000);
    assert.equal(Date.now(), 2000000);

    clock.advance(500);
    assert.equal(Date.now(), 2000500);
  });

  it("mocks Date constructor", () => {
    const clock = new TestClock(3000000);
    const date = new Date();
    assert.equal(date.getTime(), 3000000);

    clock.advance(1000);
    const date2 = new Date();
    assert.equal(date2.getTime(), 3001000);
  });

  it("supports TTL window tests with deterministic clock", () => {
    const TTL_SECONDS = 300;
    const clock = new TestClock(1000000 * 1000); // milliseconds

    const issuedAt = clock.now();
    const expiresAt = issuedAt + TTL_SECONDS * 1000;

    // Within TTL
    clock.advance(100 * 1000); // 100 seconds later
    assert.ok(clock.now() < expiresAt, "token not yet expired");

    // At TTL boundary
    clock.reset(expiresAt - 1);
    assert.ok(clock.now() < expiresAt, "just before expiry");

    clock.reset(expiresAt);
    assert.ok(clock.now() >= expiresAt, "past expiry");
  });

  it("resets to initial or custom time", () => {
    const clock = new TestClock(1000000);
    clock.advance(5000);
    assert.equal(clock.now(), 1005000);

    clock.reset();
    assert.equal(clock.now(), 1000000);

    clock.reset(2000000);
    assert.equal(clock.now(), 2000000);
  });
});
