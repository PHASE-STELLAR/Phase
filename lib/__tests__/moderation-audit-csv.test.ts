import { describe, it, expect } from "vitest";
import { formatEventsToCsv, formatEventsToNdjson } from "@/lib/moderation-audit-export";
import type { RedactedAuditEvent } from "@/lib/types/moderation-export";

describe("moderation audit CSV and NDJSON formatting", () => {
  const events: RedactedAuditEvent[] = [
    {
      id: "evt_1",
      signal_id: "sig_100",
      action: "takedown",
      moderator: "GABC...WXYZ",
      reason: 'Prohibited, "wash" trading and spam',
      created_at: 1729250000000,
      ai: {
        queue_id: "q_1",
        decision: "auto_hold",
        confidence: 0.9,
        model_id: "model_x",
      },
    },
    {
      id: "evt_2",
      signal_id: "sig_101",
      action: "restore",
      moderator: "GDEF...1234",
      reason: "Appeal accepted",
      created_at: 1729253600000,
    },
  ];

  it("formats CSV with RFC 4180 escaping", () => {
    const csv = formatEventsToCsv(events);
    const lines = csv.split("\n");

    expect(lines[0]).toBe(
      "id,created_at,timestamp_iso,action,signal_id,moderator,reason,ai_queue_id,ai_decision",
    );
    expect(lines.length).toBe(3);

    // Checks that commas and quotes inside the reason are escaped
    expect(lines[1]).toContain('"Prohibited, ""wash"" trading and spam"');
    expect(lines[1]).toContain("sig_100");
    expect(lines[2]).toContain("Appeal accepted");
  });

  it("formats NDJSON with newline-delimited JSON objects", () => {
    const ndjson = formatEventsToNdjson(events);
    const lines = ndjson.trim().split("\n");

    expect(lines.length).toBe(2);
    const parsed1 = JSON.parse(lines[0]);
    expect(parsed1.id).toBe("evt_1");
    expect(parsed1.action).toBe("takedown");

    const parsed2 = JSON.parse(lines[1]);
    expect(parsed2.id).toBe("evt_2");
    expect(parsed2.action).toBe("restore");
  });
});
