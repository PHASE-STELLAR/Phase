import type { BridgeRecord, BridgeStore } from "./types";

/** In-memory store for drills/tests. Production swaps in a durable store with the same interface. */
export class MemoryBridgeStore implements BridgeStore {
  private readonly records = new Map<string, BridgeRecord>();
  private readonly mintClaims = new Set<string>();

  async get(sourceTxHash: string): Promise<BridgeRecord | null> {
    return this.records.get(sourceTxHash) ?? null;
  }

  async put(record: BridgeRecord): Promise<BridgeRecord> {
    const existing = this.records.get(record.sourceTxHash);
    if (existing !== undefined) return existing;
    const copy: BridgeRecord = { ...record };
    this.records.set(record.sourceTxHash, copy);
    return { ...copy };
  }

  async update(
    sourceTxHash: string,
    patch: (record: BridgeRecord) => BridgeRecord,
  ): Promise<BridgeRecord> {
    const existing = this.records.get(sourceTxHash);
    if (existing === undefined) {
      throw new Error(`Bridge record not found: ${sourceTxHash}`);
    }
    const next = patch({ ...existing });
    this.records.set(sourceTxHash, next);
    return { ...next };
  }

  async claimMint(sourceTxHash: string): Promise<boolean> {
    if (this.mintClaims.has(sourceTxHash)) return false;
    this.mintClaims.add(sourceTxHash);
    return true;
  }

  async releaseMintClaim(sourceTxHash: string): Promise<void> {
    this.mintClaims.delete(sourceTxHash);
  }

  snapshot(): readonly BridgeRecord[] {
    return Array.from(this.records.values()).map((record) => ({ ...record }));
  }
}
