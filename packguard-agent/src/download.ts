/**
 * Tarball download with a hard size cap (Person A, task 3.1).
 *
 * Downloads the package `.tgz` from the tarball URL in the npm metadata and
 * hands the bytes to the safe-tar {@link safeExtract} later in the pipeline
 * (task 5.1 wires them). This module is deliberately the *only* thing that
 * touches the network for the tarball; it does NOTHING with the bytes beyond
 * buffering them. Per the core "inspect without installing" constraint
 * (Reqs 2.5, 3.5) the downloaded content is INERT data — nothing here ever
 * spawns, requires, imports, evaluates, or otherwise executes it.
 *
 * Behavior (Req 2):
 *  - Download within a 30s budget (Req 2.1), enforced with an AbortController.
 *  - On a refused/interrupted connection, a non-2xx response, or a timeout,
 *    return {@link FetchErrorType.DOWNLOAD_FAILED} and discard any partially
 *    downloaded bytes (Req 2.3).
 *  - Abort if the tarball exceeds `limits.maxTarballBytes` (100 MB by default)
 *    and return {@link FetchErrorType.DOWNLOAD_TOO_LARGE} (Req 2.4). The cap is
 *    enforced BOTH from the `Content-Length` header when present AND by
 *    counting bytes while streaming, because a server may omit or lie about
 *    `Content-Length`; we abort the moment the running total exceeds the cap.
 *  - On success, return the buffered tarball bytes (Req 2.2).
 *
 * ── Output form: buffer-into-memory-with-cap ─────────────────────────────
 * We buffer the download into a single {@link Buffer} (capped at 100 MB) rather
 * than streaming to a temp file. Rationale:
 *  - The 100 MB cap (Req 2.4) bounds memory, so buffering is safe.
 *  - It avoids temp-file lifecycle/cleanup complexity and the associated
 *    failure modes (orphaned files, partial writes on abort).
 *  - The extractor wants a `Readable`; a buffered result trivially becomes one
 *    via {@link tarballBytesToReadable} (`Readable.from([bytes])`), so the
 *    caller can feed it straight into `safeExtract`.
 *
 * The function NEVER throws across its boundary; it returns a typed
 * {@link DownloadResult} discriminated union so the orchestration layer can
 * branch and map onto the Backend_API error contract.
 *
 * Testability: the global `fetch`, the size `limits`, and the `timeoutMs` are
 * all injectable so the integration test (task 3.2) can drive this with a fake
 * fetch and tiny limits — no real network required.
 */

import { Readable } from "node:stream";

import { FetchErrorType } from "@shared/errors";
import { DEFAULT_SAFE_TAR_LIMITS, type SafeTarLimits } from "@shared/scan";

/**
 * The subset of {@link FetchErrorType} this module can produce (Reqs 2.3, 2.4).
 */
export type DownloadErrorType =
  | typeof FetchErrorType.DOWNLOAD_FAILED
  | typeof FetchErrorType.DOWNLOAD_TOO_LARGE;

/** Successful download outcome (Req 2.2). */
export interface DownloadSuccess {
  ok: true;
  /** The buffered tarball bytes (inert; never executed). */
  bytes: Buffer;
  /** Convenience: `bytes.length`. */
  byteLength: number;
}

/** Aborted download outcome, mapped to a distinct {@link DownloadErrorType}. */
export interface DownloadFailure {
  ok: false;
  errorType: DownloadErrorType;
  message: string;
}

/**
 * Typed result object. {@link downloadTarball} NEVER throws across its
 * boundary; it returns this union (Req 2.3, 2.4).
 */
export type DownloadResult = DownloadSuccess | DownloadFailure;

/**
 * Injectable fetch implementation. Matches the global `fetch` signature so the
 * default is a drop-in and a test fake can return a real `Response`.
 */
export type FetchFn = typeof fetch;

/** Options for {@link downloadTarball}. */
export interface DownloadOptions {
  /** Injectable fetch (default: global `fetch`). Enables network-free tests. */
  fetchFn?: FetchFn;
  /** Size limits (Req 2.4). Defaults to {@link DEFAULT_SAFE_TAR_LIMITS}. */
  limits?: SafeTarLimits;
  /** Overall download timeout in ms (Req 2.1). Defaults to 30_000. */
  timeoutMs?: number;
  /**
   * Optional external abort signal. If it fires, the download is aborted and
   * reported as {@link FetchErrorType.DOWNLOAD_FAILED} (interrupted, Req 2.3).
   */
  signal?: AbortSignal;
}

/** Default download timeout (Req 2.1: 30 seconds). */
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000;

/** Parse a `Content-Length` header into a non-negative integer, or `null`. */
function parseContentLength(headerValue: string | null): number | null {
  if (headerValue === null) return null;
  const trimmed = headerValue.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

/**
 * Wrap downloaded tarball bytes in a Node {@link Readable} suitable for
 * {@link safeExtract}. Wrapping `[bytes]` (a single-element array) yields the
 * whole buffer as one chunk — passing the bare Buffer would iterate it byte by
 * byte, which is wrong for a binary stream.
 */
export function tarballBytesToReadable(bytes: Buffer): Readable {
  return Readable.from([bytes]);
}

/**
 * Download the `.tgz` tarball at `tarballUrl`, enforcing the 30s budget and the
 * 100 MB size cap. Returns a typed {@link DownloadResult}; never throws.
 *
 * The size cap is enforced twice over (Req 2.4):
 *  1. Eagerly from the `Content-Length` header when the server provides one.
 *  2. Continuously while streaming, so an absent or dishonest `Content-Length`
 *     cannot smuggle in an over-cap payload — we stop the moment the running
 *     total exceeds the cap and discard everything read so far (Req 2.3, 2.4).
 */
export async function downloadTarball(
  tarballUrl: string,
  options: DownloadOptions = {},
): Promise<DownloadResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const limits = options.limits ?? DEFAULT_SAFE_TAR_LIMITS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const maxBytes = limits.maxTarballBytes;

  const controller = new AbortController();

  // Distinguishes a size-triggered abort (DOWNLOAD_TOO_LARGE) from every other
  // abort/error (DOWNLOAD_FAILED) once control reaches the catch block.
  let abortedForSize = false;

  // 30s budget (Req 2.1). A fired timer => the download did not complete in
  // time => DOWNLOAD_FAILED (Req 2.3).
  const timer =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;

  // Bridge an external abort signal into our controller (interrupted, Req 2.3).
  const onExternalAbort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  try {
    const response = await fetchFn(tarballUrl, { signal: controller.signal });

    // Non-2xx response → DOWNLOAD_FAILED (Req 2.3).
    if (!response.ok) {
      return {
        ok: false,
        errorType: FetchErrorType.DOWNLOAD_FAILED,
        message: `tarball download failed: HTTP ${response.status} ${response.statusText}`.trim(),
      };
    }

    // Eager cap check from Content-Length when the server provides one (Req 2.4).
    const declaredLength = parseContentLength(response.headers.get("content-length"));
    if (declaredLength !== null && declaredLength > maxBytes) {
      abortedForSize = true;
      controller.abort();
      return {
        ok: false,
        errorType: FetchErrorType.DOWNLOAD_TOO_LARGE,
        message: `tarball exceeds size cap: Content-Length ${declaredLength} > ${maxBytes} bytes`,
      };
    }

    const body = response.body;

    // No streamable body: fall back to a single buffered read, still capped.
    if (body === null) {
      const arrayBuffer = await response.arrayBuffer();
      if (arrayBuffer.byteLength > maxBytes) {
        return {
          ok: false,
          errorType: FetchErrorType.DOWNLOAD_TOO_LARGE,
          message: `tarball exceeds size cap: ${arrayBuffer.byteLength} > ${maxBytes} bytes`,
        };
      }
      const bytes = Buffer.from(arrayBuffer);
      return { ok: true, bytes, byteLength: bytes.length };
    }

    // Stream the body, counting bytes and enforcing the cap continuously so an
    // omitted/dishonest Content-Length cannot bypass it (Reqs 2.3, 2.4).
    const reader = body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;

      total += value.byteLength;
      if (total > maxBytes) {
        // Discard everything read so far and stop the transfer (Req 2.3, 2.4).
        abortedForSize = true;
        chunks.length = 0;
        await reader.cancel().catch(() => undefined);
        controller.abort();
        return {
          ok: false,
          errorType: FetchErrorType.DOWNLOAD_TOO_LARGE,
          message: `tarball exceeds size cap: streamed > ${maxBytes} bytes`,
        };
      }

      // Copy each chunk so a reused underlying ArrayBuffer cannot corrupt it.
      chunks.push(Buffer.from(value));
    }

    const bytes = Buffer.concat(chunks);
    return { ok: true, bytes, byteLength: bytes.length };
  } catch (err) {
    // A size-triggered abort already returned above; any abort/error reaching
    // here is a refused/interrupted connection or a timeout → DOWNLOAD_FAILED
    // (Req 2.3). Partial bytes are dropped: they live only in locals that go
    // out of scope here.
    if (abortedForSize) {
      return {
        ok: false,
        errorType: FetchErrorType.DOWNLOAD_TOO_LARGE,
        message: `tarball exceeds size cap (${maxBytes} bytes)`,
      };
    }
    const aborted =
      controller.signal.aborted ||
      (err instanceof Error && err.name === "AbortError");
    const reason = aborted
      ? `download aborted (timeout ${timeoutMs}ms or interrupted)`
      : err instanceof Error
        ? err.message
        : String(err);
    return {
      ok: false,
      errorType: FetchErrorType.DOWNLOAD_FAILED,
      message: `tarball download failed: ${reason}`,
    };
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (options.signal) options.signal.removeEventListener("abort", onExternalAbort);
  }
}
