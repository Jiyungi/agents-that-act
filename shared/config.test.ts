import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { CONFIG_DEFAULTS, loadConfig } from "@shared/config";

describe("loadConfig", () => {
  it("applies design defaults when the environment is empty", () => {
    const cfg = loadConfig({});
    expect(cfg.tigrisEndpoint).toBe(CONFIG_DEFAULTS.TIGRIS_ENDPOINT);
    expect(cfg.tigrisBucket).toBe(CONFIG_DEFAULTS.TIGRIS_BUCKET);
    expect(cfg.riskThreshold).toBe(50);
    expect(cfg.localAgentPort).toBe(3939);
    expect(cfg.scanTargetDir).toBe("./scan-target");
    expect(cfg.npmRegistryBase).toBe("https://registry.npmjs.org");
    expect(cfg.awsAccessKeyId).toBe("");
    expect(cfg.awsSecretAccessKey).toBe("");
  });

  it("reads provided values over defaults", () => {
    const cfg = loadConfig({
      TIGRIS_ENDPOINT: "https://example.test",
      AWS_ACCESS_KEY_ID: "key",
      AWS_SECRET_ACCESS_KEY: "secret",
      TIGRIS_BUCKET: "my-bucket",
      RISK_THRESHOLD: "75",
      LOCAL_AGENT_PORT: "4000",
      SCAN_TARGET_DIR: "./tmp/scan",
      NPM_REGISTRY_BASE: "https://registry.example.test",
    });
    expect(cfg.tigrisEndpoint).toBe("https://example.test");
    expect(cfg.awsAccessKeyId).toBe("key");
    expect(cfg.awsSecretAccessKey).toBe("secret");
    expect(cfg.tigrisBucket).toBe("my-bucket");
    expect(cfg.riskThreshold).toBe(75);
    expect(cfg.localAgentPort).toBe(4000);
    expect(cfg.scanTargetDir).toBe("./tmp/scan");
    expect(cfg.npmRegistryBase).toBe("https://registry.example.test");
  });

  it("falls back to AWS_ENDPOINT_URL_S3 when TIGRIS_ENDPOINT is unset", () => {
    const cfg = loadConfig({ AWS_ENDPOINT_URL_S3: "https://t3.storage.dev" });
    expect(cfg.tigrisEndpoint).toBe("https://t3.storage.dev");
  });

  it("rejects an out-of-range risk threshold", () => {
    expect(() => loadConfig({ RISK_THRESHOLD: "150" })).toThrow();
    expect(() => loadConfig({ RISK_THRESHOLD: "-1" })).toThrow();
  });

  it("rejects a non-integer port", () => {
    expect(() => loadConfig({ LOCAL_AGENT_PORT: "abc" })).toThrow();
  });

  // Smoke property test to confirm fast-check + Vitest wiring works.
  // (Real correctness properties land in later spec tasks.)
  it("accepts any in-range RISK_THRESHOLD integer", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), (t) => {
        const cfg = loadConfig({ RISK_THRESHOLD: String(t) });
        expect(cfg.riskThreshold).toBe(t);
      }),
      { numRuns: 100 },
    );
  });
});
