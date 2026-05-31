import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { loadConfig, configDefaults } from "./config.js";

describe("loadConfig", () => {
  it("applies documented defaults when env is empty", () => {
    const cfg = loadConfig({});
    expect(cfg.tigrisEndpoint).toBe(configDefaults.TIGRIS_ENDPOINT);
    expect(cfg.riskThreshold).toBe(configDefaults.RISK_THRESHOLD);
    expect(cfg.localAgentPort).toBe(configDefaults.LOCAL_AGENT_PORT);
    expect(cfg.scanTargetDir).toBe(configDefaults.SCAN_TARGET_DIR);
    expect(cfg.npmRegistryBase).toBe(configDefaults.NPM_REGISTRY_BASE);
    // Credentials default to empty so non-storage paths can run.
    expect(cfg.awsAccessKeyId).toBe("");
    expect(cfg.awsSecretAccessKey).toBe("");
    expect(cfg.tigrisBucket).toBe("");
  });

  it("reads provided values over defaults", () => {
    const cfg = loadConfig({
      TIGRIS_ENDPOINT: "https://example.test",
      AWS_ACCESS_KEY_ID: "key",
      AWS_SECRET_ACCESS_KEY: "secret",
      TIGRIS_BUCKET: "mybucket",
      RISK_THRESHOLD: "70",
      LOCAL_AGENT_PORT: "4040",
      SCAN_TARGET_DIR: "./tmp-target",
      NPM_REGISTRY_BASE: "https://registry.example.test",
    });
    expect(cfg.tigrisEndpoint).toBe("https://example.test");
    expect(cfg.awsAccessKeyId).toBe("key");
    expect(cfg.tigrisBucket).toBe("mybucket");
    expect(cfg.riskThreshold).toBe(70);
    expect(cfg.localAgentPort).toBe(4040);
    expect(cfg.scanTargetDir).toBe("./tmp-target");
    expect(cfg.npmRegistryBase).toBe("https://registry.example.test");
  });

  it("falls back to AWS_ENDPOINT_URL_S3 when TIGRIS_ENDPOINT is absent", () => {
    const cfg = loadConfig({ AWS_ENDPOINT_URL_S3: "https://fallback.test" });
    expect(cfg.tigrisEndpoint).toBe("https://fallback.test");
  });

  it("rejects a non-integer RISK_THRESHOLD", () => {
    expect(() => loadConfig({ RISK_THRESHOLD: "abc" })).toThrow();
  });

  it("rejects an out-of-range RISK_THRESHOLD", () => {
    expect(() => loadConfig({ RISK_THRESHOLD: "150" })).toThrow();
    expect(() => loadConfig({ RISK_THRESHOLD: "-1" })).toThrow();
  });

  // Sanity check that fast-check is wired up and runnable.
  it("accepts any in-range integer RISK_THRESHOLD", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), (t) => {
        const cfg = loadConfig({ RISK_THRESHOLD: String(t) });
        return cfg.riskThreshold === t;
      }),
      { numRuns: 100 },
    );
  });
});
