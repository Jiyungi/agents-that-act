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

## Remaining steps (interactive — operator must do these)

### Step 3: Connect VS Code via Remote-SSH

1. Install the VS Code Remote-SSH extension:
   `code --install-extension ms-vscode-remote.remote-ssh`
2. Generate a token-based SSH target (Daytona Dashboard → Sandboxes → ⋮ →
   "Create SSH Access", or via SDK `create_ssh_access`). Format:
   `ssh <token>@ssh.app.daytona.io`
3. In VS Code: Command Palette → "Remote-SSH: Connect to Host" → paste the
   SSH command. Open folder `/home/daytona`.

   (Quick terminal sanity check first: `daytona ssh packguard-scan`)

### Step 4: Install GitHub Copilot inside the sandbox

- In the Remote-SSH VS Code window, install `GitHub.copilot` +
  `GitHub.copilot-chat` (they install on the REMOTE, i.e. in the sandbox).
- Sign in to GitHub Copilot via the OAuth device-code flow.

### Step 5: Install Opsera MCP server + OAuth login

- Add the Opsera MCP server config inside the sandbox VS Code.
- Complete Opsera OAuth login from within the sandbox.
- Then type `/security-scan` in Copilot Chat pointed at `/home/daytona/scan-target`.

Record SUCCESS/FAILURE + a reason for each (this table is the deliverable).

---

## Cleanup

- Stop:   `daytona stop packguard-scan`
- Delete: `daytona delete packguard-scan`
