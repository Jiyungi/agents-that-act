/**
 * Minimal smoke test for npm resolution (task 2.3).
 *
 * This is intentionally a tiny proof-of-life for the injectable `resolvePackage`
 * core and the HTTP adapter — NOT the full coverage suite. The version-resolution
 * property test (task 2.4, Property 7) and the resolution error-branch example
 * tests (task 2.5: 1.4 / 1.5 / 1.8) are separate optional tasks and live
 * elsewhere. Here we only confirm the wiring works with an injected fake `fetch`
 * (no real network) for one happy path and one representative error mapping.
 */

import { describe, expect, it } from "vitest";

import { resolvePackage } from "./_lib/resolve.js";
import { resolveToHttp, statusForErrorType } from "./resolve.js";
import { FetchErrorType } from "@shared/errors";

/** Build a fake `fetch` that returns the given status + JSON body once. */
function fakeFetch(status: number, jsonBody: unknown): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => jsonBody,
    }) as unknown as Response) as unknown as typeof fetch;
}

const REGISTRY = "https://registry.example.test";

const SAMPLE_PACKUMENT = {
  name: "left-pad",
  "dist-tags": { latest: "1.3.0" },
  versions: {
    "1.0.0": {
      version: "1.0.0",
      dist: { tarball: "https://registry.example.test/left-pad/-/left-pad-1.0.0.tgz" },
    },
    "1.3.0": {
      version: "1.3.0",
      dist: {
        tarball: "https://registry.example.test/left-pad/-/left-pad-1.3.0.tgz",
        integrity: "sha512-deadbeef",
      },
    },
  },
};

describe("resolvePackage (smoke)", () => {
  it("resolves dist-tags.latest when no version is given", async () => {
    const result = await resolvePackage(
      { packageName: "left-pad" },
      { fetchFn: fakeFetch(200, SAMPLE_PACKUMENT), registryBase: REGISTRY },
    );
    expect(result).toEqual({
      ok: true,
      resolved: {
        packageName: "left-pad",
        version: "1.3.0",
        tarballUrl: "https://registry.example.test/left-pad/-/left-pad-1.3.0.tgz",
        integrity: "sha512-deadbeef",
      },
    });
  });

  it("resolves an exact version when one is provided", async () => {
    const result = await resolvePackage(
      { packageName: "left-pad", version: "1.0.0" },
      { fetchFn: fakeFetch(200, SAMPLE_PACKUMENT), registryBase: REGISTRY },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resolved.version).toBe("1.0.0");
  });

  it("rejects an invalid name before querying the registry (INVALID_PACKAGE_NAME)", async () => {
    let called = false;
    const spyFetch = (async () => {
      called = true;
      return {} as Response;
    }) as unknown as typeof fetch;

    const result = await resolvePackage(
      { packageName: "Bad Name" },
      { fetchFn: spyFetch, registryBase: REGISTRY },
    );
    expect(called).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorType).toBe(FetchErrorType.INVALID_PACKAGE_NAME);
  });

  it("maps a 404 to PACKAGE_UNRESOLVED and the HTTP adapter to 404", async () => {
    const result = await resolvePackage(
      { packageName: "does-not-exist" },
      { fetchFn: fakeFetch(404, { error: "Not found" }), registryBase: REGISTRY },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorType).toBe(FetchErrorType.PACKAGE_UNRESOLVED);
      expect(statusForErrorType(result.errorType)).toBe(404);
    }
  });

  it("HTTP adapter returns 200 + ResolvedPackage on success", async () => {
    const { status, body } = await resolveToHttp(
      { method: "POST", body: { packageName: "left-pad" } },
      { fetchFn: fakeFetch(200, SAMPLE_PACKUMENT), registryBase: REGISTRY },
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({ packageName: "left-pad", version: "1.3.0" });
  });
});
