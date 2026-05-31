/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "false" forces the real backend; anything else / unset uses mock in dev. */
  readonly VITE_USE_MOCK?: string;
  /** Override the local loopback agent base URL (default http://127.0.0.1:3939). */
  readonly VITE_AGENT_URL?: string;
  /** Dev-only: where `/api/*` is proxied (default http://127.0.0.1:3000). */
  readonly VITE_API_PROXY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
