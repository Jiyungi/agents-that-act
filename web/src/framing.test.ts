import { describe, it, expect } from "vitest";
import {
  FRAMING,
  ERROR_COPY,
  PHASES,
  assertNoForbiddenTerms,
  containsForbiddenTerm,
} from "./framing";

// Feature: packguard, Property 19 (frontend slice): honest framing is always
// present and forbidden terms are always absent in verdict-accompanying copy.
describe("frontend framing copy (Req 17)", () => {
  it("anchors the honest label / attribution / disclaimer", () => {
    expect(FRAMING.resultsLabel.toLowerCase()).toContain(
      "static security review and risk scoring",
    );
    expect(FRAMING.attribution.toLowerCase()).toContain("opsera");
    expect(FRAMING.attribution.toLowerCase()).toContain("static analysis");
    expect(FRAMING.disclaimer.toLowerCase()).toContain("static analysis");
  });

  it("contains no forbidden terms in any FRAMING string (17.2)", () => {
    expect(assertNoForbiddenTerms()).toEqual([]);
  });

  it("contains no forbidden terms in any ERROR_COPY string (17.2)", () => {
    for (const text of Object.values(ERROR_COPY)) {
      expect(containsForbiddenTerm(text)).toBe(false);
    }
  });

  it("defines the four progress phases in order", () => {
    expect(PHASES.map((p) => p.key)).toEqual(["resolve", "fetch", "scan", "upload"]);
  });
});
