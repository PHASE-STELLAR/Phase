import { describe, it, expect, beforeEach } from "vitest"
import {
  SignalThread,
  wouldCreateCycle,
  computeMaterializedPath,
  getAncestryFromPath,
  migrateThreadRows,
  calculateThreadDepth,
  validateThreadReply,
  SignalThreadError,
} from "@/lib/signal-threads"

describe("signal threads and reply tree normalization (phase-237)", () => {
  beforeEach(() => {
    process.env.FEATURE_PHASE_81 = "1"
    process.env.FEATURE_PHASE_237 = "1"
  })

  it("detects and rejects cyclic parent references", () => {
    const threads: SignalThread[] = [
      {
        id: "t1",
        parentId: null,
        signalId: "s1",
        author: "G" + "A".repeat(55),
        content: "Root",
        depth: 0,
        createdAt: 1000,
        updatedAt: null,
        replyCount: 1,
        isDeleted: false,
      },
      {
        id: "t2",
        parentId: "t1",
        signalId: "s1",
        author: "G" + "B".repeat(55),
        content: "Child",
        depth: 1,
        createdAt: 2000,
        updatedAt: null,
        replyCount: 0,
        isDeleted: false,
      },
    ]

    const lookup = (id: string) => threads.find((t) => t.id === id)

    // Self cycle: t1 -> t1
    expect(wouldCreateCycle("t1", "t1", lookup)).toBe(true)

    // Indirect cycle: making t1's parent t2 (since t2's parent is t1)
    expect(wouldCreateCycle("t1", "t2", lookup)).toBe(true)

    // Valid: t3's parent is t2
    expect(wouldCreateCycle("t3", "t2", lookup)).toBe(false)
  })

  it("caps deep nesting at configured maxDepth", () => {
    const parent: SignalThread = {
      id: "deep-5",
      parentId: "deep-4",
      signalId: "s1",
      author: "G" + "A".repeat(55),
      content: "Deep node",
      depth: 5,
      createdAt: 1000,
      updatedAt: null,
      replyCount: 0,
      isDeleted: false,
    }

    expect(() => calculateThreadDepth(parent, 5)).toThrowError(SignalThreadError)
    expect(calculateThreadDepth(parent, 10)).toBe(6)
  })

  it("computes materialized path and reads ancestry in O(1)", () => {
    const rootPath = computeMaterializedPath(null, "root")
    expect(rootPath).toBe("/root")

    const childPath = computeMaterializedPath("root", "child1", rootPath)
    expect(childPath).toBe("/root/child1")

    const grandChildPath = computeMaterializedPath("child1", "grandchild", childPath)
    expect(grandChildPath).toBe("/root/child1/grandchild")

    const ancestry = getAncestryFromPath(grandChildPath)
    expect(ancestry).toEqual(["root", "child1", "grandchild"])
  })

  it("migrates existing flat thread rows losslessly, identifying orphans and cycles", () => {
    const rawThreads: SignalThread[] = [
      {
        id: "r1",
        parentId: null,
        signalId: "s1",
        author: "G" + "A".repeat(55),
        content: "Root 1",
        depth: 0,
        createdAt: 100,
        updatedAt: null,
        replyCount: 1,
        isDeleted: false,
      },
      {
        id: "r2",
        parentId: "r1",
        signalId: "s1",
        author: "G" + "A".repeat(55),
        content: "Reply to r1",
        depth: 0, // unnormalized
        createdAt: 200,
        updatedAt: null,
        replyCount: 0,
        isDeleted: false,
      },
      {
        id: "orphan1",
        parentId: "non-existent",
        signalId: "s1",
        author: "G" + "A".repeat(55),
        content: "Orphaned",
        depth: 0,
        createdAt: 300,
        updatedAt: null,
        replyCount: 0,
        isDeleted: false,
      },
      {
        id: "c1",
        parentId: "c2",
        signalId: "s1",
        author: "G" + "A".repeat(55),
        content: "Cycle 1",
        depth: 0,
        createdAt: 400,
        updatedAt: null,
        replyCount: 0,
        isDeleted: false,
      },
      {
        id: "c2",
        parentId: "c1",
        signalId: "s1",
        author: "G" + "A".repeat(55),
        content: "Cycle 2",
        depth: 0,
        createdAt: 401,
        updatedAt: null,
        replyCount: 0,
        isDeleted: false,
      },
    ]

    const result = migrateThreadRows(rawThreads)
    expect(result.migrated).toHaveLength(2)
    expect(result.migrated[0].materializedPath).toBe("/r1")
    expect(result.migrated[1].materializedPath).toBe("/r1/r2")
    expect(result.migrated[1].depth).toBe(1)

    expect(result.orphans).toHaveLength(1)
    expect(result.orphans[0].id).toBe("orphan1")

    expect(result.cycles).toContain("c1")
    expect(result.cycles).toContain("c2")
  })
})
