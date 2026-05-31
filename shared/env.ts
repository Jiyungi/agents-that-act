/**
 * Minimal `.env` loader (no dependency) for LOCAL runs.
 *
 * Vercel injects environment variables in production, but local runs of the
 * agent and the dev API server need the Tigris credentials + config from the
 * repo-root `.env`. This tiny parser loads KEY=VALUE pairs into `process.env`
 * WITHOUT overwriting anything already set (real env wins over the file), and
 * is a no-op in environments where the file is absent (e.g. the browser/CI).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** Load KEY=VALUE pairs from a `.env` file into `process.env` (non-destructive). */
export function loadEnvFile(envPath: string): void {
  let text: string;
  try {
    text = fs.readFileSync(envPath, "utf8");
  } catch {
    return; // missing file → no-op
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key !== "" && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

/** Load the repo-root `.env` (resolved relative to this file: `shared/..`). */
export function loadRepoEnv(): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  loadEnvFile(path.resolve(here, "..", ".env"));
}
