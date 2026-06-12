import { execFile } from "node:child_process";
import net from "node:net";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

async function commandExists(command) {
  const checker = process.platform === "win32" ? "where.exe" : "which";
  try {
    await execFileAsync(checker, [command]);
    return true;
  } catch {
    return false;
  }
}

async function windowsPidsOnPort(port) {
  const { stdout } = await execFileAsync("netstat.exe", ["-ano", "-p", "tcp"]);
  return unique(
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts.length >= 5)
      .filter((parts) => parts[0] === "TCP" && parts[1].endsWith(`:${port}`) && parts[3] === "LISTENING")
      .map((parts) => parts[4]),
  );
}

async function unixPidsOnPort(port) {
  if (!(await commandExists("lsof"))) {
    return [];
  }

  const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
  return unique(stdout.split(/\s+/));
}

async function pidsOnPort(port) {
  if (process.platform === "win32") {
    return windowsPidsOnPort(port);
  }
  return unixPidsOnPort(port);
}

export async function isPortOpen(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

export async function waitForPort(port, { host = "127.0.0.1", timeoutMs = 30000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isPortOpen(port, host)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function terminatePid(pid) {
  if (String(pid) === String(process.pid)) {
    return;
  }

  if (process.platform === "win32") {
    await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"]).catch(() => undefined);
    return;
  }

  try {
    process.kill(Number(pid), "SIGTERM");
  } catch {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, 500));

  try {
    process.kill(Number(pid), "SIGKILL");
  } catch {
    // The process may already be gone.
  }
}

export async function killPort(port) {
  const pids = await pidsOnPort(port);
  await Promise.all(pids.map(terminatePid));
  return pids;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ports = process.argv.slice(2).map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0);
  if (ports.length === 0) {
    console.error("Usage: node scripts/kill-port.mjs <port> [port...]");
    process.exit(1);
  }

  for (const port of ports) {
    const killed = await killPort(port);
    if (killed.length > 0) {
      console.log(`Stopped ${killed.length} process(es) on port ${port}: ${killed.join(", ")}`);
    } else {
      console.log(`No process found on port ${port}`);
    }
  }
}
