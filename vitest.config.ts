import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@mosaic/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@mosaic/discord-bot": fileURLToPath(new URL("./packages/discord-bot/src/index.ts", import.meta.url)),
      "@mosaic/github-app": fileURLToPath(new URL("./packages/github-app/src/index.ts", import.meta.url)),
      "@mosaic/intake": fileURLToPath(new URL("./packages/intake/src/index.ts", import.meta.url)),
      "@mosaic/llm": fileURLToPath(new URL("./packages/llm/src/index.ts", import.meta.url)),
      "@mosaic/pipeline": fileURLToPath(new URL("./packages/pipeline/src/index.ts", import.meta.url)),
      "@mosaic/slack-bot": fileURLToPath(new URL("./packages/slack-bot/src/index.ts", import.meta.url))
    }
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      reporter: ["text", "json-summary"],
      thresholds: {
        statements: 70,
        branches: 75,
        functions: 78,
        lines: 70
      }
    }
  }
});
