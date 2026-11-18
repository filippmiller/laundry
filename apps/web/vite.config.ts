import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  resolve: {
    alias: { "@shared": fileURLToPath(new URL("../../shared", import.meta.url)) },
  },
  server: {
    port: 5173,
    // `shared/` lives at the repository root, outside the Vite root.
    fs: { allow: [root, repoRoot] },
    proxy: { "/api": { target: "http://localhost:3000", changeOrigin: true } },
  },
  build: { outDir: "../../dist/web", emptyOutDir: true },
});
