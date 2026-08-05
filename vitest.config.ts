import { defineConfig } from "vitest/config";
import path from "node:path";

export const alias = {
  "@mercury/contracts": path.resolve(__dirname, "packages/contracts/src/index.ts"),
  "@mercury/domain": path.resolve(__dirname, "packages/domain/src/index.ts"),
  "@mercury/db": path.resolve(__dirname, "packages/db/src/index.ts"),
  "@mercury/application": path.resolve(__dirname, "packages/application/src/index.ts"),
  "@mercury/ai": path.resolve(__dirname, "packages/ai/src/index.ts"),
  "@mercury/channels": path.resolve(__dirname, "packages/channels/src/index.ts"),
};

export default defineConfig({ resolve: { alias } });
