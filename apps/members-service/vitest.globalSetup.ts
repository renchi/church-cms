import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

// Runs once before any test file is loaded. It generates the Prisma client so
// that importing the repository (which creates a PrismaClient) never fails with
// "did you forget to run prisma generate?" — important on a fresh checkout.
export default function setup(): void {
  const serviceDir = dirname(fileURLToPath(import.meta.url));
  execFileSync("npx", ["--no-install", "prisma", "generate"], {
    cwd: serviceDir,
    stdio: "inherit",
  });
}
