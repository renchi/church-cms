import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Mirror tsconfig's "@/*" path alias, so tests import modules the same way the app does.
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  test: {
    // The code under test (lib/membersApi.ts, the Server Action) runs on the server,
    // so a plain Node environment is enough: no browser DOM needed.
    environment: "node",
  },
});
