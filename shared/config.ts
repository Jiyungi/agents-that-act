/**
 * Centralized configuration loader for PackGuard.
 *
 * Reads configuration from environment variables with sensible defaults.
 * See `.env.example` for the full list of variables and their meaning.
 *
 * Ownership (per design):
 *   - Tigris / storage + RISK_THRESHOLD  -> Person B
 *   - LOCAL_AGENT_PORT / SCAN_TARGET_DIR / NPM_REGISTRY_BASE -> Person A
 */

export interface PackGuardConfig {
  /** Tigris S3-compatible endpoint, e.g. https://t3.storage.dev */
  tigrisEndpoint: string;
  /** Tigris/AWS access key id. */
  awsAccessKeyId: string;
  /** Tigris/AWS secret access key. */
  awsSecretAccessKey: string;
  /** Tigris bucket that holds reports, source snapshots, and scan records. */
  tigrisBucket: string;
  /** Verdict threshold T (0..100). riskScore < T => SAFE, otherwise RISKY. */
  riskThreshold: number;
  /** Loopback port for the local fetcher agent. */
  localAgentPort: number;
  /** Isolated extraction root for fetched package source. */
  scanTargetDir: string;
  /** Base URL of the npm registry. */
  npmRegistryBase: string;
}

const DEFAULTS = {
  TIGRIS_ENDPOINT: "https://t3.storage.dev",
  RISK_THRESHOLD: 50,
  LOCAL_AGENT_PORT: 3939,
  SCAN_TARGET_DIR: "./scan-target",
  NPM_REGISTRY_BASE: "https://registry.npmjs.org",
} as const;

type EnvSource = Record<string, string | undefined>;

function readString(env: EnvSource, key: string, fallback?: string): string {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") {
    if (fallback !== undefined) return fallback;
    return "";
  }
  return raw.trim();
}

function readInt(env: EnvSource, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (Number.isNaN(parsed)) {
    throw new Error(
      `Invalid value for ${key}: "${raw}" is not an integer.`,
    );
  }
  return parsed;
}

/**
 * Load configuration from the provided environment source (defaults to
 * `process.env`). Missing optional values fall back to documented defaults;
 * Tigris credentials default to empty strings so non-storage code paths
 * (resolution, extraction) can run without them.
 */
export function loadConfig(env: EnvSource = process.env): PackGuardConfig {
  const riskThreshold = readInt(env, "RISK_THRESHOLD", DEFAULTS.RISK_THRESHOLD);
  if (riskThreshold < 0 || riskThreshold > 100) {
    throw new Error(
      `RISK_THRESHOLD must be between 0 and 100 inclusive, got ${riskThreshold}.`,
    );
  }

  return {
    tigrisEndpoint: readString(
      env,
      "TIGRIS_ENDPOINT",
      readString(env, "AWS_ENDPOINT_URL_S3", DEFAULTS.TIGRIS_ENDPOINT),
    ),
    awsAccessKeyId: readString(env, "AWS_ACCESS_KEY_ID"),
    awsSecretAccessKey: readString(env, "AWS_SECRET_ACCESS_KEY"),
    tigrisBucket: readString(env, "TIGRIS_BUCKET"),
    riskThreshold,
    localAgentPort: readInt(env, "LOCAL_AGENT_PORT", DEFAULTS.LOCAL_AGENT_PORT),
    scanTargetDir: readString(env, "SCAN_TARGET_DIR", DEFAULTS.SCAN_TARGET_DIR),
    npmRegistryBase: readString(
      env,
      "NPM_REGISTRY_BASE",
      DEFAULTS.NPM_REGISTRY_BASE,
    ),
  };
}

export const configDefaults = DEFAULTS;
