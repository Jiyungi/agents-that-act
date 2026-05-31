# Requirements Document

## Introduction

PackGuard is a web application that lets a developer check whether an npm package is safe **before** installing it. A user enters a package name on a Vercel-hosted UI; the package source is fetched directly from the npm registry, safely unpacked, and scanned for security issues using Opsera's DevSecOps Security Scan Agent (static analysis via Semgrep + Gitleaks). The resulting verdict and report are stored in Tigris object storage and shown with a public shareable link. Over time, the collection of scanned packages becomes a public, browsable library (gallery) of vetted packages.

The core safety property is **"inspect without installing"**: PackGuard NEVER runs `npm install` and NEVER executes or imports fetched package code. It only downloads the `.tgz` tarball via the npm registry API and reads its contents. Reading code is safe; running it is not.

Because Opsera has no API and no CLI, the security scan itself is **manual**: a human operator who is logged into Opsera types `/security-scan` into GitHub Copilot Chat inside VS Code. PackGuard automates everything *around* the scan — fetch, safe-untar, auto-opening VS Code on the target folder, and uploading the produced report to Tigris — but the scan trigger is a human action.

This is positioned honestly as **automated security review / risk scoring before install**, based on static analysis. It is not behavioral malware detection. For the hackathon, this is an operator-driven demo (the operator is logged into Opsera), not yet a fully self-serve product for arbitrary end users.

### Workstream Organization

Requirements are tagged to map cleanly onto three parallel workstreams with clear interfaces:

- **[Person A] Fetcher + Backend** (Node / Vercel): npm registry fetch, safe-untar, VS Code launch, scan-result JSON contract, upload trigger.
- **[Person B] Storage + Frontend** (Tigris + UI): Tigris upload/list/public-URL, report JSON schema, search/verdict/gallery UI.
- **[Person C] Daytona Experiment** (independent, non-blocking): feasibility investigation for running fetch + Opsera scan inside an isolated Daytona sandbox.

A shared data contract (Requirement 12) defines the interface between Person A and Person B.

## Glossary

- **PackGuard**: The overall web application described in this document.
- **Fetcher_Service**: The Person A backend component that resolves a package, downloads its tarball, and performs safe extraction. (Node / Vercel)
- **Extractor**: The subcomponent of the Fetcher_Service that unpacks `.tgz` tarballs into the scan target directory using path-traversal-safe extraction.
- **Editor_Launcher**: The subcomponent of the Fetcher_Service that opens VS Code on the scan target directory.
- **Backend_API**: The Person A serverless HTTP interface exposed by PackGuard on Vercel.
- **Storage_Service**: The Person B component that uploads files to Tigris, lists stored scans, and produces public URLs. (Tigris)
- **Frontend_UI**: The Person B browser-based user interface (search box, Scan button, verdict card, gallery).
- **npm_Registry**: The public npm registry API used to resolve package metadata and download tarballs.
- **Opsera_Agent**: Opsera's DevSecOps Security Scan Agent, triggered manually by a human typing `/security-scan` in GitHub Copilot Chat inside VS Code.
- **Operator**: The human, logged into Opsera, who triggers the manual scan inside VS Code.
- **Scan_Target_Directory**: The isolated `./scan-target/` directory into which package source is extracted. Never executed.
- **Scan_Report**: The output produced by the Opsera_Agent (HTML, Markdown, or JSON) containing findings, file/line references, and a risk score.
- **Scan_Result_Contract**: The JSON object produced by the Fetcher_Service: `{ packageName, version, sourcePath, reportPath }`.
- **Report_Schema**: The agreed JSON schema describing the normalized scan report shared between Person A and Person B.
- **Verdict**: The top-level classification of a scanned package, one of `SAFE` or `RISKY`.
- **Finding**: A single security issue in a Scan_Report, including category, file path, line number, and severity.
- **Risk_Score**: A numeric value summarizing the overall risk of a scanned package.
- **Gallery**: The public list of previously scanned packages, read from the Storage_Service.
- **Public_Report_URL**: A publicly accessible Tigris URL for a stored Scan_Report.
- **Source_Snapshot**: The archived copy of the fetched package source stored in Tigris alongside the report.
- **Daytona_Sandbox**: An isolated Daytona environment investigated in the Person C experiment for running fetch + scan off the local machine.
- **Scan_Record**: A persisted entry combining package identity, verdict, risk score, report location, and timestamp.

## Requirements

---

## Workstream A — Fetcher + Backend (Node / Vercel)

### Requirement 1: Package Resolution via npm Registry

**User Story:** As a developer, I want PackGuard to resolve the npm package I name, so that the correct package and version are scanned.

#### Acceptance Criteria

1. WHEN a user submits a package name, THE Fetcher_Service SHALL query the npm_Registry to resolve the package metadata before returning any resolution result or error.
2. WHERE a user submits a package name without a version, THE Fetcher_Service SHALL resolve the version that the npm_Registry designates as the latest published release.
3. WHERE a user submits a package name with an explicit version, THE Fetcher_Service SHALL resolve that specific version.
4. IF the npm_Registry query reports that the named package does not exist, THEN THE Fetcher_Service SHALL return an error response that identifies the package name as unresolved and SHALL NOT initiate a scan.
5. IF the npm_Registry reports that the requested version does not exist for the named package, THEN THE Fetcher_Service SHALL return an error response that identifies the version as unresolved and SHALL NOT initiate a scan.
6. THE Fetcher_Service SHALL support scoped package names of the form `@scope/name`.
7. IF a submitted package name is empty, exceeds 214 characters, or contains characters not permitted by npm package naming constraints, THEN THE Fetcher_Service SHALL return an error response that identifies the package name as invalid before querying the npm_Registry.
8. IF the npm_Registry fails to return a response to a resolution query due to a network error or does not respond within 10 seconds, THEN THE Fetcher_Service SHALL return an error response that identifies the package as unresolved due to npm_Registry unavailability and SHALL NOT return partial resolution results.

### Requirement 2: Tarball Download

**User Story:** As a developer, I want PackGuard to download the package tarball, so that its source can be inspected without installing it.

#### Acceptance Criteria

1. WHEN package metadata is resolved, THE Fetcher_Service SHALL download the `.tgz` tarball from the tarball URL provided by the npm_Registry metadata, and SHALL complete the download within 30 seconds.
2. WHEN the tarball download completes successfully, THE Fetcher_Service SHALL return a successful download result that references the downloaded tarball content.
3. IF the tarball download fails because the connection to the npm_Registry is refused or interrupted, the npm_Registry returns a non-success response, or the download does not complete within 30 seconds, THEN THE Fetcher_Service SHALL return an error response that identifies the download failure and SHALL discard any partially downloaded data.
4. IF the size of the downloaded tarball exceeds 100 MB, THEN THE Fetcher_Service SHALL abort the download and return an error response that identifies the size-limit violation.
5. THE Fetcher_Service SHALL download the tarball without executing any code contained in the tarball.

### Requirement 3: Inspect-Without-Installing Safety (Core Constraint)

**User Story:** As a security-conscious developer, I want PackGuard to never run untrusted package code, so that inspecting a package cannot compromise the host.

#### Acceptance Criteria

1. THE Fetcher_Service SHALL obtain package source only by downloading and extracting the tarball from the npm_Registry into a designated isolated extraction directory.
2. WHEN processing any package, THE Fetcher_Service SHALL complete fetch and extraction without invoking `npm install`, `npm ci`, `yarn`, `pnpm`, or any package-manager install command.
3. WHEN processing any package, THE Fetcher_Service SHALL complete fetch and extraction without executing, importing, requiring, or evaluating any file contained in the package.
4. WHEN processing any package, THE Fetcher_Service SHALL ignore and refrain from executing lifecycle scripts declared in the package (including `preinstall`, `install`, and `postinstall`).
5. THE Fetcher_Service SHALL treat all extracted package content as untrusted data that is read but never run.
6. IF a tarball entry resolves to a path outside the designated isolated extraction directory, THEN THE Fetcher_Service SHALL refuse that entry and abort processing of the package without writing the entry outside the extraction directory.
7. IF the download or extraction of a package fails or does not complete within 30 seconds, THEN THE Fetcher_Service SHALL return an error response identifying the failure and SHALL NOT execute any content of the package.
8. IF a tarball's cumulative uncompressed size exceeds 250 MB or its entry count exceeds 10,000 entries, THEN THE Fetcher_Service SHALL abort extraction and return an error response identifying the resource-limit violation.

### Requirement 4: Safe Tar Extraction (Path-Traversal Protection)

**User Story:** As a developer, I want tar extraction to be safe, so that a malicious tarball cannot write files outside the scan target directory.

#### Acceptance Criteria

1. WHEN extracting a tarball, THE Extractor SHALL write each extracted entry only to a location whose fully resolved canonical path is equal to or a descendant of the canonical path of the Scan_Target_Directory.
2. IF a tarball entry resolves to a path that is not equal to or a descendant of the Scan_Target_Directory, THEN THE Extractor SHALL abort extraction of the current tarball, remove all files and directories already extracted from that tarball so that zero entries from it remain, and report an error identifying a path-traversal violation.
3. IF a tarball entry specifies an absolute path, THEN THE Extractor SHALL abort extraction of the current tarball, remove all files and directories already extracted from that tarball so that zero entries from it remain, and report an error identifying an absolute-path violation as a violation type distinct from a path-traversal violation.
4. IF a tarball entry is a symbolic link or hard link whose fully resolved target path is not equal to or a descendant of the Scan_Target_Directory, THEN THE Extractor SHALL abort extraction of the current tarball, remove all files and directories already extracted from that tarball so that zero entries from it remain, and report an error identifying a link-target-escape violation as a violation type distinct from both a path-traversal violation and an absolute-path violation.
5. IF writing a tarball entry would require traversing an intermediate path component that is a symbolic link resolving to a location outside the Scan_Target_Directory, THEN THE Extractor SHALL abort extraction of the current tarball, remove all files and directories already extracted from that tarball so that zero entries from it remain, and report an error identifying a link-target-escape violation.
6. WHEN beginning extraction for a package, THE Extractor SHALL extract into a Scan_Target_Directory that exists and contains zero entries (no files or directories) carried over from any previously scanned package.
7. WHEN extraction for a package completes, whether it succeeds or is aborted due to a violation, THE Extractor SHALL remove the Scan_Target_Directory and all of its contents so that no extracted content from that package persists after the scan.

### Requirement 5: VS Code Launch on Scan Target

**User Story:** As an operator, I want VS Code to open automatically on the extracted package, so that I can immediately run the Opsera scan.

#### Acceptance Criteria

1. WHEN extraction completes successfully, THE Editor_Launcher SHALL launch VS Code on the Scan_Target_Directory using the `code ./scan-target/` command within 10 seconds.
2. WHEN VS Code is launched on the Scan_Target_Directory, THE Backend_API SHALL display a text prompt that instructs the Operator to run `/security-scan` in GitHub Copilot Chat.
3. IF the `code` command is not available on the host, THEN THE Editor_Launcher SHALL return an error response that identifies VS Code launch as unavailable, regardless of whether extraction succeeded, SHALL state the manual command to open the Scan_Target_Directory, and SHALL retain the extracted Scan_Target_Directory.
4. IF the `code` command is available but the VS Code launch fails or does not complete within 10 seconds, THEN THE Editor_Launcher SHALL return an error response that identifies the launch failure, SHALL state the manual command to open the Scan_Target_Directory, and SHALL retain the extracted Scan_Target_Directory.

### Requirement 6: Scan Result Contract and Upload Trigger

**User Story:** As Person B, I want a clear contract describing where the report lands and a way to trigger its upload, so that the storage and UI layers can integrate with the backend.

#### Acceptance Criteria

1. WHEN extraction completes successfully, THE Backend_API SHALL produce a Scan_Result_Contract containing non-empty values for `packageName`, `version`, `sourcePath`, and `reportPath`.
2. THE Backend_API SHALL set `reportPath` in the Scan_Result_Contract to the file location where the Operator's Scan_Report is expected to be written.
3. WHEN the upload trigger is invoked and a Scan_Report exists at `reportPath`, THE Backend_API SHALL pass the Scan_Report located at `reportPath` and the Source_Snapshot to the Storage_Service.
4. WHEN the Storage_Service confirms that the Scan_Report and Source_Snapshot have been stored, THE Backend_API SHALL return a success response to the Frontend_UI.
5. IF the upload trigger is invoked while no Scan_Report exists at `reportPath`, THEN THE Backend_API SHALL return an error response that identifies the report as missing and SHALL NOT invoke the Storage_Service.
6. IF the Storage_Service does not confirm storage within 30 seconds or reports a failure, THEN THE Backend_API SHALL return an error response that identifies the upload failure and SHALL retain the Scan_Report at `reportPath`.
7. THE Backend_API SHALL expose the upload trigger as a callable interface that the Frontend_UI can invoke.

---

## Workstream B — Storage + Frontend (Tigris + UI)

### Requirement 7: Report and Source Upload to Tigris

**User Story:** As a developer, I want each scan report and source snapshot stored in Tigris, so that results are durable and shareable.

#### Acceptance Criteria

1. WHEN the upload trigger provides a Scan_Report, THE Storage_Service SHALL upload the Scan_Report to Tigris within 30 seconds.
2. WHEN the upload trigger provides a Source_Snapshot, THE Storage_Service SHALL upload the Source_Snapshot to Tigris within 30 seconds.
3. WHEN a Scan_Report is uploaded, THE Storage_Service SHALL store it under a key that includes the package name and version.
4. WHEN a Source_Snapshot is uploaded, THE Storage_Service SHALL store it under a key that includes the package name and version.
5. WHEN the Scan_Report and Source_Snapshot for a package and version are both uploaded successfully, THE Storage_Service SHALL persist a Scan_Record containing the package name, version, Verdict, Risk_Score, Public_Report_URL that resolves to the uploaded Scan_Report, and a UTC timestamp.
6. IF the upload trigger provides a missing or empty package name or version, THEN THE Storage_Service SHALL reject the upload with an error indicating the invalid identifier and SHALL NOT persist a Scan_Record.
7. IF an upload to Tigris does not succeed after a maximum of 3 attempts, THEN THE Storage_Service SHALL return an error response that identifies the upload failure and SHALL NOT persist a Scan_Record.

### Requirement 8: Public Shareable Report URLs

**User Story:** As a developer, I want a public shareable link to a report, so that I can share the verdict with others.

#### Acceptance Criteria

1. WHEN a Scan_Report is uploaded to Tigris, THE Storage_Service SHALL attempt to produce a Public_Report_URL for that Scan_Report within 10 seconds of upload completion.
2. IF Public_Report_URL generation does not succeed after a maximum of 3 attempts, THEN THE Storage_Service SHALL retain the uploaded Scan_Report in Tigris and SHALL create the Scan_Record without a Public_Report_URL value.
3. WHEN a Public_Report_URL that corresponds to a stored Scan_Report is requested by an unauthenticated client, THE Storage_Service SHALL serve the corresponding Scan_Report within 3 seconds without requiring authentication.
4. IF a requested Public_Report_URL does not correspond to a stored Scan_Report, THEN THE Storage_Service SHALL respond with an error indicating the report was not found and SHALL NOT serve any Scan_Report content.
5. WHERE a Public_Report_URL was produced, THE Storage_Service SHALL include that Public_Report_URL in the Scan_Record for the corresponding package and version.

### Requirement 9: Scanned Package Gallery

**User Story:** As a developer, I want to browse previously scanned packages, so that I can reuse vetted results without rescanning.

#### Acceptance Criteria

1. WHEN the Frontend_UI requests the gallery, THE Storage_Service SHALL return, within 5 seconds, the list of Scan_Records stored in Tigris, up to a maximum of 100 Scan_Records per request.
2. WHEN the Frontend_UI displays the gallery, THE Frontend_UI SHALL show, for each Scan_Record, the package name, version, Verdict, Risk_Score, and a link to the Public_Report_URL.
3. WHERE more than one version of the same package has been scanned, THE Storage_Service SHALL return a Scan_Record for each scanned version.
4. IF the Storage_Service fails to retrieve one or more of the requested Scan_Records, THEN THE Storage_Service SHALL return the successfully retrieved Scan_Records together with an indication that one or more Scan_Records could not be retrieved.
5. WHEN a user selects a gallery entry, THE Frontend_UI SHALL open the corresponding Public_Report_URL.
6. WHEN the Frontend_UI requests the gallery and no Scan_Records exist in Tigris, THE Storage_Service SHALL return an empty list.
7. WHEN the Storage_Service returns an empty list, THE Frontend_UI SHALL display a message indicating that no scanned packages are available.
8. IF the Storage_Service is unable to retrieve any Scan_Records because the data store is unavailable, THEN THE Storage_Service SHALL return an error indication that the gallery could not be loaded and SHALL NOT return partial data.

### Requirement 10: Scan Submission UI

**User Story:** As a developer, I want a search box and Scan button, so that I can request a scan of a package by name.

#### Acceptance Criteria

1. THE Frontend_UI SHALL present a search input that accepts a package name of 1 to 214 characters and a Scan control.
2. WHEN a user submits a package name of 1 to 214 characters through the Scan control, THE Frontend_UI SHALL send a single scan request to the Backend_API.
3. IF a user activates the Scan control while the search input is empty or contains only whitespace characters, THEN THE Frontend_UI SHALL reject the submission and display a validation message that identifies the package name as required.
4. WHILE a scan request is in progress, THE Frontend_UI SHALL display an in-progress indicator and disable the Scan control to prevent duplicate submissions.
5. WHEN a scan request completes successfully, THE Frontend_UI SHALL remove the in-progress indicator and re-enable the Scan control.
6. IF the Backend_API returns an error response, THEN THE Frontend_UI SHALL remove the in-progress indicator, re-enable the Scan control, retain the entered package name in the search input, and display a message that identifies the failure to the user.
7. IF the Backend_API does not respond within 30 seconds, THEN THE Frontend_UI SHALL cancel the scan request, remove the in-progress indicator, re-enable the Scan control, and display a message that identifies the timeout failure to the user.

### Requirement 11: Verdict and Findings Display

**User Story:** As a developer, I want to see the verdict, risk score, and the actual risky code lines, so that I can decide whether to install the package.

#### Acceptance Criteria

1. WHEN a completed Scan_Report is available for a requested package, THE Frontend_UI SHALL display the Verdict value and the Risk_Score as an integer in the range 0 to 100.
2. WHEN a Scan_Report containing one or more Findings is displayed, THE Frontend_UI SHALL display every Finding with its category, file path, and line number.
3. WHEN a Scan_Report containing one or more Findings is displayed, THE Frontend_UI SHALL display the source code line referenced by each Finding.
4. WHEN a Scan_Report is displayed, THE Frontend_UI SHALL display the Public_Report_URL as a shareable link.
5. WHEN a Scan_Report with a SAFE Verdict and zero Findings is displayed, THE Frontend_UI SHALL display the SAFE Verdict together with a message indicating that no Findings were reported.
6. IF no completed Scan_Report is available for a requested package, THEN THE Frontend_UI SHALL display a message indicating that no Scan_Report is available for the requested package.
7. IF the source code line referenced by a Finding cannot be retrieved, THEN THE Frontend_UI SHALL display the Finding with a message indicating that the referenced source code line is unavailable.
8. IF the Public_Report_URL is unavailable for a displayed Scan_Report, THEN THE Frontend_UI SHALL display a message indicating that the shareable link is unavailable.

### Requirement 12: Shared Report Schema (Person A ↔ Person B Interface)

**User Story:** As a member of either the backend or frontend workstream, I want an agreed report JSON schema, so that both sides can integrate without ambiguity.

#### Acceptance Criteria

1. THE Report_Schema SHALL define a normalized report object containing `packageName` (a string of 1 to 214 characters), `version` (a string of 1 to 256 characters), `verdict`, `riskScore`, and a `findings` collection of 0 to 1000 items.
2. THE Report_Schema SHALL define each item in the `findings` collection as containing `category` (a string of 1 to 100 characters), `filePath` (a string of 1 to 4096 characters), `lineNumber` (an integer of 0 or greater, where 0 indicates an unspecified line), `severity`, and `codeSnippet` (a string of 0 to 1000 characters).
3. THE Report_Schema SHALL define `verdict` as exactly one of the case-sensitive values `SAFE` or `RISKY`.
4. WHEN the Fetcher_Service or Storage_Service produces a normalized report, THE produced report SHALL conform to the Report_Schema.
5. IF a raw Scan_Report from the Opsera_Agent is missing a field required by the Report_Schema, THEN the normalizing component SHALL populate that field with the fail-safe default the Report_Schema specifies: missing `verdict` defaults to `RISKY`, missing `riskScore` defaults to 100, a missing `findings` collection defaults to empty, a missing `severity` defaults to `CRITICAL`, a missing `lineNumber` defaults to 0, and a missing required string field defaults to a placeholder value.
6. THE Report_Schema SHALL define `riskScore` as an integer ranging from 0 to 100 inclusive.
7. THE Report_Schema SHALL define `severity` as exactly one of the ordered case-sensitive values `LOW`, `MEDIUM`, `HIGH`, or `CRITICAL`.

### Requirement 13: Verdict Derivation from Risk Score

**User Story:** As a developer, I want a consistent verdict rule, so that the SAFE/RISKY label is predictable and explainable.

#### Acceptance Criteria

1. THE Report_Schema SHALL define the Risk_Score as a numeric value ranging from 0 to 100 inclusive, and SHALL define a single Risk_Score threshold value within the range 0 to 100 inclusive that separates a SAFE Verdict from a RISKY Verdict.
2. WHEN a normalized report has a Risk_Score below the threshold, THE normalizing component SHALL set the Verdict to SAFE.
3. WHEN a normalized report has a Risk_Score at or above the threshold, THE normalizing component SHALL set the Verdict to RISKY.
4. WHEN the same Scan_Report is normalized more than once under the same threshold, THE normalizing component SHALL derive the same Verdict each time (deterministic derivation).
5. WHEN the Risk_Score threshold is updated after a Scan_Record has been persisted, THE Storage_Service SHALL retain the Verdict recorded at the time the Scan_Record was created.
6. IF a normalized report has a Risk_Score that is missing or outside the range 0 to 100 inclusive, THEN THE normalizing component SHALL reject the report with an error indicating an invalid Risk_Score and SHALL NOT assign a Verdict.

---

## Workstream C — Daytona Sandbox Feasibility Experiment (Independent, Non-Blocking)

### Requirement 14: Daytona Sandbox Feasibility Investigation

**User Story:** As the team, I want to know whether the fetch and Opsera scan can run inside an isolated Daytona sandbox, so that untrusted code never touches a real machine.

#### Acceptance Criteria

1. THE Daytona experiment SHALL produce a written feasibility deliverable that states a YES or NO conclusion, supported by observed execution evidence, on whether both the fetch operation and the Opsera scan can execute to completion inside a Daytona_Sandbox without executing on the host machine.
2. WHERE the experiment concludes YES, THE deliverable SHALL include written step-by-step reproduction instructions that, when followed, result in both the fetch operation and the Opsera scan executing to completion inside a Daytona_Sandbox.
3. WHERE the experiment concludes YES, THE deliverable SHALL describe the steps required to replace the local fetch step with a Daytona_Sandbox-based fetch step.
4. WHERE the experiment concludes NO, THE deliverable SHALL document the specific blockers or limitations that prevented the fetch operation or the Opsera scan from executing inside a Daytona_Sandbox.
5. THE Daytona experiment SHALL be conducted without modifying the behavior of the Fetcher_Service, Storage_Service, or Frontend_UI.

### Requirement 15: Daytona Experiment Investigation Steps

**User Story:** As the experimenter, I want defined investigation steps, so that the feasibility conclusion is grounded in concrete attempts.

#### Acceptance Criteria

1. WHEN the Daytona experiment starts, THE Daytona experiment SHALL attempt to spin up a Daytona_Sandbox within a 120-second timeout and SHALL record the outcome as success or failure with a completion timestamp.
2. WHERE the Daytona_Sandbox spin-up succeeded, THE Daytona experiment SHALL attempt to connect VS Code to the Daytona_Sandbox over Remote-SSH within a 60-second timeout and SHALL record the outcome as success or failure with a completion timestamp.
3. WHERE the Remote-SSH connection succeeded, THE Daytona experiment SHALL attempt to install GitHub Copilot inside the Daytona_Sandbox within a 300-second timeout and SHALL record the outcome as success or failure with a completion timestamp.
4. WHERE the Remote-SSH connection succeeded, THE Daytona experiment SHALL attempt to install the Opsera MCP server inside the Daytona_Sandbox within a 300-second timeout and SHALL record the outcome as success or failure with a completion timestamp.
5. WHERE the Opsera MCP server installation succeeded, THE Daytona experiment SHALL attempt to complete Opsera OAuth login remotely from within the Daytona_Sandbox within a 120-second timeout and SHALL record the outcome as success or failure with a completion timestamp.
6. IF a prerequisite step fails, THEN THE Daytona experiment SHALL skip the steps that depend on it and SHALL record those dependent steps as not attempted.
7. IF an attempted investigation step fails, THEN THE deliverable SHALL record the failing step and an observed reason for the failure.
8. IF an attempted investigation step does not complete within its specified timeout, THEN THE deliverable SHALL record that step as failed with an observed reason indicating that the timeout was exceeded.

---

## Cross-Cutting Requirements

### Requirement 16: Vercel Serverless Deployment

**User Story:** As a developer, I want PackGuard hosted on Vercel, so that it is accessible online rather than local-only.

#### Acceptance Criteria

1. THE Backend_API SHALL be deployed as Vercel serverless functions reachable through a public URL.
2. THE Frontend_UI SHALL be served from the Vercel deployment through a public URL.
3. WHEN the Frontend_UI sends a scan request, THE Backend_API on the Vercel deployment SHALL receive the request and return a response within 10 seconds.
4. IF the Backend_API does not return a response within 10 seconds, THEN THE Frontend_UI SHALL display an error message indicating that the scan request timed out and SHALL retain the user's submitted input.
5. IF a scan request cannot be routed to the Backend_API on the Vercel deployment, THEN THE Frontend_UI SHALL display an error message indicating that the scanning service is unavailable.

### Requirement 17: Honest Capability Framing

**User Story:** As a user, I want PackGuard to describe its capabilities honestly, so that I do not over-trust the verdict.

#### Acceptance Criteria

1. WHEN the Frontend_UI displays a Verdict, THE Frontend_UI SHALL present the result labeled as an automated static security review and risk scoring.
2. WHEN the Frontend_UI displays a Verdict, THE Frontend_UI SHALL exclude from all text accompanying the Verdict (including labels, descriptions, and tooltips) any terminology asserting behavioral analysis, dynamic analysis, runtime detection, or malware detection.
3. WHEN the Frontend_UI displays a Verdict, THE Frontend_UI SHALL display attribution indicating that the security scan was performed by the Opsera_Agent using static analysis.
4. WHEN the Frontend_UI displays a Verdict, THE Frontend_UI SHALL display a disclaimer stating that static analysis does not detect runtime or behavioral threats and does not guarantee that the package is free of malicious behavior.
