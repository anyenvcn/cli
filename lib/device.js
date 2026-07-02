import fs from "node:fs";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { WebSocketServer } from "ws";
import { registerAccountLocalClient } from "./cloud-api.js";
import { VERSION, configPath, debugLog, maskToken, readConfig, writeConfig } from "./config.js";
import { patchDaemonState } from "./daemon.js";

const TOOL_CANDIDATES = [
  { id: "codex", name: "Codex CLI", command: "codex" },
  { id: "claude", name: "Claude Code", command: "claude" },
  { id: "cursor", name: "Cursor Agent", command: "cursor-agent" },
  { id: "qwen", name: "Qwen Code", command: "qwen" },
  { id: "opencode", name: "OpenCode", command: "opencode" },
  { id: "qoder", name: "Qoder CLI", command: "qodercli" },
  { id: "gemini", name: "Gemini CLI", command: "gemini" },
];

const LOCAL_AGENT_COMMANDS = {
  codex: (prompt) => ({ command: "codex", args: ["exec", prompt] }),
  claude: (prompt) => ({ command: "claude", args: ["--print", prompt] }),
  cursor: (prompt) => ({ command: "cursor-agent", args: ["-p", prompt] }),
  qwen: (prompt) => ({ command: "qwen", args: ["-p", prompt, "-o", "stream-json"] }),
  opencode: (prompt) => ({ command: "opencode", args: ["run", prompt] }),
  qoder: (prompt) => ({ command: "qodercli", args: ["-q", "--yolo", "-p", prompt] }),
};

function commandExists(command) {
  const isWin = process.platform === "win32";
  const result = spawnSync(isWin ? "where" : "command", isWin ? [command] : ["-v", command], {
    shell: !isWin,
    encoding: "utf8",
    timeout: 2000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return "";
  return String(result.stdout || "").trim().split(/\r?\n/)[0] || "";
}

function commandVersion(command) {
  const result = spawnSync(command, ["--version"], {
    shell: process.platform === "win32",
    encoding: "utf8",
    timeout: 3000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return "";
  return String(result.stdout || result.stderr || "").trim().split(/\r?\n/)[0] || "";
}

export function discoverLocalTools() {
  return TOOL_CANDIDATES.map((tool) => {
    const path = commandExists(tool.command);
    return {
      ...tool,
      found: Boolean(path),
      path,
      version: path ? commandVersion(tool.command) : "",
    };
  });
}

function uniqueStrings(items) {
  return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))];
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function retryNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function reconnectPolicy(options = {}) {
  const maxAttempts = retryNumber(
    process.env.ANYENV_DAEMON_RECONNECT_MAX_ATTEMPTS,
    0,
    0,
    1000000,
  );
  return {
    enabled: !options.once,
    maxAttempts,
    initialDelayMs: retryNumber(
      process.env.ANYENV_DAEMON_RECONNECT_INITIAL_DELAY,
      1,
      0.25,
      300,
    ) * 1000,
    maxDelayMs: retryNumber(
      process.env.ANYENV_DAEMON_RECONNECT_MAX_DELAY,
      30,
      1,
      600,
    ) * 1000,
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createConnectionId() {
  if (typeof crypto.randomUUID === "function") return `lconn_${crypto.randomUUID()}`;
  return `lconn_${crypto.randomBytes(16).toString("hex")}`;
}

function createRunId() {
  if (typeof crypto.randomUUID === "function") return `lrun_${crypto.randomUUID()}`;
  return `lrun_${crypto.randomBytes(16).toString("hex")}`;
}

function reconnectDelayMs(policy, attempt) {
  if (!policy.enabled) return 0;
  const exponent = Math.max(0, Math.min(10, attempt - 1));
  return Math.min(policy.maxDelayMs, Math.round(policy.initialDelayMs * (2 ** exponent)));
}

function redactForLog(value, depth = 0) {
  if (depth > 5) return "[depth-limit]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (/^(pt_|evls_gt_|eyJ)/.test(value)) return maskToken(value);
    return value;
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactForLog(item, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/authorization|secret|password|credential|token/i.test(key)) {
      out[key] = typeof item === "string" ? maskToken(item) : "[redacted]";
    } else {
      out[key] = redactForLog(item, depth + 1);
    }
  }
  return out;
}

function daemonLogMaxBytes() {
  return clampNumber(process.env.ANYENV_DAEMON_LOG_MAX_BYTES, 2 * 1024 * 1024, 64 * 1024, 50 * 1024 * 1024);
}

function compactDeviceLogIfNeeded(logPath) {
  const maxBytes = daemonLogMaxBytes();
  try {
    const stat = fs.statSync(logPath);
    if (stat.size < maxBytes) return;
    const keepBytes = Math.max(32 * 1024, Math.floor(maxBytes / 2));
    const fd = fs.openSync(logPath, "r");
    try {
      const size = Math.min(keepBytes, stat.size);
      const buffer = Buffer.alloc(size);
      fs.readSync(fd, buffer, 0, size, stat.size - size);
      const header = `[AnyEnv:device] ${new Date().toISOString()} log.compacted {"previousBytes":${stat.size},"keptBytes":${size}}\n`;
      fs.writeFileSync(logPath, `${header}${buffer.toString("utf8")}`, { mode: 0o600 });
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Log compaction is best effort and should never stop the device agent.
  }
}

function daemonStatePatchForLog(event, payload, timestamp) {
  const patch = {
    lastEvent: event,
    lastEventAt: timestamp,
  };
  if (payload.runId) patch.lastRunId = payload.runId;
  if (payload.connectionId) patch.lastConnectionId = payload.connectionId;
  if (event === "daemon.start") {
    patch.daemonStartedAt = timestamp;
    patch.lastExit = null;
    patch.lastSignal = null;
    patch.lastStopReason = "";
  }
  if (event === "ws.heartbeat.sent") {
    patch.lastHeartbeatAt = timestamp;
  }
  if (event === "ws.close") {
    patch.lastWebSocketClose = {
      at: timestamp,
      code: Number(payload.code || 0),
      reason: String(payload.reason || ""),
      wasClean: Boolean(payload.wasClean),
    };
  }
  if (event.startsWith("ws.reconnect.")) {
    patch.lastReconnectAt = timestamp;
    patch.lastReconnectEvent = event;
  }
  if (event === "ws.reconnect.stop") {
    patch.lastStopReason = String(payload.reason || "reconnect_stopped");
  }
  if (event === "ws.reconnect.give_up") {
    patch.lastStopReason = "reconnect_give_up";
  }
  if (event === "daemon.signal") {
    patch.lastSignal = {
      at: timestamp,
      signal: String(payload.signal || ""),
      uptimeSeconds: Number(payload.uptimeSeconds || 0),
    };
  }
  if (event === "daemon.exit") {
    patch.lastExit = {
      at: timestamp,
      code: Number(payload.code || 0),
      uptimeSeconds: Number(payload.uptimeSeconds || 0),
      reason: String(payload.reason || ""),
    };
  }
  if (event === "daemon.uncaught_exception") {
    patch.lastExit = {
      at: timestamp,
      code: 1,
      uptimeSeconds: Number(payload.uptimeSeconds || 0),
      reason: "uncaught_exception",
      message: String(payload.message || "").slice(0, 500),
    };
  }
  return patch;
}

function deviceLog(event, detail = {}) {
  const payload = redactForLog(detail);
  const suffix = payload && Object.keys(payload).length ? ` ${JSON.stringify(payload)}` : "";
  const timestamp = new Date().toISOString();
  const line = `[AnyEnv:device] ${timestamp} ${event}${suffix}\n`;
  const logPath = process.env.ANYENV_DAEMON_LOG || path.join(path.dirname(configPath()), "daemon.log");
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
    compactDeviceLogIfNeeded(logPath);
    fs.appendFileSync(logPath, line, { mode: 0o600 });
    try {
      fs.chmodSync(logPath, 0o600);
    } catch {
      // Best effort on platforms without POSIX chmod.
    }
  } catch {
    // Do not let logging failures take down the local device connection.
  }
  if (process.env.ANYENV_DAEMON_STATE) {
    try {
      patchDaemonState(daemonStatePatchForLog(event, payload || {}, timestamp));
    } catch {
      // State updates are diagnostic only.
    }
  }
}

function socketCloseInfo(args = []) {
  const [first, second] = args;
  if (typeof first === "number") {
    return {
      code: first,
      reason: Buffer.isBuffer(second) ? second.toString("utf8") : String(second || ""),
      wasClean: first === 1000,
    };
  }
  if (first && typeof first === "object") {
    return {
      code: Number(first.code || 0),
      reason: String(first.reason || ""),
      wasClean: Boolean(first.wasClean),
    };
  }
  return { code: 0, reason: "", wasClean: false };
}

function errorMessage(error) {
  return error?.message || error?.error?.message || String(error || "unknown error");
}

function isAuthLikeFailure(error) {
  const message = errorMessage(error);
  return error?.status === 401
    || error?.status === 403
    || /Token is invalid|Token 无效|missing local-device permission|local-device permission|auth failed|authentication failed/i.test(message);
}

function workspaceRoots(workspaces = []) {
  return uniqueStrings(
    (Array.isArray(workspaces) ? workspaces : [])
      .map((workspace) => workspace?.path)
      .filter(Boolean)
      .map((workspacePath) => path.resolve(String(workspacePath))),
  );
}

function localCommandPolicy(options = {}) {
  const roots = options.commandRoot
    ? [path.resolve(String(options.commandRoot))]
    : workspaceRoots(options.workspaces);
  const fallbackRoots = roots.length ? roots : [process.cwd()];
  return {
    enabled: Boolean(options.allowLocalCommands),
    mode: "experimental-local-shell",
    roots: uniqueStrings(fallbackRoots),
    root: fallbackRoots[0],
    timeoutSeconds: clampNumber(options.commandTimeoutSeconds, 3600, 1, 21600),
    maxOutputBytes: clampNumber(options.commandMaxOutputBytes, 1048576, 1024, 2097152),
  };
}

function remoteDesktopSetupInstructions() {
  return {
    macos: [
      "打开系统设置 -> 通用 -> 共享 -> 屏幕共享。",
      "运行 anyenv restart --allow-remote-desktop；CLI 默认会自动探测真实 VNC/RFB 端口。",
    ],
    linux: [
      "安装 x11vnc、tigervnc 或 wayvnc，并让 VNC 服务只监听 127.0.0.1。",
      "运行 anyenv restart --allow-remote-desktop；需要时可用 --vnc-port 指定真实端口。",
    ],
    windows: [
      "安装可信的 VNC Server，并尽量绑定到 localhost/127.0.0.1。",
      "运行 anyenv restart --allow-remote-desktop；需要时可用 --vnc-port 指定真实端口。",
    ],
  };
}

function remoteDesktopPolicy(options = {}) {
  const portInfo = vncPortInfo(options.vncPort);
  return {
    enabled: Boolean(options.allowRemoteDesktop),
    mode: "experimental-local-vnc",
    protocol: "vnc",
    host: "127.0.0.1",
    port: portInfo.port,
    portMode: portInfo.portMode,
    candidatePorts: portInfo.candidatePorts,
    setup: remoteDesktopSetupInstructions(),
  };
}

function parsePortList(value) {
  return uniqueStrings(String(value || "").split(/[,\s]+/))
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item >= 1 && item <= 65535);
}

function defaultVncCandidatePorts() {
  const envPorts = parsePortList(process.env.ANYENV_VNC_PORT_CANDIDATES);
  if (envPorts.length) return envPorts;
  return Array.from({ length: 11 }, (_, index) => 5900 + index);
}

function vncPortInfo(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw || raw === "true" || raw === "auto" || raw === "0") {
    const candidatePorts = defaultVncCandidatePorts();
    return {
      port: candidatePorts[0] || 5900,
      portMode: "auto",
      candidatePorts,
    };
  }
  const port = clampNumber(value, 5900, 1, 65535);
  return {
    port,
    portMode: "fixed",
    candidatePorts: [port],
  };
}

function vncHandshakeTimeoutMs() {
  return clampNumber(process.env.ANYENV_VNC_HANDSHAKE_TIMEOUT_MS, 5000, 100, 30000);
}

function vncAutoHandshakeTimeoutMs() {
  return clampNumber(
    process.env.ANYENV_VNC_AUTO_HANDSHAKE_TIMEOUT_MS || process.env.ANYENV_VNC_HANDSHAKE_TIMEOUT_MS,
    750,
    100,
    5000,
  );
}

function isRfbHandshake(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 4 && buffer.subarray(0, 4).toString("ascii") === "RFB ";
}

function isInsideRoot(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveCommandCwd(policy, requestedCwd) {
  const raw = String(requestedCwd || "").trim();
  const target = raw
    ? path.resolve(path.isAbsolute(raw) ? raw : path.join(policy.root, raw))
    : policy.root;
  if (!policy.roots.some((root) => isInsideRoot(root, target))) {
    const error = new Error("命令工作目录不在本机 CLI 允许目录内。");
    error.code = "cwd_outside_allowed_roots";
    error.allowedRoots = policy.roots;
    error.cwd = target;
    throw error;
  }
  return target;
}

function commandEnvironment(cwd) {
  const keys = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "COLORTERM",
    "CLICOLOR",
    "CLICOLOR_FORCE",
    "FORCE_COLOR",
    "NO_COLOR",
    "LSCOLORS",
    "LS_COLORS",
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATHEXT",
  ];
  const env = {};
  for (const key of keys) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.PWD = cwd;
  env.ANYENV_LOCAL_COMMAND = "1";
  return env;
}

function pythonPtyHelperSource() {
  return String.raw`
import base64
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time

def emit(payload):
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()

def set_winsize(fd, cols, rows):
    cols = max(1, int(cols or 80))
    rows = max(1, int(rows or 24))
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

cwd = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else os.getcwd()
cols = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2] else 100
rows = int(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] else 30
shell = os.environ.get("SHELL") or "/bin/bash"
if not os.path.exists(shell):
    shell = "/bin/sh"

master_fd, slave_fd = pty.openpty()
set_winsize(slave_fd, cols, rows)
env = os.environ.copy()
if not env.get("TERM") or env.get("TERM", "").lower() in ("dumb", "unknown"):
    env["TERM"] = "xterm-256color"
env["PWD"] = cwd
try:
    proc = subprocess.Popen(
        [shell, "-l"],
        cwd=cwd,
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        env=env,
        close_fds=True,
        start_new_session=True,
    )
finally:
    os.close(slave_fd)

flags = fcntl.fcntl(master_fd, fcntl.F_GETFL)
fcntl.fcntl(master_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)
stdin_fd = sys.stdin.fileno()
stdin_flags = fcntl.fcntl(stdin_fd, fcntl.F_GETFL)
fcntl.fcntl(stdin_fd, fcntl.F_SETFL, stdin_flags | os.O_NONBLOCK)

emit({"type": "ready", "pid": proc.pid, "shell": shell})
stdin_buffer = b""
closing = False

def drain_master():
    while True:
        try:
            chunk = os.read(master_fd, 65536)
        except OSError as exc:
            if exc.errno in (errno.EIO, errno.EAGAIN, errno.EWOULDBLOCK):
                break
            raise
        if not chunk:
            break
        emit({"type": "output", "data": base64.b64encode(chunk).decode("ascii")})

while True:
    readable, _, _ = select.select([master_fd, stdin_fd], [], [], 0.1)
    if master_fd in readable:
        drain_master()
    if stdin_fd in readable:
        try:
            chunk = os.read(stdin_fd, 65536)
        except OSError as exc:
            if exc.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                chunk = b""
            else:
                raise
        if not chunk:
            closing = True
        else:
            stdin_buffer += chunk
            while b"\n" in stdin_buffer:
                raw, stdin_buffer = stdin_buffer.split(b"\n", 1)
                if not raw.strip():
                    continue
                try:
                    frame = json.loads(raw.decode("utf-8"))
                except Exception as exc:
                    emit({"type": "error", "error": "invalid_control_frame", "message": str(exc)})
                    continue
                ftype = frame.get("type")
                if ftype == "input":
                    try:
                        data = base64.b64decode(str(frame.get("data") or ""), validate=False)
                        if data:
                            os.write(master_fd, data)
                    except Exception as exc:
                        emit({"type": "error", "error": "input_write_failed", "message": str(exc)})
                elif ftype == "resize":
                    try:
                        set_winsize(master_fd, int(frame.get("cols") or 80), int(frame.get("rows") or 24))
                    except Exception as exc:
                        emit({"type": "error", "error": "resize_failed", "message": str(exc)})
                elif ftype == "close":
                    closing = True
                    break
    code = proc.poll()
    if closing and code is None:
        try:
            os.killpg(proc.pid, signal.SIGHUP)
        except Exception:
            try:
                proc.terminate()
            except Exception:
                pass
        deadline = time.time() + 2.0
        while time.time() < deadline and proc.poll() is None:
            drain_master()
            time.sleep(0.05)
        if proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
        code = proc.wait()
    if code is not None:
        drain_master()
        emit({"type": "exit", "exitCode": code})
        break
`;
}

function pythonCommandForPty() {
  if (process.platform === "win32") return "";
  for (const command of ["python3", "python"]) {
    const result = spawnSync(command, ["-c", "import pty,sys; sys.exit(0)"], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "ignore", "ignore"],
    });
    if (result.status === 0) return command;
  }
  return "";
}

function trimPtyHistory(session) {
  const maxEntries = 5000;
  const maxBytes = 2 * 1024 * 1024;
  let bytes = session.history.reduce((total, item) => total + String(item.data || "").length, 0);
  while (session.history.length > maxEntries || bytes > maxBytes) {
    const item = session.history.shift();
    bytes -= String(item?.data || "").length;
    session.historyTrimmed = true;
  }
}

function ptyControlWrite(child, frame) {
  if (!child?.stdin || child.stdin.destroyed) return false;
  try {
    child.stdin.write(`${JSON.stringify(frame)}\n`);
    return true;
  } catch {
    return false;
  }
}

function attachLocalPtySession(session, message, emitFrame) {
  const requestId = String(message.requestId || session.requestId || "");
  const lastSeq = Math.max(0, Number(message.lastSeq || 0) || 0);
  session.requestId = requestId;
  session.handler = emitFrame;
  if (message.cols || message.rows) {
    ptyControlWrite(session.child, {
      type: "resize",
      cols: clampNumber(message.cols, 100, 20, 400),
      rows: clampNumber(message.rows, 30, 5, 200),
    });
  }
  setTimeout(() => {
    for (const item of session.history) {
      if (Number(item.seq || 0) > lastSeq && session.handler) {
        session.handler({
          type: "pty.output",
          requestId: session.requestId,
          sessionId: session.sessionId,
          data: item.data,
          seq: item.seq,
          replay: true,
        });
      }
    }
  }, 0).unref?.();
  return {
    type: "pty.open.response",
    requestId,
    sessionId: session.sessionId,
    ok: true,
    reconnected: true,
    pid: session.pid || null,
    cwd: session.cwd,
    seq: session.seq,
    historyTrimmed: Boolean(session.historyTrimmed),
  };
}

async function openLocalPtySession(message, options = {}, sessions = new Map(), emitFrame = () => {}, log = () => {}) {
  const policy = localCommandPolicy(options);
  const requestId = String(message.requestId || "");
  const sessionId = String(message.sessionId || requestId || createRunId()).trim();
  if (!policy.enabled) {
    return {
      type: "pty.open.response",
      requestId,
      sessionId,
      ok: false,
      code: "local_command_disabled",
      error: "本机命令行能力未开启。请在本机运行 anyenv restart --workspace . --allow-local-commands 后重试。",
      commandExecution: policy,
    };
  }
  let cwd = "";
  try {
    cwd = resolveCommandCwd(policy, message.cwd);
  } catch (error) {
    return {
      type: "pty.open.response",
      requestId,
      sessionId,
      ok: false,
      code: error.code || "invalid_cwd",
      error: error.message || "Shell 工作目录无效。",
      cwd: error.cwd || "",
      allowedRoots: error.allowedRoots || policy.roots,
      commandExecution: policy,
    };
  }
  const existing = sessions.get(sessionId);
  if (existing && !existing.closed) {
    return attachLocalPtySession(existing, { ...message, requestId }, emitFrame);
  }
  const python = pythonCommandForPty();
  if (!python) {
    return {
      type: "pty.open.response",
      requestId,
      sessionId,
      ok: false,
      code: "pty_unavailable",
      error: "当前系统缺少可用 Python PTY 运行时，无法启动真实本机 Shell。",
      commandExecution: policy,
    };
  }

  return await new Promise((resolve) => {
    let settled = false;
    let stdoutBuffer = "";
    const session = {
      sessionId,
      requestId,
      cwd,
      child: null,
      handler: emitFrame,
      seq: 0,
      history: [],
      historyTrimmed: false,
      closed: false,
      exitSent: false,
      pid: null,
    };
    const finishOpen = (payload) => {
      if (settled) return;
      settled = true;
      resolve({
        type: "pty.open.response",
        requestId,
        sessionId,
        cwd,
        commandExecution: policy,
        ...payload,
      });
    };
    const sendOutput = (data) => {
      if (!data || session.closed) return;
      session.seq += 1;
      const item = { seq: session.seq, data };
      session.history.push(item);
      trimPtyHistory(session);
      if (session.handler) {
        session.handler({
          type: "pty.output",
          requestId: session.requestId,
          sessionId,
          data,
          seq: session.seq,
        });
      }
    };
    const sendError = (code, messageText) => {
      if (session.handler) {
        session.handler({
          type: "pty.error",
          requestId: session.requestId,
          sessionId,
          code,
          error: messageText,
        });
      }
    };
    const childEnv = commandEnvironment(cwd);
    if (!childEnv.TERM || ["dumb", "unknown"].includes(String(childEnv.TERM).toLowerCase())) {
      childEnv.TERM = "xterm-256color";
    }
    childEnv.ANYENV_LOCAL_PTY = "1";
    let child = null;
    try {
      child = spawn(
        python,
        [
          "-u",
          "-c",
          pythonPtyHelperSource(),
          cwd,
          String(clampNumber(message.cols, 100, 20, 400)),
          String(clampNumber(message.rows, 30, 5, 200)),
        ],
        {
          cwd,
          env: childEnv,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      );
    } catch (error) {
      finishOpen({
        ok: false,
        code: "pty_spawn_failed",
        error: errorMessage(error) || "本机 Shell 启动失败。",
      });
      return;
    }
    session.child = child;
    sessions.set(sessionId, session);
    child.stdin?.on("error", () => {
      // The PTY helper can close stdin while the browser is still disconnecting.
    });
    child.stdout?.on("data", (chunk) => {
      stdoutBuffer += String(chunk || "");
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let frame = null;
        try {
          frame = JSON.parse(line);
        } catch (error) {
          log("pty.helper.parse_failed", { sessionId, message: errorMessage(error) });
          continue;
        }
        if (frame.type === "ready") {
          session.pid = frame.pid || null;
          log("pty.ready", { requestId, sessionId, pid: session.pid, cwd });
          finishOpen({
            ok: true,
            pid: session.pid,
            shell: frame.shell || "",
            reconnected: false,
          });
        } else if (frame.type === "output") {
          sendOutput(String(frame.data || ""));
        } else if (frame.type === "error") {
          sendError(String(frame.error || "pty_error"), String(frame.message || frame.error || "PTY 错误"));
        } else if (frame.type === "exit") {
          session.closed = true;
          if (session.exitSent) continue;
          session.exitSent = true;
          sessions.delete(sessionId);
          const payload = {
            type: "pty.exit",
            requestId: session.requestId,
            sessionId,
            ok: Number(frame.exitCode || 0) === 0,
            exitCode: Number(frame.exitCode || 0),
            seq: session.seq,
          };
          session.handler?.(payload);
        }
      }
    });
    child.stderr?.on("data", (chunk) => {
      sendError("pty_helper_stderr", String(chunk || "").slice(0, 2000));
    });
    child.on("error", (error) => {
      sessions.delete(sessionId);
      session.closed = true;
      finishOpen({
        ok: false,
        code: "pty_spawn_failed",
        error: errorMessage(error) || "本机 Shell 启动失败。",
      });
      sendError("pty_spawn_failed", errorMessage(error));
    });
    child.on("close", (exitCode, signal) => {
      sessions.delete(sessionId);
      session.closed = true;
      if (!settled) {
        finishOpen({
          ok: false,
          code: "pty_closed_before_ready",
          error: "本机 Shell 启动后立即退出。",
          exitCode,
          signal,
        });
        return;
      }
      if (session.exitSent) return;
      session.exitSent = true;
      session.handler?.({
        type: "pty.exit",
        requestId: session.requestId,
        sessionId,
        ok: exitCode === 0,
        exitCode,
        signal,
        seq: session.seq,
      });
    });
  });
}

function closeLocalPtySessions(sessions, reason = "daemon_stopped") {
  for (const [sessionId, session] of sessions.entries()) {
    sessions.delete(sessionId);
    session.closed = true;
    session.handler = null;
    try {
      ptyControlWrite(session.child, { type: "close", reason });
    } catch {
      // Ignore close races.
    }
    setTimeout(() => {
      try {
        if (session.child && !session.child.killed) session.child.kill("SIGKILL");
      } catch {
        // Ignore close races.
      }
    }, 1500).unref?.();
  }
}

function decodePtyOutput(data) {
  try {
    return Buffer.from(String(data || ""), "base64").toString("utf8");
  } catch {
    return "";
  }
}

function encodePtyInput(data) {
  return Buffer.from(String(data || ""), "utf8").toString("base64");
}

function safeSendLocalBridgeJson(ws, payload) {
  try {
    if (ws.readyState === 1) ws.send(JSON.stringify(payload));
  } catch {
    // Ignore browser disconnect races.
  }
}

function localBridgeOriginAllowed(origin) {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();
    return host === "localhost"
      || host === "127.0.0.1"
      || host === "::1"
      || host === "www.anyenv.cn"
      || host === "anyenv.cn"
      || host.endsWith(".anyenv.cn");
  } catch {
    return false;
  }
}

async function handleLocalShellBridgeConnection(ws, req, context, config, options, sessions, log) {
  const sessionId = context.sessionId;
  let authenticated = false;
  let requestId = "";
  const closeWithError = (message, code = "bridge_error", closeCode = 4001) => {
    safeSendLocalBridgeJson(ws, { type: "error", code, message });
    try {
      ws.close(closeCode);
    } catch {
      // Ignore close races.
    }
  };
  const sendBridgeEvent = (event) => {
    const type = String(event.type || "");
    if (type === "pty.output") {
      safeSendLocalBridgeJson(ws, {
        type: "output",
        data: decodePtyOutput(event.data),
        seq: event.seq,
        replay: Boolean(event.replay),
      });
      return;
    }
    if (type === "pty.exit" || type === "pty.close") {
      safeSendLocalBridgeJson(ws, {
        type: "exit",
        exitCode: event.exitCode,
        signal: event.signal,
        ok: event.ok,
      });
      return;
    }
    if (type === "pty.error") {
      safeSendLocalBridgeJson(ws, {
        type: "error",
        code: event.code || "pty_error",
        message: event.error || event.message || "本机 Shell 错误",
      });
    }
  };
  const authTimer = setTimeout(() => {
    if (!authenticated) closeWithError("认证超时", "auth_timeout", 4001);
  }, Math.max(5, Number(options.authTimeoutSeconds || 15)) * 1000);

  ws.on("message", (raw) => {
    let message = null;
    try {
      message = JSON.parse(String(raw));
    } catch {
      if (!authenticated) closeWithError("认证失败: 首帧必须是 JSON", "bad_auth_frame", 4001);
      return;
    }
    if (!authenticated) {
      if (!message || message.type !== "auth") {
        closeWithError("认证失败: 首帧必须为 auth", "bad_auth_frame", 4001);
        return;
      }
      const bridgeToken = String(message.bridgeToken || "");
      if (!context.bridgeToken || bridgeToken !== context.bridgeToken) {
        closeWithError("认证失败，请重新登录 AnyEnv", "auth_failed", 4001);
        return;
      }
      if (String(message.clientId || config.clientId) !== config.clientId) {
        closeWithError("本机 bridge clientId 不匹配", "client_mismatch", 4003);
        return;
      }
      authenticated = true;
      clearTimeout(authTimer);
      requestId = String(message.requestId || `local-${sessionId}-${Date.now().toString(36)}`);
      log("local_bridge.pty.open", {
        requestId,
        sessionId,
        cwd: message.cwd || "",
        lastSeq: Number(message.lastSeq || 0) || 0,
      });
      openLocalPtySession(
        {
          type: "pty.open.request",
          requestId,
          sessionId,
          cwd: message.cwd || "",
          cols: message.cols,
          rows: message.rows,
          lastSeq: message.lastSeq,
        },
        options,
        sessions,
        sendBridgeEvent,
        log,
      )
        .then((response) => {
          if (!response.ok) {
            closeWithError(response.error || "本机 Shell 启动失败", response.code || "pty_open_failed", 1011);
            return;
          }
          safeSendLocalBridgeJson(ws, {
            type: "ready",
            sessionId,
            requestId,
            reconnected: Boolean(response.reconnected),
            pid: response.pid,
            seq: response.seq || Number(message.lastSeq || 0) || 0,
            historyTrimmed: Boolean(response.historyTrimmed),
            transport: "local-bridge",
          });
        })
        .catch((error) => {
          closeWithError(errorMessage(error) || "本机 Shell 启动失败", "pty_handler_failed", 1011);
        });
      return;
    }

    const session = sessions.get(sessionId);
    if (!session) {
      safeSendLocalBridgeJson(ws, {
        type: "error",
        code: "pty_session_not_found",
        message: "本机 Shell 会话不存在或已结束。",
      });
      return;
    }
    session.requestId = requestId || session.requestId;
    session.handler = sendBridgeEvent;
    const ftype = String(message.type || "");
    if (ftype === "input") {
      ptyControlWrite(session.child, { type: "input", data: encodePtyInput(message.data) });
    } else if (ftype === "resize") {
      ptyControlWrite(session.child, {
        type: "resize",
        cols: clampNumber(message.cols, 100, 20, 400),
        rows: clampNumber(message.rows, 30, 5, 200),
      });
    } else if (ftype === "close") {
      sessions.delete(sessionId);
      session.closed = true;
      ptyControlWrite(session.child, { type: "close", reason: "closed_by_local_browser" });
      setTimeout(() => {
        try {
          if (session.child && !session.child.killed) session.child.kill("SIGKILL");
        } catch {
          // Ignore close races.
        }
      }, 1500).unref?.();
    }
  });

  ws.on("close", () => {
    clearTimeout(authTimer);
    const session = sessions.get(sessionId);
    if (session) session.handler = null;
  });
  ws.on("error", (error) => {
    log("local_bridge.ws.error", { sessionId, message: errorMessage(error) });
  });
}

async function startLocalShellBridge(config, options = {}, sessions = new Map(), runId = "") {
  if (!localCommandPolicy(options).enabled || options.disableLocalBridge) return null;
  const bridgeToken = crypto.randomBytes(24).toString("base64url");
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify({ ok: true, service: "anyenv-local-shell-bridge", clientId: config.clientId }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: false, error: "not_found" }));
  });
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set();
  wss.on("connection", (ws, req, context) => {
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
    const log = (event, detail = {}) => deviceLog(event, { runId, localBridge: true, ...detail });
    void handleLocalShellBridgeConnection(ws, req, { ...context, bridgeToken }, config, options, sessions, log);
  });
  server.on("upgrade", (req, socket, head) => {
    if (!localBridgeOriginAllowed(req.headers.origin || "")) {
      socket.destroy();
      return;
    }
    let sessionId = "";
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const match = url.pathname.match(/^\/ws\/local-shell\/([^/]+)\/pty$/);
      sessionId = match ? decodeURIComponent(match[1]) : "";
    } catch {
      sessionId = "";
    }
    if (!sessionId) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, { sessionId });
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const metadata = {
    enabled: true,
    protocol: "anyenv-local-shell-bridge-v1",
    host: "127.0.0.1",
    port,
    wsBase: `ws://127.0.0.1:${port}`,
    auth: "local-bridge-token",
    token: bridgeToken,
    startedAt: new Date().toISOString(),
  };
  deviceLog("local_bridge.start", { runId, port, protocol: metadata.protocol });
  return {
    metadata,
    close: () => {
      for (const ws of sockets) {
        try {
          ws.close(1001, "bridge_closed");
        } catch {
          // Ignore close races.
        }
      }
      try {
        wss.close();
      } catch {
        // Ignore close races.
      }
      try {
        server.close();
      } catch {
        // Ignore close races.
      }
    },
  };
}

function detachLocalPtySessions(sessions) {
  for (const session of sessions.values()) {
    session.handler = null;
  }
}

function appendLimitedOutput(state, stream, chunk) {
  if (state.bytes >= state.maxBytes) {
    state.truncated = true;
    return "";
  }
  const text = String(chunk || "");
  const bytes = Buffer.byteLength(text, "utf8");
  const remaining = state.maxBytes - state.bytes;
  if (bytes <= remaining) {
    state[stream].push(text);
    state.bytes += bytes;
    return text;
  }
  const limited = Buffer.from(text).subarray(0, remaining).toString("utf8");
  state[stream].push(limited);
  state.bytes += remaining;
  state.truncated = true;
  return limited;
}

function providerNativeToolKey(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isProviderNativeInteractionTool(name) {
  const raw = String(name || "").trim().toLowerCase();
  if (raw === "ask_user_question") return false;
  return new Set(["askuserquestion", "requestuserinput", "requestinput", "userinput"]).has(providerNativeToolKey(name));
}

function clipText(value, limit) {
  const text = value == null ? "" : String(value);
  return text.length <= limit ? text : text.slice(0, limit);
}

function contentItems(message) {
  if (!message || typeof message !== "object") return [];
  if (Array.isArray(message.content)) return message.content;
  return Array.isArray(message.parts) ? message.parts : [];
}

function parseMaybeJsonObject(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function optionItem(value, index) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const label = String(value.label || value.text || value.title || value.value || "").trim();
    return {
      id: String(value.id || value.value || `option_${index + 1}`),
      label: clipText(label || `选项 ${index + 1}`, 80),
      description: clipText(value.description || value.desc || "", 240),
      recommended: Boolean(value.recommended || value.default),
    };
  }
  return {
    id: `option_${index + 1}`,
    label: clipText(value, 80) || `选项 ${index + 1}`,
    description: "",
    recommended: false,
  };
}

function optionsList(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).map((item, index) => optionItem(item, index));
}

function questionText(data) {
  for (const key of ["question", "prompt", "message", "text", "description"]) {
    const value = data?.[key];
    if (typeof value === "string" && value.trim()) return clipText(value.trim(), 1200);
  }
  return "";
}

function providerNativeInteractionPart(toolUseId, name, input) {
  const data = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const title = String(data.title || data.header || data.name || "Agent 提问").trim();
  const prompt = questionText(data);
  const rootOptions = optionsList(data.options || data.choices);
  const questions = [];
  if (Array.isArray(data.questions)) {
    for (const [index, raw] of data.questions.slice(0, 6).entries()) {
      const item = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : { question: raw };
      const opts = optionsList(item.options || item.choices);
      const qText = questionText(item) || prompt || String(item.id || `question_${index + 1}`);
      questions.push({
        id: String(item.id || `question_${index + 1}`),
        header: clipText(item.header || item.title || title, 40),
        question: qText,
        multiSelect: Boolean(item.multiSelect || item.multi_select || item.multiple),
        allowOther: Boolean(item.allowOther ?? item.allow_other ?? true),
        options: opts.length ? opts : rootOptions,
      });
    }
  }
  if (!questions.length) {
    questions.push({
      id: String(data.questionId || data.question_id || "answer"),
      header: clipText(title, 40),
      question: prompt || title,
      multiSelect: Boolean(data.multiSelect || data.multi_select || data.multiple),
      allowOther: Boolean(data.allowOther ?? data.allow_other ?? true),
      options: rootOptions,
    });
  }
  const options = rootOptions.length ? rootOptions : (questions[0]?.options || []);
  const id = String(toolUseId || data.requestId || data.id || `native-${providerNativeToolKey(name)}`);
  return {
    type: "interaction",
    interactionId: id,
    interactionType: options.length ? "choice" : "question",
    status: "pending",
    title: clipText(title, 80),
    prompt: prompt || questions[0]?.question || "",
    toolUseId: String(toolUseId || data.requestId || data.id || ""),
    toolName: String(name || ""),
    toolInput: data,
    questions,
    options,
    response: {},
    source: "provider_native_stream",
  };
}

function providerNativePartsFromLine(line) {
  const text = String(line || "").trim();
  if (!text || text[0] !== "{") return [];
  let obj = null;
  try {
    obj = JSON.parse(text);
  } catch {
    return [];
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return [];
  if (obj.type === "interaction" && obj.source === "provider_native_stream") {
    return obj.toolUseId || obj.interactionId ? [obj] : [];
  }

  const out = [];
  const pushFunctionCall = (call) => {
    if (!call || typeof call !== "object") return;
    const name = String(call.name || call.function?.name || "").trim();
    if (!name || !isProviderNativeInteractionTool(name)) return;
    const input = parseMaybeJsonObject(call.args || call.arguments || call.input || call.function?.arguments);
    const toolUseId = String(call.id || call.call_id || call.callId || call.tool_call_id || input.requestId || input.id || "").trim();
    out.push(providerNativeInteractionPart(toolUseId, name, input));
  };

  if (obj.type === "assistant") {
    for (const item of contentItems(obj.message || {})) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      if (item.type === "tool_use") {
        const name = String(item.name || "").trim();
        if (name && isProviderNativeInteractionTool(name)) {
          out.push(providerNativeInteractionPart(String(item.id || "").trim(), name, item.input || {}));
        }
      } else if (item.functionCall && typeof item.functionCall === "object") {
        pushFunctionCall(item.functionCall);
      }
    }
  } else if (obj.type === "function_call" || obj.type === "tool_call") {
    pushFunctionCall(obj);
  } else if (obj.functionCall && typeof obj.functionCall === "object") {
    pushFunctionCall(obj.functionCall);
  }
  return out;
}

function apiEndpoint(apiBase, pathname) {
  return `${String(apiBase || "").replace(/\/+$/, "")}${pathname}`;
}

function providerNativeStdinError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function providerNativeWriteErrorReason(error) {
  return String(error?.code || errorMessage(error) || "child_stdin_write_failed").slice(0, 500);
}

function providerNativePayloadHash(payloadText) {
  return crypto.createHash("sha256").update(String(payloadText || ""), "utf8").digest("hex");
}

async function reportProviderNativeWriteBackResult({
  config,
  message,
  responseBody,
  toolUseId,
  payloadText,
  status,
  reason,
  extra = {},
}) {
  const token = String(message.interactionToken || "").trim();
  if (!token || typeof fetch !== "function") return false;
  try {
    const response = await fetch(apiEndpoint(config.apiBase, "/internal/interactions/provider-native/write-back-result"), {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        interactionId: String(responseBody?.interactionId || ""),
        toolUseId,
        status,
        reason: String(reason || "").slice(0, 500),
        format: String(responseBody?.format || responseBody?.envelope?.format || ""),
        bytes: Buffer.byteLength(String(payloadText || ""), "utf8"),
        payloadTextSha256: payloadText ? providerNativePayloadHash(payloadText) : "",
        deliveryMode: "local_cli_stdin",
        ...extra,
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function providerNativeCallbackRecoveryMarker(message, part) {
  const input = part?.toolInput && typeof part.toolInput === "object" ? part.toolInput : {};
  for (const value of [
    input.callbackRecoveryMarker,
    input.recoveryMarker,
    input.expectedOutputMarker,
    message.providerNativeCallbackRecoveryMarker,
    message.callbackRecoveryMarker,
  ]) {
    const marker = String(value || "").trim();
    if (marker) return marker.slice(0, 500);
  }
  return "";
}

function providerNativeCallbackRecoveryTimeoutMs(message, part) {
  const input = part?.toolInput && typeof part.toolInput === "object" ? part.toolInput : {};
  const seconds = clampNumber(
    input.callbackRecoveryTimeoutSeconds ?? message.providerNativeCallbackRecoveryTimeoutSeconds,
    30,
    1,
    600,
  );
  return Math.round(seconds * 1000);
}

function writeProviderNativePayload(child, payloadText) {
  const stdin = child?.stdin;
  if (!stdin || stdin.destroyed || !stdin.writable) {
    return Promise.reject(providerNativeStdinError("child_stdin_unavailable", "child stdin is unavailable"));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (error) => {
      if (settled) return;
      settled = true;
      stdin.off?.("error", onError);
      stdin.off?.("close", onClose);
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };
    const onError = (error) => done(error || providerNativeStdinError("child_stdin_error", "child stdin errored"));
    const onClose = () => done(providerNativeStdinError("child_stdin_closed", "child stdin closed before write completed"));
    stdin.once("error", onError);
    stdin.once("close", onClose);
    try {
      stdin.write(payloadText, (error) => done(error || null));
    } catch (error) {
      done(error);
    }
  });
}

async function providerNativeAskAndWrite({ config, message, part, child, emit, controllers, recovery }) {
  const token = String(message.interactionToken || "").trim();
  const toolUseId = String(part.toolUseId || part.interactionId || "").trim();
  if (!token) {
    emit({ event: "provider_native.write_back.skipped", toolUseId, reason: "missing_interaction_token" });
    return;
  }
  if (typeof fetch !== "function") {
    emit({ event: "provider_native.write_back.skipped", toolUseId, reason: "fetch_unavailable" });
    return;
  }
  const controller = new AbortController();
  controllers.add(controller);
  try {
    emit({ event: "provider_native.interaction.required", toolUseId, toolName: part.toolName || "" });
    const response = await fetch(apiEndpoint(config.apiBase, "/internal/interactions/provider-native/ask"), {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        part,
        wait: true,
        timeoutSeconds: clampNumber(message.interactionTimeoutSeconds, 21600, 30, 21600),
        pollSeconds: 1,
        dryRun: false,
      }),
      signal: controller.signal,
    });
    let body = null;
    const raw = await response.text();
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = { detail: raw };
    }
    if (!response.ok) {
      emit({
        event: "provider_native.write_back.failed",
        toolUseId,
        statusCode: response.status,
        reason: String(body?.detail?.code || body?.detail || body?.error || response.statusText || "request_failed").slice(0, 500),
      });
      return;
    }
    const payloadText = String(body?.envelope?.payloadText || "");
    if (!body?.ready || !payloadText) {
      emit({
        event: "provider_native.write_back.not_ready",
        toolUseId,
        status: String(body?.status || ""),
        reason: String(body?.reason || ""),
      });
      return;
    }
    if (!child?.stdin || child.stdin.destroyed || !child.stdin.writable) {
      emit({ event: "provider_native.write_back.failed", toolUseId, reason: "child_stdin_unavailable" });
      return;
    }
    try {
      await writeProviderNativePayload(child, payloadText);
    } catch (error) {
      const reason = providerNativeWriteErrorReason(error);
      const auditReported = await reportProviderNativeWriteBackResult({
        config,
        message,
        responseBody: body,
        toolUseId,
        payloadText,
        status: "failed",
        reason,
      });
      emit({ event: "provider_native.write_back.failed", toolUseId, reason, auditReported });
      return;
    }
    const recoveryMarker = providerNativeCallbackRecoveryMarker(message, part);
    if (recoveryMarker && recovery && typeof recovery.watch === "function") {
      recovery.watch({
        toolUseId,
        responseBody: body,
        payloadText,
        marker: recoveryMarker,
        timeoutMs: providerNativeCallbackRecoveryTimeoutMs(message, part),
      });
    }
    const auditReported = await reportProviderNativeWriteBackResult({
      config,
      message,
      responseBody: body,
      toolUseId,
      payloadText,
      status: "delivered",
    });
    emit({
      event: "provider_native.write_back.delivered",
      toolUseId,
      format: String(body?.format || body?.envelope?.format || ""),
      bytes: Buffer.byteLength(payloadText, "utf8"),
      auditReported,
    });
  } catch (error) {
    if (controller.signal.aborted) return;
    emit({ event: "provider_native.write_back.failed", toolUseId, reason: errorMessage(error).slice(0, 500) });
  } finally {
    controllers.delete(controller);
  }
}

export async function localCommandResponse(config, message = {}, options = {}, onEvent = null) {
  const policy = localCommandPolicy(options);
  const requestId = message.requestId || "";
  if (!policy.enabled) {
    return {
      type: "command.response",
      requestId,
      ok: false,
      code: "local_command_disabled",
      error: "本机命令行能力未开启。请在本机运行 anyenv restart --workspace . --allow-local-commands 后重试。",
      commandExecution: policy,
    };
  }
  const command = String(message.command || "").trim();
  if (!command) {
    return {
      type: "command.response",
      requestId,
      ok: false,
      code: "empty_command",
      error: "命令不能为空。",
      commandExecution: policy,
    };
  }
  if (command.includes("\0")) {
    return {
      type: "command.response",
      requestId,
      ok: false,
      code: "invalid_command",
      error: "命令包含非法字符。",
      commandExecution: policy,
    };
  }

  let cwd = "";
  try {
    cwd = resolveCommandCwd(policy, message.cwd);
  } catch (error) {
    return {
      type: "command.response",
      requestId,
      ok: false,
      code: error.code || "invalid_cwd",
      error: error.message || "命令工作目录无效。",
      cwd: error.cwd || "",
      allowedRoots: error.allowedRoots || policy.roots,
      commandExecution: policy,
    };
  }

  const timeoutSeconds = Math.min(
    policy.timeoutSeconds,
    clampNumber(message.timeoutSeconds, policy.timeoutSeconds, 1, 21600),
  );
  const maxOutputBytes = Math.min(
    policy.maxOutputBytes,
    clampNumber(message.maxOutputBytes, policy.maxOutputBytes, 1024, 2097152),
  );
  const startedAt = Date.now();
  const output = {
    stdout: [],
    stderr: [],
    bytes: 0,
    maxBytes: maxOutputBytes,
    truncated: false,
  };
  let eventSequence = 0;
  const emitOutput = (stream, chunk) => {
    const data = appendLimitedOutput(output, stream, chunk);
    if (!data || typeof onEvent !== "function") return;
    eventSequence += 1;
    onEvent({
      type: "command.event",
      requestId,
      event: "output",
      stream,
      data,
      sequence: eventSequence,
      timestamp: new Date().toISOString(),
    });
  };

  return await new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let child = null;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        type: "command.response",
        requestId,
        command,
        cwd,
        durationMs: Date.now() - startedAt,
        stdout: output.stdout.join(""),
        stderr: output.stderr.join(""),
        truncated: output.truncated,
        commandExecution: {
          ...policy,
          timeoutSeconds,
          maxOutputBytes,
        },
        ...payload,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (child) {
        try {
          child.kill("SIGTERM");
        } catch {}
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {}
        }, 1000).unref?.();
      }
    }, timeoutSeconds * 1000);

    try {
      child = spawn(command, {
        cwd,
        shell: true,
        env: commandEnvironment(cwd),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      finish({
        ok: false,
        code: "spawn_failed",
        error: error?.message || "本地命令启动失败。",
        exitCode: null,
        signal: null,
      });
      return;
    }

    child.stdout?.on("data", (chunk) => emitOutput("stdout", chunk));
    child.stderr?.on("data", (chunk) => emitOutput("stderr", chunk));
    child.on("error", (error) => {
      finish({
        ok: false,
        code: "spawn_failed",
        error: error?.message || "本地命令执行失败。",
        exitCode: null,
        signal: null,
      });
    });
    child.on("close", (exitCode, signal) => {
      finish({
        ok: !timedOut && exitCode === 0,
        code: timedOut ? "command_timeout" : (exitCode === 0 ? "" : "command_failed"),
        error: timedOut ? `命令执行超过 ${timeoutSeconds} 秒,已终止。` : "",
        exitCode,
        signal,
      });
    });
  });
}

export function startLocalAgentRun(config, message = {}, options = {}, onEvent = () => {}) {
  const policy = localCommandPolicy(options);
  const requestId = message.requestId || "";
  const agentId = String(message.agentId || "").trim().toLowerCase();
  const content = String(message.content || "").trim();
  const commandSpec = LOCAL_AGENT_COMMANDS[agentId]?.(content);
  const fail = (payload) => ({
    promise: Promise.resolve({
      type: "agent.run.response",
      requestId,
      ok: false,
      agentId,
      ...payload,
    }),
    cancel: () => {},
  });
  if (!policy.enabled) {
    return fail({
      code: "local_command_disabled",
      error: "本机命令行能力未开启。请在本机运行 anyenv restart --workspace . --allow-local-commands 后重试。",
      commandExecution: policy,
    });
  }
  if (!commandSpec) {
    return fail({
      code: "unsupported_agent",
      error: "当前本机 Agent run 协议暂不支持该 agent。",
      supportedAgents: Object.keys(LOCAL_AGENT_COMMANDS),
    });
  }
  if (!content) {
    return fail({ code: "empty_prompt", error: "Agent 指令不能为空。" });
  }

  let cwd = "";
  try {
    cwd = resolveCommandCwd(policy, message.cwd);
  } catch (error) {
    return fail({
      code: error.code || "invalid_cwd",
      error: error.message || "Agent 工作目录无效。",
      cwd: error.cwd || "",
      allowedRoots: error.allowedRoots || policy.roots,
      commandExecution: policy,
    });
  }

  const toolPath = commandExists(commandSpec.command);
  if (!toolPath) {
    return fail({
      code: "agent_tool_not_found",
      error: `本机未找到 ${commandSpec.command}，请先安装或登录对应 AI coding CLI。`,
      command: commandSpec.command,
    });
  }

  const timeoutSeconds = Math.min(
    policy.timeoutSeconds,
    clampNumber(message.timeoutSeconds, policy.timeoutSeconds, 1, 600),
  );
  const maxOutputBytes = Math.min(
    Math.max(policy.maxOutputBytes, 131072),
    clampNumber(message.maxOutputBytes, Math.max(policy.maxOutputBytes, 131072), 1024, 524288),
  );
  const startedAt = Date.now();
  const output = {
    stdout: [],
    stderr: [],
    bytes: 0,
    maxBytes: maxOutputBytes,
    truncated: false,
  };

  let child = null;
  let cancelRequested = false;
  let cancelReason = "";
  let cancelSignal = "SIGTERM";
  let stdoutLineBuffer = "";
  let stdoutBufferInspectTimer = null;
  let childClosed = false;
  const providerNativeControllers = new Set();
  const providerNativeInFlight = new Set();
  const providerNativeRecoveryWatchers = new Map();

  const emit = (payload) => {
    try {
      onEvent({
        type: "agent.run.event",
        requestId,
        agentId,
        ...payload,
      });
    } catch {
      // Event delivery is best effort; the final response remains authoritative.
    }
  };
  const removeProviderNativeRecoveryWatcher = (toolUseId) => {
    const watcher = providerNativeRecoveryWatchers.get(toolUseId);
    if (!watcher) return null;
    providerNativeRecoveryWatchers.delete(toolUseId);
    if (watcher.timer) clearTimeout(watcher.timer);
    return watcher;
  };
  const reportProviderNativeCallbackRecovery = async (watcher, status, reason = "") => {
    const recovered = status === "callback_recovered";
    const auditReported = await reportProviderNativeWriteBackResult({
      config,
      message,
      responseBody: watcher.responseBody,
      toolUseId: watcher.toolUseId,
      payloadText: watcher.payloadText,
      status,
      reason,
      extra: {
        callbackMarkerSha256: providerNativePayloadHash(watcher.marker),
        elapsedMs: Math.max(0, Date.now() - watcher.startedAt),
      },
    });
    emit({
      event: recovered ? "provider_native.callback.recovered" : "provider_native.callback.failed",
      toolUseId: watcher.toolUseId,
      reason,
      auditReported,
    });
  };
  const failProviderNativeCallbackRecovery = (toolUseId, reason) => {
    const watcher = removeProviderNativeRecoveryWatcher(toolUseId);
    if (!watcher) return;
    void reportProviderNativeCallbackRecovery(watcher, "callback_recovery_failed", reason);
  };
  const providerNativeRecovery = {
    watch({ toolUseId, responseBody, payloadText, marker, timeoutMs }) {
      const id = String(toolUseId || responseBody?.toolUseId || "").trim();
      const recoveryMarker = String(marker || "").trim();
      if (!id || !recoveryMarker) return;
      removeProviderNativeRecoveryWatcher(id);
      const watcher = {
        toolUseId: id,
        responseBody,
        payloadText,
        marker: recoveryMarker,
        startedAt: Date.now(),
        timer: null,
      };
      watcher.timer = setTimeout(() => {
        failProviderNativeCallbackRecovery(id, "provider_callback_recovery_marker_timeout");
      }, Math.max(1, timeoutMs || 30000));
      watcher.timer.unref?.();
      providerNativeRecoveryWatchers.set(id, watcher);
      emit({
        event: "provider_native.callback.watch_started",
        toolUseId: id,
        timeoutMs: Math.max(1, timeoutMs || 30000),
      });
    },
    inspect(text) {
      const chunk = String(text || "");
      if (!chunk || providerNativeRecoveryWatchers.size === 0) return;
      for (const watcher of Array.from(providerNativeRecoveryWatchers.values())) {
        if (!chunk.includes(watcher.marker)) continue;
        removeProviderNativeRecoveryWatcher(watcher.toolUseId);
        void reportProviderNativeCallbackRecovery(watcher, "callback_recovered");
      }
    },
    failAll(reason) {
      for (const toolUseId of Array.from(providerNativeRecoveryWatchers.keys())) {
        failProviderNativeCallbackRecovery(toolUseId, reason);
      }
    },
  };
  const abortProviderNativeWaits = () => {
    for (const controller of providerNativeControllers) {
      try {
        controller.abort();
      } catch {}
    }
    providerNativeControllers.clear();
  };
  const clearBufferedProviderNativeInspection = () => {
    if (!stdoutBufferInspectTimer) return;
    clearTimeout(stdoutBufferInspectTimer);
    stdoutBufferInspectTimer = null;
  };
  const inspectProviderNativeLine = (line) => {
    if (childClosed) return;
    for (const part of providerNativePartsFromLine(line)) {
      const toolUseId = String(part.toolUseId || part.interactionId || "").trim();
      if (!toolUseId || providerNativeInFlight.has(toolUseId)) continue;
      providerNativeInFlight.add(toolUseId);
      providerNativeAskAndWrite({
        config,
        message,
        part,
        child,
        emit,
        controllers: providerNativeControllers,
        recovery: providerNativeRecovery,
      }).finally(() => {
        providerNativeInFlight.delete(toolUseId);
      });
    }
  };
  const scheduleBufferedProviderNativeInspection = () => {
    if (stdoutBufferInspectTimer || childClosed || !stdoutLineBuffer.trim()) return;
    stdoutBufferInspectTimer = setTimeout(() => {
      stdoutBufferInspectTimer = null;
      if (childClosed || !stdoutLineBuffer.trim()) return;
      const bufferedLine = stdoutLineBuffer;
      if (providerNativePartsFromLine(bufferedLine).length === 0) return;
      stdoutLineBuffer = "";
      inspectProviderNativeLine(bufferedLine);
    }, 100);
    stdoutBufferInspectTimer.unref?.();
  };

  const promise = new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      childClosed = true;
      clearBufferedProviderNativeInspection();
      abortProviderNativeWaits();
      resolve({
        type: "agent.run.response",
        requestId,
        agentId,
        command: commandSpec.command,
        argv: [commandSpec.command, ...commandSpec.args],
        cwd,
        durationMs: Date.now() - startedAt,
        stdout: output.stdout.join(""),
        stderr: output.stderr.join(""),
        truncated: output.truncated,
        commandExecution: {
          ...policy,
          timeoutSeconds,
          maxOutputBytes,
        },
        ...payload,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (child && !child.killed) child.kill("SIGTERM");
    }, timeoutSeconds * 1000);

    emit({
      event: "run.started",
      cwd,
      command: commandSpec.command,
      argv: [commandSpec.command, ...commandSpec.args],
    });

    try {
      child = spawn(toolPath, commandSpec.args, {
        cwd,
        shell: false,
        env: {
          ...commandEnvironment(cwd),
          ANYENV_LOCAL_AGENT_RUN: "1",
          ANYENV_AGENT_ID: agentId,
          ANYENV_INTERACTION_API_BASE: config.apiBase || "",
          ANYENV_INTERACTION_TOKEN: message.interactionToken || "",
        },
        windowsHide: true,
      });
    } catch (error) {
      finish({
        ok: false,
        code: "spawn_failed",
        error: error?.message || "本机 Agent 启动失败。",
        exitCode: null,
        signal: null,
      });
      return;
    }

    child.stdin?.on("error", () => {
      // stdin write failures are reported through provider-native write events.
    });
    child.stdout?.on("data", (chunk) => {
      const text = String(chunk || "");
      appendLimitedOutput(output, "stdout", chunk);
      emit({ event: "message.delta", role: "assistant", text });
      providerNativeRecovery.inspect(text);
      stdoutLineBuffer += text;
      const lines = stdoutLineBuffer.split(/\r?\n/);
      stdoutLineBuffer = lines.pop() || "";
      for (const line of lines) inspectProviderNativeLine(line);
      scheduleBufferedProviderNativeInspection();
    });
    child.stderr?.on("data", (chunk) => {
      appendLimitedOutput(output, "stderr", chunk);
      emit({ event: "stderr", text: String(chunk || "") });
    });
    child.on("error", (error) => {
      finish({
        ok: false,
        code: "spawn_failed",
        error: error?.message || "本机 Agent 执行失败。",
        exitCode: null,
        signal: null,
      });
    });
    child.on("close", (exitCode, signal) => {
      childClosed = true;
      clearBufferedProviderNativeInspection();
      stdoutLineBuffer = "";
      providerNativeRecovery.failAll("provider_process_closed_before_callback_recovery_marker");
      const cancelled = cancelRequested && !timedOut;
      const code = timedOut
        ? "agent_run_timeout"
        : (cancelled ? "agent_run_cancelled" : (exitCode === 0 ? "" : "agent_run_failed"));
      emit({ event: "run.completed", ok: !timedOut && !cancelled && exitCode === 0, exitCode, signal, code });
      finish({
        ok: !timedOut && !cancelled && exitCode === 0,
        code,
        error: timedOut
          ? `本机 Agent 执行超过 ${timeoutSeconds} 秒,已终止。`
          : (cancelled ? (cancelReason || "本机 Agent run 已取消。") : ""),
        exitCode,
        signal,
      });
    });
  });

  return {
    promise,
    cancel: (reason = "cancelled_by_server", signal = "SIGTERM") => {
      cancelRequested = true;
      cancelReason = String(reason || "cancelled_by_server");
      cancelSignal = signal || "SIGTERM";
      abortProviderNativeWaits();
      if (child && !child.killed) child.kill(cancelSignal);
    },
  };
}

export async function localAgentRunResponse(config, message = {}, options = {}, onEvent = () => {}) {
  const run = startLocalAgentRun(config, message, options, onEvent);
  return await run.promise;
}

export function localDeviceMetadata(options = {}) {
  const commandExecution = localCommandPolicy(options);
  const remoteDesktop = remoteDesktopPolicy(options);
  return {
    platform: os.platform(),
    arch: os.arch(),
    hostname: os.hostname(),
    node: process.version,
    cwd: process.cwd(),
    homedir: os.homedir(),
    commandExecution,
    remoteDesktop,
    ...(options.localShellBridge ? { localShellBridge: options.localShellBridge } : {}),
    ...(Array.isArray(options.workspaces) ? { workspaces: options.workspaces } : {}),
  };
}

export function localDevicePayload(config, options = {}) {
  const workspaces = Array.isArray(options.workspaces) ? options.workspaces : [];
  const commandExecution = localCommandPolicy(options);
  const remoteDesktop = remoteDesktopPolicy(options);
  return {
    deviceId: config.deviceId,
    name: options.name || config.deviceName || `${os.hostname()} Local Device`,
    tools: discoverLocalTools(),
    capabilities: uniqueStrings([
      "local-device",
      "tool-discovery",
      "status",
      ...(workspaces.length ? ["local-workspace"] : []),
      ...(commandExecution.enabled
        ? [
          "command-exec",
          "local-shell:pty",
          "agent-run",
          "agent-run:stream",
          "agent-run:cancel",
          "agent-run:provider-native-write-back",
          ...(options.localShellBridge ? ["local-shell:direct"] : []),
        ]
        : []),
      ...(remoteDesktop.enabled ? ["remote-desktop", "remote-desktop:vnc"] : []),
    ]),
    metadata: localDeviceMetadata({ ...options, workspaces }),
    workspaces,
  };
}

export function websocketBaseFromApiBase(apiBase) {
  const url = new URL(apiBase);
  let pathname = url.pathname.replace(/\/api\/v1\/?$/, "").replace(/\/api\/?$/, "");
  if (!pathname.endsWith("/ws/local-devices")) pathname = `${pathname.replace(/\/+$/, "")}/ws/local-devices`;
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

async function createWebSocket(url) {
  try {
    const mod = await import("ws");
    return new mod.WebSocket(url);
  } catch {
    if (typeof WebSocket === "function") return new WebSocket(url);
    throw new Error("当前 Node 运行时不支持 WebSocket。请使用 AnyEnv CLI 二进制安装包，或安装 Node.js 22+ 后重试。");
  }
}

function onSocket(socket, event, handler) {
  if (typeof socket.on === "function") {
    socket.on(event, handler);
    return;
  }
  socket.addEventListener(event, handler);
}

function messageData(eventOrData) {
  if (eventOrData && Object.prototype.hasOwnProperty.call(eventOrData, "data")) return eventOrData.data;
  return eventOrData;
}

function sendJson(socket, payload) {
  socket.send(JSON.stringify(payload));
}

function closeSocket(socket, code = 1000) {
  try {
    socket.close(code);
  } catch {
    // Ignore close races.
  }
}

function localVncPolicyForPort(policy, port) {
  return {
    ...policy,
    port,
    resolvedPort: port,
  };
}

function connectLocalVncCandidate(requestId, policy, port, sessions, sendFrame, log, handshakeTimeoutMs) {
  const candidatePolicy = localVncPolicyForPort(policy, port);
  return new Promise((resolve) => {
    let opened = false;
    let settled = false;
    let handshakeTimer = null;
    let handshakeBuffer = Buffer.alloc(0);
    const tcp = net.createConnection({ host: candidatePolicy.host, port });
    const emitFrame = (payload) => {
      try {
        sendFrame(payload);
      } catch (error) {
        log("vnc.frame.send_failed", { requestId, message: errorMessage(error) });
      }
    };
    const clearHandshakeTimer = () => {
      if (!handshakeTimer) return;
      clearTimeout(handshakeTimer);
      handshakeTimer = null;
    };
    const settle = (payload) => {
      if (settled) return;
      settled = true;
      if (payload.ok === false) clearHandshakeTimer();
      resolve(payload);
    };
    const failAndClose = (payload) => {
      settle({
        ...payload,
        remoteDesktop: candidatePolicy,
      });
      tcp.destroy();
    };
    tcp.setNoDelay(true);
    tcp.setTimeout(Math.max(handshakeTimeoutMs + 500, 1000), () => {
      if (!opened) tcp.destroy(new Error("connect timeout"));
    });
    tcp.on("connect", () => {
      tcp.setTimeout(0);
      handshakeTimer = setTimeout(() => {
        log("vnc.handshake.timeout", { requestId, host: candidatePolicy.host, port });
        failAndClose({
          type: "vnc.open.response",
          requestId,
          ok: false,
          code: "vnc_handshake_timeout",
          error: `本机 ${candidatePolicy.host}:${port} 接受了 TCP 连接，但没有返回 VNC/RFB 握手。请确认该端口是真正的 VNC 服务，未被 Docker、Registry、HTTP 等其他服务占用。`,
          detail: `未在 ${handshakeTimeoutMs}ms 内收到 RFB 握手。`,
        });
      }, handshakeTimeoutMs);
      handshakeTimer.unref?.();
    });
    tcp.on("data", (chunk) => {
      if (!chunk || !chunk.length) return;
      if (!opened) {
        handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
        if (handshakeBuffer.length < 4) return;
        if (!isRfbHandshake(handshakeBuffer)) {
          const asciiHead = handshakeBuffer.subarray(0, 16).toString("ascii").replace(/[^\x20-\x7e]/g, ".");
          log("vnc.handshake.invalid", { requestId, host: candidatePolicy.host, port, asciiHead });
          failAndClose({
            type: "vnc.open.response",
            requestId,
            ok: false,
            code: "vnc_handshake_invalid",
            error: `本机 ${candidatePolicy.host}:${port} 不是 VNC/RFB 服务。请检查 --vnc-port 是否指向真实 VNC Server。`,
            detail: asciiHead ? `收到的前缀: ${asciiHead}` : "",
          });
          return;
        }
        clearHandshakeTimer();
        opened = true;
        sessions.set(requestId, { socket: tcp, policy: candidatePolicy });
        log("vnc.open.connected", { requestId, host: candidatePolicy.host, port, portMode: candidatePolicy.portMode, handshake: "rfb" });
        settle({
          type: "vnc.open.response",
          requestId,
          ok: true,
          protocol: candidatePolicy.protocol,
          host: candidatePolicy.host,
          port,
          resolvedPort: port,
          remoteDesktop: candidatePolicy,
        });
        const firstFrame = handshakeBuffer;
        handshakeBuffer = Buffer.alloc(0);
        setTimeout(() => emitFrame({
          type: "vnc.data",
          requestId,
          data: firstFrame.toString("base64"),
        }), 0);
        return;
      }
      emitFrame({
        type: "vnc.data",
        requestId,
        data: chunk.toString("base64"),
      });
    });
    tcp.on("error", (error) => {
      const messageText = errorMessage(error);
      log("vnc.socket.error", { requestId, opened, message: messageText });
      if (!opened) {
        failAndClose({
          type: "vnc.open.response",
          requestId,
          ok: false,
          code: "vnc_connect_failed",
          error: `无法连接本机 VNC 服务 ${candidatePolicy.host}:${port}。请先安装/启动屏幕共享或 VNC Server。`,
          detail: messageText,
        });
        return;
      }
      emitFrame({
        type: "vnc.close",
        requestId,
        ok: false,
        code: "vnc_socket_error",
        error: messageText,
      });
    });
    tcp.on("close", () => {
      clearHandshakeTimer();
      sessions.delete(requestId);
      if (!opened) {
        settle({
          type: "vnc.open.response",
          requestId,
          ok: false,
          code: "vnc_connect_closed",
          error: `无法连接本机 VNC 服务 ${candidatePolicy.host}:${port}。`,
          remoteDesktop: candidatePolicy,
        });
        return;
      }
      emitFrame({
        type: "vnc.close",
        requestId,
        ok: true,
        reason: "tcp_closed",
      });
    });
  });
}

async function openLocalVncSession(message = {}, options = {}, sessions, sendFrame, log = () => {}) {
  const requestId = String(message.requestId || "");
  const policy = remoteDesktopPolicy(options);
  if (!requestId) {
    return {
      type: "vnc.open.response",
      requestId,
      ok: false,
      code: "missing_request_id",
      error: "缺少 VNC 请求 ID。",
      remoteDesktop: policy,
    };
  }
  if (!policy.enabled) {
    return {
      type: "vnc.open.response",
      requestId,
      ok: false,
      code: "remote_desktop_disabled",
      error: "本机远程桌面能力未开启。请在本机运行 anyenv restart --allow-remote-desktop 后重试。",
      remoteDesktop: policy,
    };
  }
  if (sessions.has(requestId)) {
    return {
      type: "vnc.open.response",
      requestId,
      ok: false,
      code: "vnc_session_exists",
      error: "该 VNC 会话已经存在。",
      remoteDesktop: policy,
    };
  }

  const candidatePorts = policy.portMode === "auto" ? policy.candidatePorts : [policy.port];
  const attempts = [];
  for (const port of candidatePorts) {
    const response = await connectLocalVncCandidate(
      requestId,
      policy,
      port,
      sessions,
      sendFrame,
      log,
      policy.portMode === "auto" ? vncAutoHandshakeTimeoutMs() : vncHandshakeTimeoutMs(),
    );
    if (response.ok) return response;
    attempts.push({
      port,
      code: response.code || "vnc_probe_failed",
      detail: response.detail || response.error || "",
    });
    if (policy.portMode !== "auto") return response;
  }

  const detail = attempts
    .map((item) => `${item.port}:${item.code}${item.detail ? `(${item.detail})` : ""}`)
    .join("; ");
  return {
    type: "vnc.open.response",
    requestId,
    ok: false,
    code: "vnc_auto_probe_failed",
    error: `未在本机候选端口找到 VNC/RFB 服务。已探测: ${candidatePorts.join(", ")}。请启动屏幕共享或 VNC Server，或使用 --vnc-port 指定真实端口。`,
    detail,
    remoteDesktop: {
      ...policy,
      resolvedPort: null,
    },
  };
}

function closeLocalVncSessions(sessions, reason = "websocket_closed") {
  for (const [requestId, session] of sessions.entries()) {
    sessions.delete(requestId);
    try {
      session.socket.destroy(new Error(reason));
    } catch {
      // Ignore close races.
    }
  }
}

function statusResponse(config, requestId, options = {}, connectionId = "") {
  const payload = localDevicePayload(config, options);
  return {
    type: "status.response",
    requestId,
    ok: true,
    connectionId,
    clientId: config.clientId,
    deviceId: config.deviceId,
    clientVersion: VERSION,
    tools: payload.tools,
    metadata: payload.metadata,
    capabilities: payload.capabilities,
    commandExecution: payload.metadata.commandExecution,
  };
}

const PROCESS_DIAGNOSTICS_KEY = Symbol.for("anyenv.device.processDiagnostics");

function installDeviceProcessDiagnostics(runId, cleanup = () => {}) {
  if (globalThis[PROCESS_DIAGNOSTICS_KEY]) return;
  const startedAt = Date.now();
  let exiting = false;
  const uptimeSeconds = () => Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  const runCleanup = (reason) => {
    try {
      cleanup(reason);
    } catch (error) {
      deviceLog("daemon.cleanup.failed", { runId, reason, message: errorMessage(error), uptimeSeconds: uptimeSeconds() });
    }
  };
  const exitForSignal = (signal) => {
    if (exiting) return;
    exiting = true;
    deviceLog("daemon.signal", { runId, signal, uptimeSeconds: uptimeSeconds() });
    runCleanup(`signal_${String(signal || "").toLowerCase()}`);
    process.exit(signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 0);
  };
  globalThis[PROCESS_DIAGNOSTICS_KEY] = true;
  process.once("SIGINT", () => exitForSignal("SIGINT"));
  process.once("SIGTERM", () => exitForSignal("SIGTERM"));
  if (process.platform !== "win32") {
    process.once("SIGHUP", () => exitForSignal("SIGHUP"));
  }
  process.once("uncaughtException", (error) => {
    if (exiting) return;
    exiting = true;
    deviceLog("daemon.uncaught_exception", {
      runId,
      message: errorMessage(error),
      stack: String(error?.stack || "").slice(0, 2000),
      uptimeSeconds: uptimeSeconds(),
    });
    runCleanup("uncaught_exception");
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    deviceLog("daemon.unhandled_rejection", {
      runId,
      message: errorMessage(reason),
      uptimeSeconds: uptimeSeconds(),
    });
  });
  process.once("exit", (code) => {
    deviceLog("daemon.exit", { runId, code, uptimeSeconds: uptimeSeconds(), reason: exiting ? "handled_exit" : "process_exit" });
  });
}

export async function registerAccountDevice(config, options = {}) {
  const payload = localDevicePayload(config, options);
  const client = await registerAccountLocalClient(config, {
    clientId: config.clientId,
    deviceId: config.deviceId,
    name: payload.name,
    clientVersion: VERSION,
    tools: payload.tools,
    capabilities: uniqueStrings(["account-local-client", ...payload.capabilities]),
    metadata: payload.metadata,
    workspaces: payload.workspaces,
  });
  const stored = readConfig();
  const existingWorkspaces = Array.isArray(stored.localWorkspaces) ? stored.localWorkspaces : [];
  const localWorkspaces = payload.workspaces.length
    ? [
      ...existingWorkspaces.filter((item) => !payload.workspaces.some((workspace) => workspace.id === item.id || workspace.path === item.path)),
      ...payload.workspaces,
    ]
    : existingWorkspaces;
  writeConfig({
    ...stored,
    apiBase: config.apiBase,
    projectToken: "",
    globalToken: config.globalToken,
    accessToken: config.accessToken,
    clientId: config.clientId,
    deviceId: config.deviceId,
    deviceName: payload.name,
    localClientId: client.clientId,
    localWorkspaces,
    projectId: "",
    name: config.name,
    type: config.type,
    syncItems: config.syncItems,
  });
  return { integration: client, payload, accountScoped: true };
}

export async function connectDevice(config, options = {}) {
  const policy = reconnectPolicy(options);
  const runId = createRunId();
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let stopped = false;
  const runningPtySessions = new Map();
  let localShellBridge = null;
  try {
    localShellBridge = await startLocalShellBridge(config, options, runningPtySessions, runId);
  } catch (error) {
    deviceLog("local_bridge.start.failed", { runId, message: errorMessage(error) });
  }
  installDeviceProcessDiagnostics(runId, (reason) => {
    localShellBridge?.close();
    closeLocalPtySessions(runningPtySessions, reason || "daemon_exiting");
  });
  const runtimeOptions = localShellBridge
    ? { ...options, localShellBridge: localShellBridge.metadata }
    : options;
  const url = options.ws || websocketBaseFromApiBase(config.apiBase);
  const workspaceCount = Array.isArray(runtimeOptions.workspaces) ? runtimeOptions.workspaces.length : 0;

  debugLog(config, "device.connect.start", {
    scope: "account",
    apiBase: config.apiBase,
    projectId: "",
    globalTokenConfigured: Boolean(config.globalToken),
    projectTokenConfigured: false,
    clientId: config.clientId,
    deviceId: config.deviceId,
    workspaceCount,
  });
  deviceLog("daemon.start", {
    runId,
    scope: "account",
    apiBase: config.apiBase,
    websocketUrl: url,
    clientId: config.clientId,
    deviceId: config.deviceId,
    workspaceCount,
    reconnect: {
      enabled: policy.enabled,
      maxAttempts: policy.maxAttempts || "unlimited",
      initialDelayMs: policy.initialDelayMs,
      maxDelayMs: policy.maxDelayMs,
    },
  });

  const scheduleReconnect = (reason = {}) => {
    if (stopped || !policy.enabled) return;
    const nextAttempt = reconnectAttempts + 1;
    if (policy.maxAttempts > 0 && nextAttempt > policy.maxAttempts) {
      deviceLog("ws.reconnect.give_up", {
        runId,
        attempts: reconnectAttempts,
        maxAttempts: policy.maxAttempts,
        reason,
      });
      return;
    }
    reconnectAttempts = nextAttempt;
    const delayMs = reconnectDelayMs(policy, reconnectAttempts);
    deviceLog("ws.reconnect.schedule", {
      runId,
      attempt: reconnectAttempts,
      delayMs,
      reason,
    });
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      try {
        await connectOnce(reconnectAttempts);
        reconnectAttempts = 0;
      } catch (error) {
        const message = errorMessage(error);
        deviceLog("ws.reconnect.failed", {
          runId,
          attempt: reconnectAttempts,
          message,
          status: error?.status || null,
        });
        if (isAuthLikeFailure(error)) {
          stopped = true;
          deviceLog("ws.reconnect.stop", {
            runId,
            reason: "auth_failed",
            message,
            nextStep: "Run anyenv login --account, then restart the daemon.",
          });
          return;
        }
        scheduleReconnect({ type: "connect_error", message });
      }
    }, delayMs);
  };

  const connectOnce = async (attempt = 0) => {
    const connectionId = createConnectionId();
    const log = (event, detail = {}) => deviceLog(event, { runId, connectionId, ...detail });
    const reconnecting = attempt > 0;
    log(reconnecting ? "ws.reconnect.begin" : "ws.connect.begin", {
      attempt,
      url,
    });
    const registered = await registerAccountDevice(config, runtimeOptions);
    debugLog(config, "device.registered", {
      scope: "account",
      integrationId: registered.integration?.id || "",
      projectId: "",
      status: registered.integration?.status || registered.integration?.clientStatus || "",
    });
    log("device.registered", {
      attempt,
      integrationId: registered.integration?.id || "",
      status: registered.integration?.status || registered.integration?.clientStatus || "",
      capabilities: registered.payload.capabilities,
      commandExecution: registered.payload.metadata?.commandExecution,
    });
    debugLog(config, "ws.connect", { url });
    const socket = await createWebSocket(url);
    const auth = await new Promise((resolve, reject) => {
      let settled = false;
      let authSent = false;
      let authenticated = false;
      let heartbeatTimer = null;
      const runningAgentRuns = new Map();
      const runningVncSessions = new Map();
      const cancelRunningAgentRuns = (reason = "connection_closed") => {
        for (const [requestId, run] of runningAgentRuns.entries()) {
          try {
            log("agent.run.cancel.local", { requestId, reason });
            run.cancel(reason);
          } catch (error) {
            log("agent.run.cancel.local.failed", { requestId, message: errorMessage(error) });
          }
        }
      };
      const clearHeartbeat = () => {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      };
      const authTimer = setTimeout(() => {
        closeSocket(socket, 4000);
        settle(reject, new Error("Local device connection authentication timed out"));
      }, Math.max(5, Number(runtimeOptions.authTimeoutSeconds || 15)) * 1000);
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(authTimer);
        fn(value);
      };
      const startHeartbeat = () => {
        if (runtimeOptions.once || heartbeatTimer) return;
        heartbeatTimer = setInterval(() => {
          try {
            sendJson(socket, {
              type: "heartbeat",
              clientVersion: VERSION,
              deviceId: config.deviceId,
              connectionId,
              capabilities: localDevicePayload(config, runtimeOptions).capabilities,
              metadata: localDeviceMetadata(runtimeOptions),
            });
            debugLog(config, "ws.heartbeat.sent", { scope: "account" });
            log("ws.heartbeat.sent", { attempt });
          } catch (error) {
            clearHeartbeat();
            const message = errorMessage(error);
            log("ws.heartbeat.failed", { attempt, message });
            closeSocket(socket, 4002);
          }
        }, Math.max(10, Number(runtimeOptions.heartbeatSeconds || 30)) * 1000);
      };
      const sendAuth = (force = false) => {
        if (authSent) return;
        if (!force && socket.readyState !== undefined && socket.readyState !== 1) return;
        authSent = true;
        const authFrame = {
          type: "auth",
          scope: "account",
          token: config.globalToken,
          projectId: "",
          clientId: config.clientId,
          deviceId: config.deviceId,
          connectionId,
          name: registered.payload.name,
          clientVersion: VERSION,
          tools: registered.payload.tools,
          capabilities: registered.payload.capabilities,
          metadata: registered.payload.metadata,
        };
        debugLog(config, "ws.auth.send", {
          type: authFrame.type,
          scope: authFrame.scope,
          tokenType: "global",
          projectId: authFrame.projectId,
          clientId: authFrame.clientId,
          deviceId: authFrame.deviceId,
          name: authFrame.name,
          clientVersion: authFrame.clientVersion,
          tools: Array.isArray(authFrame.tools) ? authFrame.tools.length : 0,
          capabilities: Array.isArray(authFrame.capabilities) ? authFrame.capabilities : [],
          workspaces: Array.isArray(authFrame.metadata?.workspaces) ? authFrame.metadata.workspaces.length : 0,
        });
        log("ws.auth.send", {
          attempt,
          scope: authFrame.scope,
          clientId: authFrame.clientId,
          deviceId: authFrame.deviceId,
          capabilities: authFrame.capabilities,
          workspaceCount: Array.isArray(authFrame.metadata?.workspaces) ? authFrame.metadata.workspaces.length : 0,
        });
        sendJson(socket, authFrame);
      };
      onSocket(socket, "open", () => {
        debugLog(config, "ws.open", { url });
        log("ws.open", { attempt, url });
        sendAuth(true);
      });
      queueMicrotask(sendAuth);
      setTimeout(sendAuth, 0);
      onSocket(socket, "error", (err) => {
        const error = err?.error || err;
        const message = errorMessage(error);
        log("ws.error", { attempt, authenticated, message });
        if (!settled) settle(reject, error);
      });
      onSocket(socket, "message", (eventOrData) => {
        let message = null;
        try {
          message = JSON.parse(String(messageData(eventOrData)));
        } catch {
          return;
        }
        if (message.type === "ready") {
          authenticated = true;
          debugLog(config, "ws.ready", message);
          log(reconnecting ? "ws.reconnect.ready" : "ws.ready", {
            attempt,
            scope: message.scope || "account",
            clientId: message.clientId || config.clientId,
            deviceId: message.deviceId || config.deviceId,
          });
          startHeartbeat();
          settle(resolve, message);
          if (runtimeOptions.once) {
            sendJson(socket, statusResponse(config, "initial-status", runtimeOptions, connectionId));
            closeSocket(socket);
          }
          return;
        }
        if (message.type === "error") {
          const detail = message.error || message.message || "Local device connection authentication failed";
          debugLog(config, "ws.error.frame", message);
          log("ws.error.frame", { attempt, message: String(detail) });
          closeSocket(socket, 4001);
          settle(reject, new Error(String(detail)));
          return;
        }
        if (message.type === "ping") {
          sendJson(socket, { type: "pong", clientVersion: VERSION, deviceId: config.deviceId, connectionId });
          return;
        }
        if (message.type === "status.request") {
          sendJson(socket, statusResponse(config, message.requestId || "", runtimeOptions, connectionId));
          return;
        }
        if (message.type === "command.request") {
          log("command.request", {
            requestId: message.requestId || "",
            cwd: message.cwd || "",
            commandLength: String(message.command || "").length,
          });
          const wantsCommandEvents = Array.isArray(message._eventTypes) && message._eventTypes.includes("command.event");
          localCommandResponse(
            config,
            message,
            runtimeOptions,
            wantsCommandEvents ? (event) => sendJson(socket, { ...event, connectionId }) : null,
          )
            .then((response) => {
              log("command.response", {
                requestId: response.requestId || "",
                ok: response.ok,
                code: response.code || "",
                exitCode: response.exitCode ?? null,
                durationMs: response.durationMs ?? null,
                truncated: Boolean(response.truncated),
              });
              sendJson(socket, { ...response, connectionId });
            })
            .catch((error) => {
              log("command.response.failed", {
                requestId: message.requestId || "",
                message: errorMessage(error),
              });
              sendJson(socket, {
                type: "command.response",
                requestId: message.requestId || "",
                connectionId,
                ok: false,
                code: "command_handler_failed",
                error: error?.message || "本地命令处理失败。",
              });
            });
        }
        if (message.type === "pty.open.request") {
          const requestId = String(message.requestId || "");
          const sessionId = String(message.sessionId || requestId || "");
          log("pty.open.request", {
            requestId,
            sessionId,
            cwd: message.cwd || "",
            enabled: localCommandPolicy(runtimeOptions).enabled,
            lastSeq: Number(message.lastSeq || 0) || 0,
          });
          openLocalPtySession(
            message,
            runtimeOptions,
            runningPtySessions,
            (event) => sendJson(socket, { ...event, connectionId }),
            log,
          )
            .then((response) => {
              log("pty.open.response", {
                requestId,
                sessionId: response.sessionId || sessionId,
                ok: response.ok,
                code: response.code || "",
                reconnected: Boolean(response.reconnected),
                pid: response.pid || null,
              });
              sendJson(socket, { ...response, connectionId });
            })
            .catch((error) => {
              log("pty.open.failed", { requestId, sessionId, message: errorMessage(error) });
              sendJson(socket, {
                type: "pty.open.response",
                requestId,
                sessionId,
                connectionId,
                ok: false,
                code: "pty_handler_failed",
                error: error?.message || "本机 Shell 处理失败。",
              });
            });
          return;
        }
        if (message.type === "pty.input") {
          const sessionId = String(message.sessionId || "");
          const session = runningPtySessions.get(sessionId);
          if (!session) {
            sendJson(socket, {
              type: "pty.error",
              requestId: message.requestId || "",
              sessionId,
              connectionId,
              code: "pty_session_not_found",
              error: "本机 Shell 会话不存在或已结束。",
            });
            return;
          }
          session.requestId = String(message.requestId || session.requestId || "");
          session.handler = (event) => sendJson(socket, { ...event, connectionId });
          if (!ptyControlWrite(session.child, { type: "input", data: String(message.data || "") })) {
            sendJson(socket, {
              type: "pty.error",
              requestId: session.requestId,
              sessionId,
              connectionId,
              code: "pty_input_failed",
              error: "写入本机 Shell 失败。",
            });
          }
          return;
        }
        if (message.type === "pty.resize") {
          const sessionId = String(message.sessionId || "");
          const session = runningPtySessions.get(sessionId);
          if (session) {
            session.requestId = String(message.requestId || session.requestId || "");
            session.handler = (event) => sendJson(socket, { ...event, connectionId });
            ptyControlWrite(session.child, {
              type: "resize",
              cols: clampNumber(message.cols, 100, 20, 400),
              rows: clampNumber(message.rows, 30, 5, 200),
            });
          }
          return;
        }
        if (message.type === "pty.detach") {
          const sessionId = String(message.sessionId || "");
          const session = runningPtySessions.get(sessionId);
          log("pty.detach", { requestId: message.requestId || "", sessionId, found: Boolean(session) });
          if (session) session.handler = null;
          return;
        }
        if (message.type === "pty.close") {
          const sessionId = String(message.sessionId || "");
          const session = runningPtySessions.get(sessionId);
          log("pty.close.request", { requestId: message.requestId || "", sessionId, found: Boolean(session), reason: message.reason || "" });
          if (session) {
            runningPtySessions.delete(sessionId);
            session.closed = true;
            session.handler = (event) => sendJson(socket, { ...event, connectionId });
            ptyControlWrite(session.child, { type: "close", reason: message.reason || "closed_by_server" });
            setTimeout(() => {
              try {
                if (session.child && !session.child.killed) session.child.kill("SIGKILL");
              } catch {
                // Ignore close races.
              }
            }, 1500).unref?.();
          }
          return;
        }
        if (message.type === "vnc.open.request") {
          const requestId = String(message.requestId || "");
          log("vnc.open.request", {
            requestId,
            enabled: remoteDesktopPolicy(runtimeOptions).enabled,
          });
          openLocalVncSession(
            message,
            runtimeOptions,
            runningVncSessions,
            (event) => sendJson(socket, { ...event, connectionId }),
            log,
          )
            .then((response) => {
              log("vnc.open.response", {
                requestId,
                ok: response.ok,
                code: response.code || "",
                port: response.port || response.remoteDesktop?.port || null,
              });
              sendJson(socket, { ...response, connectionId });
            })
            .catch((error) => {
              log("vnc.open.failed", { requestId, message: errorMessage(error) });
              sendJson(socket, {
                type: "vnc.open.response",
                requestId,
                connectionId,
                ok: false,
                code: "vnc_handler_failed",
                error: error?.message || "本机远程桌面处理失败。",
              });
            });
          return;
        }
        if (message.type === "vnc.data") {
          const requestId = String(message.requestId || "");
          const session = runningVncSessions.get(requestId);
          if (!session) {
            sendJson(socket, {
              type: "vnc.close",
              requestId,
              connectionId,
              ok: false,
              code: "vnc_session_not_found",
              error: "本机 VNC 会话不存在或已结束。",
            });
            return;
          }
          try {
            session.socket.write(Buffer.from(String(message.data || ""), "base64"));
          } catch (error) {
            sendJson(socket, {
              type: "vnc.close",
              requestId,
              connectionId,
              ok: false,
              code: "vnc_write_failed",
              error: errorMessage(error),
            });
            session.socket.destroy();
          }
          return;
        }
        if (message.type === "vnc.close") {
          const requestId = String(message.requestId || "");
          const session = runningVncSessions.get(requestId);
          log("vnc.close.request", { requestId, found: Boolean(session), reason: message.reason || "" });
          if (session) {
            runningVncSessions.delete(requestId);
            session.socket.destroy();
          }
          return;
        }
        if (message.type === "agent.run.request") {
          const requestId = message.requestId || "";
          log("agent.run.request", {
            requestId,
            agentId: message.agentId || "",
            cwd: message.cwd || "",
            contentLength: String(message.content || "").length,
          });
          const run = startLocalAgentRun(config, message, runtimeOptions, (event) => {
            sendJson(socket, { ...event, connectionId });
          });
          runningAgentRuns.set(requestId, run);
          run.promise
            .then((response) => {
              log("agent.run.response", {
                requestId: response.requestId || "",
                agentId: response.agentId || "",
                ok: response.ok,
                code: response.code || "",
                exitCode: response.exitCode ?? null,
                durationMs: response.durationMs ?? null,
                truncated: Boolean(response.truncated),
              });
              sendJson(socket, { ...response, connectionId });
            })
            .catch((error) => {
              log("agent.run.response.failed", {
                requestId,
                message: errorMessage(error),
              });
              sendJson(socket, {
                type: "agent.run.response",
                requestId,
                connectionId,
                ok: false,
                code: "agent_run_handler_failed",
                error: error?.message || "本机 Agent run 处理失败。",
              });
            })
            .finally(() => {
              runningAgentRuns.delete(requestId);
            });
          return;
        }
        if (message.type === "agent.run.cancel") {
          const requestId = message.requestId || "";
          const run = runningAgentRuns.get(requestId);
          log("agent.run.cancel", {
            requestId,
            found: Boolean(run),
            reason: message.reason || "",
          });
          if (run) run.cancel(message.reason || "cancelled_by_server");
          else {
            sendJson(socket, {
              type: "agent.run.response",
              requestId,
              connectionId,
              ok: false,
              code: "agent_run_not_found",
              error: "本机 Agent run 不存在或已结束。",
            });
          }
          return;
        }
      });
      onSocket(socket, "close", (...args) => {
        const info = socketCloseInfo(args);
        clearHeartbeat();
        cancelRunningAgentRuns("websocket_closed");
        detachLocalPtySessions(runningPtySessions);
        closeLocalVncSessions(runningVncSessions, "websocket_closed");
        debugLog(config, "ws.close", info);
        log("ws.close", { attempt, authenticated, ...info });
        if (!settled) {
          const detail = info.reason ? `: ${info.reason}` : "";
          settle(reject, new Error(`Local device connection closed${info.code ? ` (${info.code})` : ""}${detail}`));
          return;
        }
        if (authenticated && !runtimeOptions.once) {
          scheduleReconnect({ type: "ws_close", ...info });
        }
      });
    });
    return { ...registered, websocketUrl: url, auth, runId, connectionId };
  };

  try {
    while (true) {
      try {
        const initial = await connectOnce(reconnectAttempts);
        reconnectAttempts = 0;
        return initial;
      } catch (error) {
        const message = errorMessage(error);
        deviceLog("ws.connect.failed", {
          runId,
          attempt: reconnectAttempts,
          message,
          status: error?.status || null,
        });
        if (!policy.enabled || isAuthLikeFailure(error)) {
          throw error;
        }
        const nextAttempt = reconnectAttempts + 1;
        if (policy.maxAttempts > 0 && nextAttempt > policy.maxAttempts) {
          deviceLog("ws.reconnect.give_up", {
            runId,
            attempts: reconnectAttempts,
            maxAttempts: policy.maxAttempts,
            reason: { type: "initial_connect_error", message },
          });
          throw error;
        }
        reconnectAttempts = nextAttempt;
        const delayMs = reconnectDelayMs(policy, reconnectAttempts);
        deviceLog("ws.reconnect.schedule", {
          runId,
          attempt: reconnectAttempts,
          delayMs,
          reason: { type: "initial_connect_error", message },
        });
        await wait(delayMs);
      }
    }
  } catch (error) {
    localShellBridge?.close();
    closeLocalPtySessions(runningPtySessions, "connect_failed");
    throw error;
  }
}
