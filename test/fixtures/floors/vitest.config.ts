// Runs the repo coverage floors against this fixture tree (see scripts/boundaries.test.ts).
import { defineConfig } from "vitest/config";
import { coverageFloors } from "../../../vitest.config.ts";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: { provider: "v8", exclude: ["**/*.test.ts"], reporter: ["text"], thresholds: coverageFloors },
  },
});
