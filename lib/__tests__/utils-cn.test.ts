import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { cn } from "../utils.js"

describe("lib/utils - cn class merging", () => {
  it("merges standard class names cleanly", () => {
    const result = cn("px-2 py-1", "bg-red-500", "text-white")
    assert.equal(result, "px-2 py-1 bg-red-500 text-white")
  })

  it("resolves conflicting tailwind classes", () => {
    const result = cn("px-2 px-4", "text-red-500 text-blue-500")
    assert.equal(result, "px-4 text-blue-500")
  })

  it("handles conditional classes, falsy values, and arrays", () => {
    const isPrimary = true
    const isHidden = false
    const result = cn(
      "base-class",
      isPrimary && "primary-class",
      isHidden && "hidden-class",
      null,
      undefined,
      ["nested-1", "nested-2"],
    )
    assert.equal(result, "base-class primary-class nested-1 nested-2")
  })

  it("returns empty string when given no inputs or empty inputs", () => {
    assert.equal(cn(), "")
    assert.equal(cn(null, undefined, false), "")
  })
})
