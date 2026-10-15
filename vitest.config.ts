import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/**/*.test.ts", "src/**/*.test.ts"],
    coverage: { provider: "v8", include: ["scripts/**/*.ts", "src/**/*.ts"], exclude: ["**/*.test.ts"] },
  },
});
