import "dotenv/config";
import { defineWorkspace } from "vitest/config";
import path from "node:path";

const alias = {
  "@mercury/contracts": path.resolve(__dirname, "packages/contracts/src/index.ts"),
  "@mercury/domain": path.resolve(__dirname, "packages/domain/src/index.ts"),
  "@mercury/db": path.resolve(__dirname, "packages/db/src/index.ts"),
  "@mercury/application": path.resolve(__dirname, "packages/application/src/index.ts"),
  "@mercury/ai": path.resolve(__dirname, "packages/ai/src/index.ts"),
  "@mercury/channels": path.resolve(__dirname, "packages/channels/src/index.ts"),
};

export default defineWorkspace([
  {
    resolve: { alias },
    test: {
      name: "unit",
      include: [
        "packages/domain/test/**/*.test.ts",
        "packages/ai/test/**/*.test.ts",
        "packages/contracts/test/**/*.test.ts",
        "packages/channels/test/**/*.test.ts",
        "packages/application/test/**/*.test.ts",
      ],
    },
  },
  {
    resolve: { alias },
    test: {
      name: "component",
      environment: "jsdom",
      include: ["apps/web/test/**/*.test.tsx"],
      globals: true,
      setupFiles: ["apps/web/test/setup.ts"],
    },
  },
  {
    resolve: { alias },
    test: {
      name: "integration",
      include: ["tests/integration/**/*.test.ts"],
      env: {
        DATABASE_URL: process.env.TEST_DATABASE_URL ?? "",
        INTERPRETER: "rule",
        STORAGE_DIR: "./var/test-storage",
      },
      pool: "forks",
      poolOptions: { forks: { singleFork: true } },
      testTimeout: 30000,
      hookTimeout: 30000,
    },
  },
]);
