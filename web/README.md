# `web/` — Frontend_UI (Person B)

The PackGuard frontend: a **Vite + React + TypeScript** single-page app served
from the same Vercel deployment as `api/`. It implements the search/scan flow,
the manual handoff panel, the verdict card, and the gallery described in
`.kiro/specs/packguard/frontend-design-prompt.md`.

The UI binds to the **canonical shared contracts** in `../shared` — types from
`@shared/contracts` and honest-framing copy from `@shared/framing` are imported
directly, so the frontend can never drift from the backend.

## Architecture

The browser talks to two backends (§4 of the design):

1. **Serverless API** on the same origin (`/api/*`) — npm resolution
   (`/api/resolve`), gallery list (`/api/scans`), record persistence
   (`/api/scan-records`).
2. **Local loopback agent** at `http://127.0.0.1:3939` — the filesystem-bound
   steps (`/local/fetch`, `/local/upload`, `/local/health`), because a
   serverless function can't write the folder VS Code opens or read the local
   report file.

The scan flow is an explicit state machine (`useScanFlow`):

```
IDLE → RESOLVING → FETCHING → AWAITING_SCAN → UPLOADING → DONE | ERROR
```

`AWAITING_SCAN` is the durable pause where the operator runs `/security-scan`
in GitHub Copilot Chat; the `ScanResultContract` is held in state across it.

## Layout

```
web/
  index.html
  vite.config.ts          # @shared alias + /api dev proxy
  src/
    main.tsx              # React root
    App.tsx               # shell + flow wiring
    useScanFlow.ts        # the §5 state machine
    api.ts                # typed client (real + mock) for every §4 endpoint
    framing.ts            # honest-framing copy (anchored to @shared/framing)
    usePref.ts            # localStorage-backed demo prefs
    styles.css            # terminal/hacker theme
    components/           # SearchBar, ScanProgress, ManualHandoffPanel,
                          # AgentHealthBanner, ErrorPanel, Gallery, VerdictCard,
                          # Icons, TweaksPanel
    mock/data.ts          # demo fixtures (mock mode only)
```

## Develop

```bash
cd web
npm install
npm run dev        # http://localhost:5173 (mock backend by default in dev)
```

### Wire to the real backend

The API client picks its mode from `VITE_USE_MOCK` (see `.env.example`):

- **Mock (default in dev):** runs entirely in the browser against the fixtures
  in `src/mock/data.ts`. The floating **tweaks** panel lets you preview every
  contract state (verdict style, agent health, gallery states) and the error
  branches (try scanning `does-not-exist-pkg` or `no-vscode`).
- **Real backend:** set `VITE_USE_MOCK=false`. The app then calls same-origin
  `/api/*` and the local agent at `VITE_AGENT_URL` (default
  `http://127.0.0.1:3939`). In `npm run dev`, `/api/*` is proxied to
  `VITE_API_PROXY` (default `http://127.0.0.1:3000`, the Vercel dev server).
  Production builds default to the real backend automatically.

## Build & typecheck

```bash
npm run typecheck   # tsc --noEmit
npm run build       # tsc --noEmit && vite build → web/dist
```
