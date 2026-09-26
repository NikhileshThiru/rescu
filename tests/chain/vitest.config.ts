import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Each file creates its own declaration, so files can share one validator.
    fileParallelism: true,
    reporters: ["verbose"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
