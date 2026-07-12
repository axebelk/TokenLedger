import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// /api → control-plane API, /gw → gateway. Applied to both the dev server and
// `vite preview` so a from-source production run is single-origin without a
// separate reverse proxy. `flush_interval`-style buffering is disabled so SSE
// streaming passes through.
const proxy = {
  "/api": { target: "http://localhost:4000", changeOrigin: true },
  "/gw": { target: "http://localhost:4100", changeOrigin: true },
};

export default defineConfig({
  plugins: [react()],
  server: { port: 3000, proxy },
  preview: { port: 8080, proxy },
});
