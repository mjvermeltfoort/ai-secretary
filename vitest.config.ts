import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    maxWorkers: 2,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "tests/access.test.ts", "tests/voice.test.ts", "tests/transcription.test.ts", "tests/kneut*.test.ts", "tests/voiceBriefing.test.ts"],
  },
});
