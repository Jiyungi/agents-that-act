/**
 * packguard-agent entry point (Person A, task 7.1).
 *
 * Starts the Local_Fetcher_Agent loopback server bound to 127.0.0.1 ONLY (see
 * {@link startAgentServer} / {@link LOOPBACK_HOST}). The operator runs this
 * locally (e.g. `npx packguard-agent`) so the Vercel-hosted UI can reach the
 * filesystem- and `code`-CLI-bound steps via `fetch('http://127.0.0.1:3939/…')`.
 *
 * Kept intentionally minimal: it only wires defaults from config and prints
 * where it is listening. All behavior lives in {@link createAgentServer}.
 */

import { LOOPBACK_HOST, startAgentServer } from "./server.js";
import { resolveEditorCommand } from "./editor-launcher.js";
import { loadRepoEnv } from "@shared/env";

async function main(): Promise<void> {
  // Load repo-root .env so the Tigris-backed Storage_Service has credentials
  // when the agent runs locally (Vercel injects these in the cloud instead).
  loadRepoEnv();
  const agent = await startAgentServer();
  const editor = resolveEditorCommand();
  // eslint-disable-next-line no-console
  console.log(
    `packguard-agent listening on http://${LOOPBACK_HOST}:${agent.port} ` +
      `(loopback only — never exposed to the network)\n` +
      `  editor launch command: ${editor}` +
      (editor === "code"
        ? ""
        : `  (set EDITOR_COMMAND to override)`),
  );
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error("packguard-agent failed to start:", err);
  process.exitCode = 1;
});
