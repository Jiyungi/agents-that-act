/**
 * Smoke / unit tests for the tarball downloader (task 3.1).
 *
 * These prove the downloader compiles and runs WITHOUT a real network by
 * injecting a fake `fetch`. The full integration test for the success path and
 * the just-over-100 MB size boundary is a SEPARATE optional task (3.2) and is
 * intentionally NOT implemented here.
 */

import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { FetchErrorType } from "@shared/errors";
import { DEFAULT_SAFE_TAR_LIMITS } from "@shared/scan";
import {
  downloadTarball,
  tarballBytesToReadable,
  type FetchFn,
} from "./download.js";

/** Build a fake `fetch` that returns `body` with the given headers/status. */
function fakeFetch(
  body: Buffer | null,
  init?: { status?: number; statusText?: string; contentLength?: number | null },
): FetchFn {
  const status = init?.status ?? 200;
  const headers = new Headers();
  if (init?.contentLength !== null && init?.contentLength !== undefined) {
    headers.set("content-length", String(init.contentLength));
  }
  return (async () =>
    new Response(body === null ? null : new Uint8Array(body), {
      status,
      statusText: init?.statusText ?? "",
      headers,
    })) as unknown as FetchFn;
}

/** A `fetch` that rejects, simulating a refused/interrupted connection. */
const refusingFetch = (async () => {
  throw new Error("ECONNREFUSED");
}) as unknown as FetchFn;

describe("downloadTarball", () => {
  it("downloads a small body and returns the buffered bytes (Reqs 2.1, 2.2)", async () => {
    const payload = Buffer.from("fake-tgz-bytes");
    const result = await downloadTarball("https://registry.example/pkg.tgz", {
      fetchFn: fakeFetch(payload, { contentLength: payload.length }),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.byteLength).toBe(payload.length);
      expect(result.bytes.equals(payload)).toBe(true);
    }
  });

  it("succeeds when the server omits Content-Length (streamed counting)", async () => {
    const payload = Buffer.from("no-content-length-here");
    const result = await downloadTarball("https://registry.example/pkg.tgz", {
      fetchFn: fakeFetch(payload, { contentLength: null }),
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bytes.equals(payload)).toBe(true);
  });

  it("returns DOWNLOAD_FAILED on a non-2xx response (Req 2.3)", async () => {
    const result = await downloadTarball("https://registry.example/pkg.tgz", {
      fetchFn: fakeFetch(Buffer.from("nope"), { status: 404, statusText: "Not Found" }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorType).toBe(FetchErrorType.DOWNLOAD_FAILED);
  });

  it("returns DOWNLOAD_FAILED on a refused/interrupted connection (Req 2.3)", async () => {
    const result = await downloadTarball("https://registry.example/pkg.tgz", {
      fetchFn: refusingFetch,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorType).toBe(FetchErrorType.DOWNLOAD_FAILED);
  });

  it("aborts via Content-Length when it exceeds the cap (Req 2.4)", async () => {
    const payload = Buffer.from("x".repeat(200));
    const result = await downloadTarball("https://registry.example/pkg.tgz", {
      fetchFn: fakeFetch(payload, { contentLength: 200 }),
      limits: { ...DEFAULT_SAFE_TAR_LIMITS, maxTarballBytes: 100 },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorType).toBe(FetchErrorType.DOWNLOAD_TOO_LARGE);
  });

  it("aborts via streamed counting when Content-Length lies/omits (Req 2.4)", async () => {
    // 200 real bytes but Content-Length omitted: the cap must still trip.
    const payload = Buffer.from("y".repeat(200));
    const result = await downloadTarball("https://registry.example/pkg.tgz", {
      fetchFn: fakeFetch(payload, { contentLength: null }),
      limits: { ...DEFAULT_SAFE_TAR_LIMITS, maxTarballBytes: 100 },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorType).toBe(FetchErrorType.DOWNLOAD_TOO_LARGE);
  });

  it("times out and returns DOWNLOAD_FAILED when the fetch never resolves (Req 2.1, 2.3)", async () => {
    // A fetch that resolves only when its signal aborts, simulating a hang.
    const hangingFetch = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      })) as unknown as FetchFn;

    const result = await downloadTarball("https://registry.example/pkg.tgz", {
      fetchFn: hangingFetch,
      timeoutMs: 20,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorType).toBe(FetchErrorType.DOWNLOAD_FAILED);
  });

  it("wraps buffered bytes into a single-chunk Readable for the extractor", async () => {
    const payload = Buffer.from("stream-me");
    const stream = tarballBytesToReadable(payload);
    expect(stream).toBeInstanceOf(Readable);

    const collected: Buffer[] = [];
    for await (const chunk of stream) collected.push(chunk as Buffer);
    expect(Buffer.concat(collected).equals(payload)).toBe(true);
  });
});
