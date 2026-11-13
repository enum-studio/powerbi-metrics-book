import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Security tests share the `_security_test` suffix with Python's, so one
    // pattern finds every security test in the repository.
    include: ["src/**/*.test.ts", "src/**/*_security_test.ts"],
    // Starts this checkout's Postgres, builds the migrated template database
    // once (or reuses it) and starts Cerbos, before any file runs.
    globalSetup: ["test/global-setup.ts"],
    // Gives each test file a database of its own, cloned from that template,
    // so files running in parallel share no rows, locks, events or jobs.
    setupFiles: ["test/file-database.ts"],
    // Every running file holds a database of about 15 MB, and the test
    // Postgres keeps its data in the 1 GB of memory test/compose.yml gives
    // it. Seventeen workers ran 512 MB out of memory; eight peak at about
    // 580 MB of the container on a full run, and the first run also builds the
    // template. Raise both together.
    maxWorkers: 8,
    // Headroom for a slow, busy machine (Cerbos and Postgres in Docker); no
    // test waits for another file any more.
    testTimeout: 30_000,
  },
});
