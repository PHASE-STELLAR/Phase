import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const scratch = mkdtempSync(path.join(tmpdir(), "phase-lore-test-"))
process.env.PHASE_DATA_DIR = scratch
process.env.PHASE_DATA_ROOT = scratch
process.env.NEXT_PUBLIC_FEATURE_PHASE_153 = "1"
process.env.FEATURE_PHASE_153 = "1"

import {
  auditLorePassages,
  listLoreAuditReports,
  getLoreAuditReport,
} from "@/lib/lore-auditor"
import { getSecurityCounter, resetSecurityCounters } from "@/lib/security-counters"

function testContradictionDetection() {
  resetSecurityCounters()

  const passages = [
    {
      tokenId: 1,
      entityName: "Aetherius",
      text: "In the Great Cataclysm, Aetherius was destroyed and fell from the celestial sphere.",
    },
    {
      tokenId: 2,
      entityName: "Aetherius",
      text: "Centuries later, Aetherius remains flourishing and living peacefully in the crystal citadel.",
    },
    {
      tokenId: 3,
      entityName: "Valoria",
      text: "Valoria was an ancient city founded during the Golden Age.",
    },
  ]

  const report = auditLorePassages(passages, 1)
  assert.equal(report.status, "FLAGGED")
  assert.equal(report.totalNarrativesScanned, 3)
  assert.equal(report.contradictionsFound, 1)
  assert.ok(report.items)
  assert.equal(report.items[0].severity, "fatal_contradiction")
  assert.equal(report.items[0].entityName, "Aetherius")
  assert.equal(report.items[0].tokenIdA, 1)
  assert.equal(report.items[0].tokenIdB, 2)
  assert.ok(getSecurityCounter("lore_audits_performed") >= 1)
  assert.ok(getSecurityCounter("lore_contradictions_detected") >= 1)

  // Retrieve report from database
  const reports = listLoreAuditReports(1)
  assert.ok(reports.length >= 1)
  assert.equal(reports[0].id, report.id)

  const detailed = getLoreAuditReport(report.id)
  assert.ok(detailed)
  assert.equal(detailed.items?.length, 1)
  assert.equal(detailed.items![0].entityName, "Aetherius")
}

function testCleanPassages() {
  const cleanPassages = [
    {
      tokenId: 10,
      entityName: "Solas",
      text: "Solas guided the stars toward harmony.",
    },
    {
      tokenId: 11,
      entityName: "Luna",
      text: "Luna mirrored the light of Solas from afar.",
    },
  ]

  const report = auditLorePassages(cleanPassages, 2)
  assert.equal(report.status, "COMPLETED")
  assert.equal(report.contradictionsFound, 0)
}

testContradictionDetection()
testCleanPassages()
