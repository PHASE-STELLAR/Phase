/**
 * Deterministic test clock for time-sensitive tests (issue #737).
 * Allows tests to control time, eliminating flakiness from real-world clock skew.
 *
 * Usage:
 *   const clock = new TestClock();
 *   const now = clock.now(); // initial time
 *   clock.advance(5000); // advance 5 seconds
 *   clock.freeze(); // freeze at current time
 *   clock.unfreeze(); // resume normal time
 */

let globalTestClock: TestClock | undefined;

export class TestClock {
  private startTime: number;
  private currentTime: number;
  private frozen: boolean = false;
  private frozenTime: number = 0;

  constructor(initialTime: number = Date.now()) {
    this.startTime = initialTime;
    this.currentTime = initialTime;
    if (globalTestClock) {
      globalTestClock.uninstall();
    }
    globalTestClock = this;
    this.install();
  }

  now(): number {
    if (this.frozen) {
      return this.frozenTime;
    }
    return this.currentTime;
  }

  nowDate(): Date {
    return new Date(this.now());
  }

  advance(ms: number): void {
    if (!this.frozen) {
      this.currentTime += ms;
    }
  }

  freeze(): void {
    this.frozen = true;
    this.frozenTime = this.currentTime;
  }

  unfreeze(): void {
    this.frozen = false;
  }

  reset(time: number = this.startTime): void {
    this.currentTime = time;
    this.frozenTime = time;
  }

  private install(): void {
    globalDate = Date;
    const self = this;

    const MockDate = class extends Date {
      constructor(...args: any[]) {
        if (args.length === 0) {
          super(self.now());
        } else {
          super(...args);
        }
      }

      static now(): number {
        return self.now();
      }

      static parse(s: string): number {
        return globalDate.parse(s);
      }

      static UTC(...args: number[]): number {
        return (globalDate as any).UTC(...args);
      }
    } as any;

    global.Date = MockDate as any;
  }

  uninstall(): void {
    if (globalDate) {
      global.Date = globalDate as any;
    }
    if (globalTestClock === this) {
      globalTestClock = undefined;
    }
  }
}

let globalDate: DateConstructor | undefined;

/**
 * Get the currently active test clock, or undefined if none is running.
 */
export function getTestClock(): TestClock | undefined {
  return globalTestClock;
}

/**
 * Reset any active test clock.
 */
export function resetTestClock(): void {
  if (globalTestClock) {
    globalTestClock.uninstall();
    globalTestClock = undefined;
  }
}
