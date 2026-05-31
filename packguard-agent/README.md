# packguard-agent/ — local loopback agent (Person A)

A small npm package the operator runs locally (`npx packguard-agent`, entry
`src/index.ts`). It exposes a loopback HTTP API on
`127.0.0.1:${LOCAL_AGENT_PORT}` (default 3939) for the filesystem- and
`code`-CLI-bound steps that a Vercel serverless function cannot perform.

## Security: loopback-only bind

The agent touches the **operator's own disk** (it extracts tarballs into
`./scan-target/` and launches the operator's `code` CLI). It therefore binds to
`127.0.0.1` **only** — `startAgentServer` hard-codes `LOOPBACK_HOST` and offers
no way to bind `0.0.0.0` or any public interface. This is a hard security
requirement: exposing the agent to the network would expose local disk access.

## Routes (Interface 2) and status mapping — task 7.1 (implemented)

| Method | Path             | Status |
|--------|------------------|--------|
| POST   | `/local/fetch`   | implemented (7.1) |
| GET    | `/local/health`  | implemented (7.1) |
| POST   | `/local/upload`  | **reserved for task 7.2** (route table extension point) |

`POST /local/fetch` body `{ packageName, version?, tarballUrl, integrity? }`
wires download → safe-untar → launch VS Code → `Scan_Result_Contract`. The agent
does **not** resolve (the UI supplies `tarballUrl` from `/api/resolve`). On
success it returns `200` with the `ScanResultContract` plus an `uploadId` and
the `/security-scan` `prompt`. On failure it returns
`{ errorType, message, manualCommand? }`.

`FetchErrorType` → HTTP status (see `FETCH_ERROR_STATUS` in `src/server.ts`):

| errorType | status | notes |
|---|---|---|
| `INVALID_PACKAGE_NAME` | 400 | bad operator input (Req 1.7) |
| `PACKAGE_UNRESOLVED`, `VERSION_UNRESOLVED` | 404 | not found |
| `DOWNLOAD_TOO_LARGE`, `RESOURCE_LIMIT_EXCEEDED` | 413 | caps tripped |
| `PATH_TRAVERSAL`, `ABSOLUTE_PATH`, `LINK_TARGET_ESCAPE` | 422 | unsafe tarball content |
| `REGISTRY_UNAVAILABLE`, `DOWNLOAD_FAILED` | 502 | upstream/transient |
| `EXTRACTION_TIMEOUT` | 504 | time budget exceeded |
| `VSCODE_UNAVAILABLE` | 503 | + `manualCommand`; scan-target **retained** (Req 5.3) |
| `VSCODE_LAUNCH_FAILED` | 500 | + `manualCommand`; scan-target **retained** (Req 5.4) |

Transport-level problems use distinct codes: `BAD_REQUEST` (400, malformed/
missing JSON), `NOT_FOUND` (404), `METHOD_NOT_ALLOWED` (405), `PAYLOAD_TOO_LARGE`
(413), `INTERNAL_ERROR` (500).

`GET /local/health` → `{ status: "ok", codeCliAvailable: boolean }` via
`isCodeCliAvailable()`.

## uploadId seam for task 7.2

On any scan whose extraction succeeded (even when VS Code launch fails), the
fetch handler registers the active scan in `AgentServer.activeScans`
(`Map<uploadId, { contract, cleanup, createdAt }>`) and returns the `uploadId`.
Task 7.2's `POST /local/upload` (body `{ uploadId }`, Interface 3) resolves the
`uploadId` to the active `ScanResultContract`, normalizes the report at
`contract.reportPath`, hands it to the `Storage_Service`, and calls the stored
`cleanup` (Req 4.7) only after a confirmed upload. The fetch handler never calls
`cleanup`, so the populated `./scan-target/` survives the manual-scan pause.
Add the route at the marked extension point in the `routes` table in
`src/server.ts`.

## Building blocks

- `POST /local/fetch` — `fetchAndExtract` (download → safe-untar) → `launchEditor`
- `GET  /local/health` — `isCodeCliAvailable`
- `POST /local/upload` — tasks 7.2 (read report, normalize, hand off to Storage_Service)

Bound to localhost only. See `design.md` → "Interface 2", "Error Handling",
"Deployment Model".
