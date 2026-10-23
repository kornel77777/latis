import { defineConfig } from "vitest/config";

// Two projects: plain Node unit tests, and "native" tests that load better-sqlite3,
// which is compiled for Electron's ABI and so runs under Electron-as-Node.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/test/**/*.test.ts", "apps/desktop/test/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "native",
          include: ["apps/desktop/test/native/**/*.test.ts"],
          environment: "node",
          pool: "forks",
        },
      },
    ],
  },
});
