import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(import.meta.dirname, "desktop/ui"),
  base: "./",
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, "dist-desktop"),
    emptyOutDir: true,
    target: "es2023",
    sourcemap: false,
    chunkSizeWarningLimit: 700,
  },
});
