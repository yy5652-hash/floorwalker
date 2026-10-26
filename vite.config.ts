// Add shadcn components from the repo root with:
// TS_NODE_PROJECT=web/tsconfig.json npx shadcn@4.22.1 add <component>
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./web/src", import.meta.url)) },
  },
  build: { outDir: "../dist/web", emptyOutDir: true },
});
