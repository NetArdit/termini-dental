import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 60000,
    // The test database is PostgreSQL compiled to WebAssembly. On this machine V8's optimising WebAssembly
    // compiler runs out of memory while tiering it up and kills the worker; the baseline compiler does not.
    execArgv: ["--liftoff-only"],
    // One test file at a time, for the same memory reason.
    fileParallelism: false,
  },
});
