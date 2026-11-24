import { describe, it, expect } from "vitest";
import {
  getLegalCopy,
  LEGAL_COPY,
  calculateCopyExpansion,
} from "@/lib/copy/legal-copy";

describe("legal copy dictionary and expansion resilience", () => {
  it("provides comprehensive dictionary keys for English and Spanish", () => {
    const en = getLegalCopy("en");
    const es = getLegalCopy("es");

    const requiredKeys: (keyof typeof en)[] = [
      "modalTitle",
      "modalSubtitle",
      "tabsTos",
      "tabsPrivacy",
      "versionLabel",
      "effectiveDateLabel",
      "checksumLabel",
      "scrollNotice",
      "acceptCheckbox",
      "acceptButton",
      "rejectButton",
      "consentPendingError",
      "consentSuccess",
      "alreadyAccepted",
      "closeLabel",
    ];

    for (const key of requiredKeys) {
      expect(en[key]).toBeDefined();
      expect(en[key].length).toBeGreaterThan(0);
      expect(es[key]).toBeDefined();
      expect(es[key].length).toBeGreaterThan(0);
    }
  });

  it("confirms Spanish text expansion is positive (~15% to 40% across sentences)", () => {
    const titleExpansion = calculateCopyExpansion("modalTitle");
    const checkboxExpansion = calculateCopyExpansion("acceptCheckbox");
    const noticeExpansion = calculateCopyExpansion("scrollNotice");

    expect(titleExpansion).toBeGreaterThan(0);
    expect(checkboxExpansion).toBeGreaterThan(0);
    expect(noticeExpansion).toBeGreaterThan(0);
  });

  it("falls back to English when an unknown language code is requested", () => {
    const fallback = getLegalCopy("fr-FR");
    expect(fallback.modalTitle).toBe(LEGAL_COPY.en.modalTitle);
  });
});
