import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const binDir = path.join(root, "dist", "bin");

function currentPlatformBinary() {
  const osName = process.platform === "darwin"
    ? "darwin"
    : process.platform === "linux"
      ? "linux"
      : process.platform === "win32"
        ? "windows"
        : "";
  const archName = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : "";
  if (!osName || !archName) {
    throw new Error(`Unsupported smoke platform: ${process.platform}/${process.arch}`);
  }
  const ext = process.platform === "win32" ? ".exe" : "";
  return path.join(binDir, `anyenv-${osName}-${archName}${ext}`);
}

function run(binary, args, options = {}) {
  return execFileSync(binary, args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...(options.env || {}),
    },
    encoding: "utf8",
    stdio: options.stdio || "pipe",
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForStatusAndLogs(binary, cwd, env, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;
  let lastLogText = "";

  while (Date.now() < deadline) {
    try {
      lastStatus = JSON.parse(run(binary, ["status", "--json"], { cwd, env }));
      lastLogText = lastStatus.logPath && fs.existsSync(lastStatus.logPath)
        ? fs.readFileSync(lastStatus.logPath, "utf8")
        : "";
      if (
        lastStatus.running
        && /daemon\.start/.test(lastLogText)
        && /ws\.connect\.begin/.test(lastLogText)
        && /ws\.(connect\.failed|reconnect\.schedule)/.test(lastLogText)
      ) {
        return { status: lastStatus, logText: lastLogText };
      }
    } catch {}
    await sleep(250);
  }

  return { status: lastStatus, logText: lastLogText };
}

const binary = currentPlatformBinary();
if (!fs.existsSync(binary)) {
  throw new Error(`Missing packaged binary for daemon smoke: ${binary}`);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-packaged-daemon-smoke-"));
const cwd = path.join(tempRoot, "cwd with spaces");
const workspace = path.join(tempRoot, "workspace");
const configPath = path.join(tempRoot, "config.json");
fs.mkdirSync(cwd, { recursive: true });
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(
  configPath,
  `${JSON.stringify({
    apiBase: "http://127.0.0.1:9/api/v1",
    globalToken: "evls_gt_packaged_smoke_token",
    clientId: "lc_packaged_smoke",
    deviceId: "ld_packaged_smoke",
  }, null, 2)}\n`,
);

const env = { ANYENV_CONFIG: configPath };
let status = null;
let logText = "";

try {
  try {
    run(binary, ["start", "--workspace", workspace, "--name", "PackagedDaemonSmoke"], { cwd, env });
  } catch (err) {
    const output = `${err?.stdout || ""}${err?.stderr || ""}`;
    if (/Cannot find module|MODULE_NOT_FOUND/i.test(output)) {
      throw new Error(`Packaged daemon self-spawn failed before writing a daemon log:\n${output}`);
    }
  }
  ({ status, logText } = await waitForStatusAndLogs(binary, cwd, env));

  if (!status?.state?.pid || !Array.isArray(status.state.args)) {
    throw new Error(`Daemon smoke did not write a valid state file:\n${JSON.stringify(status, null, 2)}`);
  }
  if (!status.state.args.includes("start") || !status.state.args.includes("--foreground")) {
    throw new Error(`Daemon smoke launched unexpected args:\n${JSON.stringify(status.state.args, null, 2)}`);
  }
  if (/Cannot find module|MODULE_NOT_FOUND/i.test(logText)) {
    throw new Error(`Packaged daemon self-spawn failed:\n${logText}`);
  }
  if (!status.running) {
    throw new Error(`Daemon smoke exited instead of retrying an unreachable API:\n${JSON.stringify(status, null, 2)}`);
  }
  if (!/daemon\.start/.test(logText) || !/"runId":"lrun_/.test(logText)) {
    throw new Error(`Daemon smoke did not persist a runId in the daemon log:\n${logText}`);
  }
  if (!/ws\.connect\.begin/.test(logText) || !/"connectionId":"lconn_/.test(logText)) {
    throw new Error(`Daemon smoke did not persist a connectionId in the daemon log:\n${logText}`);
  }
  if (!/ws\.reconnect\.schedule/.test(logText)) {
    throw new Error(`Daemon smoke did not record retry scheduling:\n${logText}`);
  }
  if (!/fetch failed|ECONNREFUSED|api_unreachable/i.test(logText)) {
    throw new Error(`Daemon smoke did not reach the foreground connector failure path:\n${logText}`);
  }

  run(binary, ["stop", "--json"], { cwd, env });
  fs.rmSync(tempRoot, { recursive: true, force: true });
  console.log(`smoked packaged daemon self-spawn: ${path.relative(root, binary)}`);
} catch (err) {
  try {
    run(binary, ["stop", "--json"], { cwd, env });
  } catch {
    // Best effort cleanup; keep temp files for failure diagnosis.
  }
  const detail = [
    err?.message || String(err),
    "",
    `tempRoot: ${tempRoot}`,
    status ? `status: ${JSON.stringify(status, null, 2)}` : "",
    logText ? `daemon log:\n${logText}` : "",
  ].filter(Boolean).join("\n");
  throw new Error(detail);
}
