/**
 * Property-based tests for package-name validation and scoped-name handling
 * (Person A, task 2.2 — Property 6, Reqs 1.6, 1.7).
 *
 * These complement the example-based `package-name.test.ts`: where that file
 * pins specific cases, this file asserts the *universal* property across a wide
 * mix of generated candidate names (arbitrary strings, constructed-valid
 * unscoped/scoped names, Unicode, and length-boundary names).
 *
 * The two claims of Property 6 exercised here are:
 *   (a) acceptance IFF the npm naming constraints hold — checked against an
 *       INDEPENDENT oracle predicate (`oracleAcceptsName`) that mirrors the
 *       rules with a regex formulation rather than re-using the validator's
 *       `encodeURIComponent` formulation, so the two derivations cross-check; and
 *   (b) for ANY accepted name, `decodePackageName(encodePackageName(name))`
 *       round-trips to the exact original, and the encoded key contains no `/`.
 *
 * The "rejected before any npm_Registry query" clause of Property 6 is a
 * consequence of the validator being a pure, side-effect-free classifier
 * (no I/O) and is additionally covered by `api/resolve.smoke.test.ts`.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  MAX_PACKAGE_NAME_LENGTH,
  decodePackageName,
  encodePackageName,
  isValidPackageName,
} from "@shared/package-name";

/**
 * Independent oracle for npm package-name validity, written as an explicit
 * character-class formulation (NOT `encodeURIComponent`) so it is a genuine
 * cross-check of the implementation rather than a copy of it.
 *
 * Allowed segment shape: the first character is a lowercase letter, digit, or
 * `-` (a leading `.` or `_` is forbidden); subsequent characters add `.` and
 * `_`. Uppercase, whitespace, the npm-forbidden marks `~'!()*`, and any other
 * non-URL-safe character are excluded. A scoped name is exactly `@scope/name`
 * with both halves satisfying the segment shape; the whole name must be
 * non-empty, free of leading/trailing whitespace, and at most 214 characters.
 */
const SEGMENT = /^[a-z0-9-][a-z0-9._-]*$/;

function oracleAcceptsName(name: string): boolean {
  if (typeof name !== "string") return false;
  if (name.length === 0) return false;
  // Leading/trailing whitespace (and, transitively, whitespace-only names).
  if (name.trim() !== name) return false;
  if (name.length > MAX_PACKAGE_NAME_LENGTH) return false;

  if (name.startsWith("@")) {
    const match = /^@([^/]+)\/([^/]+)$/.exec(name);
    if (match === null) return false;
    const scope = match[1];
    const unscoped = match[2];
    if (scope === undefined || unscoped === undefined) return false;
    return SEGMENT.test(scope) && SEGMENT.test(unscoped);
  }

  if (name.includes("/")) return false;
  return SEGMENT.test(name);
}

// ── Generators ────────────────────────────────────────────────────────────

const SEGMENT_FIRST_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789-".split("");
const SEGMENT_REST_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789._-".split("");

/** A guaranteed-valid unscoped segment (1..31 chars), e.g. `left-pad`. */
const validSegmentArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...SEGMENT_FIRST_CHARS),
    fc.array(fc.constantFrom(...SEGMENT_REST_CHARS), { maxLength: 30 }),
  )
  .map(([first, rest]) => first + rest.join(""));

/** A guaranteed-valid scoped name `@scope/name` (well under 214 chars). */
const validScopedArb: fc.Arbitrary<string> = fc
  .tuple(validSegmentArb, validSegmentArb)
  .map(([scope, name]) => `@${scope}/${name}`);

/** Names straddling the 214-character length boundary (some valid, some not). */
const lengthBoundaryArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...SEGMENT_REST_CHARS), { minLength: 208, maxLength: 222 })
  .map((rest) => "a" + rest.join(""));

/**
 * A broad candidate-name generator mixing constructed-valid names with mostly
 * invalid arbitrary/Unicode strings and explicit malformed forms, so both the
 * accept and reject branches of the property are exercised heavily.
 */
const candidateNameArb: fc.Arbitrary<string> = fc.oneof(
  // Mostly invalid: printable ASCII (uppercase, spaces, symbols) and Unicode.
  fc.string(),
  fc.string({ minLength: 0, maxLength: 6 }),
  fc.fullUnicodeString({ maxLength: 12 }),
  // Constructed-valid names.
  validSegmentArb,
  validScopedArb,
  // Length-boundary names around 214.
  lengthBoundaryArb,
  // Explicit malformed / edge forms.
  fc.constantFrom(
    "",
    "   ",
    "\t",
    ".hidden",
    "_private",
    "Foo",
    "@",
    "@/name",
    "@scope/",
    "@a/b/c",
    "@scope//name",
    "foo/bar",
    "foo bar",
    "café",
    "foo~bar",
    "@Scope/name",
  ),
);

describe("Property 6: package-name validation and scoped-name round-trip", () => {
  it("accepts a candidate iff it satisfies npm naming constraints (oracle cross-check)", () => {
    // Feature: packguard, Property 6: For any candidate package name, the validator accepts it if and only if it satisfies npm naming constraints (non-empty, ≤ 214 characters, permitted characters, including @scope/name form); names judged invalid are rejected before any npm_Registry query, and any accepted scoped name encodes to a registry/Tigris key that decodes back to the original name.
    fc.assert(
      fc.property(candidateNameArb, (name) => {
        expect(isValidPackageName(name)).toBe(oracleAcceptsName(name));
      }),
      { numRuns: 300 },
    );
  });

  it("round-trips any accepted name through encode/decode with a slash-free key", () => {
    // Feature: packguard, Property 6: For any candidate package name, the validator accepts it if and only if it satisfies npm naming constraints (non-empty, ≤ 214 characters, permitted characters, including @scope/name form); names judged invalid are rejected before any npm_Registry query, and any accepted scoped name encodes to a registry/Tigris key that decodes back to the original name.
    fc.assert(
      fc.property(candidateNameArb, (name) => {
        fc.pre(isValidPackageName(name));
        const encoded = encodePackageName(name);
        expect(encoded.includes("/")).toBe(false);
        expect(decodePackageName(encoded)).toBe(name);
      }),
      { numRuns: 300 },
    );
  });

  it("round-trips every accepted scoped name to a single slash-free segment", () => {
    // Feature: packguard, Property 6: For any candidate package name, the validator accepts it if and only if it satisfies npm naming constraints (non-empty, ≤ 214 characters, permitted characters, including @scope/name form); names judged invalid are rejected before any npm_Registry query, and any accepted scoped name encodes to a registry/Tigris key that decodes back to the original name.
    fc.assert(
      fc.property(validScopedArb, (name) => {
        const encoded = encodePackageName(name);
        expect(encoded.includes("/")).toBe(false);
        expect(decodePackageName(encoded)).toBe(name);
      }),
      { numRuns: 100 },
    );
  });
});
