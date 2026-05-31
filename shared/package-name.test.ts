import { describe, expect, it } from "vitest";
import {
  MAX_PACKAGE_NAME_LENGTH,
  PackageNameError,
  assertValidPackageName,
  decodePackageName,
  encodePackageName,
  isValidPackageName,
  validatePackageName,
} from "@shared/package-name";
import { FetchErrorType } from "@shared/errors";

describe("validatePackageName", () => {
  it("accepts common unscoped names", () => {
    for (const name of ["left-pad", "lodash", "lodash.merge", "some_pkg", "a", "react"]) {
      expect(validatePackageName(name)).toEqual({ valid: true });
    }
  });

  it("accepts well-formed scoped names", () => {
    for (const name of ["@scope/name", "@acme/widget", "@a/b", "@types/node"]) {
      expect(validatePackageName(name)).toEqual({ valid: true });
    }
  });

  it("accepts a name of exactly 214 characters and rejects 215", () => {
    expect(isValidPackageName("a".repeat(MAX_PACKAGE_NAME_LENGTH))).toBe(true);
    expect(isValidPackageName("a".repeat(MAX_PACKAGE_NAME_LENGTH + 1))).toBe(false);
  });

  it("rejects empty and whitespace-only names", () => {
    for (const name of ["", " ", "   ", "\t", "\n"]) {
      const result = validatePackageName(name);
      expect(result.valid).toBe(false);
    }
  });

  it("rejects leading/trailing whitespace", () => {
    for (const name of [" left-pad", "left-pad ", " left-pad ", "left pad"]) {
      expect(isValidPackageName(name)).toBe(false);
    }
  });

  it("rejects names with uppercase letters", () => {
    for (const name of ["React", "LODASH", "Left-Pad", "@Scope/name", "@scope/Name"]) {
      expect(isValidPackageName(name)).toBe(false);
    }
  });

  it("rejects names starting with a period or underscore", () => {
    for (const name of [".hidden", "_private", "@scope/.x", "@scope/_y", "@.bad/x", "@_bad/x"]) {
      expect(isValidPackageName(name)).toBe(false);
    }
  });

  it("rejects npm-forbidden special characters", () => {
    for (const name of ["foo~bar", "foo'bar", "foo!bar", "foo(bar", "foo)bar", "foo*bar"]) {
      expect(isValidPackageName(name)).toBe(false);
    }
  });

  it("rejects characters that are not URL-safe", () => {
    for (const name of ["foo bar", "foo%bar", "foo#bar", "foo?bar", "foo:bar", "café"]) {
      expect(isValidPackageName(name)).toBe(false);
    }
  });

  it("rejects malformed scoped names", () => {
    for (const name of ["@", "@/", "@scope/", "@/name", "@scope", "@a/b/c", "@scope//name"]) {
      expect(isValidPackageName(name)).toBe(false);
    }
  });

  it("rejects unscoped names containing a slash", () => {
    expect(isValidPackageName("foo/bar")).toBe(false);
  });

  it("reports INVALID_PACKAGE_NAME with a reason on rejection", () => {
    const result = validatePackageName("");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errorType).toBe(FetchErrorType.INVALID_PACKAGE_NAME);
      expect(typeof result.reason).toBe("string");
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("assertValidPackageName", () => {
  it("does not throw for a valid name", () => {
    expect(() => assertValidPackageName("@acme/widget")).not.toThrow();
  });

  it("throws a typed PackageNameError for an invalid name", () => {
    try {
      assertValidPackageName("Bad Name");
      throw new Error("expected assertValidPackageName to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PackageNameError);
      expect((err as PackageNameError).errorType).toBe(
        FetchErrorType.INVALID_PACKAGE_NAME,
      );
    }
  });
});

describe("encodePackageName / decodePackageName", () => {
  it("encodes a scoped name into a single safe segment without a slash", () => {
    const encoded = encodePackageName("@acme/widget");
    expect(encoded).toBe("%40acme%2Fwidget");
    expect(encoded).not.toContain("/");
  });

  it("round-trips every valid name back to the exact original", () => {
    for (const name of ["left-pad", "lodash.merge", "@scope/name", "@types/node", "a"]) {
      expect(decodePackageName(encodePackageName(name))).toBe(name);
    }
  });

  it("is consistent with the storage-fake encodeName helper", () => {
    // storage-fake.ts uses encodeURIComponent; encodePackageName must match.
    expect(encodePackageName("@acme/widget")).toBe(encodeURIComponent("@acme/widget"));
  });
});
