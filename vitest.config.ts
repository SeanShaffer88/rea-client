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
          // The real-REA suite spawns a Node MCP server; run serially.
          fileParallelism: false,
        },
      },
    ],
  },
});
