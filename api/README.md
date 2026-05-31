# api/ — Vercel serverless functions (Person A + B)

Serverless handlers reachable on the public Vercel URL:

- `resolve.ts` — npm package validation + version resolution (task 2.3)
- `scans.ts` — gallery list, proxies Tigris (task 12.2)
- `scan-records.ts` — persist a `Scan_Record` (task 12.1)

No untrusted package code runs here: functions only do npm metadata
resolution and Tigris reads/writes. See `design.md` (Deployment Model).
