/**
 * Centralized configuration loader for PackGuard.
 *
 * Reads environment variables once and exposes a typed, validated config
 * object with the defaults agreed in the design document (see
 * "Configuration / environment" in design.md).
 *
 * Owners per design:
 *  - Tigris vars + RISK_THRESHOLD: Person B
 *  - LOCAL_AGENT_PORT / SCAN_TARGET_DIR / NPM_REGISTRY_BASE: Person A
 */

/** Defaults defined by the design's configuration table. */
export const CONFIG_DEFAULTS = {
  TIGRIS_ENDPOINT: "https://t3.storage.dev",
  TIGRIS_BUCKET: "packguard",
  RISK_THRESHOLD: 50,
  LOCAL_AGENT_PORT: 3939,
  SCAN_TARGET_DIR: "./scan-target",
  NPM_REGISTRY_BASE: "https://registry.npmjs.org",
} as const;

/**
 * @deprecated Use {@link CONFIG_DEFAULTS}. Retained as an alias so older
 * imports of `configDefaults` keep resolving.
 */
export const configDefaults = CONFIG_DEFAULTS;

export interface PackGuardConfig {
  /** Tigris S3-compatible endpoint (e.g. https://t3.storage.dev). */
  tigrisEndpoint: string;
  /** Tigris/AWS access key id. Empty string when unset. */
  awsAccessKeyId: string;
  /** Tigris/AWS secret access key. Empty string when unset. */
  awsSecretAccessKey: string;
  /** Tigris bucket name. */
  tigrisBucket: string;
  /** Verdict threshold T (integer 0..100). riskScore < T => SAFE. */
  riskThreshold: number;
  /** Loopback port for the local agent. */
  localAgentPort: number;
  /** Isolated extraction root directory. */
  scanTargetDir: string;
  /** npm registry base URL. */
  npmRegistryBase: string;
}

type EnvSource = Record<string, string | undefined>;

function readString(env: EnvSource, key: string, fallback: string): string {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  return trimmed === "" ? fallback : trimmed;
}

function readInt(
  env: EnvSource,
  key: string,
  fallback: number,
  bounds?: { min?: number; max?: number },
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new Error(
      `Invalid config: ${key}="${raw}" must be an integer (got "${raw}").`,
    );
  }
  if (bounds?.min !== undefined && parsed < bounds.min) {
    throw new Error(
      `Invalid config: ${key}=${parsed} must be >= ${bounds.min}.`,
    );
  }
  if (bounds?.max !== undefined && parsed > bounds.max) {
    throw new Error(
      `Invalid config: ${key}=${parsed} must be <= ${bounds.max}.`,
    );
  }
  return parsed;
}

/**
 * Load configuration from a provided environment map (defaults to
 * `process.env`). Pure with respect to its input so it is easy to test.
 *
 * `TIGRIS_ENDPOINT` is preferred; `AWS_ENDPOINT_URL_S3` is accepted as a
 * fallback so the AWS SDK and this loader can share a single value.
 */
export function loadConfig(env: EnvSource = process.env): PackGuardConfig {
  return {
    tigrisEndpoint: readString(
      env,
      "TIGRIS_ENDPOINT",
      readString(env, "AWS_ENDPOINT_URL_S3", CONFIG_DEFAULTS.TIGRIS_ENDPOINT),
    ),
    awsAccessKeyId: readString(env, "AWS_ACCESS_KEY_ID", ""),
    awsSecretAccessKey: readString(env, "AWS_SECRET_ACCESS_KEY", ""),
    tigrisBucket: readString(env, "TIGRIS_BUCKET", CONFIG_DEFAULTS.TIGRIS_BUCKET),
    riskThreshold: readInt(env, "RISK_THRESHOLD", CONFIG_DEFAULTS.RISK_THRESHOLD, {
      min: 0,
      max: 100,
    }),
    localAgentPort: readInt(
      env,
      "LOCAL_AGENT_PORT",
      CONFIG_DEFAULTS.LOCAL_AGENT_PORT,
      { min: 1, max: 65535 },
    ),
    scanTargetDir: readString(
      env,
      "SCAN_TARGET_DIR",
      CONFIG_DEFAULTS.SCAN_TARGET_DIR,
    ),
    npmRegistryBase: readString(
      env,
      "NPM_REGISTRY_BASE",
      CONFIG_DEFAULTS.NPM_REGISTRY_BASE,
    ),
  };
}
