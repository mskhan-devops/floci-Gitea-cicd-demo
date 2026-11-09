import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Django serves the built assets from /static/, so keep them under that prefix.
export default defineConfig({
  base: "/static/",
  plugins: [react()],
  build: {
    outDir: "dist",
    assetsDir: "assets",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8000",
    },
  },
});
