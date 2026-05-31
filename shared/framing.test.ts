import { describe, it, expect } from "vitest";
import {
  FRAMING_LABEL,
  OPSERA_ATTRIBUTION,
  STATIC_ANALYSIS_DISCLAIMER,
  REQUIRED_FRAMING_TEXTS,
  FORBIDDEN_TERMS,
  findForbiddenTerms,
  containsForbiddenTerm,
} from "./framing.js";

describe("framing copy constants (Req 17)", () => {
  it("exposes the honest label (17.1)", () => {
    expect(FRAMING_LABEL.toLowerCase()).toContain(
      "static security review and risk scoring",
    );
  });

  it("attributes the scan to Opsera using static analysis (17.3)", () => {
    expect(OPSERA_ATTRIBUTION.toLowerCase()).toContain("opsera");
    expect(OPSERA_ATTRIBUTION.toLowerCase()).toContain("static analysis");
  });

  it("includes a static-analysis disclaimer (17.4)", () => {
    expect(STATIC_ANALYSIS_DISCLAIMER.toLowerCase()).toContain(
      "static analysis",
    );
    expect(STATIC_ANALYSIS_DISCLAIMER.toLowerCase()).toContain("malicious");
  });

  it("required framing texts include label, attribution, and disclaimer", () => {
    expect(REQUIRED_FRAMING_TEXTS).toContain(FRAMING_LABEL);
    expect(REQUIRED_FRAMING_TEXTS).toContain(OPSERA_ATTRIBUTION);
    expect(REQUIRED_FRAMING_TEXTS).toContain(STATIC_ANALYSIS_DISCLAIMER);
  });

  it("none of the approved copy contains a forbidden term (17.2 self-check)", () => {
    for (const text of REQUIRED_FRAMING_TEXTS) {
      expect(containsForbiddenTerm(text)).toBe(false);
    }
  });
});

describe("forbidden-term helpers (Req 17.2)", () => {
  it("lists the four forbidden terms", () => {
    expect(FORBIDDEN_TERMS).toEqual([
      "behavioral",
      "dynamic analysis",
      "runtime detection",
      "malware detection",
    ]);
  });

  it("detects forbidden terms case-insensitively as substrings", () => {
    expect(containsForbiddenTerm("This uses Behavioral Analysis")).toBe(true);
    expect(containsForbiddenTerm("DYNAMIC ANALYSIS engine")).toBe(true);
    expect(findForbiddenTerms("runtime detection of malware detection")).toEqual([
      "runtime detection",
      "malware detection",
    ]);
  });

  it("returns no matches for honest text", () => {
    expect(findForbiddenTerms(FRAMING_LABEL)).toEqual([]);
    expect(containsForbiddenTerm("Automated static security review")).toBe(false);
  });
});
