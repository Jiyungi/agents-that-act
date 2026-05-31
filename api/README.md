# `api/` — Vercel serverless functions (Person A + Person B)

Serverless HTTP surface deployed on Vercel:

- `/api/resolve` — npm package-name validation + version resolution (Person A, task 2.3)
- `/api/scan-records` — persist a `ScanRecord` (Person B, task 12.1)
- `/api/scans` — gallery list (Person B, task 12.2)

These functions are pure network/storage I/O. The filesystem-bound steps
(download, safe-untar, VS Code launch, upload trigger) live in
`packguard-agent/` because Vercel functions have no persistent disk.
