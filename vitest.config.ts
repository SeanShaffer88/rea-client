import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts", "test/unit/**/*.test.tsx"],
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
      // `cli.ts` and `desktop/server.ts` are entry points whose behaviour is
      // asserted by spawning them as subprocesses, which in-process v8 coverage
      // cannot observe. `index.ts` is re-exports only, `protocol.ts` is a
      // type-only contract, and `types.ts` modules are declarations.
      exclude: [
        "src/cli.ts",
        "src/index.ts",
        "src/**/types.ts",
        "src/desktop/server.ts",
        "src/desktop/protocol.ts",
      ],
      reporter: ["text", "json-summary"],
      // A ratchet, not an aspiration: set just below the measured floor so a
      // regression fails the build instead of quietly eroding coverage.
      thresholds: {
        statements: 85,
        branches: 77,
        functions: 85,
        lines: 88,
      },
    },
  },
});
