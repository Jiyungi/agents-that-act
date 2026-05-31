# `packguard-agent/` — local loopback agent (Person A)

A small HTTP server bound to `127.0.0.1:LOCAL_AGENT_PORT` (default 3939) that
performs the filesystem-bound steps that cannot run on Vercel:

- `POST /local/fetch` — download `.tgz`, safe-untar into `SCAN_TARGET_DIR`,
  launch `code ./scan-target/`, return the `ScanResultContract` (tasks 7.1, 6.x)
- `POST /local/upload` — upload-trigger: read the report, normalize, upload to
  Tigris, persist the record (task 7.2)
- `GET /local/health` — reports `codeCliAvailable`

It is bound to localhost only and never executes fetched package code
("inspect without installing").
