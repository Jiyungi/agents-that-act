/**
 * Vercel serverless function `POST|GET /api/resolve` (Person A, task 2.3).
 *
 * Thin HTTP wrapper over the injectable core {@link resolvePackage} in
 * `api/_lib/resolve.ts`. It does three things and nothing else:
 *  1. read `packageName` (required) + `version` (optional) from the request,
 *  2. call the core resolver (which validates the name first, then queries the
 *     npm registry within a 10s timeout), and
 *  3. map the typed {@link ResolveResult} onto an HTTP status + JSON body.
 *
 * Because there is no `@vercel/node` dependency in this repo, the handler is
 * typed against a minimal structural `{ method, query, body }` request shape
 * and a minimal `{ status, json }` response shape. This matches both the
 * classic Vercel signature `export default (req, res) => …` and is trivial to
 * drive from a test. The real network call and all branching live in the core
 * module, so this file stays free of business logic.
 *
 * ── Request / response contract ──────────────────────────────────────────
 * Request (either shape):
 *   POST /api/resolve   body: { "packageName": string, "version"?: string }
 *   GET  /api/resolve?packageName=<name>&version=<optional>
 *
 * Response:
 *   200 { packageName, version, tarballUrl, integrity? }   // ResolvedPackage
 *   4xx/5xx { errorType: FetchErrorType, message: string } // Backend_API error
 *
 * Status mapping (design.md → Error Handling → Fetcher/Extractor):
 *   INVALID_PACKAGE_NAME → 400   (bad request; rejected before any query)
 *   PACKAGE_UNRESOLVED   → 404   (package not found, Req 1.4)
 *   VERSION_UNRESOLVED   → 404   (version not found, Req 1.5)
 *   REGISTRY_UNAVAILABLE → 502   (upstream registry error / >10s, Req 1.8)
 *   missing packageName  → 400   (INVALID_PACKAGE_NAME)
 */

import { FetchErrorType } from "../shared/errors.js";
import type { ResolvedPackage } from "../shared/scan.js";
import {
  resolvePackage,
  type ResolveDeps,
  type ResolveErrorType,
  type ResolveInput,
} from "./_lib/resolve.js";

/** Minimal request shape compatible with Vercel's Node request object. */
export interface ResolveRequest {
  method?: string | undefined;
  query?: Record<string, string | string[] | undefined> | undefined;
  body?: unknown;
}

/** Minimal response shape compatible with Vercel's Node response object. */
export interface ResolveResponse {
  status(code: number): ResolveResponse;
  json(payload: unknown): unknown;
}

/** HTTP body returned on success: the {@link ResolvedPackage} fields. */
type SuccessBody = ResolvedPackage;

/** HTTP body returned on failure: the Backend_API error contract. */
interface ErrorBody {
  errorType: ResolveErrorType;
  message: string;
}

/** Map a resolution {@link ResolveErrorType} to its HTTP status code. */
export function statusForErrorType(errorType: ResolveErrorType): number {
  switch (errorType) {
    case FetchErrorType.INVALID_PACKAGE_NAME:
      return 400;
    case FetchErrorType.PACKAGE_UNRESOLVED:
      return 404;
    case FetchErrorType.VERSION_UNRESOLVED:
      return 404;
    case FetchErrorType.REGISTRY_UNAVAILABLE:
      return 502;
    default:
      // Exhaustiveness guard: if ResolveErrorType grows, `errorType` will no
      // longer be assignable to `never` here and this fails to compile.
      return assertNever(errorType);
  }
}

/** Compile-time exhaustiveness helper; never reached at runtime. */
function assertNever(value: never): number {
  throw new Error(`unhandled resolve error type: ${String(value)}`);
}

/** Read the first value of a query param that may be a string or string[]. */
function firstParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Extract `{ packageName, version }` from a request, accepting either a JSON
 * body (POST) or query params (GET). `packageName` is required; `version` is
 * optional. Returns `null` when no usable `packageName` is present.
 */
export function readResolveInput(req: ResolveRequest): ResolveInput | null {
  const body = typeof req.body === "object" && req.body !== null
    ? (req.body as Record<string, unknown>)
    : undefined;

  const bodyName = typeof body?.["packageName"] === "string" ? body["packageName"] : undefined;
  const bodyVersion = typeof body?.["version"] === "string" ? body["version"] : undefined;

  const queryName = firstParam(req.query?.["packageName"]);
  const queryVersion = firstParam(req.query?.["version"]);

  const packageName = bodyName ?? queryName;
  if (packageName === undefined) return null;

  const version = bodyVersion ?? queryVersion;
  return version !== undefined && version.length > 0
    ? { packageName, version }
    : { packageName };
}

/**
 * Pure HTTP adapter: resolve an input to `{ status, body }` without touching a
 * `res` object, so it is directly unit-testable. Used by the default handler.
 */
export async function resolveToHttp(
  req: ResolveRequest,
  deps: ResolveDeps = {},
): Promise<{ status: number; body: SuccessBody | ErrorBody }> {
  const input = readResolveInput(req);
  if (input === null) {
    return {
      status: 400,
      body: {
        errorType: FetchErrorType.INVALID_PACKAGE_NAME,
        message: "request is missing the required 'packageName' field",
      },
    };
  }

  const result = await resolvePackage(input, deps);
  if (result.ok) {
    return { status: 200, body: result.resolved };
  }
  return {
    status: statusForErrorType(result.errorType),
    body: { errorType: result.errorType, message: result.message },
  };
}

/**
 * Vercel handler entry point. Reads the request, resolves, and writes the
 * mapped status + JSON body. All resolution logic lives in the core module;
 * this only does request parsing and response mapping.
 */
export default async function handler(
  req: ResolveRequest,
  res: ResolveResponse,
): Promise<void> {
  const { status, body } = await resolveToHttp(req);
  res.status(status).json(body);
}
