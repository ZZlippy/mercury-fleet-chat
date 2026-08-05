import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// VITE_BASE_PATH is only set for the GitHub Pages demo build (see
// package.json's build:demo script), where the app is served from a
// subpath like /mercury-fleet-chat/ instead of the domain root.
export default defineConfig({
  base: process.env.VITE_BASE_PATH || "/",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://localhost:4000", changeOrigin: false } },
  },
  build: { outDir: "dist", sourcemap: false },
});
