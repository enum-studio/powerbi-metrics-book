import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["e2e/**/*.e2e.ts"],
    // Starts the stack from empty volumes; takes it down with them after.
    globalSetup: ["e2e/global-setup.ts"],
    // Each test builds on the one before: the first failure ends the run.
    bail: 1,
    // The first sync and the CLI's device-flow polls take minutes on a busy machine.
    testTimeout: 6 * 60_000,
    hookTimeout: 20 * 60_000,
  },
});
