/**
 * Local dev API server (NOT used in production — Vercel runs the functions).
 *
 * Serves the same serverless handlers (`/api/resolve`, `/api/scans`,
 * `/api/scan-records`, `/api/report`) behind a tiny `node:http` server on
 * `127.0.0.1:3000`, which is where the Vite dev server proxies `/api/*`
 * (see `web/vite.config.ts` → `VITE_API_PROXY`). This lets the whole app run
 * end-to-end locally against real Tigris.
 *
 * Run with:  npx tsx scripts/dev-api.ts
 */

import * as http from "node:http";

import { loadRepoEnv } from "../shared/env.js";

// Load repo-root .env (Tigris creds, threshold, …) BEFORE importing handlers
// so the lazy Storage_Service picks up the right config.
loadRepoEnv();

const PORT = Number(process.env["DEV_API_PORT"] ?? 3000);
const HOST = "127.0.0.1";

/** Adapter request matching the minimal shape the handlers expect. */
interface AdapterReq {
  method?: string;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
}

/** Adapter response collecting status + JSON for the http layer. */
class AdapterRes {
  statusCode = 200;
  payload: unknown = undefined;
  status(code: number): this {
    this.statusCode = code;
    return this;
  }
  json(payload: unknown): unknown {
    this.payload = payload;
    return payload;
  }
}

type Handler = (req: AdapterReq, res: AdapterRes) => Promise<void> | void;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

async function main(): Promise<void> {
  // Import handlers AFTER env is loaded.
  const resolve = (await import("../api/resolve.js")).default as Handler;
  const scans = (await import("../api/scans.js")).default as Handler;
  const scanRecords = (await import("../api/scan-records.js")).default as Handler;
  const report = (await import("../api/report.js")).default as Handler;

  const routes: Record<string, Handler> = {
    "/api/resolve": resolve,
    "/api/scans": scans,
    "/api/scan-records": scanRecords,
    "/api/report": report,
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      // CORS for direct browser calls (the Vite proxy is same-origin anyway).
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      if ((req.method ?? "GET").toUpperCase() === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
      const handler = routes[url.pathname];
      if (!handler) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `no route for ${url.pathname}` }));
        return;
      }

      const query: Record<string, string> = {};
      url.searchParams.forEach((v, k) => (query[k] = v));

      const rawBody = await readBody(req);
      let body: unknown = undefined;
      if (rawBody) {
        try {
          body = JSON.parse(rawBody);
        } catch {
          body = rawBody;
        }
      }

      const aReq: AdapterReq = { method: req.method, query, body };
      const aRes = new AdapterRes();
      try {
        await handler(aReq, aRes);
      } catch (err) {
        aRes.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
      res.writeHead(aRes.statusCode, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(aRes.payload ?? {}));
    })();
  });

  server.listen(PORT, HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`dev-api listening on http://${HOST}:${PORT} (routes: ${Object.keys(routes).join(", ")})`);
  });
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error("dev-api failed to start:", err);
  process.exitCode = 1;
});
