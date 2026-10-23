import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const root = fileURLToPath(new URL(".", import.meta.url));
// Only `dependencies` (native/runtime modules) are externalised and shipped; everything
// else, including the @latis/* workspace packages, is a devDependency and gets bundled.

export default defineConfig({
  main: {
    build: {
      externalizeDeps: true,
      rollupOptions: {
        input: {
          index: resolve(root, "src/main/index.ts"),
          "fake-runner": resolve(root, "src/main/agents/adapters/fake/runner.ts"),
        },
      },
    },
  },
  preload: {
    // Sandboxed preloads can't require npm modules and must be CommonJS.
    build: {
      externalizeDeps: false,
      rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
  },
});
