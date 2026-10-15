import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Pulling the NATS image on a cold Docker cache can take a while.
    hookTimeout: 60_000,
  },
});
