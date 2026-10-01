import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig({
  plugins: [preact()],
  server: { proxy: { "/v1": "http://localhost:8787" } },
  build: { outDir: "dist", emptyOutDir: true },
});
