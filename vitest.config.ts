import { configDefaults, defineConfig } from "vitest/config";

// The modules that hold the invariants (disclosure log, approvals, the chain, the narrow-only policy) must keep
// every file at ≥95% line coverage. perFile means a glob that matches no file yet checks nothing and passes.
export const coverageFloors = {
  "src/{disclosure,trust,store,policy}/**": { lines: 95, perFile: true },
};

export default defineConfig({
  test: {
    include: ["scripts/**/*.test.ts", "src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "test/fixtures/**"],
    coverage: {
      provider: "v8",
      include: ["scripts/**/*.ts", "src/**/*.ts"],
      exclude: ["**/*.test.ts"],
      thresholds: coverageFloors,
    },
  },
});
