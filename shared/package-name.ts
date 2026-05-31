/**
 * Package-name validation + safe-key encode/decode (Person A, task 2.1).
 *
 * Pure logic shared by the serverless resolver (`/api/resolve`) and the local
 * agent (`packguard-agent`). It lives in `shared/` — and is re-exported from
 * `shared/index.ts` — precisely because it is side-effect free and reused by
 * both surfaces.
 *
 * Responsibilities (Reqs 1.6, 1.7; design.md → Property 6):
 *  - Classify a candidate package name as valid/invalid against npm naming
 *    constraints, including the scoped `@scope/name` form. This is a pure
 *    classifier: callers MUST reject invalid names BEFORE any npm_Registry
 *    query (Req 1.7). Invalid names are reported with the shared
 *    {@link FetchErrorType.INVALID_PACKAGE_NAME} type.
 *  - Encode a (scoped) name into a single safe registry/Tigris key segment and
 *    decode it back, round-tripping to the exact original. Encoding uses
 *    `encodeURIComponent` to stay consistent with `shared/testing/storage-fake.ts`
 *    (`encodeName`) and the Tigris key layout in design.md (Reqs 7.3, 7.4).
 *
 * Reference semantics: the well-established `validate-npm-package-name`
 * package. We implement it directly (no dependency) and, per task 2.1,
 * promote npm's "not valid for new packages" warnings — length > 214,
 * uppercase letters, and the special marks `~'!()*` — to hard errors. The
 * blacklist / core-module-name *warnings* from that package are intentionally
 * NOT enforced here: the enforced rule set is exactly the one enumerated for
 * this task (non-empty/no-whitespace, length ≤ 214, no leading `.`/`_`, no
 * uppercase, URL-safe characters only, and the scoped form `@scope/name`
 * where both segments follow the unscoped rules).
 */

import { FetchErrorType } from "./errors.js";

/** npm hard cap on total package-name length (Req 1.7). */
export const MAX_PACKAGE_NAME_LENGTH = 214;

/**
 * Characters that `encodeURIComponent` leaves unescaped (they are RFC 2396
 * "unreserved marks") but npm forbids in package names. We reject them
 * explicitly because the `encodeURIComponent(part) === part` check alone would
 * let them through.
 */
const FORBIDDEN_UNRESERVED_MARKS = /[~'!()*]/;

/** A name accepted by {@link validatePackageName}. */
export interface ValidPackageName {
  valid: true;
}

/**
 * A name rejected by {@link validatePackageName}. `errorType` is the shared
 * {@link FetchErrorType.INVALID_PACKAGE_NAME} value so callers can map it
 * straight onto the Backend_API error contract (Req 1.7); `reason` is a
 * human-readable explanation of which constraint failed.
 */
export interface InvalidPackageName {
  valid: false;
  errorType: typeof FetchErrorType.INVALID_PACKAGE_NAME;
  reason: string;
}

/** Discriminated result of {@link validatePackageName}. */
export type PackageNameValidation = ValidPackageName | InvalidPackageName;

function invalid(reason: string): InvalidPackageName {
  return {
    valid: false,
    errorType: FetchErrorType.INVALID_PACKAGE_NAME,
    reason,
  };
}

/**
 * Validate a single unscoped segment (a plain name, or one half of a scoped
 * name). Returns a failure reason string, or `null` when the segment is valid.
 * `label` is used to make the reason message specific (`"name"` / `"scope"`).
 *
 * Note: the length cap is enforced once against the whole input in
 * {@link validatePackageName}, not per-segment.
 */
function unscopedSegmentReason(segment: string, label: string): string | null {
  if (segment.length === 0) {
    return `${label} cannot be empty`;
  }
  if (segment.startsWith(".")) {
    return `${label} cannot start with a period`;
  }
  if (segment.startsWith("_")) {
    return `${label} cannot start with an underscore`;
  }
  if (segment.toLowerCase() !== segment) {
    return `${label} cannot contain uppercase letters`;
  }
  if (
    encodeURIComponent(segment) !== segment ||
    FORBIDDEN_UNRESERVED_MARKS.test(segment)
  ) {
    return `${label} can only contain URL-safe characters`;
  }
  return null;
}

/**
 * Classify a candidate package name against npm naming constraints
 * (Reqs 1.6, 1.7). Pure and synchronous: it performs no I/O, so callers can —
 * and MUST — call it before any npm_Registry query.
 *
 * Accepts:
 *  - unscoped names: `left-pad`, `lodash.merge`, `some_pkg`
 *  - scoped names:   `@scope/name` (exactly one `/`, both halves valid)
 *
 * Rejects (each with a specific `reason`):
 *  - empty or whitespace-only names
 *  - leading/trailing whitespace
 *  - length > 214
 *  - leading `.` or `_`
 *  - uppercase letters
 *  - characters that are not URL-safe (spaces, `~'!()*`, control chars, etc.)
 *  - malformed scoped forms (`@`, `@/x`, `@scope/`, `@a/b/c`, …)
 */
export function validatePackageName(name: string): PackageNameValidation {
  // Defensive: types say `string`, but callers may pass runtime `any`.
  if (typeof name !== "string") {
    return invalid("name must be a string");
  }
  if (name.length === 0) {
    return invalid("name cannot be empty");
  }
  // Catches leading/trailing whitespace and, transitively, whitespace-only
  // names (their trimmed form is "" which never equals the original).
  if (name.trim() !== name) {
    return invalid("name cannot contain leading or trailing whitespace");
  }
  if (name.length > MAX_PACKAGE_NAME_LENGTH) {
    return invalid(
      `name cannot be longer than ${MAX_PACKAGE_NAME_LENGTH} characters`,
    );
  }

  if (name.startsWith("@")) {
    // Scoped: must be exactly `@scope/name` with a single, non-empty scope
    // and a single, non-empty name and no further slashes.
    const match = /^@([^/]+)\/([^/]+)$/.exec(name);
    const scope = match?.[1];
    const unscoped = match?.[2];
    if (scope === undefined || unscoped === undefined) {
      return invalid("scoped name must be of the form @scope/name");
    }
    const scopeReason = unscopedSegmentReason(scope, "scope");
    if (scopeReason !== null) {
      return invalid(scopeReason);
    }
    const nameReason = unscopedSegmentReason(unscoped, "name");
    if (nameReason !== null) {
      return invalid(nameReason);
    }
    return { valid: true };
  }

  // Unscoped names may not contain a path separator.
  if (name.includes("/")) {
    return invalid("unscoped name cannot contain a slash");
  }
  const reason = unscopedSegmentReason(name, "name");
  if (reason !== null) {
    return invalid(reason);
  }
  return { valid: true };
}

/** `true` iff {@link validatePackageName} accepts `name`. */
export function isValidPackageName(name: string): boolean {
  return validatePackageName(name).valid;
}

/**
 * Typed error thrown by {@link assertValidPackageName}. Carries the shared
 * {@link FetchErrorType.INVALID_PACKAGE_NAME} value so exception-style callers
 * branch on the same error contract as the return-value style.
 */
export class PackageNameError extends Error {
  readonly errorType: typeof FetchErrorType.INVALID_PACKAGE_NAME;
  constructor(reason: string) {
    super(reason);
    this.name = "PackageNameError";
    this.errorType = FetchErrorType.INVALID_PACKAGE_NAME;
  }
}

/**
 * Throwing convenience wrapper over {@link validatePackageName} for callers
 * that prefer exceptions. Throws {@link PackageNameError} when `name` is
 * invalid; returns nothing when it is valid.
 */
export function assertValidPackageName(name: string): void {
  const result = validatePackageName(name);
  if (!result.valid) {
    throw new PackageNameError(result.reason);
  }
}

/**
 * Encode a (possibly scoped) package name into a single safe key segment for
 * registry/Tigris keys. `@scope/name` becomes `%40scope%2Fname` — one segment
 * with no `/` — and {@link decodePackageName} reverses it exactly.
 *
 * Consistent with `shared/testing/storage-fake.ts` (`encodeName`) and the key
 * layout in design.md (Reqs 7.3, 7.4). `encodeURIComponent`/`decodeURIComponent`
 * round-trip for every string, so the contract holds for all valid names.
 */
export function encodePackageName(name: string): string {
  return encodeURIComponent(name);
}

/** Inverse of {@link encodePackageName}; recovers the exact original name. */
export function decodePackageName(encoded: string): string {
  return decodeURIComponent(encoded);
}
