import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { killPort, waitForPort } from "./kill-port.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apiDir = join(rootDir, "artifacts", "api-server");
const webDir = join(rootDir, "artifacts", "youtube-arabic");

const mode = process.argv.find((arg) => arg === "api" || arg === "web" || arg === "all") ?? "all";
const smoke = process.argv.includes("--smoke");

const apiPort = Number(process.env.API_PORT ?? (mode === "api" && process.env.PORT ? process.env.PORT : 8080));
const webPort = Number(process.env.WEB_PORT ?? (mode === "web" && process.env.PORT ? process.env.PORT : 24245));
const basePath = process.env.BASE_PATH ?? "/";

const children = new Set();

function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? rootDir,
    env: { ...process.env, ...options.env },
    shell: false,
    stdio: options.stdio ?? "inherit",
  });

  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function runChecked(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = run(command, args, options);
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
      } else {
        rejectRun(new Error(`${command} ${args.join(" ")} exited with ${signal ?? code}`));
      }
    });
  });
}

async function stopChildren() {
  const running = [...children];
  for (const child of running) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }

  await new Promise((resolveStop) => setTimeout(resolveStop, 750));

  for (const child of running) {
    if (!child.killed) {
      child.kill("SIGKILL");
    }
  }
}

process.on("SIGINT", async () => {
  await stopChildren();
  process.exit(130);
});

process.on("SIGTERM", async () => {
  await stopChildren();
  process.exit(143);
});

async function startApi() {
  console.log(`[dev] Preparing API server on http://localhost:${apiPort}`);
  await killPort(apiPort);
  await runChecked(process.execPath, ["build.mjs"], { cwd: apiDir });

  const child = run(process.execPath, ["--enable-source-maps", "dist/index.mjs"], {
    cwd: apiDir,
    env: {
      PORT: String(apiPort),
      VITE_PORT: String(webPort),
      NODE_ENV: "development",
    },
  });

  child.once("exit", (code, signal) => {
    if (!smoke) {
      console.error(`[dev] API server stopped (${signal ?? code})`);
    }
  });

  return child;
}

async function startWeb() {
  console.log(`[dev] Preparing web app on http://localhost:${webPort}`);
  await killPort(webPort);

  const viteBin = join(webDir, "node_modules", "vite", "bin", "vite.js");
  const child = run(process.execPath, [viteBin, "--config", "vite.config.ts", "--host", "0.0.0.0"], {
    cwd: webDir,
    env: {
      PORT: String(webPort),
      BASE_PATH: basePath,
    },
  });

  child.once("exit", (code, signal) => {
    if (!smoke) {
      console.error(`[dev] Web server stopped (${signal ?? code})`);
    }
  });

  return child;
}

async function main() {
  if (![apiPort, webPort].every((port) => Number.isInteger(port) && port > 0)) {
    throw new Error("Invalid dev port configuration.");
  }

  const shouldRunApi = mode === "api" || mode === "all";
  const shouldRunWeb = mode === "web" || mode === "all";

  if (shouldRunWeb) {
    await startWeb();
  }

  if (shouldRunApi) {
    await startApi();
  }

  if (smoke) {
    const checks = [];
    if (shouldRunWeb) checks.push(["web", webPort]);
    if (shouldRunApi) checks.push(["api", apiPort]);

    for (const [label, port] of checks) {
      const ready = await waitForPort(port, { timeoutMs: 30000 });
      if (!ready) {
        throw new Error(`${label} did not open port ${port}`);
      }
      console.log(`[dev] ${label} is listening on port ${port}`);
    }

    await stopChildren();
    return;
  }

  console.log("[dev] Local development is running.");
  if (shouldRunApi) console.log(`[dev] Backend/proxy: http://localhost:${apiPort}`);
  if (shouldRunWeb) console.log(`[dev] Frontend only: http://localhost:${webPort}`);
}

main().catch(async (error) => {
  console.error(`[dev] ${error instanceof Error ? error.message : String(error)}`);
  await stopChildren();
  process.exit(1);
});
