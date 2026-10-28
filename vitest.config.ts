import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts"],
          environment: "node",
          testTimeout: 15_000,
        },
      },
      {
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          environment: "node",
          testTimeout: 180_000,
          hookTimeout: 180_000,
          // This suite spawns real MCP servers and HTTP listeners; run serially
          // so port allocation and child-process teardown stay deterministic.
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // `cli.ts` is an entry point whose behaviour is asserted by spawning it as
      // a subprocess (test/integration/cli.test.ts), which in-process v8
      // coverage cannot observe. `index.ts` is re-exports only.
      exclude: ["src/cli.ts", "src/index.ts", "src/**/types.ts"],
      reporter: ["text", "json-summary"],
      // A ratchet, not an aspiration: set just below the measured floor so a
      // regression fails the build instead of quietly eroding coverage.
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 78,
        lines: 80,
      },
    },
  },
});
