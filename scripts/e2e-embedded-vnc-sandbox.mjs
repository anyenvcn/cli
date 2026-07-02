import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";

const cliPath = process.argv[2] || "anyenv";

function waitFor(fn, timeoutMs = 15000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const value = fn();
      if (value) {
        resolve(value);
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error(`Timed out after ${timeoutMs}ms`));
        return;
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

function sendVncData(ws, requestId, bytes) {
  ws.send(JSON.stringify({
    type: "vnc.data",
    requestId,
    data: Buffer.from(bytes).toString("base64"),
  }));
}

function createRfbClient(requestId, onReady) {
  let buffer = Buffer.alloc(0);
  let stage = "server-version";
  let framebufferBytesExpected = 0;
  let framebufferHeader = false;
  let ready = false;
  return {
    get ready() {
      return ready;
    },
    append(ws, bytes) {
      buffer = Buffer.concat([buffer, bytes]);
      while (buffer.length) {
        if (stage === "server-version") {
          if (buffer.length < 12) return;
          assert.equal(buffer.subarray(0, 12).toString("ascii"), "RFB 003.008\n");
          buffer = buffer.subarray(12);
          sendVncData(ws, requestId, Buffer.from("RFB 003.008\n", "ascii"));
          stage = "security-types";
          continue;
        }
        if (stage === "security-types") {
          if (buffer.length < 2) return;
          assert.equal(buffer[0], 1);
          assert.equal(buffer[1], 1);
          buffer = buffer.subarray(2);
          sendVncData(ws, requestId, Buffer.from([1]));
          stage = "security-result";
          continue;
        }
        if (stage === "security-result") {
          if (buffer.length < 4) return;
          assert.equal(buffer.readUInt32BE(0), 0);
          buffer = buffer.subarray(4);
          sendVncData(ws, requestId, Buffer.from([1]));
          stage = "server-init";
          continue;
        }
        if (stage === "server-init") {
          if (buffer.length < 24) return;
          const width = buffer.readUInt16BE(0);
          const height = buffer.readUInt16BE(2);
          const nameLength = buffer.readUInt32BE(20);
          if (buffer.length < 24 + nameLength) return;
          const name = buffer.subarray(24, 24 + nameLength).toString("utf8");
          assert.equal(width, 800);
          assert.equal(height, 500);
          assert.match(name, /AnyEnv CLI Embedded Desktop/);
          buffer = buffer.subarray(24 + nameLength);
          const request = Buffer.alloc(10);
          request[0] = 3;
          request[1] = 0;
          request.writeUInt16BE(0, 2);
          request.writeUInt16BE(0, 4);
          request.writeUInt16BE(width, 6);
          request.writeUInt16BE(height, 8);
          sendVncData(ws, requestId, request);
          stage = "framebuffer-update";
          continue;
        }
        if (stage === "framebuffer-update") {
          if (!framebufferHeader) {
            if (buffer.length < 16) return;
            assert.equal(buffer[0], 0);
            assert.equal(buffer.readUInt16BE(2), 1);
            const rectWidth = buffer.readUInt16BE(8);
            const rectHeight = buffer.readUInt16BE(10);
            assert.equal(buffer.readInt32BE(12), 0);
            framebufferBytesExpected = rectWidth * rectHeight * 4;
            framebufferHeader = true;
            buffer = buffer.subarray(16);
          }
          if (buffer.length < framebufferBytesExpected) return;
          const sample = buffer.subarray(0, 64);
          assert.ok(sample.some((byte) => byte !== 0));
          buffer = buffer.subarray(framebufferBytesExpected);
          ready = true;
          onReady?.();
          return;
        }
        return;
      }
    },
  };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-sandbox-e2e-"));
const workspaceDir = path.join(tmp, "workspace");
fs.mkdirSync(workspaceDir, { recursive: true });
const configPath = path.join(tmp, "config.json");
fs.writeFileSync(configPath, JSON.stringify({
  apiBase: "http://127.0.0.1:1/api/v1",
  globalToken: "evls_gt_sandbox_e2e_token",
  clientId: "lc_sandbox_e2e",
  deviceId: "ld_sandbox_e2e",
}, null, 2));

let registerBody = null;
let authMessage = null;
let commandResponse = null;
let openResponse = null;
let rfbDone = false;
let resolveDone = null;
let rejectDone = null;
const done = new Promise((resolve, reject) => {
  resolveDone = resolve;
  rejectDone = reject;
});
const requestId = "lvnc-sandbox-e2e";
const rfb = createRfbClient(requestId, () => {
  rfbDone = true;
  resolveDone();
});
const marker = `anyenv-sandbox-command-ok-${Date.now()}`;

const server = http.createServer((req, res) => {
  let raw = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : null;
    if (req.url === "/api/v1/cli/local-clients/register") {
      registerBody = body;
      res.writeHead(201, { "Content-Type": "application/json", Connection: "close" });
      res.end(JSON.stringify({
        id: "aloc-sandbox-e2e",
        clientId: body.clientId,
        deviceId: body.deviceId,
        name: body.name,
        status: "online",
        capabilities: body.capabilities,
        metadata: body.metadata,
        workspaces: body.workspaces,
      }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json", Connection: "close" });
    res.end(JSON.stringify({ detail: `unexpected ${req.method} ${req.url}` }));
  });
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/ws/local-devices") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
wss.on("connection", (ws) => {
  ws.on("message", (data) => {
    try {
      const message = JSON.parse(String(data));
      if (message.type === "auth") {
        authMessage = message;
        ws.send(JSON.stringify({
          type: "ready",
          scope: "account",
          projectId: "",
          clientId: message.clientId,
          deviceId: message.deviceId,
        }));
        setTimeout(() => {
          ws.send(JSON.stringify({
            type: "command.request",
            requestId: "ldr-sandbox-e2e",
            command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`console.log(${JSON.stringify(marker)})`)}`,
            cwd: workspaceDir,
            timeoutSeconds: 5,
            maxOutputBytes: 4096,
          }));
        }, 50);
        return;
      }
      if (message.type === "command.response") {
        commandResponse = message;
        ws.send(JSON.stringify({
          type: "vnc.open.request",
          requestId,
        }));
        return;
      }
      if (message.type === "vnc.open.response") {
        openResponse = message;
        return;
      }
      if (message.type === "vnc.data") {
        rfb.append(ws, Buffer.from(message.data, "base64"));
      }
    } catch (error) {
      rejectDone(error);
    }
  });
  ws.on("error", rejectDone);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
let child = null;
try {
  child = spawn(cliPath, [
    "start",
    "--foreground",
    "--json",
    "--api",
    `http://127.0.0.1:${port}/api/v1`,
    "--workspace",
    workspaceDir,
    "--allow-local-commands",
    "--command-root",
    workspaceDir,
    "--allow-remote-desktop",
  ], {
    cwd: workspaceDir,
    env: {
      ...process.env,
      ANYENV_CONFIG: configPath,
      ANYENV_PROJECT_ID: "",
      ANYENV_PROJECT_TOKEN: "",
      ANYENV_VNC_PORT_CANDIDATES: "5997,5998",
      HOME: tmp,
      PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.on("error", rejectDone);
  await Promise.race([
    done,
    waitFor(() => child.exitCode !== null ? "child-exited" : null, 15000).then((value) => {
      throw new Error(`${value}: stdout=${stdout}\nstderr=${stderr}`);
    }),
  ]);
  assert.ok(registerBody.capabilities.includes("command-exec"));
  assert.ok(registerBody.capabilities.includes("remote-desktop:vnc"));
  assert.equal(registerBody.metadata.remoteDesktop.mode, "cli-managed-rfb");
  assert.equal(registerBody.metadata.remoteDesktop.source, "cli-embedded");
  assert.equal(registerBody.metadata.remoteDesktop.portMode, "auto");
  assert.ok(authMessage.capabilities.includes("command-exec"));
  assert.ok(authMessage.capabilities.includes("remote-desktop:vnc"));
  assert.equal(commandResponse.ok, true);
  assert.match(commandResponse.stdout, new RegExp(marker));
  assert.equal(openResponse.ok, true);
  assert.equal(openResponse.remoteDesktop.source, "cli-embedded");
  assert.ok(openResponse.resolvedPort > 0);
  assert.ok(![5997, 5998].includes(openResponse.resolvedPort));
  assert.equal(rfbDone, true);
  console.log(JSON.stringify({
    ok: true,
    cli: cliPath,
    command: "ok",
    vnc: "embedded-rfb-ok",
    version: registerBody.clientVersion || "",
    source: openResponse.remoteDesktop.source,
    resolvedPort: openResponse.resolvedPort,
  }, null, 2));
} finally {
  if (child && !child.killed) {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("close", resolve));
  }
  wss.close();
  await new Promise((resolve) => server.close(resolve));
}
