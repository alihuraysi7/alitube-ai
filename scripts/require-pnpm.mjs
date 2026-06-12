import { rm } from "node:fs/promises";
import { resolve } from "node:path";

await Promise.all([
  rm(resolve("package-lock.json"), { force: true }),
  rm(resolve("yarn.lock"), { force: true }),
]);

const userAgent = process.env.npm_config_user_agent ?? "";

if (!userAgent.startsWith("pnpm/")) {
  console.error("Use pnpm instead");
  process.exit(1);
}
