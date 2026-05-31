# PackGuard

**Check whether an npm package is safe — before you install it.**

PackGuard lets a developer type a package name into a web app, then fetches that
package's source straight from the npm registry, **safely unpacks it without ever
installing or running it**, scans it for security issues, and returns a SAFE / RISKY
verdict with a risk score, the actual risky code lines, and a public shareable
report. Every scanned package is saved to a browsable gallery.

The core safety guarantee is **"inspect without installing"**: PackGuard only
downloads the `.tgz` tarball and *reads* its contents. It never runs `npm install`,
never executes lifecycle scripts, and never imports, requires, or evaluates any
fetched file. Reading code is safe; running it is not.

Built for the "Agents That Act" hackathon — an agent that takes a real action
(fetch → scan → store → publish) end to end, with a human only in the loop for the
one step that genuinely needs a human.

---

## How it works

```
       enter package name
              │
   ┌──────────▼───────────┐   resolve name + version
   │  Vercel serverless    │──────────────► npm registry
   │  /api/resolve         │
   └──────────┬───────────┘
              │  tarballUrl
   ┌──────────▼───────────────┐   download .tgz, safe-untar into ./scan-target/,
   │  Local agent             │   open VS Code on the folder. No code is executed.
   │  127.0.0.1:3939          │
   └──────────┬───────────────┘
              │  ⏸  MANUAL: operator runs the security scan in the editor
   ┌──────────▼───────────────┐   normalize report → SAFE/RISKY verdict,
   │  Upload trigger          │   store report + source snapshot, persist record
   │  (local agent)           │──────────────► Tigris (object storage)
   └──────────┬───────────────┘
              │
   ┌──────────▼───────────┐   verdict card + public link + gallery
   │  Frontend (Vercel)    │
   └──────────────────────┘
```

The architecture splits into **automated-before**, a short **manual scan step**, and
**automated-after**, bridged by a single JSON contract that survives the human pause.
A thin serverless layer (npm resolution, storage reads, gallery) runs on Vercel; a
small loopback agent handles the filesystem-bound work (download, safe extraction,
editor launch, upload) because serverless functions have no persistent disk and can't
open the operator's editor.

---

## Tools and how they're applied

PackGuard is built around three tools — **Opsera**, **Tigris**, and **Daytona** —
each doing a job that's core to the product, not bolted on.

### Opsera — the security-scan engine behind every verdict

**Where it's used:** the manual scan step, configured in `.vscode/mcp.json` and
`.kiro/settings/mcp.json` (server `opsera` → `https://agent.opsera.ai/mcp`); consumed
by the normalizer in `packguard-agent/src/upload.ts` and the honest-framing copy in
`shared/framing.ts`.

**How it's used:** Opsera is an AI-powered DevSecOps platform exposed to the editor
over the **Model Context Protocol (MCP)**. Once the local agent extracts a package into
`./scan-target/` and opens it in VS Code, the operator runs **`/security-scan`** in
GitHub Copilot Chat, which invokes Opsera's DevSecOps Security Scan Agent
(`mcp_opsera_security-scan`). Opsera runs **static analysis (Semgrep + Gitleaks)** over
the untrusted source and writes a report. PackGuard then:

- **normalizes** Opsera's raw output into a fixed `Report_Schema` (each finding carries
  category, file path, line number, severity, and the offending code snippet),
- **derives a SAFE / RISKY verdict** by comparing Opsera's risk score against the
  `RISK_THRESHOLD` (default 50), and
- **applies fail-safe defaults** so anything Opsera omits reads pessimistically
  (missing verdict → RISKY, missing score → 100) — the scan can never accidentally make
  a package look safer than it is.

**Why it's necessary:** Opsera *is* the analysis engine — without it there is no verdict,
no risk score, and no findings; PackGuard would just be a downloader. It also runs
**directly in the IDE through MCP** (Opsera has no public API/CLI), which is exactly why
the architecture has a deliberate human-in-the-loop step instead of a fully programmatic
call. PackGuard attributes results to Opsera and frames them honestly as automated
**static** security review, not behavioral malware detection.

### Tigris — durable, shareable, S3-compatible storage

**Where it's used:** the `Storage_Service` and the upload trigger
(`packguard-agent/src/upload.ts`), configured via the `TIGRIS_*`/`AWS_*` variables in
`.env.example` (endpoint `https://t3.storage.dev`, bucket `packguard`).

**How it's used:** Tigris is a globally distributed, **S3-compatible** object store, so
PackGuard talks to it with the standard AWS S3 SDK — the config loader deliberately reads
the `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_ENDPOINT_URL_S3` variables the
SDK already understands. On each upload it writes three objects under name+version keys:

- `reports/{name}/{version}/report.json` — the normalized report, served by a Tigris
  **public URL** so anyone can view a verdict without authenticating,
- `sources/{name}/{version}/source.tgz` — a snapshot of the exact scanned source,
- `records/{name}/{version}.json` — the scan record (verdict, score, timestamp, links)
  that backs the gallery.

Uploads use bounded retries (max 3 attempts), and the public URL is minted on upload.

**Why it's necessary:** Vercel serverless functions have no persistent disk, so scan
results need a durable home that lives outside the request lifecycle. Tigris provides
that, plus the two things the product depends on: **public, no-auth report URLs** (the
shareable link on every verdict card) and a **listable record set** (the gallery that
turns one-off scans into a permanent, browsable library of vetted packages). Its
S3 compatibility means zero custom storage client — the standard SDK just works.

### Daytona — isolated sandbox execution (feasibility spike)

**Where it's used:** the Person C deliverable in `daytona-experiment/`
(`FEASIBILITY.md`, `fetch-demo.sh`, sample reports).

**How it's used:** Daytona spins up secure, instantly-created, isolated environments for
running untrusted code. The experiment used the Daytona CLI to create a sandbox, connect
VS Code over **Remote-SSH**, install GitHub Copilot Chat and the **Opsera MCP server**
inside it, complete Opsera OAuth remotely, and then fetch + untar an npm package
(`left-pad`) entirely within the sandbox — with **no `npm install` and no code
executed**. All five timed steps completed; the conclusion is a documented **YES**.

**Why it's necessary:** PackGuard's whole premise is "inspect without installing," but
today the fetch + extract still happen on the operator's local machine. Daytona answers
the key hardening question — *can untrusted package code be kept off a real machine
entirely?* — and proves a concrete path to running the full fetch → scan pipeline in
throwaway isolation, so a malicious tarball never touches a real dev box. See
`daytona-experiment/FEASIBILITY.md` for the step-by-step evidence and the local→Daytona
fetch-swap plan.

---

## Repository layout

| Path | What's inside |
|---|---|
| `api/` | Vercel serverless functions — npm resolution, gallery list, record persistence |
| `packguard-agent/` | Local loopback agent — download, safe-untar extractor, editor launcher, upload trigger |
| `shared/` | Shared TypeScript contracts (scan/report/error types), config loader, package-name validation, test fakes |
| `web/` | Vite + React frontend — search, verdict card, gallery, honest-framing copy |
| `daytona-experiment/` | Isolated-sandbox feasibility deliverable + sample scan reports |

---

## Getting started

```bash
# install dependencies
npm install

# typecheck + run the full test suite
npm run typecheck
npm test

# run the web app (frontend) in dev
npm run web:install
npm run dev
```

Copy `.env.example` to `.env` and fill in the values (storage credentials, risk
threshold, agent port, npm registry base). `.env` is gitignored — never commit real
credentials.

---

## Safety properties

PackGuard's risky surfaces are pure logic and are covered by property-based tests:
safe-tar containment (no path traversal, no absolute paths, no link escapes), resource
caps (100 MB download, 250 MB uncompressed, 10k entries), report normalization and
round-tripping, pessimistic fail-safe defaults, deterministic verdict derivation, and
storage key construction. The full suite runs with `npm test`.
