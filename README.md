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
   │  (local agent)           │──────────────► object storage
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

PackGuard is built around three external tools, each doing a job that's core to the
product rather than bolted on.

### Security scanning (DevSecOps agent, via MCP)

This is the engine of the verdict. After the source is safely extracted and opened in
the editor, the operator triggers a **DevSecOps security-scan agent** (exposed to the
editor through the Model Context Protocol) that runs static analysis — Semgrep + Gitleaks
— across the untrusted package source. PackGuard takes that raw output and:

- **normalizes** it into a fixed report schema (findings with category, file, line,
  severity, and the offending code snippet),
- **derives a SAFE / RISKY verdict** from the risk score against a configurable
  threshold, and
- **applies fail-safe defaults** so missing data always reads pessimistically (a
  missing verdict becomes RISKY, a missing score becomes 100) — the scan can never
  accidentally make a package look safer than it is.

The scan is a deliberate human action (the agent has no public API/CLI), so PackGuard
automates everything *around* it and frames the result honestly as automated **static**
security review, not behavioral malware detection.

### Object storage (S3-compatible)

Every scan result is durable and shareable because of **globally distributed,
S3-compatible object storage**. The upload trigger writes three objects per scan under
name+version keys:

- `reports/{name}/{version}/report.json` — the normalized report, served by a
  **public URL** so anyone can view a verdict without logging in,
- `sources/{name}/{version}/source.tgz` — a snapshot of the exact scanned source,
- `records/{name}/{version}.json` — the scan record (verdict, score, timestamp,
  links) that backs the gallery.

Uploads use bounded retries, and the public URL is minted on upload. This storage is
what turns a one-off scan into a permanent, linkable, browsable library of vetted
packages.

### Isolated sandbox execution (feasibility spike)

The biggest hardening question for PackGuard is: *can we keep untrusted package code
off a real machine entirely?* A parallel experiment validated running the fetch **and**
the security scan inside an **isolated, instantly-created sandbox** instead of locally.
The result was a documented **YES** — sandbox spin-up, VS Code Remote-SSH, the editor
chat agent, the security-scan MCP server, and remote OAuth all completed inside the
sandbox, with npm source fetched and extracted there and never touching the local
machine. This proves a clear path to running the whole pipeline in throwaway isolation
(see `daytona-experiment/FEASIBILITY.md` for the step-by-step evidence and the
local→sandbox swap plan).

---

## Repository layout

| Path | What's inside |
|---|---|
| `api/` | Vercel serverless functions — npm resolution, gallery list, record persistence |
| `packguard-agent/` | Local loopback agent — download, safe-untar extractor, editor launcher, upload trigger |
| `shared/` | Shared TypeScript contracts (scan/report/error types), config loader, package-name validation, test fakes |
| `web/` | Vite + React frontend — search, verdict card, gallery, honest-framing copy |
| `daytona-experiment/` | Isolated-sandbox feasibility deliverable + sample scan reports |
| `pitch/` | Project pitch page |

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
