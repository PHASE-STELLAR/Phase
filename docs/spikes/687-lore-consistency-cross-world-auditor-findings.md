# Spike 687 — AI Lore-Consistency Auditor with Cross-World Contradiction Reports Findings (Issue #550)

## What the issue claimed

The issue noted that as multiple creators add narrative lore, signals, and artifact world-building across collections, lore inconsistencies, chronological paradoxes, and dead-vs-living entity contradictions arise without an automated auditing mechanism.

## What the code actually did at spike time

- `lib/story-arc-continuity.ts` provided basic single-world narrative continuity validation at generation time.
- No cross-world or multi-passage entity audit engine existed.
- SQLite had no storage for contradiction reports, evidence citations, or severity levels.

## The gap that was real

Curators and community lorekeepers had no system to scan narrative corpora, extract entity claims, detect mutual contradictions (e.g. fatal status vs flourishing status, or chronological timeline divergences), and quote both conflicting passages with token IDs.

## Delivered specification (phase-153)

1. **Cross-world auditor engine (`lib/lore-auditor.ts`)**:
   - Compares entity statements across narrative passages.
   - Categorizes findings by severity: `minor_discrepancy`, `timeline_conflict`, `fatal_contradiction`.
   - Generates confidence scores and detailed conflict explanations.
2. **Persistence (`lib/sqlite-db.ts`)**:
   - `lore_audit_reports` table tracking scanned narratives, status, and contradiction totals.
   - `lore_contradiction_items` table storing specific entity conflicts with dual-passage quotes and token references.
3. **API endpoint (`app/api/world/lore-audit/route.ts`)**:
   - GET: List historical audit reports or fetch a detailed report by ID.
   - POST: Submit passages for consistency audit and save reports.

## Decision & Rollback

- Gated under feature flag `phase-153` (`NEXT_PUBLIC_FEATURE_PHASE_153` / `FEATURE_PHASE_153`).
- Rollback: unset env var and restart. Reports table remains inert.
