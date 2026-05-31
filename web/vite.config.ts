import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// PackGuard Frontend_UI build config.
//
// - `@shared/*` resolves to the repo's `shared/` contracts so the UI binds to
//   the exact same TypeScript types as the backend (no contract drift).
// - In dev, `/api/*` is proxied to a backend you point at via `VITE_API_PROXY`
//   (defaults to the Vercel dev server on :3000). The local loopback agent at
//   127.0.0.1:3939 is called directly from the browser, so it needs no proxy.
export default defineConfig(({ mode }) => {
  const apiProxyTarget = process.env.VITE_API_PROXY || "http://127.0.0.1:3000";

  return {
    plugins: [react()],
    resolve: {
      alias: {
        "@shared": fileURLToPath(new URL("../shared", import.meta.url)),
      },
    },
    server: {
      port: 5173,
      proxy:
        mode === "development"
          ? {
              "/api": {
                target: apiProxyTarget,
                changeOrigin: true,
              },
            }
          : undefined,
    },
    build: {
      outDir: "dist",
      sourcemap: true,
    },
  };
});
