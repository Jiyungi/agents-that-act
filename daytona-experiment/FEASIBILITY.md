# PackGuard — Daytona Sandbox Feasibility (Person C)

**Goal:** Determine whether the npm fetch + Opsera security scan can run INSIDE an
isolated Daytona sandbox instead of on a local machine, so untrusted package code
never touches a real dev machine.

**Conclusion:** ✅ **YES — feasible.** All five steps completed inside a Daytona sandbox:
sandbox spin-up, VS Code Remote-SSH, Copilot Chat in the sandbox, Opsera MCP server
installed + started, and Opsera OAuth completed remotely (confirmed by `mcp_opsera_security-scan`
and other Opsera tools appearing in Copilot's "View my Tools"). Untrusted npm source is
fetched + extracted in the sandbox and never touches the local machine.

Last updated: 2026-05-31

---

## Environment

- Host OS: Windows
- Daytona CLI: v0.183.0 (installed via `irm https://get.daytona.io/windows | iex`)
- Auth: `daytona login --api-key <DAYTONA_API_KEY from .env>` → success
- Sandbox: `packguard-scan` (id `8be9056e-8a9a-4eaa-8132-91f056081f96`), region `us`, snapshot `daytonaio/sandbox:0.8.0`
- Sandbox toolchain (preinstalled): Linux, user `daytona`, Node v25.9.0
- Note: recreated on a new Daytona account after the first account's browser OAuth (`daytona login`) returned `access_denied`.

---

## Step results (Reqs 15.1–15.5)

| # | Step | Timeout | Outcome | Evidence |
|---|------|---------|---------|----------|
| 1 | SANDBOX_SPINUP | 120s | ✅ SUCCESS | `daytona create` → "created successfully", `daytona list` shows STARTED |
| 2 | REMOTE access (exec) | 60s | ✅ SUCCESS | `daytona exec packguard-scan` runs commands in the box |
| 2b| FETCH+UNTAR in sandbox | — | ✅ SUCCESS | `left-pad` tarball downloaded via npm registry API + untarred; no `npm install`, no code executed. Files extracted under `package/` subdir. |
| 3 | REMOTE_SSH (VS Code) | 60s | ✅ SUCCESS | VS Code Remote-SSH connected to `ssh.app.daytona.io`; green badge shown, `scan-target/package` folder loaded, remote terminal live. Note: on the FIRST Daytona account, browser `daytona login` returned `access_denied` and `daytona ssh` reported "no profiles found"; resolved by using a SECOND account. The token is stored in the `User` field of `~/.ssh/config` and is short-lived — regenerate via dashboard (Create SSH Access) if the session times out. |
| 4 | INSTALL_COPILOT in sandbox | 300s | ✅ SUCCESS | GitHub Copilot Chat (now the merged all-in-one extension; standalone "GitHub Copilot" is deprecated) enabled on `SSH: ssh.app.daytona.io`; replied to a test chat message inside the sandbox. |
| 5 | INSTALL_OPSERA_MCP + OAUTH | 300s/120s | ✅ SUCCESS | `.vscode/mcp.json` created in the WORKSPACE folder (`/home/daytona/scan-target/.vscode/`, not `/home/daytona`). Server started via the CodeLens "Start". Opsera OAuth completed remotely. Confirmed: `mcp_opsera_security-scan`, `mcp_opsera_architecture-analyze`, `mcp_opsera_compliance-audit`, `mcp_opsera_dora-metrics`, `mcp_opsera_sql-security` appear in Copilot "View my Tools". |

### Evidence: fetch-without-install inside the sandbox

Command run via `daytona exec packguard-scan`:

```
cd /tmp && rm -rf st && mkdir st \
  && U=$(npm view left-pad dist.tarball) \
  && curl -sL "$U" -o p.tgz \
  && tar -xzf p.tgz -C st \
  && find st -type f
```

Output (the actual package source, never installed/run):

```
st/package/package.json
st/package/.travis.yml
st/package/COPYING
st/package/index.d.ts
st/package/index.js
st/package/README.md
st/package/test.js
st/package/perf/es6Repeat.js
st/package/perf/O(n).js
st/package/perf/perf.js
```

This proves the core PackGuard safety property ("inspect without installing")
works inside an isolated Daytona sandbox.

### Evidence: full Opsera security scan inside the sandbox

After Opsera was started, `mcp_opsera_security-scan` ran on the `package/` folder.
The Opsera agent **installed the scanner tools in the sandbox** (gitleaks, semgrep,
grype, checkov, hadolint) and executed them as terminal commands there — i.e. the
SCAN compute runs in the sandbox, not on a remote Opsera server and not on the laptop.

Result for `left-pad` (reports in `/home/daytona/scan-target/`):

| Scanner | Category | Findings |
|---------|----------|----------|
| gitleaks | secrets | 0 (`[]`) |
| semgrep | SAST / dangerous code | 0 (`results:[]`, `errors:[]`, 12 files scanned) |
| checkov | IaC | 0 (no infra files; resource_count 0) |
| hadolint | Dockerfile | 0 (no Dockerfile) |
| grype | dependency CVEs | report produced (~5 KB) |

**Verdict: 🟢 SAFE — zero findings.** Correct expected outcome for `left-pad`, a small
well-known clean package. Confirms fetch + extract + scan all execute end-to-end
inside the sandbox.

**Operational finding:** the base Daytona sandbox image does NOT ship the scanner
tools; Opsera installed them on first run (and the install + concurrent scan briefly
spiked sandbox load >30, which dropped the VS Code Remote-SSH session — it auto-recovered).
A production PackGuard sandbox snapshot should PRE-INSTALL gitleaks/semgrep/grype/checkov/hadolint
to avoid the install delay and load spike.

---

## Reproduction guide (Req 14.2 — verified end-to-end)

These are the exact steps that produced the YES result above. Prerequisites:
a Daytona account + API key, VS Code with the Remote-SSH extension, and a
GitHub account with Copilot access.

1. **Install the Daytona CLI** (Windows):
   `powershell -Command "irm https://get.daytona.io/windows | iex"`
   (open a new terminal afterward so PATH refreshes).
2. **Authenticate:** `daytona login` (browser OAuth — writes the CLI profile that
   `daytona ssh` needs). The `--api-key` flow alone authenticates list/create/exec
   but does NOT write the ssh profile.
3. **Create the sandbox:** `daytona create --name packguard-scan --target us`.
4. **Create an SSH access token:** Daytona Dashboard → Sandboxes → `packguard-scan`
   → ⋮ → "Create SSH Access" → set expiry high (e.g. 600 min). Target is
   `ssh <token>@ssh.app.daytona.io`.
5. **Connect VS Code:** Command Palette → "Remote-SSH: Connect to Host" →
   "Add New SSH Host" → paste the SSH command → connect (Linux) → open the
   workspace folder used for the scan.
6. **Enable Copilot Chat on the remote:** in the Remote-SSH window, install
   "GitHub Copilot Chat" (the merged extension) into the sandbox and sign in to GitHub.
7. **Add Opsera MCP** in the WORKSPACE folder — `<workspace>/.vscode/mcp.json`:
   ```json
   { "servers": { "opsera": { "type": "http", "url": "https://agent.opsera.ai/mcp" } } }
   ```
   Reload window → click the "Start" CodeLens above the JSON → complete Opsera
   browser OAuth. Verify with "View my Tools" in Copilot Chat (Agent mode) —
   `mcp_opsera_security-scan` should appear.
8. **Fetch a package safely (no install):**
   ```bash
   cd /home/daytona/scan-target && rm -rf package && \
     U=$(npm view <pkg> dist.tarball) && curl -sL "$U" -o /tmp/p.tgz && \
     tar -xzf /tmp/p.tgz -C .
   ```
9. **Run the scan:** in Copilot Chat (Agent mode) ask "Run a security scan on the
   package folder". On a fresh sandbox, approve the one-time scanner-tool install.
   Reports land in the scan folder (`*-report.json`).

---

## Swapping the LOCAL fetch step for a Daytona-sandboxed fetch (Req 14.3)

Person A's local design extracts untrusted source into a local `./scan-target/`.
To harden it, move the fetch+extract (and the scan) into the sandbox. The
`Scan_Result_Contract` (`{ packageName, version, sourcePath, reportPath }`) stays
the same — only `sourcePath`/`reportPath` now refer to **paths inside the sandbox**.

**Local design (today):**
```
Backend → download .tgz → safe-untar → ./scan-target/  (untrusted code on host)
        → code ./scan-target/ → operator runs Opsera scan locally
```

**Daytona-sandboxed design (hardened):**
```
Backend → daytona create (or reuse) sandbox
        → daytona exec: download .tgz + safe-untar → /home/daytona/scan-target/package
          (untrusted code NEVER on host)
        → operator connects VS Code Remote-SSH to the sandbox
        → operator runs Opsera scan IN the sandbox
        → reports pulled from sandbox → handed to Person B's upload trigger
```

**Concrete substitutions for Person A:**
- Replace the local download/untar call with `daytona exec <sandbox> -- <fetch script>`.
  The same safe-tar rules (Req 4: path traversal, absolute paths, symlink escape,
  resource limits) still apply — run the safe extractor inside the sandbox, not the host.
- Replace `code ./scan-target/` (Req 5) with connecting VS Code Remote-SSH to the
  sandbox (Dashboard token → `ssh <token>@ssh.app.daytona.io`).
- `reportPath` in the contract becomes a sandbox path (e.g.
  `/home/daytona/scan-target/<scanner>-report.json`). The upload trigger reads the
  report from the sandbox (`daytona exec ... cat <reportPath>`) before passing it to
  Person B's `Storage_Service`. Person B's interface is unchanged.

**Pre-bake the sandbox image (operational requirement found during the experiment):**
the base image lacks the scanners, so build a Daytona snapshot that pre-installs
`gitleaks`, `semgrep`, `grype`, `checkov`, `hadolint`. This removes the first-run
install delay and the load spike that dropped the Remote-SSH session.

---

## Known limitations / gotchas (observed)

- **Browser `daytona login` can return `access_denied`** on some accounts; a second
  account worked. `daytona ssh` requires the profile written by `daytona login` (not
  by `--api-key`).
- **SSH tokens are short-lived** and stored in the `User` field of `~/.ssh/config`;
  set a long expiry and regenerate from the dashboard when sessions drop.
- **Opsera MCP config must live in the workspace folder** (`<workspace>/.vscode/mcp.json`),
  not the home dir — VS Code resolves MCP relative to the open workspace.
- **`daytona exec` over the Windows shell drops/garbles output** with complex quoting
  and globbing (the remote default shell is zsh). Prefer simple, single-quoted
  commands or base64-encoded scripts; read small report files with a plain `cat`
  and an absolute path.
- **Scanner install + scan spikes sandbox CPU** (load >30), which can drop Remote-SSH;
  it auto-recovers. Pre-baking the image avoids this.

---

## Cleanup

The sandbox is a disposable cloud resource — stop or delete it when done to free resources:

- Stop (keeps it, can restart): `daytona stop packguard-scan`
- Delete (removes it entirely):  `daytona delete packguard-scan`

Note: deleting also discards the in-sandbox reports. Pull any reports you want to keep
into the repo first (`daytona exec packguard-scan -- cat <reportPath>`).
