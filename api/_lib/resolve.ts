/**
 * npm package resolution — core logic for the serverless `/api/resolve`
 * function (Person A, task 2.3).
 *
 * This module is the *pure-ish, injectable* heart of resolution so it can be
 * exercised without real network access: the `fetch` implementation, the
 * registry base URL, and the timeout are all dependency-injected. The Vercel
 * handler in `api/resolve.ts` is a thin wrapper that reads the request, calls
 * {@link resolvePackage}, and maps the typed result onto an HTTP response.
 * (It lives under `api/_lib/` because Vercel does not treat `_`-prefixed
 * directories as routable functions.)
 *
 * Responsibilities (design.md → "Why the Backend_API Is Split", Interface 2,
 * Error Handling → Fetcher/Extractor; Reqs 1.1–1.5, 1.8):
 *  - Validate the package name FIRST via the shared {@link validatePackageName}
 *    and reject `INVALID_PACKAGE_NAME` BEFORE any registry query (Req 1.7). We
 *    REUSE the shared validator — this module never re-implements naming rules.
 *  - Query the npm registry packument endpoint `{registryBase}/{name}` once
 *    (Req 1.1), within a 10-second timeout enforced by an `AbortController`
 *    (Req 1.8).
 *  - Resolve `dist-tags.latest` when no version is supplied (Req 1.2), or the
 *    exact requested version when one is supplied (Req 1.3), producing a
 *    {@link ResolvedPackage} `{ packageName, version, tarballUrl, integrity? }`.
 *  - Map every failure onto a typed {@link FetchErrorType} and NEVER return a
 *    partial result / never initiate a scan:
 *      · 404 from the registry            → `PACKAGE_UNRESOLVED` (Req 1.4)
 *      · requested version absent          → `VERSION_UNRESOLVED` (Req 1.5)
 *      · network error / timeout / non-404 → `REGISTRY_UNAVAILABLE` (Req 1.8)
 *
 * Resolution is "inspect without installing"-safe: it only reads JSON metadata
 * and never downloads or executes package content (that is task 3.1+).
 */

import { validatePackageName } from "@shared/package-name";
import { FetchErrorType } from "@shared/errors";
import type { ResolvedPackage } from "@shared/scan";
import { loadConfig } from "@shared/config";

/** Default registry timeout: 10 seconds (Req 1.8). */
export const DEFAULT_REGISTRY_TIMEOUT_MS = 10_000;

/**
 * The subset of {@link FetchErrorType} that resolution can produce. The four
 * resolution failure modes from Reqs 1.4, 1.5, 1.7, 1.8 — kept as a narrow
 * union so callers can exhaustively map them onto the Backend_API error
 * contract (design.md → Interface 2).
 */
export type ResolveErrorType =
  | typeof FetchErrorType.INVALID_PACKAGE_NAME
  | typeof FetchErrorType.PACKAGE_UNRESOLVED
  | typeof FetchErrorType.VERSION_UNRESOLVED
  | typeof FetchErrorType.REGISTRY_UNAVAILABLE;

/** Input to {@link resolvePackage}: a (validated) name and an optional version. */
export interface ResolveInput {
  /** Candidate package name; may be scoped `@scope/name` (Req 1.6). */
  packageName: string;
  /** Optional exact version. When omitted/empty, latest is resolved (Req 1.2). */
  version?: string;
}

/**
 * Injectable dependencies. Defaulting `fetchFn` to the global `fetch` and
 * `registryBase` to {@link loadConfig}'s `npmRegistryBase` keeps production
 * call sites trivial, while tests pass a fake `fetch` + base to drive every
 * branch WITHOUT real network (tasks 2.4 / 2.5).
 */
export interface ResolveDeps {
  /** `fetch` implementation. Defaults to the runtime global `fetch`. */
  fetchFn?: typeof fetch;
  /** Registry base URL. Defaults to config `NPM_REGISTRY_BASE`. */
  registryBase?: string;
  /** Per-request timeout in ms. Defaults to {@link DEFAULT_REGISTRY_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** Successful resolution: a fully-populated {@link ResolvedPackage}. */
export interface ResolveSuccess {
  ok: true;
  resolved: ResolvedPackage;
}

/** Failed resolution, mapped to a distinct {@link ResolveErrorType}. No partial result. */
export interface ResolveFailure {
  ok: false;
  errorType: ResolveErrorType;
  message: string;
}

/**
 * Discriminated result of {@link resolvePackage}. Resolution NEVER throws
 * across its boundary and NEVER returns a partial result on error (Req 1.8) —
 * it always returns this union.
 */
export type ResolveResult = ResolveSuccess | ResolveFailure;

function failure(errorType: ResolveErrorType, message: string): ResolveFailure {
  return { ok: false, errorType, message };
}

/** Narrow an unknown value to a non-empty string, else `undefined`. */
function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Narrow an unknown value to a plain object (record), else `undefined`. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Build the packument path segment for a (validated) name following the npm
 * registry convention: the `@` of a scope is kept literal while the `/`
 * separator of a scoped name is percent-encoded to `%2f`
 * (e.g. `@babel/core` → `@babel%2fcore`). Validated names only ever contain
 * URL-safe characters plus `@`/`/`, so no further escaping is required.
 */
function registryPathSegment(packageName: string): string {
  return packageName.replace(/\//g, "%2f");
}

function packumentUrl(registryBase: string, packageName: string): string {
  const base = registryBase.replace(/\/+$/, "");
  return `${base}/${registryPathSegment(packageName)}`;
}

/**
 * Interpret a parsed packument (registry metadata) for the requested input and
 * produce a typed {@link ResolveResult}. Pure and synchronous: given the same
 * metadata + input it always yields the same result (supports Property 7).
 *
 * Version selection (Reqs 1.2, 1.3):
 *  - explicit version → that exact version's manifest must exist, else
 *    `VERSION_UNRESOLVED` (Req 1.5).
 *  - no version       → `dist-tags.latest` designates the version (Req 1.2);
 *    a missing/danging latest is treated as `PACKAGE_UNRESOLVED` (the package
 *    exposes no usable published release).
 */
function interpretPackument(packument: unknown, input: ResolveInput): ResolveResult {
  const root = asRecord(packument);
  if (root === undefined) {
    return failure(
      FetchErrorType.REGISTRY_UNAVAILABLE,
      `npm registry returned malformed metadata for "${input.packageName}"`,
    );
  }

  // Canonical registry name when present; otherwise echo the validated input.
  const resolvedName = asNonEmptyString(root["name"]) ?? input.packageName;
  const versions = asRecord(root["versions"]);
  const requestedVersion = asNonEmptyString(input.version);

  // Determine which version to resolve.
  let targetVersion: string;
  if (requestedVersion !== undefined) {
    targetVersion = requestedVersion;
  } else {
    const distTags = asRecord(root["dist-tags"]);
    const latest = asNonEmptyString(distTags?.["latest"]);
    if (latest === undefined) {
      return failure(
        FetchErrorType.PACKAGE_UNRESOLVED,
        `npm registry reported no latest version for "${input.packageName}"`,
      );
    }
    targetVersion = latest;
  }

  // Locate the version manifest.
  const manifest = asRecord(versions?.[targetVersion]);
  if (manifest === undefined) {
    if (requestedVersion !== undefined) {
      return failure(
        FetchErrorType.VERSION_UNRESOLVED,
        `version "${requestedVersion}" does not exist for "${input.packageName}"`,
      );
    }
    // latest pointed at a version absent from the versions map → malformed.
    return failure(
      FetchErrorType.PACKAGE_UNRESOLVED,
      `latest version "${targetVersion}" is missing from metadata for "${input.packageName}"`,
    );
  }

  const dist = asRecord(manifest["dist"]);
  const tarballUrl = asNonEmptyString(dist?.["tarball"]);
  if (tarballUrl === undefined) {
    // The version resolved but the metadata cannot yield a downloadable
    // artifact; there is nothing usable to scan.
    return failure(
      FetchErrorType.PACKAGE_UNRESOLVED,
      `npm metadata for "${input.packageName}@${targetVersion}" did not include a tarball URL`,
    );
  }

  const version = asNonEmptyString(manifest["version"]) ?? targetVersion;
  // Prefer SRI `integrity`; fall back to the legacy `shasum` (Req 1, model).
  const integrity =
    asNonEmptyString(dist?.["integrity"]) ?? asNonEmptyString(dist?.["shasum"]);

  const resolved: ResolvedPackage = { packageName: resolvedName, version, tarballUrl };
  if (integrity !== undefined) {
    resolved.integrity = integrity;
  }
  return { ok: true, resolved };
}

/**
 * Resolve an npm package to a {@link ResolvedPackage}, or a typed failure.
 *
 * Flow (Reqs 1.1–1.5, 1.7, 1.8):
 *  1. Validate the name with the shared {@link validatePackageName}; on failure
 *     return `INVALID_PACKAGE_NAME` WITHOUT querying the registry (Req 1.7).
 *  2. GET `{registryBase}/{name}` once with a 10s `AbortController` timeout.
 *  3. Map transport outcomes: a 404 → `PACKAGE_UNRESOLVED` (Req 1.4); any other
 *     non-2xx, a network error, an unparseable body, or a timeout →
 *     `REGISTRY_UNAVAILABLE` (Req 1.8), with no partial result.
 *  4. Otherwise interpret the packument (Reqs 1.2, 1.3, 1.5).
 */
export async function resolvePackage(
  input: ResolveInput,
  deps: ResolveDeps = {},
): Promise<ResolveResult> {
  // 1) Validate the name FIRST — before any registry query (Req 1.7).
  const validation = validatePackageName(input.packageName);
  if (!validation.valid) {
    return failure(FetchErrorType.INVALID_PACKAGE_NAME, validation.reason);
  }

  const fetchFn = deps.fetchFn ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    return failure(
      FetchErrorType.REGISTRY_UNAVAILABLE,
      "no fetch implementation available in this runtime",
    );
  }
  const registryBase = deps.registryBase ?? loadConfig().npmRegistryBase;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_REGISTRY_TIMEOUT_MS;
  const url = packumentUrl(registryBase, input.packageName);

  // 2) Single registry query, bounded by a 10s abort timeout (Req 1.8).
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetchFn(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });

    // 3) Transport-level mapping.
    if (response.status === 404) {
      return failure(
        FetchErrorType.PACKAGE_UNRESOLVED,
        `package "${input.packageName}" does not exist on the npm registry`,
      );
    }
    if (!response.ok) {
      return failure(
        FetchErrorType.REGISTRY_UNAVAILABLE,
        `npm registry responded with status ${response.status}`,
      );
    }

    let packument: unknown;
    try {
      packument = await response.json();
    } catch {
      return failure(
        FetchErrorType.REGISTRY_UNAVAILABLE,
        `npm registry returned an unparseable response for "${input.packageName}"`,
      );
    }

    // 4) Interpret metadata → version resolution (Reqs 1.2, 1.3, 1.5).
    return interpretPackument(packument, input);
  } catch (err) {
    // Network error, abort/timeout, or any other transport failure (Req 1.8).
    if (timedOut) {
      return failure(
        FetchErrorType.REGISTRY_UNAVAILABLE,
        `npm registry did not respond within ${timeoutMs}ms`,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return failure(
      FetchErrorType.REGISTRY_UNAVAILABLE,
      `npm registry request failed: ${message}`,
    );
  } finally {
    clearTimeout(timer);
  }
}
