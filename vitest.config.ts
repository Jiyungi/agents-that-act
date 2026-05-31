import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./shared", import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["{shared,web,api,packguard-agent}/**/*.{test,spec}.ts"],
  },
});
