import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./vitest.globalSetup.ts"],
    // Coverage is scoped to the domain and application layers — the logic the
    // story cares about. API/infrastructure are exercised by the integration
    // tests but aren't part of the threshold.
    coverage: {
      provider: "v8",
      include: ["src/domain/**", "src/application/**"],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
      },
    },
  },
});
