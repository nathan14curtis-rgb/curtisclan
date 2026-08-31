import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Built to ./dist, deployed as Workers Assets (see ../wrangler.jsonc's
// "assets" binding) — served alongside the API on the same Worker/origin,
// so the dashboard's fetch calls can just use relative /api/... paths.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // `npm run dev` in this folder proxies API calls to a locally
      // running `wrangler dev` (see ../README.md) instead of same-origin.
      "/api": "http://localhost:8787",
    },
  },
});
