import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { configPath } from "./config.js";

export function daemonPaths() {
  const dir = path.dirname(configPath());
  return {
    dir,
    statePath: path.join(dir, "daemon.json"),
    logPath: path.join(dir, "daemon.log"),
  };
}

export function readDaemonState() {
  const { statePath } = daemonPaths();
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

export function writeDaemonState(next) {
  const { dir, statePath } = daemonPaths();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(statePath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(statePath, 0o600);
  } catch {
    // Best effort on platforms without POSIX chmod.
  }
  return statePath;
}

export function removeDaemonState() {
  const { statePath } = daemonPaths();
  fs.rmSync(statePath, { force: true });
}

export function isProcessRunning(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

export function daemonStatus() {
  const paths = daemonPaths();
  const state = readDaemonState();
  const running = Boolean(state?.pid && isProcessRunning(state.pid));
  return {
    ok: true,
    running,
    stale: Boolean(state && !running),
    state,
    ...paths,
  };
}

function daemonChildEnv(paths) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("PKG_")) delete env[key];
  }
  return {
    ...env,
    ANYENV_DAEMON: "1",
    ANYENV_DAEMON_STATE: paths.statePath,
    ANYENV_DAEMON_LOG: paths.logPath,
  };
}

function looksLikeNodeExecutable(value) {
  const base = path.basename(String(value || "")).toLowerCase();
  return base === "node" || base === "node.exe";
}

function looksLikeScriptEntrypoint(value) {
  const raw = String(value || "");
  if (!raw) return false;
  if (!/\.(cjs|mjs|js)$/i.test(raw)) return false;
  return fs.existsSync(raw);
}

export function resolveCurrentCliCommand(argv = process.argv, execPath = process.execPath, packaged = Boolean(process.pkg)) {
  if (packaged) return { command: execPath, prefixArgs: [] };
  const invoked = argv[0] || execPath || "anyenv";
  const entry = argv[1] || "";
  if (!looksLikeScriptEntrypoint(entry)) {
    return {
      command: looksLikeNodeExecutable(execPath) && invoked ? invoked : execPath || invoked,
      prefixArgs: [],
    };
  }
  return { command: execPath, prefixArgs: [entry] };
}

function currentCliCommand() {
  return resolveCurrentCliCommand();
}

function daemonLaunchCommand(command, args) {
  if (process.platform === "win32") return { command, args };
  // Packaged binaries can leak pkg bootstrap env into self-spawned children.
  // Clear it in a tiny shell trampoline so "start" remains a CLI argument.
  return {
    command: "/bin/sh",
    args: [
      "-c",
      'unset PKG_INVOKE_NODEJS PKG_EXECPATH PKG_DUMMY_ENTRYPOINT; exec "$@"',
      "anyenv-daemon",
      command,
      ...args,
    ],
  };
}

export function spawnDaemon(childArgs, metadata = {}) {
  const paths = daemonPaths();
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  const { command, prefixArgs } = currentCliCommand();
  fs.writeFileSync(paths.logPath, "", { mode: 0o600 });
  try {
    fs.chmodSync(paths.logPath, 0o600);
  } catch {
    // Best effort on platforms without POSIX chmod.
  }
  const logFd = fs.openSync(paths.logPath, "a");
  const args = [...prefixArgs, ...childArgs];
  const launch = daemonLaunchCommand(command, args);
  const child = spawn(launch.command, launch.args, {
    cwd: process.cwd(),
    detached: true,
    env: daemonChildEnv(paths),
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  fs.closeSync(logFd);
  const state = {
    pid: child.pid,
    command,
    args,
    cwd: process.cwd(),
    startedAt: new Date().toISOString(),
    configPath: configPath(),
    logPath: paths.logPath,
    ...metadata,
  };
  writeDaemonState(state);
  return { ...paths, state };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function stopDaemon(options = {}) {
  const status = daemonStatus();
  const pid = Number(status.state?.pid || 0);
  if (!status.state) {
    return { ok: true, stopped: false, wasRunning: false, reason: "not_running", ...status };
  }
  if (!status.running) {
    removeDaemonState();
    return { ok: true, stopped: false, wasRunning: false, reason: "stale_state_removed", ...status };
  }
  if (pid === process.pid) {
    removeDaemonState();
    return { ok: true, stopped: false, wasRunning: true, reason: "current_process_state_removed", ...status };
  }
  const signal = options.signal || "SIGTERM";
  process.kill(pid, signal);
  const timeoutMs = Math.max(500, Number(options.timeoutMs || 5000));
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!isProcessRunning(pid)) {
      removeDaemonState();
      return { ok: true, stopped: true, wasRunning: true, reason: "stopped", ...status };
    }
    await wait(100);
  }
  if (options.kill !== false) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process may already have exited.
    }
  }
  removeDaemonState();
  return { ok: true, stopped: true, wasRunning: true, reason: "killed", ...status };
}
