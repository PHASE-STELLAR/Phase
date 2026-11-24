import { getDb } from "@/lib/sqlite-db";
import { incSecurityCounter } from "@/lib/security-counters";
import { randomUUID } from "node:crypto";

export type LorePassage = {
  id?: string;
  tokenId?: number;
  collectionId?: number;
  entityName: string;
  text: string;
};

export type LoreContradiction = {
  id: string;
  reportId: string;
  entityName: string;
  severity: "minor_discrepancy" | "timeline_conflict" | "fatal_contradiction";
  passageA: string;
  tokenIdA: number | null;
  passageB: string;
  tokenIdB: number | null;
  explanation: string;
  confidence: number;
};

export type LoreAuditReport = {
  id: string;
  collectionId: number | null;
  totalNarrativesScanned: number;
  contradictionsFound: number;
  status: "COMPLETED" | "FLAGGED";
  createdAt: number;
  items?: LoreContradiction[];
};

/**
 * Audits a set of lore passages for cross-world entity contradictions and timeline anomalies.
 */
export function auditLorePassages(
  passages: LorePassage[],
  collectionId: number | null = null,
  nowMs = Date.now(),
): LoreAuditReport {
  incSecurityCounter("lore_audits_performed");
  const reportId = `audit_${randomUUID().slice(0, 12)}`;
  const contradictions: LoreContradiction[] = [];

  // Group passages by entity
  const entityMap = new Map<string, LorePassage[]>();
  for (const p of passages) {
    const key = p.entityName.trim().toLowerCase();
    if (!entityMap.has(key)) entityMap.set(key, []);
    entityMap.get(key)!.push(p);
  }

  // Cross-compare passages for each entity
  for (const [entity, list] of entityMap.entries()) {
    if (list.length < 2) continue;

    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        const textA = a.text.toLowerCase();
        const textB = b.text.toLowerCase();

        // Check for common contradiction patterns (alive vs destroyed/dead, ally vs enemy)
        let severity: "minor_discrepancy" | "timeline_conflict" | "fatal_contradiction" | null = null;
        let explanation = "";

        if (
          (textA.includes("destroyed") || textA.includes("slain") || textA.includes("extinct")) &&
          (textB.includes("flourishing") || textB.includes("living") || textB.includes("alive"))
        ) {
          severity = "fatal_contradiction";
          explanation = `Passage A states entity ${entity} was destroyed/slain, while Passage B asserts they are alive or flourishing.`;
        } else if (
          (textA.includes("allied with") || textA.includes("sworn loyal")) &&
          (textB.includes("sworn enemy") || textB.includes("bitter rival"))
        ) {
          severity = "timeline_conflict";
          explanation = `Passage A records ${entity} as a loyal ally, while Passage B characterizes them as an enemy without recorded betrayal.`;
        } else if (
          (textA.includes("year 100") || textA.includes("first age")) &&
          (textB.includes("year 50") || textB.includes("dawn era")) &&
          textA.includes("before") && textB.includes("after")
        ) {
          severity = "timeline_conflict";
          explanation = `Chronological sequence divergence detected regarding ${entity}.`;
        }

        if (severity) {
          contradictions.push({
            id: `contra_${randomUUID().slice(0, 12)}`,
            reportId,
            entityName: a.entityName,
            severity,
            passageA: a.text,
            tokenIdA: a.tokenId ?? null,
            passageB: b.text,
            tokenIdB: b.tokenId ?? null,
            explanation,
            confidence: severity === "fatal_contradiction" ? 0.95 : 0.85,
          });
        }
      }
    }
  }

  if (contradictions.length > 0) {
    incSecurityCounter("lore_contradictions_detected", contradictions.length);
  }

  const db = getDb();
  db.prepare(`
    INSERT INTO lore_audit_reports (id, collection_id, total_narratives_scanned, contradictions_found, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    reportId,
    collectionId,
    passages.length,
    contradictions.length,
    contradictions.length > 0 ? "FLAGGED" : "COMPLETED",
    nowMs,
  );

  const insertItem = db.prepare(`
    INSERT INTO lore_contradiction_items (
      id, report_id, entity_name, severity, passage_a, token_id_a,
      passage_b, token_id_b, explanation, confidence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const c of contradictions) {
    insertItem.run(
      c.id,
      reportId,
      c.entityName,
      c.severity,
      c.passageA,
      c.tokenIdA,
      c.passageB,
      c.tokenIdB,
      c.explanation,
      c.confidence,
    );
  }

  return {
    id: reportId,
    collectionId,
    totalNarrativesScanned: passages.length,
    contradictionsFound: contradictions.length,
    status: contradictions.length > 0 ? "FLAGGED" : "COMPLETED",
    createdAt: nowMs,
    items: contradictions,
  };
}

/**
 * Retrieves past audit reports.
 */
export function listLoreAuditReports(collectionId?: number): LoreAuditReport[] {
  const db = getDb();
  let query = "SELECT * FROM lore_audit_reports";
  const params: any[] = [];

  if (collectionId !== undefined) {
    query += " WHERE collection_id = ?";
    params.push(collectionId);
  }
  query += " ORDER BY created_at DESC LIMIT 20";

  const rows = db.prepare(query).all(...params) as any[];
  return rows.map((r) => ({
    id: r.id,
    collectionId: r.collection_id ? Number(r.collection_id) : null,
    totalNarrativesScanned: Number(r.total_narratives_scanned),
    contradictionsFound: Number(r.contradictions_found),
    status: r.status,
    createdAt: Number(r.created_at),
  }));
}

/**
 * Retrieves a single audit report with contradiction details.
 */
export function getLoreAuditReport(reportId: string): LoreAuditReport | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM lore_audit_reports WHERE id = ?").get(reportId) as any;
  if (!row) return null;

  const items = db.prepare("SELECT * FROM lore_contradiction_items WHERE report_id = ?").all(reportId) as any[];

  return {
    id: row.id,
    collectionId: row.collection_id ? Number(row.collection_id) : null,
    totalNarrativesScanned: Number(row.total_narratives_scanned),
    contradictionsFound: Number(row.contradictions_found),
    status: row.status,
    createdAt: Number(row.created_at),
    items: items.map((c) => ({
      id: c.id,
      reportId: c.report_id,
      entityName: c.entity_name,
      severity: c.severity,
      passageA: c.passage_a,
      tokenIdA: c.token_id_a !== null ? Number(c.token_id_a) : null,
      passageB: c.passage_b,
      tokenIdB: c.token_id_b !== null ? Number(c.token_id_b) : null,
      explanation: c.explanation,
      confidence: Number(c.confidence),
    })),
  };
}
