import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/rules.integration.test.ts"],
    testTimeout: 20000,
  },
});
