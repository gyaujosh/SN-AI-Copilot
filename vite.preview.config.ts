import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Config for the dev-only design harness in preview/. Separate from
 * vite.config.ts because that one is driven by vite-plugin-web-extension and
 * manifest.json, which would try to build this as part of the extension.
 */
export default defineConfig({
  root: "preview",
  plugins: [react()],
  server: { port: 5199, open: false },
});
