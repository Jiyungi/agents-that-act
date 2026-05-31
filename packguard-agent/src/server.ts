/**
 * Local_Fetcher_Agent loopback HTTP server (Person A, task 7.1).
 *
 * A tiny `node:http` server (NO framework, NO new deps) that the Vercel-hosted
 * `Frontend_UI` calls for the filesystem- and `code`-CLI-bound steps that a
 * serverless function cannot perform (design.md → "Why the Backend_API Is
 * Split", "Deployment Model"). It implements **Interface 2 — Local_Fetcher_Agent
 * HTTP API**:
 *
 *     POST /local/fetch    body { packageName, version?, tarballUrl, integrity? }
 *                          200  ScanResultContract (+ uploadId, prompt)
 *                          4xx/5xx { errorType, message, manualCommand? }
 *     GET  /local/health   200  { status: "ok", codeCliAvailable: boolean }
 *     POST /local/upload   ← RESERVED for task 7.2 (see the route table); NOT
 *                            implemented here.
 *
 * ── SECURITY: loopback-only bind (127.0.0.1) ──────────────────────────────
 * This agent touches the OPERATOR'S OWN DISK (it extracts tarballs into
 * `./scan-target/` and launches the operator's `code` CLI). It MUST therefore
 * be reachable ONLY from the operator's machine. {@link startAgentServer}
 * binds to {@link LOOPBACK_HOST} (`127.0.0.1`) and there is intentionally NO
 * way to configure a different host — it must NEVER bind to `0.0.0.0` or any
 * public interface, which would expose local disk access to the network. This
 * is a hard security requirement (design.md → "Interface 2"); see also the
 * note on {@link LOOPBACK_HOST}.
 *
 * ── "Inspect without installing" is preserved ─────────────────────────────
 * The server only composes the existing no-exec building blocks
 * ({@link fetchAndExtract} → {@link launchEditor}); it adds NO code path that
 * requires/imports/evaluates/spawns fetched package content. The only
 * child-process spawn in the whole flow is the launcher's `code <dir>`, which
 * operates on the directory, never on a fetched file.
 *
 * ── Testability ───────────────────────────────────────────────────────────
 * {@link createAgentServer} takes injectable deps — the download `fetchFn`, the
 * `fetchAndExtract` pipeline, the `launchEditor` impl, the `isCodeCliAvailable`
 * probe, the `scanTargetDir`, limits/timeouts, and an `uploadId` generator — so
 * tests drive every branch WITHOUT touching the real network or a real VS Code.
 * The factory also exposes the raw `handleRequest` listener and the
 * `activeScans` map so tests can assert on either via real loopback requests or
 * direct calls.
 */

import * as http from "node:http";
import { randomUUID } from "node:crypto";

import { FetchErrorType, UploadErrorType } from "@shared/errors";
import { loadConfig } from "@shared/config";
import { TigrisStorageService } from "@shared/storage";
import { normalizeReport as normalizeReport_shared } from "@shared/normalize";
import {
  DEFAULT_SAFE_TAR_LIMITS,
  type ResolvedPackage,
  type SafeTarLimits,
  type ScanResultContract,
} from "@shared/scan";
import { validatePackageName } from "@shared/package-name";
// Interface 4 — Storage_Service shape (design.md). TYPE-ONLY import (erased
// under verbatimModuleSyntax) so the production agent never bundles the test
// fake. Task 11.1 ships the real Tigris service; task 17.1 injects it here.
import type { StorageService } from "@shared/testing/storage-fake";

import { fetchAndExtract, type FetchAndExtractResult } from "./pipeline.js";
import {
  isCodeCliAvailable,
  launchEditor,
  resolveEditorCommand,
  type LaunchEditorResult,
} from "./editor-launcher.js";
import {
  runUploadTrigger,
  type MakeSnapshotFn,
  type NormalizeReport,
  type ReadReportFn,
} from "./upload.js";
import type { FetchFn } from "./download.js";

/**
 * The ONLY host this server ever binds to. Hard-coded to the IPv4 loopback so
 * the agent can never be reached from another machine — exposing the
 * operator's local disk/`code` CLI to the network would be a security hole
 * (design.md → "Interface 2 — bound to localhost only"). Do NOT make this
 * configurable.
 */
export const LOOPBACK_HOST = "127.0.0.1";

/**
 * Max accepted request-body size for `POST` routes. The agent's bodies are
 * tiny JSON envelopes; anything larger is rejected with 413 so a hostile or
 * buggy client cannot exhaust memory before we even parse.
 */
export const MAX_REQUEST_BODY_BYTES = 1_000_000; // 1 MB

/**
 * Transport-level (HTTP-protocol) error codes used by the router for problems
 * that are NOT domain failures — malformed JSON, unknown route, wrong method,
 * oversized body, or an unexpected internal error. They are kept DISTINCT from
 * the {@link FetchErrorType} domain codes so a client can tell "your request
 * was shaped wrong" apart from "the fetch/extract/launch step failed".
 */
export const TransportErrorType = {
  BAD_REQUEST: "BAD_REQUEST",
  NOT_FOUND: "NOT_FOUND",
  METHOD_NOT_ALLOWED: "METHOD_NOT_ALLOWED",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type TransportErrorType =
  (typeof TransportErrorType)[keyof typeof TransportErrorType];

/**
 * Maps every {@link FetchErrorType} to the HTTP status the agent returns for
 * it (design.md → "Error Handling → Fetcher / Extractor"). The grouping:
 *
 *  - 400 — bad/invalid identifier the operator supplied:
 *      INVALID_PACKAGE_NAME
 *  - 404 — the package/version could not be resolved (not found):
 *      PACKAGE_UNRESOLVED, VERSION_UNRESOLVED
 *  - 413 — payload-too-large / resource caps tripped (bad/unsafe input):
 *      DOWNLOAD_TOO_LARGE, RESOURCE_LIMIT_EXCEEDED
 *  - 422 — unsafe tarball CONTENT detected (well-formed request, dangerous
 *      data): PATH_TRAVERSAL, ABSOLUTE_PATH, LINK_TARGET_ESCAPE
 *  - 502 — upstream/transient failure talking to the registry/download:
 *      REGISTRY_UNAVAILABLE, DOWNLOAD_FAILED
 *  - 504 — the upstream step exceeded its time budget:
 *      EXTRACTION_TIMEOUT
 *  - 503 — a required local dependency is unavailable (the `code` CLI):
 *      VSCODE_UNAVAILABLE  (returned WITH manualCommand; scan-target RETAINED)
 *  - 500 — a present-but-failing local step:
 *      VSCODE_LAUNCH_FAILED (returned WITH manualCommand; scan-target RETAINED)
 *
 * Resolution errors (PACKAGE_UNRESOLVED/VERSION_UNRESOLVED/REGISTRY_UNAVAILABLE)
 * are normally produced upstream by `/api/resolve`; they are included here for
 * completeness so the mapping is exhaustive over the whole union.
 */
export const FETCH_ERROR_STATUS: Record<FetchErrorType, number> = {
  [FetchErrorType.INVALID_PACKAGE_NAME]: 400,
  [FetchErrorType.PACKAGE_UNRESOLVED]: 404,
  [FetchErrorType.VERSION_UNRESOLVED]: 404,
  [FetchErrorType.REGISTRY_UNAVAILABLE]: 502,
  [FetchErrorType.DOWNLOAD_FAILED]: 502,
  [FetchErrorType.DOWNLOAD_TOO_LARGE]: 413,
  [FetchErrorType.PATH_TRAVERSAL]: 422,
  [FetchErrorType.ABSOLUTE_PATH]: 422,
  [FetchErrorType.LINK_TARGET_ESCAPE]: 422,
  [FetchErrorType.RESOURCE_LIMIT_EXCEEDED]: 413,
  [FetchErrorType.EXTRACTION_TIMEOUT]: 504,
  [FetchErrorType.VSCODE_UNAVAILABLE]: 503,
  [FetchErrorType.VSCODE_LAUNCH_FAILED]: 500,
};

/**
 * Maps every {@link UploadErrorType} to the HTTP status the upload-trigger
 * route returns (design.md → "Error Handling → Upload / Storage", Interface 3).
 * The grouping:
 *
 *  - 404 — the report the operator was told to produce is not there yet:
 *      REPORT_MISSING. We use 404 (the named resource at `reportPath` does not
 *      exist) so the UI can say "run the scan first / no report at the agreed
 *      path"; storage was deliberately NOT called (Req 6.5).
 *  - 400 — the caller's identifier is missing/empty (bad request):
 *      INVALID_IDENTIFIER (Req 7.6).
 *  - 422 — the report exists but its CONTENT is unprocessable: a present-but-
 *      out-of-range/missing riskScore (Req 13.6): INVALID_RISK_SCORE.
 *  - 502 — the downstream Storage_Service did not confirm within 30s or failed
 *      (bad gateway / upstream failure): UPLOAD_FAILED (Reqs 6.6, 7.7). The
 *      report is RETAINED at `reportPath` so the operator can retry.
 *
 * An UNKNOWN/missing `uploadId` is NOT in this table: the server maps it to a
 * 404 with errorType `INVALID_IDENTIFIER` (the referenced scan does not exist)
 * — documented at {@link handleUpload-style registration} below.
 */
export const UPLOAD_ERROR_STATUS: Record<UploadErrorType, number> = {
  [UploadErrorType.REPORT_MISSING]: 404,
  [UploadErrorType.INVALID_IDENTIFIER]: 400,
  [UploadErrorType.INVALID_RISK_SCORE]: 422,
  [UploadErrorType.UPLOAD_FAILED]: 502,
};

/**
 * An in-flight/active scan tracked so task 7.2's `POST /local/upload` can
 * reference the right {@link ScanResultContract} by an opaque `uploadId`
 * (Interface 3's body is `{ uploadId }`).
 *
 * The fetch handler populates {@link AgentServer.activeScans} on every scan
 * whose extraction succeeded (whether or not the editor launched), and returns
 * the `uploadId` in the fetch response. `cleanup` is the pipeline's retained
 * scan-target remover (Req 4.7); task 7.2 calls it AFTER a successful upload —
 * the fetch handler deliberately does NOT call it, so the populated
 * `./scan-target/` survives the manual-scan pause.
 */
export interface ActiveScan {
  /** The Scan_Result_Contract handed back to the UI (Interface 1). */
  contract: ScanResultContract;
  /**
   * Bound scan-target cleanup (Req 4.7). NEVER executes package content — it
   * only removes files. Owned by task 7.2 to call post-upload.
   */
  cleanup: () => Promise<void>;
  /** UTC ISO-8601 timestamp when this scan became active. */
  createdAt: string;
}

/** A normalized JSON response produced by a route handler. */
interface JsonResponse {
  status: number;
  body: unknown;
}

/** A route handler: receives the (already parsed) JSON body for POST routes. */
type RouteHandler = (input: {
  body: unknown;
  req: http.IncomingMessage;
}) => Promise<JsonResponse> | JsonResponse;

/** Whether a route consumes a JSON request body (POST) or not (GET). */
interface Route {
  method: "GET" | "POST";
  /** If true, the router parses+size-limits a JSON body before the handler. */
  readsBody: boolean;
  handler: RouteHandler;
}

/** Injectable dependencies for {@link createAgentServer}. */
export interface AgentServerDeps {
  /** Isolated extraction root (`./scan-target/`). Required. */
  scanTargetDir: string;
  /** Injectable download `fetch` (forwarded to the pipeline). */
  fetchFn?: FetchFn;
  /**
   * Injectable fetch+extract pipeline. Defaults to the real
   * {@link fetchAndExtract}; tests pass a fake to avoid real network/disk.
   */
  fetchAndExtractImpl?: typeof fetchAndExtract;
  /**
   * Injectable editor launcher. Defaults to the real {@link launchEditor};
   * tests pass a fake to avoid launching a real VS Code.
   */
  launchEditorImpl?: typeof launchEditor;
  /**
   * Injectable `code` CLI probe for `GET /local/health`. Defaults to the real
   * {@link isCodeCliAvailable}.
   */
  isCodeCliAvailableImpl?: typeof isCodeCliAvailable;
  /**
   * The editor-launch command (e.g. `code`, or an absolute VS Code path). When
   * omitted, the launcher/probe use their own default (`code`). `startAgentServer`
   * resolves a real editor via {@link resolveEditorCommand} and passes it here.
   */
  codeCommand?: string;
  /** Safe-tar limits forwarded to the pipeline. Defaults to the shared caps. */
  limits?: SafeTarLimits;
  /** Download timeout (ms) forwarded to the pipeline. */
  downloadTimeoutMs?: number;
  /** Extraction timeout (ms) forwarded to the pipeline. */
  extractionTimeoutMs?: number;
  /** Upload-id generator (injectable for deterministic tests). */
  generateUploadId?: () => string;
  /**
   * Storage_Service (Interface 4) the upload trigger hands the Scan_Report +
   * Source_Snapshot to (task 7.2). Left OPTIONAL here because the real
   * Tigris-backed service is task 11.1 and final wiring is task 17.1; until
   * then tests inject {@link InMemoryStorageService}. If a `POST /local/upload`
   * arrives while this is undefined, the route replies 503 (the upload
   * dependency is not configured) rather than throwing.
   */
  storageService?: StorageService;
  /**
   * Report normalizer + verdict deriver (Person B's tasks 9.1/10.1). Injected
   * so the agent integrates before that code exists; when omitted the upload
   * trigger falls back to its own TEMPORARY stub normalizer. Replaced by the
   * real normalizer at task 17.1.
   */
  normalizeReport?: NormalizeReport;
  /** Injectable report reader (default: fs-based). Tests override it. */
  readReport?: ReadReportFn;
  /** Injectable Source_Snapshot builder (default: tar+gzip of sourcePath). */
  makeSnapshot?: MakeSnapshotFn;
  /** Storage confirm timeout (ms) for the upload trigger. Defaults to 30s. */
  uploadConfirmTimeoutMs?: number;
}

/** The object returned by {@link createAgentServer}. */
export interface AgentServer {
  /** The underlying `http.Server` (not yet listening). */
  server: http.Server;
  /**
   * The raw request listener, exposed so tests can invoke it directly with
   * mock req/res in addition to driving the server over real loopback.
   */
  handleRequest: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  /**
   * Active scans keyed by `uploadId`. Task 7.2's upload handler reads this to
   * resolve `{ uploadId }` → the active {@link ScanResultContract} + cleanup.
   */
  activeScans: Map<string, ActiveScan>;
}

/** Narrow an unknown value to a non-empty trimmed string, else `undefined`. */
function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Build the domain error envelope for a {@link FetchErrorType} failure. */
function fetchErrorResponse(
  errorType: FetchErrorType,
  message: string,
  manualCommand?: string,
): JsonResponse {
  const body: { errorType: FetchErrorType; message: string; manualCommand?: string } = {
    errorType,
    message,
  };
  if (manualCommand !== undefined) body.manualCommand = manualCommand;
  return { status: FETCH_ERROR_STATUS[errorType], body };
}

/** Build a transport-level (HTTP-protocol) error envelope. */
function transportErrorResponse(
  status: number,
  errorType: TransportErrorType,
  message: string,
): JsonResponse {
  return { status, body: { errorType, message } };
}

/**
 * Create the loopback agent server and its route table WITHOUT binding a port.
 * Use {@link startAgentServer} to bind on {@link LOOPBACK_HOST}.
 */
export function createAgentServer(deps: AgentServerDeps): AgentServer {
  const {
    scanTargetDir,
    fetchFn,
    fetchAndExtractImpl = fetchAndExtract,
    launchEditorImpl = launchEditor,
    isCodeCliAvailableImpl = isCodeCliAvailable,
    codeCommand,
    limits = DEFAULT_SAFE_TAR_LIMITS,
    downloadTimeoutMs,
    extractionTimeoutMs,
    generateUploadId = randomUUID,
    storageService,
    normalizeReport,
    readReport,
    makeSnapshot,
    uploadConfirmTimeoutMs,
  } = deps;

  const activeScans = new Map<string, ActiveScan>();

  /**
   * `POST /local/fetch` — wire resolve-input → download → extract → launch →
   * Scan_Result_Contract (design.md → Interface 2). The package is already
   * resolved by `/api/resolve`, so the body carries `tarballUrl` directly and
   * this handler does NOT query the registry; it builds a {@link ResolvedPackage}
   * from the body and runs the no-exec pipeline.
   */
  const handleFetch: RouteHandler = async ({ body }) => {
    if (typeof body !== "object" || body === null) {
      return transportErrorResponse(
        400,
        TransportErrorType.BAD_REQUEST,
        "request body must be a JSON object { packageName, version?, tarballUrl, integrity? }",
      );
    }
    const record = body as Record<string, unknown>;

    // Validate the package name with the SHARED validator → INVALID_PACKAGE_NAME
    // (Req 1.7, design Error Handling table). Defense-in-depth: the name was
    // validated upstream by /api/resolve, but we never trust the wire.
    const rawName = typeof record["packageName"] === "string" ? record["packageName"] : "";
    const nameCheck = validatePackageName(rawName);
    if (!nameCheck.valid) {
      return fetchErrorResponse(FetchErrorType.INVALID_PACKAGE_NAME, nameCheck.reason);
    }

    // tarballUrl is required (the agent does not resolve; it downloads what the
    // UI supplied from /api/resolve). A missing/empty URL is a request-shape
    // problem → 400 BAD_REQUEST.
    const tarballUrl = asNonEmptyString(record["tarballUrl"]);
    if (tarballUrl === undefined) {
      return transportErrorResponse(
        400,
        TransportErrorType.BAD_REQUEST,
        "`tarballUrl` is required and must be a non-empty string",
      );
    }

    // version is optional on the wire (Interface 2) but a successful scan MUST
    // carry a non-empty version (Req 6.1: the Scan_Result_Contract's version is
    // non-empty). In our topology /api/resolve always supplies it; if absent we
    // cannot produce a spec-compliant contract → 400 BAD_REQUEST.
    const version = asNonEmptyString(record["version"]);
    if (version === undefined) {
      return transportErrorResponse(
        400,
        TransportErrorType.BAD_REQUEST,
        "`version` is required to produce a Scan_Result_Contract (Req 6.1)",
      );
    }

    const integrity = asNonEmptyString(record["integrity"]);
    const resolved: ResolvedPackage = {
      // `validatePackageName` rejects any surrounding whitespace, so the raw
      // accepted name is already canonical — use it directly.
      packageName: rawName,
      version,
      tarballUrl,
      ...(integrity !== undefined ? { integrity } : {}),
    };

    // 1) Download → safe-extract → build contract. The pipeline never throws
    //    and never executes fetched content; on abort it has already rolled
    //    back + removed the scan-target (Reqs 4.2–4.7).
    const result: FetchAndExtractResult = await fetchAndExtractImpl(resolved, {
      scanTargetDir,
      ...(fetchFn !== undefined ? { fetchFn } : {}),
      limits,
      ...(downloadTimeoutMs !== undefined ? { downloadTimeoutMs } : {}),
      ...(extractionTimeoutMs !== undefined ? { extractionTimeoutMs } : {}),
    });
    if (!result.ok) {
      // Download/extract failure: map the distinct violation type → status.
      // Nothing was retained, so no uploadId is registered.
      return fetchErrorResponse(result.errorType, result.message);
    }

    // 2) Extraction succeeded — register the active scan so task 7.2 can find
    //    it by uploadId, then launch VS Code (Reqs 5.1, 5.2). We register
    //    BEFORE branching on the launch result because the populated
    //    scan-target is RETAINED in BOTH outcomes (success and the two VS Code
    //    error cases, Reqs 5.3, 5.4): the operator may still open it manually
    //    and run the upload trigger. We never call `result.cleanup` here.
    const uploadId = generateUploadId();
    activeScans.set(uploadId, {
      contract: result.contract,
      cleanup: result.cleanup,
      createdAt: new Date().toISOString(),
    });

    const launch: LaunchEditorResult = await launchEditorImpl(
      result.contract.sourcePath,
      codeCommand !== undefined ? { codeCommand } : {},
    );
    if (launch.ok) {
      // 200: the Scan_Result_Contract, extended in the HTTP envelope with the
      // uploadId (the 7.2 seam) and the /security-scan prompt (Req 5.2). The
      // four contract fields stay top-level so the body IS a ScanResultContract.
      return {
        status: 200,
        body: { ...result.contract, uploadId, prompt: launch.prompt },
      };
    }

    // VS Code launch failed (VSCODE_UNAVAILABLE / VSCODE_LAUNCH_FAILED). Per
    // Reqs 5.3/5.4 the scan-target is RETAINED (we did NOT call cleanup) and we
    // return the error WITH the manualCommand. We also include the contract +
    // uploadId so the UI can still drive the manual-open + upload flow.
    return {
      status: FETCH_ERROR_STATUS[launch.errorType],
      body: {
        errorType: launch.errorType,
        message: launch.message,
        manualCommand: launch.manualCommand,
        contract: result.contract,
        uploadId,
      },
    };
  };

  /** `GET /local/health` — report whether the `code` CLI is available (Req 5). */
  const handleHealth: RouteHandler = async () => {
    const codeCliAvailable = await isCodeCliAvailableImpl(
      codeCommand !== undefined ? { codeCommand } : {},
    );
    return { status: 200, body: { status: "ok", codeCliAvailable } };
  };

  /**
   * `POST /local/upload` — the upload-trigger interface (Interface 3, task 7.2).
   *
   * Thin HTTP shell over {@link runUploadTrigger}: it resolves `{ uploadId }`
   * against {@link activeScans}, runs the core logic (read report → normalize →
   * snapshot → Storage_Service.uploadScan → cleanup), and maps the typed
   * {@link UploadErrorType} result onto an HTTP status via
   * {@link UPLOAD_ERROR_STATUS}. The core's REPORT_MISSING / UPLOAD_FAILED /
   * INVALID_RISK_SCORE / INVALID_IDENTIFIER branches (Reqs 6.5, 6.6, 13.6, 7.6)
   * are unit-tested directly in `upload.test.ts`; here we cover the wiring.
   *
   * On a CONFIRMED success the core already called the stored `cleanup` (Req
   * 4.7); this handler then REMOVES the entry from `activeScans` so the
   * uploadId cannot be reused against an emptied scan-target. On UPLOAD_FAILED
   * the report is RETAINED and the entry is KEPT so the operator can retry
   * (Req 6.6).
   */
  const handleUpload: RouteHandler = async ({ body }) => {
    if (typeof body !== "object" || body === null) {
      return transportErrorResponse(
        400,
        TransportErrorType.BAD_REQUEST,
        "request body must be a JSON object { uploadId }",
      );
    }
    const uploadId = asNonEmptyString((body as Record<string, unknown>)["uploadId"]);
    if (uploadId === undefined) {
      // A missing/empty uploadId is a malformed request (Req 7.6 family). 400 +
      // the INVALID_IDENTIFIER domain code so the UI branches consistently.
      return {
        status: UPLOAD_ERROR_STATUS[UploadErrorType.INVALID_IDENTIFIER],
        body: {
          errorType: UploadErrorType.INVALID_IDENTIFIER,
          message: "`uploadId` is required and must be a non-empty string",
        },
      };
    }

    // Unknown uploadId → 404 with INVALID_IDENTIFIER: the referenced active
    // scan does not exist (it may have already been uploaded+cleaned, or never
    // existed). DOCUMENTED CHOICE: 404 (not 400) because the identifier was
    // well-formed but names no resource; the errorType stays INVALID_IDENTIFIER
    // so the UI has a single "bad/again identifier" branch.
    const active = activeScans.get(uploadId);
    if (active === undefined) {
      return {
        status: 404,
        body: {
          errorType: UploadErrorType.INVALID_IDENTIFIER,
          message: `no active scan for uploadId ${uploadId}`,
        },
      };
    }

    // The Storage_Service is required to run the trigger. Until task 11.1/17.1
    // wires the real one (or a test injects the fake), reply 503 rather than
    // throwing — the route exists (Req 6.7) but its dependency is absent.
    if (storageService === undefined) {
      return transportErrorResponse(
        503,
        TransportErrorType.INTERNAL_ERROR,
        "upload trigger unavailable: no Storage_Service is configured (wired at task 17.1)",
      );
    }

    const result = await runUploadTrigger({
      contract: active.contract,
      cleanup: active.cleanup,
      storageService,
      ...(normalizeReport !== undefined ? { normalizeReport } : {}),
      ...(readReport !== undefined ? { readReport } : {}),
      ...(makeSnapshot !== undefined ? { makeSnapshot } : {}),
      ...(uploadConfirmTimeoutMs !== undefined ? { timeoutMs: uploadConfirmTimeoutMs } : {}),
    });

    if (result.ok) {
      // Confirmed upload: the core cleaned up the retained scan-target (Req
      // 4.7). Drop the entry so the uploadId can't be reused (Reqs 6.3, 6.4).
      activeScans.delete(uploadId);
      return { status: 200, body: { scanRecord: result.scanRecord } };
    }

    // Failure: retain the active scan (the report is still at reportPath for
    // REPORT_MISSING this is moot; for UPLOAD_FAILED it enables a retry).
    return {
      status: UPLOAD_ERROR_STATUS[result.errorType],
      body: { errorType: result.errorType, message: result.message },
    };
  };

  // ── Route table ───────────────────────────────────────────────────────────
  // Keyed by path → method → Route. Structured so task 7.2 adds `POST
  // /local/upload` by inserting one entry below (the placeholder comment marks
  // the spot); the dispatcher's 404/405 logic then covers it automatically.
  const routes = new Map<string, Map<string, Route>>([
    [
      "/local/fetch",
      new Map<string, Route>([
        ["POST", { method: "POST", readsBody: true, handler: handleFetch }],
      ]),
    ],
    [
      "/local/health",
      new Map<string, Route>([
        ["GET", { method: "GET", readsBody: false, handler: handleHealth }],
      ]),
    ],
    // ── TASK 7.2: upload-trigger interface (Interface 3) ───────────────────
    // `handleUpload` resolves `{ uploadId }` against `activeScans`, normalizes
    // the report at `contract.reportPath`, hands it to the Storage_Service,
    // and calls the stored `cleanup` after a confirmed upload.
    [
      "/local/upload",
      new Map<string, Route>([
        ["POST", { method: "POST", readsBody: true, handler: handleUpload }],
      ]),
    ],
  ]);

  const handleRequest = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void => {
    // CORS: the browser page (Vercel origin / localhost:5173) calls this
    // loopback agent cross-origin. The agent is bound to 127.0.0.1 only, so it
    // is reachable only from the operator's own machine; permissive CORS here
    // just lets the local UI talk to it. Handle the preflight directly.
    setCorsHeaders(res);
    if ((req.method ?? "GET").toUpperCase() === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    void dispatch(req)
      .then((response) => writeJson(res, response.status, response.body))
      .catch((err: unknown) => {
        // Defensive: handlers are not expected to throw, but never leak a stack
        // trace across the wire.
        const message = err instanceof Error ? err.message : String(err);
        writeJson(
          res,
          500,
          transportErrorResponse(500, TransportErrorType.INTERNAL_ERROR, message).body,
        );
      });
  };

  /** Resolve a request to a {@link JsonResponse}, handling routing + body parse. */
  async function dispatch(req: http.IncomingMessage): Promise<JsonResponse> {
    const method = (req.method ?? "GET").toUpperCase();
    const path = parsePath(req.url ?? "/");

    const byMethod = routes.get(path);
    if (byMethod === undefined) {
      return transportErrorResponse(
        404,
        TransportErrorType.NOT_FOUND,
        `no route for ${method} ${path}`,
      );
    }
    const route = byMethod.get(method);
    if (route === undefined) {
      const allow = [...byMethod.keys()].join(", ");
      return {
        status: 405,
        body: {
          errorType: TransportErrorType.METHOD_NOT_ALLOWED,
          message: `method ${method} not allowed for ${path}; allowed: ${allow}`,
          allow,
        },
      };
    }

    if (!route.readsBody) {
      return route.handler({ body: undefined, req });
    }

    const parsed = await readJsonBody(req, MAX_REQUEST_BODY_BYTES);
    if (!parsed.ok) {
      return parsed.tooLarge
        ? transportErrorResponse(
            413,
            TransportErrorType.PAYLOAD_TOO_LARGE,
            `request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`,
          )
        : transportErrorResponse(
            400,
            TransportErrorType.BAD_REQUEST,
            "request body must be valid JSON",
          );
    }
    return route.handler({ body: parsed.value, req });
  }

  const server = http.createServer(handleRequest);

  return { server, handleRequest, activeScans };
}

/** Strip the query/fragment from a request URL, returning just the path. */
function parsePath(url: string): string {
  const queryIndex = url.indexOf("?");
  const hashIndex = url.indexOf("#");
  let end = url.length;
  if (queryIndex !== -1) end = Math.min(end, queryIndex);
  if (hashIndex !== -1) end = Math.min(end, hashIndex);
  const path = url.slice(0, end);
  // Normalize a trailing slash (except for the root) so "/local/health/" maps
  // to "/local/health".
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/** Parsed-body result: a value, a parse failure, or an over-size failure. */
type ReadJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; tooLarge?: boolean };

/**
 * Read and JSON-parse a request body with a hard size cap. Returns a typed
 * result rather than throwing. An empty body, invalid JSON, or a body that
 * exceeds `maxBytes` all fail (the size case is flagged via `tooLarge`).
 */
function readJsonBody(
  req: http.IncomingMessage,
  maxBytes: number,
): Promise<ReadJsonResult> {
  return new Promise<ReadJsonResult>((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const settle = (result: ReadJsonResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        settle({ ok: false, tooLarge: true });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (settled) return;
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (raw === "") {
        settle({ ok: false });
        return;
      }
      try {
        settle({ ok: true, value: JSON.parse(raw) });
      } catch {
        settle({ ok: false });
      }
    });

    req.on("error", () => settle({ ok: false }));
  });
}

/** Write a JSON response with the standard content-type. */
function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload).toString(),
  });
  res.end(payload);
}

/**
 * Set permissive CORS headers so the local Frontend_UI (served from a Vercel
 * origin or `localhost:5173` in dev) can call this loopback agent from the
 * browser. SAFE because the agent binds to 127.0.0.1 only and is therefore
 * reachable solely from the operator's own machine.
 */
function setCorsHeaders(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

/** Options for {@link startAgentServer}. */
export interface StartAgentServerOptions {
  /**
   * Port to bind. Defaults to config `LOCAL_AGENT_PORT` (3939). Pass `0` to
   * bind an ephemeral port (useful in tests).
   */
  port?: number;
  /**
   * Dep overrides. `scanTargetDir` defaults to config `SCAN_TARGET_DIR` when
   * not provided.
   */
  deps?: Partial<AgentServerDeps>;
}

/** A started server: the {@link AgentServer} plus the actually-bound port. */
export interface StartedAgentServer extends AgentServer {
  /** The bound port (resolved from `address()` when `port: 0` was requested). */
  port: number;
}

/**
 * Create and start the agent server, binding to {@link LOOPBACK_HOST} ONLY.
 *
 * SECURITY: the bind host is fixed to `127.0.0.1` — there is no option to bind
 * a public interface. This guarantees the disk-touching agent is reachable
 * only from the operator's own machine.
 */
export function startAgentServer(
  options: StartAgentServerOptions = {},
): Promise<StartedAgentServer> {
  const config = loadConfig();
  const port = options.port ?? config.localAgentPort;
  const scanTargetDir = options.deps?.scanTargetDir ?? config.scanTargetDir;

  // Wire the REAL Storage_Service + report normalizer by default (task 17.1),
  // unless a caller injected its own (tests inject fakes). Constructing the
  // Tigris service is lazy — it only talks to the network on an actual upload.
  const storageService =
    options.deps?.storageService ?? new TigrisStorageService({ config });
  const normalizeReport =
    options.deps?.normalizeReport ??
    ((raw: unknown) => normalizeReport_shared(raw, { threshold: config.riskThreshold }));

  // Resolve a real editor-launch command (env override → code → known VS Code
  // install paths → code-insiders/kiro). Lets the agent open VS Code even when
  // `code` was never added to PATH (common on Windows).
  const codeCommand = options.deps?.codeCommand ?? resolveEditorCommand();

  const agent = createAgentServer({
    ...options.deps,
    scanTargetDir,
    storageService,
    normalizeReport,
    codeCommand,
  });

  return new Promise<StartedAgentServer>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    agent.server.once("error", onError);
    // Bind to the loopback host ONLY (never 0.0.0.0). Security-critical.
    agent.server.listen(port, LOOPBACK_HOST, () => {
      agent.server.removeListener("error", onError);
      const address = agent.server.address();
      const boundPort =
        typeof address === "object" && address !== null ? address.port : port;
      resolve({ ...agent, port: boundPort });
    });
  });
}
