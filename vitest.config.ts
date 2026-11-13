import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Unit tests run in Node. The `@/…` path alias mirrors tsconfig so imports resolve.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The monthly-workbook round-trip tests build and re-read a full .xlsm; on a busy PC they
    // can pass the 5 s default and fail an otherwise good build.
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
