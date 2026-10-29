import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "tests/access.test.ts", "tests/voice.test.ts", "tests/transcription.test.ts", "tests/kneut*.test.ts"],
  },
});
