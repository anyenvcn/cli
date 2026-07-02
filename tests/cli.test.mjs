import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const bin = path.join(root, "bin", "anyenv.js");

function run(args, env = {}) {
  return execFileSync(process.execPath, [bin, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 60000,
  });
}

function runAsync(args, env = {}) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [bin, ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      encoding: "utf8",
      timeout: 60000,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

function runAsyncFull(args, env = {}) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [bin, ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      encoding: "utf8",
      timeout: 60000,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function credentialTestEnv(env = {}) {
  return {
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    DASHSCOPE_API_KEY: "",
    CURSOR_API_KEY: "",
    QODER_PERSONAL_ACCESS_TOKEN: "",
    ...env,
  };
}

function waitFor(fn, timeoutMs = 5000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const value = fn();
      if (value) {
        resolve(value);
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error("timed out waiting for condition"));
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

test("config path prints the active config file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const config = path.join(dir, "config.json");
  assert.equal(run(["config", "path"], { ANYENV_CONFIG: config }).trim(), config);
});

test("package version matches CLI version constant", async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const { VERSION } = await import("../lib/config.js");
  assert.equal(VERSION, pkg.version);
  assert.equal(run(["--version"]).trim(), pkg.version);
});

test("help includes local device connection commands", () => {
  const output = run(["--help"]);
  assert.match(output, /Connect IDE\/MCP/);
  assert.match(output, /anyenv setup ide/);
  assert.match(output, /anyenv start/);
  assert.match(output, /anyenv restart/);
  assert.match(output, /anyenv stop/);
  assert.match(output, /anyenv logs/);
  assert.match(output, /anyenv update\|upgrade/);
  assert.match(output, /anyenv env activate/);
  assert.match(output, /anyenv device register/);
  assert.match(output, /anyenv device connect/);
  assert.doesNotMatch(output, /--once/);
  assert.match(output, /--allow-local-commands/);
  assert.match(output, /--allow-remote-desktop/);
  assert.doesNotMatch(output, /--allow-remote-desktop \[--workspace/);
  assert.match(output, /--base-url/);
  assert.match(output, /cursor\|claude\|vscode\|generic/);
});

test("local command handler is disabled by default and scoped to allowed roots", async () => {
  const { localCommandResponse } = await import("../lib/device.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-command-"));
  const workspace = path.join(dir, "workspace");
  const outside = path.join(dir, "outside");
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);

  const disabled = await localCommandResponse(
    { clientId: "lc_cmd", deviceId: "ld_cmd" },
    { requestId: "req-disabled", command: "pwd" },
    { workspaces: [{ path: workspace }] },
  );
  assert.equal(disabled.ok, false);
  assert.equal(disabled.code, "local_command_disabled");

  const enabled = await localCommandResponse(
    { clientId: "lc_cmd", deviceId: "ld_cmd" },
    {
      requestId: "req-enabled",
      command: `${JSON.stringify(process.execPath)} -e "console.log(process.cwd())"`,
      cwd: workspace,
      timeoutSeconds: 5,
    },
    {
      allowLocalCommands: true,
      workspaces: [{ path: workspace }],
      commandTimeoutSeconds: 10,
    },
  );
  assert.equal(enabled.ok, true);
  assert.equal(enabled.exitCode, 0);
  assert.equal(enabled.cwd, workspace);
  assert.match(enabled.stdout.trim(), new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(enabled.commandExecution.enabled, true);

  const denied = await localCommandResponse(
    { clientId: "lc_cmd", deviceId: "ld_cmd" },
    { requestId: "req-denied", command: "pwd", cwd: outside },
    {
      allowLocalCommands: true,
      workspaces: [{ path: workspace }],
    },
  );
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "cwd_outside_allowed_roots");
});

test("local command handler closes stdin for non-interactive bridge commands", async () => {
  const { localCommandResponse } = await import("../lib/device.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-stdin-"));
  const response = await localCommandResponse(
    { clientId: "lc_stdin", deviceId: "ld_stdin" },
    {
      requestId: "req-stdin",
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdin.resume(); process.stdin.on('end', () => console.log('stdin-closed'));")}`,
      cwd: dir,
      timeoutSeconds: 2,
    },
    {
      allowLocalCommands: true,
      workspaces: [{ path: dir }],
      commandTimeoutSeconds: 2,
    },
  );
  assert.equal(response.ok, true);
  assert.match(response.stdout, /stdin-closed/);
});

test("local agent-run handler executes known CLI and emits events", async () => {
  const { localAgentRunResponse } = await import("../lib/device.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-agent-"));
  const workspace = path.join(dir, "workspace");
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(workspace);
  fs.mkdirSync(binDir);
  const fakeCodex = path.join(binDir, "codex");
  fs.writeFileSync(fakeCodex, "#!/bin/sh\necho local-agent:$*\n", "utf8");
  fs.chmodSync(fakeCodex, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${oldPath || ""}`;
  const events = [];
  try {
    const response = await localAgentRunResponse(
      { clientId: "lc_agent", deviceId: "ld_agent" },
      {
        requestId: "req-agent",
        agentId: "codex",
        content: "hello local",
        cwd: workspace,
        timeoutSeconds: 5,
      },
      {
        allowLocalCommands: true,
        workspaces: [{ path: workspace }],
        commandTimeoutSeconds: 10,
      },
      (event) => events.push(event),
    );
    assert.equal(response.type, "agent.run.response");
    assert.equal(response.ok, true);
    assert.equal(response.agentId, "codex");
    assert.equal(response.cwd, workspace);
    assert.match(response.stdout, /local-agent:exec hello local/);
    assert.equal(events[0].type, "agent.run.event");
    assert.equal(events[0].event, "run.started");
    assert.ok(events.some((event) => event.event === "message.delta" && /local-agent/.test(event.text || "")));
    assert.ok(events.some((event) => event.event === "run.completed" && event.ok === true));
  } finally {
    process.env.PATH = oldPath;
  }
});

test("local agent-run writes provider-native answer envelope back to child stdin", async () => {
  const { localAgentRunResponse } = await import("../lib/device.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-agent-native-"));
  const workspace = path.join(dir, "workspace");
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(workspace);
  fs.mkdirSync(binDir);
  const fakeCodex = path.join(binDir, "codex");
  fs.writeFileSync(
    fakeCodex,
    [
      "#!/bin/sh",
      "printf '%s\\n' '{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_cli_native\",\"name\":\"requestUserInput\",\"input\":{\"title\":\"确认\",\"question\":\"继续吗？\"}}]}}'",
      "IFS= read -r line",
      "printf 'provider-native:%s\\n' \"$line\"",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.chmodSync(fakeCodex, 0o755);

  let askRequest = null;
  let askBody = null;
  let reportBody = null;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (req.url === "/api/v1/internal/interactions/provider-native/ask") {
        askRequest = {
          method: req.method,
          url: req.url,
          authorization: req.headers.authorization,
        };
        askBody = raw ? JSON.parse(raw) : null;
        res.writeHead(200, { "Content-Type": "application/json", "Connection": "close" });
        res.end(JSON.stringify({
          ready: true,
          status: "delivered_to_adapter",
          interactionId: "int_cli_native",
          toolUseId: "toolu_cli_native",
          format: "codex.requestUserInput.tool_result",
          envelope: {
            format: "codex.requestUserInput.tool_result",
            payloadText: "{\"type\":\"tool_result\",\"tool_call_id\":\"toolu_cli_native\",\"output\":\"{\\\"answer\\\":\\\"继续\\\"}\",\"is_error\":false}\n",
          },
        }));
        return;
      }
      if (req.url === "/api/v1/internal/interactions/provider-native/write-back-result") {
        reportBody = raw ? JSON.parse(raw) : null;
        res.writeHead(200, { "Content-Type": "application/json", "Connection": "close" });
        res.end(JSON.stringify({ ok: true, status: "delivered_to_provider_stdin" }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json", "Connection": "close" });
      res.end(JSON.stringify({ detail: `unexpected ${req.method} ${req.url}` }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${oldPath || ""}`;
  const events = [];
  try {
    const { port } = server.address();
    const response = await localAgentRunResponse(
      {
        apiBase: `http://127.0.0.1:${port}/api/v1`,
        clientId: "lc_agent_native",
        deviceId: "ld_agent_native",
      },
      {
        requestId: "req-agent-native",
        agentId: "codex",
        content: "needs user input",
        cwd: workspace,
        timeoutSeconds: 5,
        interactionToken: "evls_it_cli_native",
      },
      {
        allowLocalCommands: true,
        workspaces: [{ path: workspace }],
        commandTimeoutSeconds: 10,
      },
      (event) => events.push(event),
    );

    assert.equal(response.type, "agent.run.response");
    assert.equal(response.ok, true);
    assert.equal(askRequest.method, "POST");
    assert.equal(askRequest.url, "/api/v1/internal/interactions/provider-native/ask");
    assert.equal(askRequest.authorization, "Bearer evls_it_cli_native");
    assert.equal(askBody.part.toolUseId, "toolu_cli_native");
    assert.equal(askBody.part.toolName, "requestUserInput");
    assert.equal(askBody.wait, true);
    assert.equal(askBody.dryRun, false);
    await waitFor(
      () => events.some((event) => event.event === "provider_native.write_back.delivered" && event.auditReported === true),
      1000,
    );
    assert.equal(reportBody.interactionId, "int_cli_native");
    assert.equal(reportBody.toolUseId, "toolu_cli_native");
    assert.equal(reportBody.status, "delivered");
    assert.equal(reportBody.reason, "");
    assert.equal(reportBody.deliveryMode, "local_cli_stdin");
    assert.equal(reportBody.format, "codex.requestUserInput.tool_result");
    assert.ok(reportBody.bytes > 0);
    assert.match(reportBody.payloadTextSha256, /^[a-f0-9]{64}$/);
    assert.match(response.stdout, /provider-native:\{"type":"tool_result"/);
    assert.ok(events.some((event) => event.event === "provider_native.interaction.required"));
  } finally {
    process.env.PATH = oldPath;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("local agent-run observes provider-native callback recovery marker after stdin write", async () => {
  const { localAgentRunResponse } = await import("../lib/device.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-agent-native-callback-"));
  const workspace = path.join(dir, "workspace");
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(workspace);
  fs.mkdirSync(binDir);
  const fakeCodex = path.join(binDir, "codex");
  const marker = "ANYENV_PROVIDER_NATIVE_CALLBACK_RECOVERED_cli";
  const nativeLine = "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_cli_native_callback\",\"name\":\"requestUserInput\",\"input\":{\"title\":\"确认\",\"question\":\"继续吗？\"}}]}}";
  fs.writeFileSync(
    fakeCodex,
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' '${nativeLine}'`,
      "IFS= read -r line",
      "printf 'provider-native:%s\\n' \"$line\"",
      `printf '${marker}\\n'`,
      "",
    ].join("\n"),
    "utf8",
  );
  fs.chmodSync(fakeCodex, 0o755);

  const reports = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (req.url === "/api/v1/internal/interactions/provider-native/ask") {
        res.writeHead(200, { "Content-Type": "application/json", "Connection": "close" });
        res.end(JSON.stringify({
          ready: true,
          status: "delivered_to_adapter",
          interactionId: "int_cli_native_callback",
          toolUseId: "toolu_cli_native_callback",
          format: "codex.requestUserInput.tool_result",
          envelope: {
            format: "codex.requestUserInput.tool_result",
            payloadText: "{\"type\":\"tool_result\",\"tool_call_id\":\"toolu_cli_native_callback\",\"output\":\"{\\\"answer\\\":\\\"继续\\\"}\",\"is_error\":false}\n",
          },
        }));
        return;
      }
      if (req.url === "/api/v1/internal/interactions/provider-native/write-back-result") {
        reports.push(raw ? JSON.parse(raw) : {});
        res.writeHead(200, { "Content-Type": "application/json", "Connection": "close" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json", "Connection": "close" });
      res.end(JSON.stringify({ detail: `unexpected ${req.method} ${req.url}` }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${oldPath || ""}`;
  const events = [];
  try {
    const { port } = server.address();
    const response = await localAgentRunResponse(
      {
        apiBase: `http://127.0.0.1:${port}/api/v1`,
        clientId: "lc_agent_native_callback",
        deviceId: "ld_agent_native_callback",
      },
      {
        requestId: "req-agent-native-callback",
        agentId: "codex",
        content: "native input with callback marker",
        cwd: workspace,
        timeoutSeconds: 5,
        interactionToken: "evls_it_cli_native_callback",
        providerNativeCallbackRecoveryMarker: marker,
        providerNativeCallbackRecoveryTimeoutSeconds: 2,
      },
      {
        allowLocalCommands: true,
        workspaces: [{ path: workspace }],
        commandTimeoutSeconds: 10,
      },
      (event) => events.push(event),
    );

    assert.equal(response.ok, true);
    await waitFor(
      () => reports.some((item) => item.status === "callback_recovered"),
      1000,
    );
    assert.ok(reports.some((item) => item.status === "delivered"));
    const recovered = reports.find((item) => item.status === "callback_recovered");
    assert.equal(recovered.interactionId, "int_cli_native_callback");
    assert.equal(recovered.toolUseId, "toolu_cli_native_callback");
    assert.equal(recovered.deliveryMode, "local_cli_stdin");
    assert.match(recovered.callbackMarkerSha256, /^[a-f0-9]{64}$/);
    assert.ok(recovered.elapsedMs >= 0);
    assert.ok(events.some((event) => event.event === "provider_native.callback.watch_started"));
    assert.ok(events.some((event) => event.event === "provider_native.callback.recovered" && event.auditReported === true));
  } finally {
    process.env.PATH = oldPath;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("local agent-run handles provider-native JSON without trailing newline while child waits", async () => {
  const { localAgentRunResponse } = await import("../lib/device.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-agent-native-buffer-"));
  const workspace = path.join(dir, "workspace");
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(workspace);
  fs.mkdirSync(binDir);
  const fakeCodex = path.join(binDir, "codex");
  const nativeLine = "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_cli_native_buffer\",\"name\":\"requestUserInput\",\"input\":{\"title\":\"确认\",\"question\":\"继续吗？\"}}]}}";
  fs.writeFileSync(
    fakeCodex,
    [
      "#!/usr/bin/env bash",
      `printf '%s' '${nativeLine}'`,
      "IFS= read -r line",
      "printf '\\nprovider-native-buffer:%s\\n' \"$line\"",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.chmodSync(fakeCodex, 0o755);

  let askCount = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (req.url === "/api/v1/internal/interactions/provider-native/ask") {
        askCount += 1;
        const parsed = raw ? JSON.parse(raw) : {};
        assert.equal(parsed.part.toolUseId, "toolu_cli_native_buffer");
        res.writeHead(200, { "Content-Type": "application/json", "Connection": "close" });
        res.end(JSON.stringify({
          ready: true,
          status: "delivered_to_adapter",
          format: "codex.requestUserInput.tool_result",
          envelope: {
            format: "codex.requestUserInput.tool_result",
            payloadText: "{\"type\":\"tool_result\",\"tool_call_id\":\"toolu_cli_native_buffer\",\"output\":\"{\\\"answer\\\":\\\"继续\\\"}\",\"is_error\":false}\n",
          },
        }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json", "Connection": "close" });
      res.end(JSON.stringify({ detail: `unexpected ${req.method} ${req.url}` }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${oldPath || ""}`;
  const events = [];
  try {
    const { port } = server.address();
    const response = await localAgentRunResponse(
      {
        apiBase: `http://127.0.0.1:${port}/api/v1`,
        clientId: "lc_agent_native_buffer",
        deviceId: "ld_agent_native_buffer",
      },
      {
        requestId: "req-agent-native-buffer",
        agentId: "codex",
        content: "native input without newline",
        cwd: workspace,
        timeoutSeconds: 5,
        interactionToken: "evls_it_cli_native_buffer",
      },
      {
        allowLocalCommands: true,
        workspaces: [{ path: workspace }],
        commandTimeoutSeconds: 10,
      },
      (event) => events.push(event),
    );

    assert.equal(response.ok, true);
    assert.equal(askCount, 1);
    assert.match(response.stdout, /provider-native-buffer:\{"type":"tool_result"/);
    assert.equal(events.filter((event) => event.event === "provider_native.interaction.required").length, 1);
    await waitFor(
      () => events.filter((event) => event.event === "provider_native.write_back.delivered").length === 1,
      1000,
    );
  } finally {
    process.env.PATH = oldPath;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("local agent-run reports provider-native stdin write failure", async () => {
  const { localAgentRunResponse } = await import("../lib/device.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-agent-native-stdin-fail-"));
  const workspace = path.join(dir, "workspace");
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(workspace);
  fs.mkdirSync(binDir);
  const fakeCodex = path.join(binDir, "codex");
  const nativeLine = "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_cli_native_stdin_fail\",\"name\":\"requestUserInput\",\"input\":{\"title\":\"确认\",\"question\":\"继续吗？\"}}]}}";
  fs.writeFileSync(
    fakeCodex,
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' '${nativeLine}'`,
      "exec 0<&-",
      "sleep 0.5",
      "printf 'still-alive\\n'",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.chmodSync(fakeCodex, 0o755);

  let askCount = 0;
  let reportBody = null;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (req.url === "/api/v1/internal/interactions/provider-native/ask") {
        askCount += 1;
        res.writeHead(200, { "Content-Type": "application/json", "Connection": "close" });
        res.end(JSON.stringify({
          ready: true,
          status: "delivered_to_adapter",
          interactionId: "int_cli_native_stdin_fail",
          toolUseId: "toolu_cli_native_stdin_fail",
          format: "codex.requestUserInput.tool_result",
          envelope: {
            format: "codex.requestUserInput.tool_result",
            payloadText: "{\"type\":\"tool_result\",\"tool_call_id\":\"toolu_cli_native_stdin_fail\",\"output\":\"{\\\"answer\\\":\\\"继续\\\"}\",\"is_error\":false}\n",
          },
        }));
        return;
      }
      if (req.url === "/api/v1/internal/interactions/provider-native/write-back-result") {
        reportBody = raw ? JSON.parse(raw) : null;
        res.writeHead(200, { "Content-Type": "application/json", "Connection": "close" });
        res.end(JSON.stringify({ ok: true, status: "provider_stdin_write_failed" }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json", "Connection": "close" });
      res.end(JSON.stringify({ detail: `unexpected ${req.method} ${req.url}` }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${oldPath || ""}`;
  const events = [];
  try {
    const { port } = server.address();
    const response = await localAgentRunResponse(
      {
        apiBase: `http://127.0.0.1:${port}/api/v1`,
        clientId: "lc_agent_native_stdin_fail",
        deviceId: "ld_agent_native_stdin_fail",
      },
      {
        requestId: "req-agent-native-stdin-fail",
        agentId: "codex",
        content: "native input with closed stdin",
        cwd: workspace,
        timeoutSeconds: 5,
        interactionToken: "evls_it_cli_native_stdin_fail",
      },
      {
        allowLocalCommands: true,
        workspaces: [{ path: workspace }],
        commandTimeoutSeconds: 10,
      },
      (event) => events.push(event),
    );

    assert.equal(response.ok, true);
    assert.equal(askCount, 1);
    assert.match(response.stdout, /still-alive/);
    assert.equal(events.filter((event) => event.event === "provider_native.interaction.required").length, 1);
    assert.equal(events.filter((event) => event.event === "provider_native.write_back.delivered").length, 0);
    const failed = events.find((event) => event.event === "provider_native.write_back.failed");
    assert.ok(failed);
    assert.match(String(failed.reason || ""), /EPIPE|ERR_STREAM_DESTROYED|child_stdin_closed|child_stdin_unavailable|write after end/i);
    assert.equal(failed.auditReported, true);
    assert.equal(reportBody.interactionId, "int_cli_native_stdin_fail");
    assert.equal(reportBody.toolUseId, "toolu_cli_native_stdin_fail");
    assert.equal(reportBody.status, "failed");
    assert.match(String(reportBody.reason || ""), /EPIPE|ERR_STREAM_DESTROYED|child_stdin_closed|child_stdin_unavailable|write after end/i);
    assert.equal(reportBody.deliveryMode, "local_cli_stdin");
    assert.ok(reportBody.bytes > 0);
    assert.match(reportBody.payloadTextSha256, /^[a-f0-9]{64}$/);
  } finally {
    process.env.PATH = oldPath;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("local agent-run ignores trailing provider-native JSON after child exits", async () => {
  const { localAgentRunResponse } = await import("../lib/device.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-agent-native-trailing-"));
  const workspace = path.join(dir, "workspace");
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(workspace);
  fs.mkdirSync(binDir);
  const fakeCodex = path.join(binDir, "codex");
  const nativeLine = "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_cli_native_trailing\",\"name\":\"requestUserInput\",\"input\":{\"title\":\"确认\",\"question\":\"继续吗？\"}}]}}";
  fs.writeFileSync(
    fakeCodex,
    [
      "#!/usr/bin/env bash",
      `printf '%s' '${nativeLine}'`,
      "",
    ].join("\n"),
    "utf8",
  );
  fs.chmodSync(fakeCodex, 0o755);

  let askCount = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    if (req.url === "/api/v1/internal/interactions/provider-native/ask") {
      askCount += 1;
    }
    res.writeHead(200, { "Content-Type": "application/json", "Connection": "close" });
    res.end(JSON.stringify({
      ready: true,
      status: "delivered_to_adapter",
      envelope: {
        format: "codex.requestUserInput.tool_result",
        payloadText: "{\"type\":\"tool_result\",\"tool_call_id\":\"toolu_cli_native_trailing\",\"output\":\"{}\",\"is_error\":false}\n",
      },
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${oldPath || ""}`;
  const events = [];
  try {
    const { port } = server.address();
    const response = await localAgentRunResponse(
      {
        apiBase: `http://127.0.0.1:${port}/api/v1`,
        clientId: "lc_agent_native_trailing",
        deviceId: "ld_agent_native_trailing",
      },
      {
        requestId: "req-agent-native-trailing",
        agentId: "codex",
        content: "native input exits immediately",
        cwd: workspace,
        timeoutSeconds: 5,
        interactionToken: "evls_it_cli_native_trailing",
      },
      {
        allowLocalCommands: true,
        workspaces: [{ path: workspace }],
        commandTimeoutSeconds: 10,
      },
      (event) => events.push(event),
    );

    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(response.ok, true);
    assert.equal(askCount, 0);
    assert.equal(events.filter((event) => event.event === "provider_native.interaction.required").length, 0);
    assert.equal(events.filter((event) => event.event === "provider_native.write_back.delivered").length, 0);
  } finally {
    process.env.PATH = oldPath;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("local agent-run dedupes duplicate provider-native toolUseId while ask is in flight", async () => {
  const { localAgentRunResponse } = await import("../lib/device.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-agent-native-dedupe-"));
  const workspace = path.join(dir, "workspace");
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(workspace);
  fs.mkdirSync(binDir);
  const fakeCodex = path.join(binDir, "codex");
  const nativeLine = "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_cli_native_dupe\",\"name\":\"requestUserInput\",\"input\":{\"title\":\"确认\",\"question\":\"继续吗？\"}}]}}";
  fs.writeFileSync(
    fakeCodex,
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' '${nativeLine}'`,
      `printf '%s\\n' '${nativeLine}'`,
      "IFS= read -r line1",
      "printf 'provider-native-1:%s\\n' \"$line1\"",
      "if IFS= read -r -t 1 line2; then",
      "  printf 'provider-native-2:%s\\n' \"$line2\"",
      "fi",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.chmodSync(fakeCodex, 0o755);

  let askCount = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (req.url === "/api/v1/internal/interactions/provider-native/ask") {
        askCount += 1;
        const parsed = raw ? JSON.parse(raw) : {};
        assert.equal(parsed.part.toolUseId, "toolu_cli_native_dupe");
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json", "Connection": "close" });
          res.end(JSON.stringify({
            ready: true,
            status: "delivered_to_adapter",
            format: "codex.requestUserInput.tool_result",
            envelope: {
              format: "codex.requestUserInput.tool_result",
              payloadText: "{\"type\":\"tool_result\",\"tool_call_id\":\"toolu_cli_native_dupe\",\"output\":\"{\\\"answer\\\":\\\"继续\\\"}\",\"is_error\":false}\n",
            },
          }));
        }, 100);
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json", "Connection": "close" });
      res.end(JSON.stringify({ detail: `unexpected ${req.method} ${req.url}` }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${oldPath || ""}`;
  const events = [];
  try {
    const { port } = server.address();
    const response = await localAgentRunResponse(
      {
        apiBase: `http://127.0.0.1:${port}/api/v1`,
        clientId: "lc_agent_native_dedupe",
        deviceId: "ld_agent_native_dedupe",
      },
      {
        requestId: "req-agent-native-dedupe",
        agentId: "codex",
        content: "duplicate native input",
        cwd: workspace,
        timeoutSeconds: 5,
        interactionToken: "evls_it_cli_native_dedupe",
      },
      {
        allowLocalCommands: true,
        workspaces: [{ path: workspace }],
        commandTimeoutSeconds: 10,
      },
      (event) => events.push(event),
    );

    assert.equal(response.ok, true);
    assert.equal(askCount, 1);
    assert.match(response.stdout, /provider-native-1:\{"type":"tool_result"/);
    assert.doesNotMatch(response.stdout, /provider-native-2:/);
    assert.equal(events.filter((event) => event.event === "provider_native.interaction.required").length, 1);
    await waitFor(
      () => events.filter((event) => event.event === "provider_native.write_back.delivered").length === 1,
      1000,
    );
  } finally {
    process.env.PATH = oldPath;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("local agent-run cancel terminates the child process", async () => {
  const { startLocalAgentRun } = await import("../lib/device.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-agent-cancel-"));
  const workspace = path.join(dir, "workspace");
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(workspace);
  fs.mkdirSync(binDir);
  const fakeCodex = path.join(binDir, "codex");
  fs.writeFileSync(
    fakeCodex,
    "#!/bin/sh\ntrap 'echo cancelled > \"$PWD/cancelled\"; exit 143' TERM\necho started\nwhile true; do sleep 1; done\n",
    "utf8",
  );
  fs.chmodSync(fakeCodex, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${oldPath || ""}`;
  const events = [];
  try {
    const run = startLocalAgentRun(
      { clientId: "lc_agent_cancel", deviceId: "ld_agent_cancel" },
      {
        requestId: "req-agent-cancel",
        agentId: "codex",
        content: "long local",
        cwd: workspace,
        timeoutSeconds: 30,
      },
      {
        allowLocalCommands: true,
        workspaces: [{ path: workspace }],
        commandTimeoutSeconds: 30,
      },
      (event) => events.push(event),
    );
    await waitFor(() => events.some((event) => event.event === "message.delta" && /started/.test(event.text || "")), 3000);
    run.cancel("test_cancel");
    const response = await run.promise;
    assert.equal(response.type, "agent.run.response");
    assert.equal(response.ok, false);
    assert.equal(response.code, "agent_run_cancelled");
    assert.match(response.error, /test_cancel/);
    assert.equal(fs.readFileSync(path.join(workspace, "cancelled"), "utf8").trim(), "cancelled");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("local device websocket close cancels in-flight agent runs", () => {
  const source = fs.readFileSync(path.join(root, "lib", "device.js"), "utf8");
  const closeBlock = source.slice(source.indexOf('onSocket(socket, "close"'), source.indexOf("});", source.indexOf('onSocket(socket, "close"')));
  assert.match(source, /const cancelRunningAgentRuns = \(reason = "connection_closed"\) =>/);
  assert.match(closeBlock, /cancelRunningAgentRuns\("websocket_closed"\)/);
  assert.match(source, /agent\.run\.cancel\.local/);
});

test("config show masks project token", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const config = path.join(dir, "config.json");
  fs.writeFileSync(
    config,
    JSON.stringify({
      apiBase: "https://api.anyenv.cn/api/v1",
      projectToken: "pt_abcdefghijklmnopqrstuvwxyz",
      clientId: "lc_test",
      syncItems: ["memory", "tools"],
    }),
  );

  const output = run(["config", "show"], { ANYENV_CONFIG: config });
  assert.match(output, /projectToken: pt_\*\*\*\*...wxyz/);
  assert.doesNotMatch(output, /abcdefghijklmnopqrstuvwxyz/);
});

test("config show masks global token and project context", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const config = path.join(dir, "config.json");
  fs.writeFileSync(
    config,
    JSON.stringify({
      apiBase: "https://api.anyenv.cn/api/v1",
      globalToken: "evls_gt_abcdefghijklmnopqrstuvwxyz",
      projectId: "soulmate",
      clientId: "lc_test",
    }),
  );

  const output = run(["config", "show"], { ANYENV_CONFIG: config, ANYENV_PROJECT_ID: "soulmate" });
  assert.match(output, /globalToken: evl\*\*\*\*...wxyz/);
  assert.match(output, /projectId: soulmate/);
  assert.doesNotMatch(output, /abcdefghijklmnopqrstuvwxyz/);
});

test("token set saves a global token with project context without registering", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const config = path.join(dir, "config.json");
  const output = run([
    "token",
    "set",
    "--token",
    "evls_gt_abcdefghijklmnopqrstuvwxyz",
    "--project",
    "soulmate",
    "--no-register",
    "--json",
  ], { ANYENV_CONFIG: config });
  const parsed = JSON.parse(output);
  const stored = JSON.parse(fs.readFileSync(config, "utf8"));
  assert.equal(parsed.token, "evl****...wxyz");
  assert.equal(parsed.projectId, "soulmate");
  assert.equal(stored.globalToken, "evls_gt_abcdefghijklmnopqrstuvwxyz");
  assert.equal(stored.projectToken, "");
  assert.equal(stored.projectId, "soulmate");
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".anyenv", "project.json"), "utf8")).projectId, "soulmate");
  fs.rmSync(path.join(root, ".anyenv"), { recursive: true, force: true });
});

test("config show json includes masked config and field sources", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const config = path.join(dir, "config.json");
  fs.writeFileSync(path.join(dir, "daemon.log"), "old stale daemon error\n");
  fs.writeFileSync(config, JSON.stringify({
    apiBase: "http://stored.test/api/v1",
    projectToken: "pt_abcdefghijklmnopqrstuvwxyz",
    clientId: "lc_test",
  }));
  const output = run(["config", "show", "--json"], {
    ANYENV_CONFIG: config,
    ANYENV_ACCESS_TOKEN: "eyJ-access-token-for-cloud-resources",
  });
  const parsed = JSON.parse(output);
  assert.equal(parsed.config.projectToken, "pt_****...wxyz");
  assert.equal(parsed.sources.apiBase, "config");
  assert.equal(parsed.sources.accessToken, "env");
  assert.equal(parsed.sources.projectToken, "config");
});

test("mcp config emits a stdio server snippet", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const config = path.join(dir, "config.json");
  const output = run(["mcp", "config", "--client", "cursor"], { ANYENV_CONFIG: config });
  const parsed = JSON.parse(output);
  assert.equal(parsed.mcpServers.anyenv.env.ANYENV_CONFIG, config);
  assert.deepEqual(parsed.mcpServers.anyenv.args.slice(-1), ["mcp"]);
});

test("mcp config includes project context when using global token", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const config = path.join(dir, "config.json");
  fs.writeFileSync(config, JSON.stringify({
    globalToken: "evls_gt_abcdefghijklmnopqrstuvwxyz",
    projectId: "soulmate",
  }));
  const output = run(["mcp", "config", "--client", "cursor"], {
    ANYENV_CONFIG: config,
    ANYENV_PROJECT_ID: "soulmate",
  });
  const parsed = JSON.parse(output);
  assert.equal(parsed.mcpServers.anyenv.env.ANYENV_CONFIG, config);
  assert.equal(parsed.mcpServers.anyenv.env.ANYENV_PROJECT_ID, "soulmate");
});

test("token set can save a project token without registering", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const config = path.join(dir, "config.json");
  const output = run([
    "token",
    "set",
    "--token",
    "pt_abcdefghijklmnopqrstuvwxyz",
    "--name",
    "Local Test",
    "--type",
    "cursor",
    "--no-register",
  ], { ANYENV_CONFIG: config });
  assert.match(output, /Token saved: pt_\*\*\*\*...wxyz/);
  const stored = JSON.parse(fs.readFileSync(config, "utf8"));
  assert.equal(stored.apiBase, "https://api.anyenv.cn/api/v1");
  assert.equal(stored.projectToken, "pt_abcdefghijklmnopqrstuvwxyz");
  assert.equal(stored.name, "Local Test");
  assert.equal(stored.type, "cursor");
  assert.ok(stored.clientId.startsWith("lc_"));
  assert.ok(stored.deviceId.startsWith("ld_"));
});

test("auth token set saves a user access token separately from project token", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const config = path.join(dir, "config.json");
  const output = run([
    "auth",
    "token",
    "set",
    "--token",
    "eyJ-access-token-for-cloud-resources",
    "--json",
  ], { ANYENV_CONFIG: config });
  const parsed = JSON.parse(output);
  const stored = JSON.parse(fs.readFileSync(config, "utf8"));
  assert.equal(parsed.accessToken, "eyJ****...rces");
  assert.equal(stored.accessToken, "eyJ-access-token-for-cloud-resources");
  assert.equal(stored.apiBase, "https://api.anyenv.cn/api/v1");
  assert.equal(stored.projectToken, undefined);
});

test("auth status masks user access token", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const config = path.join(dir, "config.json");
  fs.writeFileSync(config, JSON.stringify({
    apiBase: "https://api.anyenv.cn/api/v1",
    accessToken: "eyJ-access-token-for-cloud-resources",
  }));
  const output = run(["auth", "status", "--json"], { ANYENV_CONFIG: config });
  const parsed = JSON.parse(output);
  assert.equal(parsed.hasAccessToken, true);
  assert.equal(parsed.accessToken, "eyJ****...rces");
  assert.doesNotMatch(output, /access-token-for-cloud-resources/);
});

test("credentials import syncs a qoder token and sets the default agent credential", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const config = path.join(dir, "config.json");
  fs.writeFileSync(config, JSON.stringify({
    apiBase: "http://127.0.0.1:1/api/v1",
    accessToken: "eyJ-cli-access-token",
  }));
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      requests.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body: raw ? JSON.parse(raw) : null,
      });
      if (req.method === "GET" && req.url === "/api/v1/credentials") {
        res.writeHead(200, { "Content-Type": "application/json", "Connection": "close" });
        res.end(JSON.stringify([]));
        return;
      }
      if (req.method === "POST" && req.url === "/api/v1/credentials") {
        res.writeHead(201, { "Content-Type": "application/json", "Connection": "close" });
        res.end(JSON.stringify({
          id: "cred-qoder",
          type: "api-key",
          name: "Qoder CLI 访问令牌",
          aiProvider: "qoder",
          status: "connected",
          secretConfigured: true,
        }));
        return;
      }
      if (req.method === "PUT" && req.url === "/api/v1/credentials/defaults/qoder") {
        res.writeHead(200, { "Content-Type": "application/json", "Connection": "close" });
        res.end(JSON.stringify({ credentialIds: { qoder: "cred-qoder" }, modelIds: {} }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json", "Connection": "close" });
      res.end(JSON.stringify({ detail: `unexpected ${req.method} ${req.url}` }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    fs.writeFileSync(config, JSON.stringify({
      apiBase: `http://127.0.0.1:${port}/api/v1`,
      accessToken: "eyJ-cli-access-token",
    }));
    const output = await runAsync([
      "credentials",
      "import",
      "--provider",
      "qoder",
      "--yes",
      "--json",
    ], {
      ANYENV_CONFIG: config,
      QODER_PERSONAL_ACCESS_TOKEN: "qoder-secret-token-value",
    });
    const parsed = JSON.parse(output);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.items[0].action, "created");
    assert.equal(parsed.items[0].credential.id, "cred-qoder");
    assert.equal(parsed.items[0].defaultAgentId, "qoder");
    assert.doesNotMatch(output, /qoder-secret-token-value/);

    assert.deepEqual(requests.map((request) => `${request.method} ${request.url}`), [
      "GET /api/v1/credentials",
      "POST /api/v1/credentials",
      "PUT /api/v1/credentials/defaults/qoder",
    ]);
    assert.ok(requests.every((request) => request.authorization === "Bearer eyJ-cli-access-token"));
    assert.equal(requests[1].body.type, "api-key");
    assert.equal(requests[1].body.aiProvider, "qoder");
    assert.equal(requests[1].body.secret, "qoder-secret-token-value");
    assert.equal(requests[2].body.credentialId, "cred-qoder");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("credentials import updates an existing provider credential by name", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const config = path.join(dir, "config.json");
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      requests.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body: raw ? JSON.parse(raw) : null,
      });
      if (req.method === "GET" && req.url === "/api/v1/credentials") {
        res.writeHead(200, { "Content-Type": "application/json", "Connection": "close" });
        res.end(JSON.stringify([
          {
            id: "cred-existing-codex",
            type: "api-key",
            name: "Codex OpenAI API Key",
            aiProvider: "openai",
            secretConfigured: true,
          },
        ]));
        return;
      }
      if (req.method === "PUT" && req.url === "/api/v1/credentials/cred-existing-codex") {
        res.writeHead(200, { "Content-Type": "application/json", "Connection": "close" });
        res.end(JSON.stringify({
          id: "cred-existing-codex",
          type: "api-key",
          name: "Codex OpenAI API Key",
          aiProvider: "openai",
          status: "connected",
          secretConfigured: true,
        }));
        return;
      }
      if (req.method === "PUT" && req.url === "/api/v1/credentials/defaults/codex") {
        res.writeHead(200, { "Content-Type": "application/json", "Connection": "close" });
        res.end(JSON.stringify({ credentialIds: { codex: "cred-existing-codex" }, modelIds: {} }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json", "Connection": "close" });
      res.end(JSON.stringify({ detail: `unexpected ${req.method} ${req.url}` }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    fs.writeFileSync(config, JSON.stringify({
      apiBase: `http://127.0.0.1:${port}/api/v1`,
      accessToken: "eyJ-cli-access-token",
    }));
    const output = await runAsync([
      "credentials",
      "import",
      "--provider",
      "codex",
      "--token",
      "sk-local-openai-token",
      "--yes",
      "--json",
    ], { ANYENV_CONFIG: config });
    const parsed = JSON.parse(output);
    assert.equal(parsed.items[0].action, "updated");
    assert.equal(parsed.items[0].credential.id, "cred-existing-codex");
    assert.doesNotMatch(output, /sk-local-openai-token/);
    assert.deepEqual(requests.map((request) => `${request.method} ${request.url}`), [
      "GET /api/v1/credentials",
      "PUT /api/v1/credentials/cred-existing-codex",
      "PUT /api/v1/credentials/defaults/codex",
    ]);
    assert.equal(requests[1].body.aiProvider, "openai");
    assert.equal(requests[1].body.secret, "sk-local-openai-token");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("credentials import dry-run previews detected token without uploading it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const config = path.join(dir, "config.json");
  fs.writeFileSync(config, JSON.stringify({ accessToken: "eyJ-cli-access-token" }));
  const output = run([
    "credentials",
    "import",
    "--provider",
    "qoder",
    "--dry-run",
    "--json",
  ], {
    ANYENV_CONFIG: config,
    QODER_PERSONAL_ACCESS_TOKEN: "qoder-secret-token-value",
  });
  const parsed = JSON.parse(output);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.items[0].provider, "qoder");
  assert.equal(parsed.items[0].aiProvider, "qoder");
  assert.equal(parsed.items[0].setDefaultAgentId, "qoder");
  assert.doesNotMatch(output, /qoder-secret-token-value/);
});

test("credentials import --from-local dry-run detects desktop sources without leaking secrets", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-local-"));
  const home = path.join(dir, "home");
  const config = path.join(dir, "config.json");
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.mkdirSync(path.join(home, "Library", "Application Support", "Claude"), { recursive: true });
  fs.mkdirSync(path.join(home, "Library", "Application Support", "Qoder", "SharedClientCache", "cache"), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(config, JSON.stringify({ accessToken: "eyJ-cli-access-token" }));
  const fakeClaude = path.join(binDir, "claude");
  fs.writeFileSync(fakeClaude, `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  printf '%s\n' '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"hidden@example.com","subscriptionType":"max"}'
  exit 0
fi
exit 1
`, "utf8");
  fs.chmodSync(fakeClaude, 0o755);
  fs.writeFileSync(path.join(home, ".codex", "auth.json"), JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: {},
    tokens: {
      access_token: "codex-desktop-access-token",
      refresh_token: "codex-desktop-refresh-token",
    },
  }));
  fs.writeFileSync(path.join(home, "Library", "Application Support", "Claude", "config.json"), JSON.stringify({
    "oauth:tokenCache": "claude-desktop-oauth-cache",
  }));
  fs.writeFileSync(path.join(home, "Library", "Application Support", "Qoder", "SharedClientCache", "cache", "machine_token.json"), JSON.stringify({
    token: "qoder-desktop-machine-token",
    type: "machine",
  }));

  const output = run([
    "credentials",
    "import",
    "--all",
    "--from-local",
    "--dry-run",
    "--json",
  ], credentialTestEnv({ ANYENV_CONFIG: config, HOME: home, PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}` }));
  const parsed = JSON.parse(output);
  assert.equal(parsed.dryRun, true);
  const qoder = parsed.items.find((item) => item.provider === "qoder");
  assert.equal(qoder.aiProvider, "qoder");
  assert.equal(qoder.source, "local");
  assert.equal(qoder.sourceKind, "desktop-token");
  assert.match(qoder.sourceName, /machine_token\.json:token/);
  assert.equal(qoder.token, "qod****...oken");
  assert.ok(parsed.skipped.some((group) => group.provider === "codex" && group.sources.some((source) => /登录态不能作为 OPENAI_API_KEY/.test(source.reason))));
  assert.ok(parsed.skipped.some((group) => group.provider === "claude" && group.sources.some((source) => /不能作为 ANTHROPIC_API_KEY/.test(source.reason))));
  assert.ok(parsed.skipped.some((group) => group.provider === "claude" && group.sources.some((source) => source.sourceKind === "local-cli-login" && /本机 Claude Code 登录态/.test(source.reason))));
  assert.doesNotMatch(output, /qoder-desktop-machine-token/);
  assert.doesNotMatch(output, /codex-desktop-access-token/);
  assert.doesNotMatch(output, /claude-desktop-oauth-cache/);
  assert.doesNotMatch(output, /hidden@example.com/);
});

test("credentials import syncs a Qoder desktop token from local storage", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-local-sync-"));
  const home = path.join(dir, "home");
  const config = path.join(dir, "config.json");
  fs.mkdirSync(path.join(home, "Library", "Application Support", "Qoder", "SharedClientCache", "cache"), { recursive: true });
  fs.writeFileSync(path.join(home, "Library", "Application Support", "Qoder", "SharedClientCache", "cache", "machine_token.json"), JSON.stringify({
    token: "qoder-local-desktop-token",
  }));
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      requests.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body: raw ? JSON.parse(raw) : null,
      });
      if (req.method === "GET" && req.url === "/api/v1/credentials") {
        res.writeHead(200, { "Content-Type": "application/json", "Connection": "close" });
        res.end(JSON.stringify([]));
        return;
      }
      if (req.method === "POST" && req.url === "/api/v1/credentials") {
        res.writeHead(201, { "Content-Type": "application/json", "Connection": "close" });
        res.end(JSON.stringify({
          id: "cred-qoder-local",
          type: "api-key",
          name: "Qoder CLI 访问令牌",
          aiProvider: "qoder",
          status: "connected",
          secretConfigured: true,
        }));
        return;
      }
      if (req.method === "PUT" && req.url === "/api/v1/credentials/defaults/qoder") {
        res.writeHead(200, { "Content-Type": "application/json", "Connection": "close" });
        res.end(JSON.stringify({ credentialIds: { qoder: "cred-qoder-local" }, modelIds: {} }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json", "Connection": "close" });
      res.end(JSON.stringify({ detail: `unexpected ${req.method} ${req.url}` }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    fs.writeFileSync(config, JSON.stringify({
      apiBase: `http://127.0.0.1:${port}/api/v1`,
      accessToken: "eyJ-cli-access-token",
    }));
    const output = await runAsync([
      "credentials",
      "import",
      "--provider",
      "qoder",
      "--from-local",
      "--yes",
      "--json",
    ], credentialTestEnv({ ANYENV_CONFIG: config, HOME: home }));
    const parsed = JSON.parse(output);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.items[0].source, "local");
    assert.equal(parsed.items[0].sourceKind, "desktop-token");
    assert.equal(parsed.items[0].credential.id, "cred-qoder-local");
    assert.equal(requests[1].body.secret, "qoder-local-desktop-token");
    assert.doesNotMatch(output, /qoder-local-desktop-token/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

const hasSqlite3 = (() => {
  try {
    execFileSync("sqlite3", ["-version"], { encoding: "utf8", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
})();

test("credentials import reads Cursor desktop token from local sqlite storage", { skip: !hasSqlite3 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-cursor-local-"));
  const home = path.join(dir, "home");
  const config = path.join(dir, "config.json");
  const db = path.join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
  fs.mkdirSync(path.dirname(db), { recursive: true });
  fs.writeFileSync(config, JSON.stringify({ accessToken: "eyJ-cli-access-token" }));
  execFileSync("sqlite3", [db, "create table ItemTable(key text primary key, value text); insert into ItemTable(key, value) values('cursorAuth/accessToken', 'cursor-desktop-access-token');"], { encoding: "utf8" });

  const output = run([
    "credentials",
    "import",
    "--provider",
    "cursor",
    "--from-local",
    "--dry-run",
    "--json",
  ], credentialTestEnv({ ANYENV_CONFIG: config, HOME: home }));
  const parsed = JSON.parse(output);
  assert.equal(parsed.items[0].provider, "cursor");
  assert.equal(parsed.items[0].aiProvider, "cursor");
  assert.equal(parsed.items[0].sourceKind, "desktop-token");
  assert.match(parsed.items[0].sourceName, /state\.vscdb:cursorAuth\/accessToken/);
  assert.doesNotMatch(output, /cursor-desktop-access-token/);
});

test("login defaults back to production when stored API is localhost", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const config = path.join(dir, "config.json");
  fs.writeFileSync(config, JSON.stringify({
    apiBase: "http://localhost:36732/api/v1",
    clientId: "lc_stale_localhost",
  }));
  const child = spawn(process.execPath, [
    bin,
    "login",
    "--no-open",
    "--timeout",
    "30",
  ], {
    cwd: root,
    env: {
      ...process.env,
      ANYENV_CONFIG: config,
      ANYENV_API_BASE: "",
      ANYENV_WEB_BASE: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  try {
    const loginUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`login URL was not printed\n${stderr}`)), 10000);
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        const match = stdout.match(/https?:\/\/[^\s]+\/cli\/login[^\s]+/);
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    const url = new URL(loginUrl);
    assert.equal(url.origin, "https://www.anyenv.cn");
    assert.equal(url.searchParams.get("apiBase"), "https://api.anyenv.cn/api/v1");
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("close", resolve));
  }
});

test("login --account stores an access token without requiring a project token", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const config = path.join(dir, "config.json");
  const child = spawn(process.execPath, [
    bin,
    "login",
    "--account",
    "--no-open",
    "--json",
    "--timeout",
    "30",
    "--name",
    "Account Local Client",
  ], {
    cwd: root,
    env: {
      ...process.env,
      ANYENV_CONFIG: config,
      ANYENV_API_BASE: "http://api.test/api/v1",
      ANYENV_PROJECT_ID: "soulmate",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const exitPromise = new Promise((resolve, reject) => {
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`login failed: ${code}\n${stderr}`));
    });
  });
  const loginUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("login URL was not printed")), 10000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const match = stdout.match(/https?:\/\/[^\s]+\/cli\/login[^\s]+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      if (code !== 0 && !stdout.includes("/cli/login")) {
        clearTimeout(timer);
        reject(new Error(`login exited early: ${code}\n${stderr}`));
      }
    });
  });
  const url = new URL(loginUrl);
  assert.equal(url.searchParams.get("protocol"), "global-token-v1");
  assert.equal(url.searchParams.get("mode"), "account");
  const callback = url.searchParams.get("callback");
  const state = url.searchParams.get("state");
  assert.ok(callback);
  assert.ok(state);
  const res = await fetch(callback, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      state,
      accessToken: "eyJ-account-only-access-token",
      apiBase: "http://api.test/api/v1",
      name: "Account Local Client",
      type: "custom",
      syncItems: ["memory", "tools"],
    }),
  });
  assert.equal(res.status, 200);
  await exitPromise;
  const json = JSON.parse(stdout.match(/\{[\s\S]*\}\s*$/)?.[0] || "{}");
  const stored = JSON.parse(fs.readFileSync(config, "utf8"));
  assert.equal(json.accountOnly, true);
  assert.equal(json.integration, null);
  assert.equal(json.accessTokenConfigured, true);
  assert.equal(stored.accessToken, "eyJ-account-only-access-token");
  assert.equal(stored.projectToken, undefined);
  assert.equal(stored.name, "Account Local Client");
});

test("login stores an account-level global token without requiring project context", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const config = path.join(dir, "config.json");
  const child = spawn(process.execPath, [
    bin,
    "login",
    "--no-open",
    "--json",
    "--timeout",
    "30",
    "--name",
    "Global Local Client",
  ], {
    cwd: dir,
    env: {
      ...process.env,
      ANYENV_CONFIG: config,
      ANYENV_API_BASE: "http://api.test/api/v1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const exitPromise = new Promise((resolve, reject) => {
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`login failed: ${code}\n${stderr}`));
    });
  });
  const loginUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("login URL was not printed")), 10000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const match = stdout.match(/https?:\/\/[^\s]+\/cli\/login[^\s]+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  const url = new URL(loginUrl);
  assert.equal(url.searchParams.get("protocol"), "global-token-v1");
  assert.equal(url.searchParams.get("projectId"), null);
  const callback = url.searchParams.get("callback");
  const state = url.searchParams.get("state");
  assert.ok(callback);
  assert.ok(state);
  const res = await fetch(callback, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      state,
      globalToken: "evls_gt_account_level_global_token",
      accessToken: "eyJ-global-login-access-token",
      apiBase: "http://api.test/api/v1",
      name: "Global Local Client",
      type: "custom",
      syncItems: ["memory", "tools"],
    }),
  });
  assert.equal(res.status, 200);
  await exitPromise;
  const json = JSON.parse(stdout.match(/\{[\s\S]*\}\s*$/)?.[0] || "{}");
  const stored = JSON.parse(fs.readFileSync(config, "utf8"));
  assert.equal(json.accountOnly, true);
  assert.equal(json.tokenType, "global");
  assert.equal(json.projectRegistered, false);
  assert.equal(json.integration, null);
  assert.equal(stored.globalToken, "evls_gt_account_level_global_token");
  assert.equal(stored.accessToken, "eyJ-global-login-access-token");
  assert.equal(stored.projectToken, "");
  assert.equal(stored.projectId || "", "");
});

test("login URL ignores ambient project context unless project is explicit", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const config = path.join(dir, "config.json");
  fs.writeFileSync(config, JSON.stringify({ projectId: "soulmate" }));
  const child = spawn(process.execPath, [
    bin,
    "login",
    "--no-open",
    "--timeout",
    "30",
  ], {
    cwd: root,
    env: {
      ...process.env,
      ANYENV_CONFIG: config,
      ANYENV_API_BASE: "http://api.test/api/v1",
      ANYENV_PROJECT_ID: "soulmate",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  try {
    const loginUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`login URL was not printed\n${stderr}`)), 10000);
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        const match = stdout.match(/https?:\/\/[^\s]+\/cli\/login[^\s]+/);
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    const url = new URL(loginUrl);
    assert.equal(url.searchParams.get("protocol"), "global-token-v1");
    assert.equal(url.searchParams.get("projectId"), null);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("close", resolve));
  }
});

test("login with explicit project registers global token project client", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const config = path.join(dir, "config.json");
  let capturedRequest = null;
  let captured = null;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      capturedRequest = {
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
      };
      captured = raw ? JSON.parse(raw) : null;
      if (req.url === "/api/v1/projects/soulmate/cli/clients/register") {
        res.writeHead(201, { "Content-Type": "application/json", "Connection": "close" });
        res.end(JSON.stringify({
          id: "int-login-global",
          projectId: "soulmate",
          clientId: captured.clientId,
          name: captured.name,
          type: captured.type,
          syncItems: captured.syncItems,
        }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json", "Connection": "close" });
      res.end(JSON.stringify({ detail: `unexpected ${req.method} ${req.url}` }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const child = spawn(process.execPath, [
      bin,
      "login",
      "--project-id",
      "soulmate",
      "--no-open",
      "--json",
      "--timeout",
      "30",
      "--name",
      "Project Global Client",
    ], {
      cwd: dir,
      env: {
        ...process.env,
        ANYENV_CONFIG: config,
        ANYENV_API_BASE: `http://127.0.0.1:${port}/api/v1`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const exitPromise = new Promise((resolve, reject) => {
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`login failed: ${code}\n${stderr}`));
      });
    });
    const loginUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("login URL was not printed")), 10000);
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        const match = stdout.match(/https?:\/\/[^\s]+\/cli\/login[^\s]+/);
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    const url = new URL(loginUrl);
    assert.equal(url.searchParams.get("protocol"), "global-token-v1");
    assert.equal(url.searchParams.get("projectId"), "soulmate");
    const callback = url.searchParams.get("callback");
    const state = url.searchParams.get("state");
    const res = await fetch(callback, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        state,
        globalToken: "evls_gt_project_global_token",
        accessToken: "eyJ-project-login-access-token",
        apiBase: `http://127.0.0.1:${port}/api/v1`,
        name: "Project Global Client",
        type: "custom",
        syncItems: ["memory", "tools"],
      }),
    });
    assert.equal(res.status, 200);
    await exitPromise;
    const json = JSON.parse(stdout.match(/\{[\s\S]*\}\s*$/)?.[0] || "{}");
    const stored = JSON.parse(fs.readFileSync(config, "utf8"));
    assert.equal(capturedRequest.method, "POST");
    assert.equal(capturedRequest.url, "/api/v1/projects/soulmate/cli/clients/register");
    assert.equal(capturedRequest.authorization, "Bearer evls_gt_project_global_token");
    assert.equal(captured.name, "Project Global Client");
    assert.equal(json.accountOnly, false);
    assert.equal(json.tokenType, "global");
    assert.equal(json.projectRegistered, true);
    assert.equal(json.integration.projectId, "soulmate");
    assert.equal(stored.globalToken, "evls_gt_project_global_token");
    assert.equal(stored.projectToken, "");
    assert.equal(stored.projectId, "soulmate");
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, ".anyenv", "project.json"), "utf8")).projectId, "soulmate");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("local workspace add requires an account-level global token", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const config = path.join(dir, "config.json");
  const workspaceDir = path.join(dir, "local-app");
  fs.mkdirSync(workspaceDir);
  fs.writeFileSync(config, JSON.stringify({
    apiBase: "http://127.0.0.1:1/api/v1",
    accessToken: "eyJ-local-client-access-token",
    clientId: "lc_local_workspace_test",
    deviceId: "ld_local_workspace_test",
  }));

  let error = null;
  try {
    await runAsync([
      "local",
      "workspace",
      "add",
      workspaceDir,
      "--name",
      "Local App",
      "--json",
    ], {
      ANYENV_CONFIG: config,
    });
  } catch (err) {
    error = err;
  }
  assert.ok(error);
  assert.match(error.stderr || error.stdout || error.message, /Missing global token/);
  const stored = JSON.parse(fs.readFileSync(config, "utf8"));
  assert.equal(stored.localWorkspaces, undefined);
});

test("local workspace add uses cli local-client endpoint with global token", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const config = path.join(dir, "config.json");
  const workspaceDir = path.join(dir, "global-local-app");
  fs.mkdirSync(workspaceDir);
  fs.writeFileSync(config, JSON.stringify({
    apiBase: "http://127.0.0.1:1/api/v1",
    globalToken: "evls_gt_global_local_client_token",
    projectId: "soulmate",
    clientId: "lc_global_workspace_test",
    deviceId: "ld_global_workspace_test",
  }));

  let capturedRequest = null;
  let captured = null;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      capturedRequest = {
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
      };
      captured = JSON.parse(raw);
      res.writeHead(201, { "Content-Type": "application/json", "Connection": "close" });
      res.end(JSON.stringify({
        id: "aloc-global-test",
        clientId: captured.clientId,
        deviceId: captured.deviceId,
        name: captured.name,
        status: "online",
        workspaces: captured.workspaces,
        tools: captured.tools,
        capabilities: captured.capabilities,
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const output = await runAsync([
      "local",
      "workspace",
      "add",
      workspaceDir,
      "--name",
      "Global Local App",
      "--json",
    ], {
      ANYENV_CONFIG: config,
      ANYENV_API_BASE: `http://127.0.0.1:${port}/api/v1`,
      ANYENV_PROJECT_ID: "soulmate",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    });
    const parsed = JSON.parse(output);
    const stored = JSON.parse(fs.readFileSync(config, "utf8"));
    assert.equal(capturedRequest.method, "POST");
    assert.equal(capturedRequest.url, "/api/v1/cli/local-clients/register");
    assert.equal(capturedRequest.authorization, "Bearer evls_gt_global_local_client_token");
    assert.equal(parsed.workspace.name, "Global Local App");
    assert.equal(captured.clientId, "lc_global_workspace_test");
    assert.equal(stored.globalToken, "evls_gt_global_local_client_token");
    assert.equal(stored.projectId, "soulmate");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("global token uses cli project endpoints while cloud coding uses access token", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const config = path.join(dir, "config.json");
  fs.writeFileSync(config, JSON.stringify({
    apiBase: "http://127.0.0.1:1/api/v1",
    accessToken: "eyJ-user-access-token",
    globalToken: "evls_gt_cli_global_token",
    projectId: "soulmate",
    clientId: "lc_cloud_auth_test",
  }));

  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
    });
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (req.url === "/api/v1/cli/projects/soulmate") {
        res.writeHead(200, { "Content-Type": "application/json", "Connection": "close" });
        res.end(JSON.stringify({ id: "soulmate", name: "SoulMate", status: "running" }));
      } else if (req.url?.startsWith("/api/v1/projects/soulmate/cli/workspace")) {
        res.writeHead(200, { "Content-Type": "application/json", "Connection": "close" });
        res.end(JSON.stringify({
          project: { id: "soulmate", name: "SoulMate" },
          files: [],
          memory: [],
          knowledge: [],
          toolIds: [],
          sync: { allowedItems: [], deniedReason: "client_not_registered" },
        }));
      } else if (req.url === "/api/v1/projects/soulmate/sessions/s1/messages") {
        res.writeHead(200, { "Content-Type": "application/json", "Connection": "close" });
        res.end(JSON.stringify({ accepted: true, task: { id: "task-cli" }, session: { id: "s1" } }));
      } else {
        res.writeHead(404, { "Content-Type": "application/json", "Connection": "close" });
        res.end(JSON.stringify({ detail: `unexpected ${req.method} ${req.url}` }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const env = {
      ANYENV_CONFIG: config,
      ANYENV_API_BASE: `http://127.0.0.1:${port}/api/v1`,
      ANYENV_PROJECT_ID: "soulmate",
    };
    JSON.parse(await runAsync(["projects", "get", "soulmate", "--json"], env));
    JSON.parse(await runAsync(["context", "workspace", "--project", "soulmate", "--json"], env));
    JSON.parse(await runAsync(["coding", "--project", "soulmate", "--session", "s1", "--prompt", "hello", "--json"], env));

    assert.equal(requests[0].url, "/api/v1/cli/projects/soulmate");
    assert.equal(requests[0].authorization, "Bearer evls_gt_cli_global_token");
    assert.equal(requests[1].url, "/api/v1/projects/soulmate/cli/workspace?clientId=lc_cloud_auth_test");
    assert.equal(requests[1].authorization, "Bearer evls_gt_cli_global_token");
    assert.equal(requests[2].url, "/api/v1/projects/soulmate/sessions/s1/messages");
    assert.equal(requests[2].authorization, "Bearer eyJ-user-access-token");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("mcp config preserves explicit global token environment", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const config = path.join(dir, "config.json");
  const output = run(["mcp", "config", "--client", "cursor"], {
    ANYENV_CONFIG: config,
    ANYENV_GLOBAL_TOKEN: "evls_gt_env_only_token",
    ANYENV_PROJECT_ID: "soulmate",
  });
  const parsed = JSON.parse(output);
  assert.equal(parsed.mcpServers.anyenv.env.ANYENV_CONFIG, config);
  assert.equal(parsed.mcpServers.anyenv.env.ANYENV_GLOBAL_TOKEN, "evls_gt_env_only_token");
  assert.equal(parsed.mcpServers.anyenv.env.ANYENV_PROJECT_ID, "soulmate");
});

test("device doctor emits local tool discovery without a token", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const config = path.join(dir, "config.json");
  const output = run(["device", "doctor", "--json", "--api", "http://localhost:36732/api/v1"], { ANYENV_CONFIG: config });
  const parsed = JSON.parse(output);
  assert.equal(parsed.ok, true);
  assert.ok(parsed.deviceId.startsWith("ld_"));
  assert.ok(Array.isArray(parsed.tools));
  assert.ok(parsed.tools.some((tool) => tool.id === "codex"));
  assert.equal(parsed.capabilities.includes("local-compute"), false);
});

test("daemon status json uses the active config directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const config = path.join(dir, "config.json");
  const output = run(["status", "--json"], { ANYENV_CONFIG: config });
  const parsed = JSON.parse(output);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.running, false);
  assert.equal(parsed.stale, false);
  assert.equal(parsed.state, null);
  assert.equal(parsed.statePath, path.join(dir, "daemon.json"));
  assert.equal(parsed.logPath, path.join(dir, "daemon.log"));
  assert.deepEqual(parsed.recentLogs, []);
});

test("daemon logs reads the active daemon log tail", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const config = path.join(dir, "config.json");
  fs.writeFileSync(config, JSON.stringify({ apiBase: "http://127.0.0.1:36732/api/v1" }));
  fs.writeFileSync(path.join(dir, "daemon.log"), [
    "[AnyEnv:device] 2026-06-22T00:00:00.000Z ws.close {\"code\":1006}",
    "[AnyEnv:device] 2026-06-22T00:00:01.000Z ws.reconnect.schedule {\"attempt\":1,\"delayMs\":1000}",
  ].join("\n"));
  const human = run(["logs", "--tail", "1"], { ANYENV_CONFIG: config });
  assert.doesNotMatch(human, /ws.close/);
  assert.match(human, /ws.reconnect.schedule/);
  const parsed = JSON.parse(run(["logs", "--tail", "2", "--json"], { ANYENV_CONFIG: config }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.logPath, path.join(dir, "daemon.log"));
  assert.equal(parsed.lines.length, 2);
  assert.match(parsed.lines[0], /ws.close/);
});

test("daemon status surfaces stale auth failure diagnostics", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const config = path.join(dir, "config.json");
  fs.writeFileSync(config, JSON.stringify({ apiBase: "http://127.0.0.1:36732/api/v1" }));
  fs.writeFileSync(path.join(dir, "daemon.json"), JSON.stringify({
    pid: 999999,
    scope: "account",
    projectId: "",
    logPath: path.join(dir, "daemon.log"),
  }));
  fs.writeFileSync(path.join(dir, "daemon.log"), [
    "[anyenv:debug] old lowercase debug prefix",
    "Token is invalid, revoked, or missing local-device permission",
    "[AnyEnv:debug] new uppercase debug prefix",
  ].join("\n"));

  const human = run(["status"], { ANYENV_CONFIG: config });
  assert.match(human, /stale state found/);
  assert.match(human, /Last log: Token is invalid, revoked, or missing local-device permission/);
  assert.match(human, /Next step: Run anyenv login --account/);

  const parsed = JSON.parse(run(["status", "--json"], { ANYENV_CONFIG: config }));
  assert.equal(parsed.running, false);
  assert.equal(parsed.stale, true);
  assert.equal(parsed.diagnostic.code, "local_device_auth_failed");
  assert.match(parsed.diagnostic.nextStep, /anyenv login --account/);
});

test("daemon status explains stale heartbeat without an exit record", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const config = path.join(dir, "config.json");
  const logPath = path.join(dir, "daemon.log");
  const now = new Date(Date.now() - 90_000).toISOString();
  fs.writeFileSync(config, JSON.stringify({ apiBase: "http://127.0.0.1:36732/api/v1" }));
  fs.writeFileSync(path.join(dir, "daemon.json"), JSON.stringify({
    pid: 99999999,
    scope: "account",
    projectId: "",
    logPath,
    startedAt: new Date(Date.now() - 300_000).toISOString(),
    lastEvent: "ws.heartbeat.sent",
    lastEventAt: now,
    lastHeartbeatAt: now,
  }));
  fs.writeFileSync(logPath, [
    `[AnyEnv:device] ${now} ws.heartbeat.sent {"runId":"lrun_test","connectionId":"lconn_test","attempt":2}`,
  ].join("\n"));

  const human = run(["status"], { ANYENV_CONFIG: config });
  assert.match(human, /stale state found/);
  assert.match(human, /Diagnostic: The last daemon event was a healthy heartbeat/);
  assert.match(human, /CLI cache issue/);

  const parsed = JSON.parse(run(["status", "--json"], { ANYENV_CONFIG: config }));
  assert.equal(parsed.running, false);
  assert.equal(parsed.stale, true);
  assert.equal(parsed.diagnostic.code, "daemon_disappeared_after_heartbeat");
  assert.equal(parsed.diagnostic.lastEvent, "ws.heartbeat.sent");
  assert.equal(parsed.diagnostic.lastHeartbeatAt, now);
});

test("start dry-run plans a foreground daemon without exposing tokens", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const config = path.join(dir, "config.json");
  fs.writeFileSync(config, JSON.stringify({
    apiBase: "http://127.0.0.1:36732/api/v1",
    globalToken: "evls_gt_device_daemon_token",
    projectId: "soulmate",
    clientId: "lc_device_daemon",
    deviceId: "ld_device_daemon",
  }));
  const output = run([
    "start",
    "--dry-run",
    "--json",
    "--name",
    "Daemon Test",
  ], { ANYENV_CONFIG: config });
  const parsed = JSON.parse(output);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.scope, "account");
  assert.equal(parsed.projectId, null);
  assert.deepEqual(parsed.args, ["start", "--foreground", "--name", "Daemon Test"]);
  assert.equal(parsed.websocketUrl, "ws://127.0.0.1:36732/ws/local-devices");
  assert.doesNotMatch(output, /evls_gt_device_daemon_token/);
});

test("start rejects the old project-scoped local device mode", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const config = path.join(dir, "config.json");
  fs.writeFileSync(config, JSON.stringify({
    globalToken: "evls_gt_device_account_only_token",
    projectId: "soulmate",
    clientId: "lc_device_account_only",
  }));

  assert.throws(
    () => run(["start", "--project", "soulmate", "--dry-run", "--json"], { ANYENV_CONFIG: config }),
    (error) => {
      const parsed = JSON.parse(error.stdout);
      assert.equal(parsed.ok, false);
      assert.match(parsed.error.message, /账号级 CLI 能力/);
      return true;
    },
  );
});

test("start dry-run without explicit project ignores ambient project context", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const config = path.join(dir, "config.json");
  fs.writeFileSync(config, JSON.stringify({
    apiBase: "http://127.0.0.1:36732/api/v1",
    globalToken: "evls_gt_account_daemon_token",
    projectId: "stored-project-context",
    clientId: "lc_account_daemon",
    deviceId: "ld_account_daemon",
  }));
  const output = run([
    "start",
    "--dry-run",
    "--json",
    "--name",
    "Account Daemon",
  ], {
    ANYENV_CONFIG: config,
    ANYENV_PROJECT_ID: "env-project-context",
    ANYENV_PROJECT_TOKEN: "",
  });
  const parsed = JSON.parse(output);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.scope, "account");
  assert.equal(parsed.projectId, null);
  assert.deepEqual(parsed.args, ["start", "--foreground", "--name", "Account Daemon"]);
  assert.doesNotMatch(output, /evls_gt_account_daemon_token/);
});

test("start dry-run preserves debug flag for foreground daemon child", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const config = path.join(dir, "config.json");
  fs.writeFileSync(config, JSON.stringify({
    apiBase: "http://127.0.0.1:36732/api/v1",
    globalToken: "evls_gt_debug_daemon_token",
    clientId: "lc_debug_daemon",
    deviceId: "ld_debug_daemon",
  }));
  const output = run([
    "start",
    "--dry-run",
    "--json",
    "--workspace",
    dir,
    "--debug",
  ], { ANYENV_CONFIG: config });
  const parsed = JSON.parse(output);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.scope, "account");
  assert.deepEqual(parsed.args, ["start", "--foreground", "--workspace", dir, "--debug"]);
  assert.doesNotMatch(output, /evls_gt_debug_daemon_token/);
});

test("start without project registers an account-scoped agent with explicit workspaces", async () => {
  const { WebSocketServer } = await import("ws");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const workspaceDir = path.join(dir, "workspace");
  fs.mkdirSync(workspaceDir);
  const config = path.join(dir, "config.json");
  fs.writeFileSync(config, JSON.stringify({
    apiBase: "http://127.0.0.1:1/api/v1",
    globalToken: "evls_gt_account_agent_token",
    projectId: "stale-project-context",
    clientId: "lc_account_agent",
    deviceId: "ld_account_agent",
  }));

  let accountRegisterRequest = null;
  let accountRegisterBody = null;
  let authMessage = null;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      accountRegisterRequest = {
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
      };
      accountRegisterBody = raw ? JSON.parse(raw) : null;
      if (req.url === "/api/v1/cli/local-clients/register") {
        res.writeHead(201, { "Content-Type": "application/json", "Connection": "close" });
        res.end(JSON.stringify({
          id: "aloc-account-agent",
          clientId: accountRegisterBody.clientId,
          deviceId: accountRegisterBody.deviceId,
          name: accountRegisterBody.name,
          status: "online",
          workspaces: accountRegisterBody.workspaces,
          tools: accountRegisterBody.tools,
          capabilities: accountRegisterBody.capabilities,
        }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json", "Connection": "close" });
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
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const output = await runAsync([
      "start",
      "--foreground",
      "--once",
      "--json",
      "--api",
      `http://127.0.0.1:${port}/api/v1`,
      "--workspace",
      workspaceDir,
      "--name",
      "Account Agent",
    ], {
      ANYENV_CONFIG: config,
      ANYENV_PROJECT_ID: "ambient-project-context",
      ANYENV_PROJECT_TOKEN: "",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    });
    const parsed = JSON.parse(output);
    const stored = JSON.parse(fs.readFileSync(config, "utf8"));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.auth.scope, "account");
    assert.equal(parsed.auth.projectId, "");
    assert.equal(accountRegisterRequest.method, "POST");
    assert.equal(accountRegisterRequest.url, "/api/v1/cli/local-clients/register");
    assert.equal(accountRegisterRequest.authorization, "Bearer evls_gt_account_agent_token");
    assert.equal(accountRegisterBody.clientId, "lc_account_agent");
    assert.equal(accountRegisterBody.deviceId, "ld_account_agent");
    assert.equal(accountRegisterBody.workspaces.length, 1);
    assert.equal(accountRegisterBody.workspaces[0].path, workspaceDir);
    assert.equal(authMessage.scope, "account");
    assert.equal(authMessage.projectId, "");
    assert.equal(authMessage.metadata.workspaces[0].path, workspaceDir);
    assert.equal(stored.localWorkspaces[0].path, workspaceDir);
  } finally {
    wss.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("start foreground surfaces local device websocket auth errors", async () => {
  const { WebSocketServer } = await import("ws");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const workspaceDir = path.join(dir, "workspace");
  fs.mkdirSync(workspaceDir);
  const config = path.join(dir, "config.json");
  fs.writeFileSync(config, JSON.stringify({
    apiBase: "http://127.0.0.1:1/api/v1",
    globalToken: "evls_gt_rejected_agent_token",
    clientId: "lc_rejected_agent",
    deviceId: "ld_rejected_agent",
  }));

  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      if (req.url === "/api/v1/cli/local-clients/register") {
        res.writeHead(201, { "Content-Type": "application/json", "Connection": "close" });
        res.end(JSON.stringify({
          id: "aloc-rejected-agent",
          clientId: body.clientId,
          deviceId: body.deviceId,
          name: body.name,
          status: "online",
          workspaces: body.workspaces,
        }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json", "Connection": "close" });
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
      const message = JSON.parse(String(data));
      if (message.type === "auth") {
        ws.send(JSON.stringify({
          type: "error",
          error: "Token 无效、已撤销或缺少本地设备权限",
        }));
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    await assert.rejects(
      runAsync([
        "start",
        "--foreground",
        "--once",
        "--json",
        "--api",
        `http://127.0.0.1:${port}/api/v1`,
        "--workspace",
        workspaceDir,
      ], {
        ANYENV_CONFIG: config,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      }),
      (error) => {
        const parsed = JSON.parse(error.stdout);
        assert.equal(parsed.ok, false);
        assert.equal(parsed.error.code, "local_device_auth_failed");
        assert.equal(parsed.error.tokenType, "global");
        assert.match(parsed.error.message, /missing local-device permission/);
        assert.doesNotMatch(parsed.error.message, /缺少本地设备权限|Token 无效/);
        return true;
      },
    );
  } finally {
    wss.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("start foreground registers and authenticates an account local client with global token", async () => {
  const { WebSocketServer } = await import("ws");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const config = path.join(dir, "config.json");
  fs.writeFileSync(config, JSON.stringify({
    apiBase: "http://127.0.0.1:1/api/v1",
    globalToken: "evls_gt_device_foreground_token",
    projectId: "soulmate",
    clientId: "lc_device_foreground",
    deviceId: "ld_device_foreground",
  }));

  let registerRequest = null;
  let registeredBody = null;
  let authMessage = null;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      registerRequest = {
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
      };
      registeredBody = raw ? JSON.parse(raw) : null;
      if (req.url === "/api/v1/cli/local-clients/register") {
        res.writeHead(201, { "Content-Type": "application/json", "Connection": "close" });
        res.end(JSON.stringify({
          id: "aloc-device-foreground",
          projectId: "",
          clientId: registeredBody.clientId,
          deviceId: registeredBody.deviceId,
          name: registeredBody.name,
          status: "online",
          capabilities: registeredBody.capabilities,
          workspaces: registeredBody.workspaces,
        }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json", "Connection": "close" });
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
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const output = await runAsync([
      "start",
      "--foreground",
      "--once",
      "--json",
      "--name",
      "Foreground Device",
    ], {
      ANYENV_CONFIG: config,
      ANYENV_API_BASE: `http://127.0.0.1:${port}/api/v1`,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    });
    const parsed = JSON.parse(output);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.mode, "foreground");
    assert.equal(parsed.connected, true);
    assert.equal(parsed.websocketUrl, `ws://127.0.0.1:${port}/ws/local-devices`);
    assert.equal(parsed.auth.scope, "account");
    assert.equal(parsed.integration.id, "aloc-device-foreground");
    assert.equal(registerRequest.method, "POST");
    assert.equal(registerRequest.url, "/api/v1/cli/local-clients/register");
    assert.equal(registerRequest.authorization, "Bearer evls_gt_device_foreground_token");
    assert.equal(registeredBody.clientId, "lc_device_foreground");
    assert.equal(registeredBody.deviceId, "ld_device_foreground");
    assert.equal(registeredBody.name, "Foreground Device");
    assert.equal(authMessage.type, "auth");
    assert.equal(authMessage.scope, "account");
    assert.equal(authMessage.token, "evls_gt_device_foreground_token");
    assert.equal(authMessage.projectId, "");
    assert.equal(authMessage.clientId, "lc_device_foreground");
    assert.equal(authMessage.deviceId, "ld_device_foreground");
  } finally {
    wss.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("start foreground executes an allowed account command request over websocket", async () => {
  const { WebSocketServer } = await import("ws");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-command-e2e-"));
  const workspaceDir = path.join(dir, "workspace");
  fs.mkdirSync(workspaceDir);
  const config = path.join(dir, "config.json");
  fs.writeFileSync(config, JSON.stringify({
    apiBase: "http://127.0.0.1:1/api/v1",
    globalToken: "evls_gt_command_e2e_token",
    clientId: "lc_command_e2e",
    deviceId: "ld_command_e2e",
  }));

  let registerBody = null;
  let authMessage = null;
  let commandResponse = null;
  const commandEvents = [];
  const commandMarker = `anyenv-command-e2e-${Date.now()}`;
  const commandScript = `console.log(${JSON.stringify(commandMarker)})`;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      if (req.url === "/api/v1/cli/local-clients/register") {
        registerBody = body;
        res.writeHead(201, { "Content-Type": "application/json", "Connection": "close" });
        res.end(JSON.stringify({
          id: "aloc-command-e2e",
          clientId: body.clientId,
          deviceId: body.deviceId,
          name: body.name,
          status: "online",
          capabilities: body.capabilities,
          workspaces: body.workspaces,
        }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json", "Connection": "close" });
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
            requestId: "ldr-command-e2e",
            command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(commandScript)}`,
            cwd: workspaceDir,
            timeoutSeconds: 5,
            maxOutputBytes: 4096,
            _eventTypes: ["command.event"],
          }));
        }, 50);
        return;
      }
      if (message.type === "command.event") {
        commandEvents.push(message);
        return;
      }
      if (message.type === "command.response") {
        commandResponse = message;
        ws.close(1000);
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let child = null;
  try {
    const { port } = server.address();
    let stdout = "";
    let stderr = "";
    child = spawn(process.execPath, [
      bin,
      "start",
      "--foreground",
      "--json",
      "--api",
      `http://127.0.0.1:${port}/api/v1`,
      "--workspace",
      workspaceDir,
      "--allow-local-commands",
      "--command-timeout",
      "10",
    ], {
      cwd: root,
      env: {
        ...process.env,
        ANYENV_CONFIG: config,
        ANYENV_PROJECT_ID: "ambient-project-context",
        ANYENV_PROJECT_TOKEN: "",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => { stderr += `${error.message}\n`; });
    const parsed = await waitFor(() => {
      if (!commandResponse) return null;
      const match = stdout.match(/\{[\s\S]*\}\s*$/);
      if (!match) return null;
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }, 10000);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.auth.scope, "account");
    assert.ok(registerBody.capabilities.includes("command-exec"));
    assert.ok(registerBody.metadata.commandExecution.enabled);
    assert.equal(registerBody.metadata.commandExecution.root, workspaceDir);
    assert.ok(authMessage.capabilities.includes("command-exec"));
    assert.match(authMessage.connectionId, /^lconn_/);
    assert.equal(commandResponse.type, "command.response");
    assert.equal(commandResponse.requestId, "ldr-command-e2e");
    assert.equal(commandResponse.connectionId, authMessage.connectionId);
    assert.equal(commandResponse.ok, true);
    assert.equal(commandResponse.cwd, workspaceDir);
    assert.match(commandResponse.stdout, new RegExp(commandMarker));
    assert.ok(commandEvents.some((event) => event.stream === "stdout" && event.data.includes(commandMarker)));
    assert.ok(commandEvents.every((event) => event.connectionId === authMessage.connectionId));
    assert.equal(commandResponse.exitCode, 0);
    const logText = fs.readFileSync(path.join(dir, "daemon.log"), "utf8");
    assert.match(logText, new RegExp(authMessage.connectionId));
    assert.match(logText, /command.request/);
    assert.match(logText, /command.response/);
    assert.match(logText, /ws.close/);
  } finally {
    if (child && !child.killed) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("close", resolve));
    }
    wss.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("start foreground opens a real local PTY shell over websocket", async () => {
  let pythonOk = false;
  for (const command of ["python3", "python"]) {
    try {
      execFileSync(command, ["-c", "import pty,sys; sys.exit(0)"], { stdio: "ignore", timeout: 3000 });
      pythonOk = true;
      break;
    } catch {
      // Try the next Python command.
    }
  }
  if (!pythonOk) return;

  const { WebSocketServer } = await import("ws");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-pty-e2e-"));
  const workspaceDir = path.join(dir, "workspace");
  fs.mkdirSync(workspaceDir);
  const config = path.join(dir, "config.json");
  fs.writeFileSync(config, JSON.stringify({
    apiBase: "http://127.0.0.1:1/api/v1",
    globalToken: "evls_gt_pty_e2e_token",
    accessToken: "access_pty_e2e_token",
    clientId: "lc_pty_e2e",
    deviceId: "ld_pty_e2e",
  }));

  let registerBody = null;
  let authMessage = null;
  let openResponse = null;
  let exitResponse = null;
  let ptyOutput = "";
  const marker = `ANYENV_PTY_OK_${Date.now()}`;
  const expectedRows = 17;
  const expectedCols = 61;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      if (req.url === "/api/v1/cli/local-clients/register") {
        registerBody = body;
        res.writeHead(201, { "Content-Type": "application/json", "Connection": "close" });
        res.end(JSON.stringify({
          id: "aloc-pty-e2e",
          clientId: body.clientId,
          deviceId: body.deviceId,
          name: body.name,
          status: "online",
          capabilities: body.capabilities,
          workspaces: body.workspaces,
        }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json", "Connection": "close" });
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
            type: "pty.open.request",
            requestId: "lpty-e2e-request",
            sessionId: "lsh_pty_e2e",
            cwd: workspaceDir,
            cols: 100,
            rows: 30,
            lastSeq: 0,
          }));
        }, 50);
        return;
      }
      if (message.type === "pty.open.response") {
        openResponse = message;
        ws.send(JSON.stringify({
          type: "pty.resize",
          requestId: "lpty-e2e-request",
          sessionId: "lsh_pty_e2e",
          cols: expectedCols,
          rows: expectedRows,
        }));
        ws.send(JSON.stringify({
          type: "pty.input",
          requestId: "lpty-e2e-request",
          sessionId: "lsh_pty_e2e",
          data: Buffer.from(`printf '\\033[31m${marker}\\033[0m\\n'; printf 'ENV=TERM:%s COLOR:%s FORCE:%s NO:%s\\n' "$TERM" "$COLORTERM" "$FORCE_COLOR" "\${NO_COLOR-unset}"; printf 'SIZE='; stty size; exit\n`, "utf8").toString("base64"),
        }));
        return;
      }
      if (message.type === "pty.output") {
        ptyOutput += Buffer.from(String(message.data || ""), "base64").toString("utf8");
        return;
      }
      if (message.type === "pty.exit") {
        exitResponse = message;
        ws.close(1000);
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let child = null;
  try {
    const { port } = server.address();
    let stdout = "";
    let stderr = "";
    child = spawn(process.execPath, [
      bin,
      "start",
      "--foreground",
      "--json",
      "--api",
      `http://127.0.0.1:${port}/api/v1`,
      "--workspace",
      workspaceDir,
      "--allow-local-commands",
    ], {
      cwd: root,
      env: {
        ...process.env,
        ANYENV_CONFIG: config,
        ANYENV_PROJECT_ID: "",
        ANYENV_PROJECT_TOKEN: "",
        TERM: "dumb",
        NO_COLOR: "1",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => { stderr += `${error.message}\n`; });
    const parsed = await waitFor(() => {
      if (!exitResponse) return null;
      const match = stdout.match(/\{[\s\S]*\}\s*$/);
      if (!match) return null;
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }, 10000);
    assert.equal(parsed.ok, true);
    assert.ok(registerBody.capabilities.includes("command-exec"));
    assert.ok(registerBody.capabilities.includes("local-shell:pty"));
    assert.ok(registerBody.capabilities.includes("local-shell:direct"));
    assert.equal(registerBody.metadata?.localShellBridge?.enabled, true);
    assert.match(registerBody.metadata?.localShellBridge?.wsBase || "", /^ws:\/\/127\.0\.0\.1:\d+$/);
    assert.match(registerBody.metadata?.localShellBridge?.token || "", /^[A-Za-z0-9_-]{20,}$/);
    assert.ok(authMessage.capabilities.includes("local-shell:pty"));
    assert.ok(authMessage.capabilities.includes("local-shell:direct"));
    assert.equal(openResponse.type, "pty.open.response");
    assert.equal(openResponse.ok, true);
    assert.equal(openResponse.sessionId, "lsh_pty_e2e");
    assert.equal(openResponse.cwd, workspaceDir);
    assert.match(ptyOutput, new RegExp(marker));
    assert.match(ptyOutput, new RegExp(`\\x1b\\[31m${marker}\\x1b\\[0m`));
    assert.match(ptyOutput, /ENV=TERM:xterm-256color COLOR: FORCE: NO:1/);
    assert.match(ptyOutput, new RegExp(`SIZE=${expectedRows}\\s+${expectedCols}`));
    assert.equal(exitResponse.type, "pty.exit");
    assert.equal(exitResponse.sessionId, "lsh_pty_e2e");
  } finally {
    if (child && !child.killed) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("close", resolve));
    }
    wss.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("start foreground bridges local VNC bytes when remote desktop is explicitly enabled", async () => {
  const { WebSocketServer } = await import("ws");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-vnc-e2e-"));
  const config = path.join(dir, "config.json");
  fs.writeFileSync(config, JSON.stringify({
    apiBase: "http://127.0.0.1:1/api/v1",
    globalToken: "evls_gt_vnc_e2e_token",
    clientId: "lc_vnc_e2e",
    deviceId: "ld_vnc_e2e",
  }));

  let tcpSocket = null;
  let tcpReceived = "";
  const tcpServer = net.createServer((socket) => {
    tcpSocket = socket;
    socket.write(Buffer.from("RFB 003.008\n", "utf8"));
    socket.on("data", (chunk) => {
      tcpReceived += chunk.toString("utf8");
    });
  });
  await new Promise((resolve) => tcpServer.listen(0, "127.0.0.1", resolve));
  const vncPort = tcpServer.address().port;

  let registerBody = null;
  let authMessage = null;
  let openResponse = null;
  let vncBannerFrame = null;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      if (req.url === "/api/v1/cli/local-clients/register") {
        registerBody = body;
        res.writeHead(201, { "Content-Type": "application/json", "Connection": "close" });
        res.end(JSON.stringify({
          id: "aloc-vnc-e2e",
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
      res.writeHead(404, { "Content-Type": "application/json", "Connection": "close" });
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
            type: "vnc.open.request",
            requestId: "lvnc-cli-e2e",
          }));
        }, 50);
        return;
      }
      if (message.type === "vnc.open.response") {
        openResponse = message;
        ws.send(JSON.stringify({
          type: "vnc.data",
          requestId: "lvnc-cli-e2e",
          data: Buffer.from("browser-to-vnc", "utf8").toString("base64"),
        }));
        return;
      }
      if (message.type === "vnc.data") {
        vncBannerFrame = message;
        ws.send(JSON.stringify({ type: "vnc.close", requestId: "lvnc-cli-e2e", reason: "test_done" }));
        ws.close(1000);
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let child = null;
  try {
    const { port } = server.address();
    child = spawn(process.execPath, [
      bin,
      "start",
      "--foreground",
      "--json",
      "--api",
      `http://127.0.0.1:${port}/api/v1`,
      "--allow-remote-desktop",
      "--vnc-port",
      String(vncPort),
    ], {
      cwd: root,
      env: {
        ...process.env,
        ANYENV_CONFIG: config,
        ANYENV_PROJECT_ID: "",
        ANYENV_PROJECT_TOKEN: "",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr.resume();
    child.stdout.resume();
    await waitFor(() => openResponse && vncBannerFrame && tcpReceived.includes("browser-to-vnc"), 10000);
    assert.ok(registerBody.capabilities.includes("remote-desktop"));
    assert.ok(registerBody.capabilities.includes("remote-desktop:vnc"));
    assert.ok(!registerBody.capabilities.includes("local-workspace"));
    assert.deepEqual(registerBody.workspaces, []);
    assert.equal(registerBody.metadata.remoteDesktop.enabled, true);
    assert.equal(registerBody.metadata.remoteDesktop.port, vncPort);
    assert.ok(authMessage.capabilities.includes("remote-desktop:vnc"));
    assert.equal(openResponse.ok, true);
    assert.equal(openResponse.requestId, "lvnc-cli-e2e");
    assert.equal(Buffer.from(vncBannerFrame.data, "base64").toString("utf8"), "RFB 003.008\n");
  } finally {
    if (tcpSocket) tcpSocket.destroy();
    if (child && !child.killed) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("close", resolve));
    }
    wss.close();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => tcpServer.close(resolve));
  }
});

test("start foreground auto-detects a local VNC port that speaks RFB", async () => {
  const { WebSocketServer } = await import("ws");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-vnc-auto-"));
  const config = path.join(dir, "config.json");
  fs.writeFileSync(config, JSON.stringify({
    apiBase: "http://127.0.0.1:1/api/v1",
    globalToken: "evls_gt_vnc_auto_token",
    clientId: "lc_vnc_auto",
    deviceId: "ld_vnc_auto",
  }));

  let badSocket = null;
  const badServer = net.createServer((socket) => {
    badSocket = socket;
  });
  await new Promise((resolve) => badServer.listen(0, "127.0.0.1", resolve));
  const badPort = badServer.address().port;

  let tcpSocket = null;
  let tcpReceived = "";
  const tcpServer = net.createServer((socket) => {
    tcpSocket = socket;
    socket.write(Buffer.from("RFB 003.008\n", "utf8"));
    socket.on("data", (chunk) => {
      tcpReceived += chunk.toString("utf8");
    });
  });
  await new Promise((resolve) => tcpServer.listen(0, "127.0.0.1", resolve));
  const vncPort = tcpServer.address().port;

  let registerBody = null;
  let openResponse = null;
  let vncBannerFrame = null;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      if (req.url === "/api/v1/cli/local-clients/register") {
        registerBody = body;
        res.writeHead(201, { "Content-Type": "application/json", "Connection": "close" });
        res.end(JSON.stringify({
          id: "aloc-vnc-auto",
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
      res.writeHead(404, { "Content-Type": "application/json", "Connection": "close" });
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
      const message = JSON.parse(String(data));
      if (message.type === "auth") {
        ws.send(JSON.stringify({
          type: "ready",
          scope: "account",
          projectId: "",
          clientId: message.clientId,
          deviceId: message.deviceId,
        }));
        setTimeout(() => {
          ws.send(JSON.stringify({
            type: "vnc.open.request",
            requestId: "lvnc-cli-auto",
          }));
        }, 50);
        return;
      }
      if (message.type === "vnc.open.response") {
        openResponse = message;
        ws.send(JSON.stringify({
          type: "vnc.data",
          requestId: "lvnc-cli-auto",
          data: Buffer.from("browser-to-auto-vnc", "utf8").toString("base64"),
        }));
        return;
      }
      if (message.type === "vnc.data") {
        vncBannerFrame = message;
        ws.send(JSON.stringify({ type: "vnc.close", requestId: "lvnc-cli-auto", reason: "test_done" }));
        ws.close(1000);
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let child = null;
  try {
    const { port } = server.address();
    child = spawn(process.execPath, [
      bin,
      "start",
      "--foreground",
      "--json",
      "--api",
      `http://127.0.0.1:${port}/api/v1`,
      "--allow-remote-desktop",
    ], {
      cwd: root,
      env: {
        ...process.env,
        ANYENV_CONFIG: config,
        ANYENV_PROJECT_ID: "",
        ANYENV_PROJECT_TOKEN: "",
        ANYENV_VNC_PORT_CANDIDATES: `${badPort},${vncPort}`,
        ANYENV_VNC_AUTO_HANDSHAKE_TIMEOUT_MS: "150",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr.resume();
    child.stdout.resume();
    await waitFor(() => openResponse && vncBannerFrame && tcpReceived.includes("browser-to-auto-vnc"), 10000);
    assert.equal(registerBody.metadata.remoteDesktop.portMode, "auto");
    assert.deepEqual(registerBody.metadata.remoteDesktop.candidatePorts, [badPort, vncPort]);
    assert.equal(openResponse.ok, true);
    assert.equal(openResponse.port, vncPort);
    assert.equal(openResponse.resolvedPort, vncPort);
    assert.equal(openResponse.remoteDesktop.port, vncPort);
    assert.equal(openResponse.remoteDesktop.portMode, "auto");
    assert.equal(Buffer.from(vncBannerFrame.data, "base64").toString("utf8"), "RFB 003.008\n");
  } finally {
    if (badSocket) badSocket.destroy();
    if (tcpSocket) tcpSocket.destroy();
    if (child && !child.killed) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("close", resolve));
    }
    wss.close();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => tcpServer.close(resolve));
    await new Promise((resolve) => badServer.close(resolve));
  }
});

test("start foreground rejects a local remote desktop port that never speaks RFB", async () => {
  const { WebSocketServer } = await import("ws");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-vnc-timeout-"));
  const config = path.join(dir, "config.json");
  fs.writeFileSync(config, JSON.stringify({
    apiBase: "http://127.0.0.1:1/api/v1",
    globalToken: "evls_gt_vnc_timeout_token",
    clientId: "lc_vnc_timeout",
    deviceId: "ld_vnc_timeout",
  }));

  let tcpSocket = null;
  const tcpServer = net.createServer((socket) => {
    tcpSocket = socket;
  });
  await new Promise((resolve) => tcpServer.listen(0, "127.0.0.1", resolve));
  const vncPort = tcpServer.address().port;

  let openResponse = null;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      if (req.url === "/api/v1/cli/local-clients/register") {
        res.writeHead(201, { "Content-Type": "application/json", "Connection": "close" });
        res.end(JSON.stringify({
          id: "aloc-vnc-timeout",
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
      res.writeHead(404, { "Content-Type": "application/json", "Connection": "close" });
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
      const message = JSON.parse(String(data));
      if (message.type === "auth") {
        ws.send(JSON.stringify({
          type: "ready",
          scope: "account",
          projectId: "",
          clientId: message.clientId,
          deviceId: message.deviceId,
        }));
        setTimeout(() => {
          ws.send(JSON.stringify({
            type: "vnc.open.request",
            requestId: "lvnc-cli-timeout",
          }));
        }, 50);
        return;
      }
      if (message.type === "vnc.open.response") {
        openResponse = message;
        ws.close(1000);
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let child = null;
  try {
    const { port } = server.address();
    child = spawn(process.execPath, [
      bin,
      "start",
      "--foreground",
      "--json",
      "--api",
      `http://127.0.0.1:${port}/api/v1`,
      "--allow-remote-desktop",
      "--vnc-port",
      String(vncPort),
    ], {
      cwd: root,
      env: {
        ...process.env,
        ANYENV_CONFIG: config,
        ANYENV_PROJECT_ID: "",
        ANYENV_PROJECT_TOKEN: "",
        ANYENV_VNC_HANDSHAKE_TIMEOUT_MS: "200",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr.resume();
    child.stdout.resume();
    await waitFor(() => openResponse, 10000);
    assert.equal(openResponse.ok, false);
    assert.equal(openResponse.code, "vnc_handshake_timeout");
    assert.match(openResponse.error, /VNC\/RFB/);
  } finally {
    if (tcpSocket) tcpSocket.destroy();
    if (child && !child.killed) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("close", resolve));
    }
    wss.close();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => tcpServer.close(resolve));
  }
});

test("start background fails fast when the daemon exits during websocket auth", async () => {
  const { WebSocketServer } = await import("ws");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const workspaceDir = path.join(dir, "workspace");
  fs.mkdirSync(workspaceDir);
  const config = path.join(dir, "config.json");
  fs.writeFileSync(config, JSON.stringify({
    apiBase: "http://127.0.0.1:1/api/v1",
    globalToken: "evls_gt_rejected_background_token",
    clientId: "lc_rejected_background",
    deviceId: "ld_rejected_background",
  }));

  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      if (req.url === "/api/v1/cli/local-clients/register") {
        res.writeHead(201, { "Content-Type": "application/json", "Connection": "close" });
        res.end(JSON.stringify({
          id: "aloc-rejected-background",
          clientId: body.clientId,
          deviceId: body.deviceId,
          name: body.name,
          status: "online",
          workspaces: body.workspaces,
        }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json", "Connection": "close" });
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
      const message = JSON.parse(String(data));
      if (message.type === "auth") {
        ws.send(JSON.stringify({
          type: "error",
          error: "Token 无效、已撤销或缺少本地设备权限",
        }));
      }
    });
  });

  const env = {
    ANYENV_CONFIG: config,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  };
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    await assert.rejects(
      runAsync([
        "start",
        "--json",
        "--api",
        `http://127.0.0.1:${port}/api/v1`,
        "--workspace",
        workspaceDir,
        "--debug",
        "--startup-timeout-ms",
        "2500",
      ], env),
      (error) => {
        const parsed = JSON.parse(error.stdout);
        assert.equal(parsed.ok, false);
        assert.match(parsed.error.message, /daemon exited immediately after startup/);
        assert.match(parsed.error.message, /missing local-device permission/);
        assert.match(parsed.error.message, /Next steps:/);
        assert.match(parsed.error.message, /anyenv login/);
        assert.match(parsed.error.nextStep, /login --account/);
        assert.match(parsed.error.nextStep, /account-level local-client WebSocket server/);
        assert.doesNotMatch(parsed.error.message, /daemon 启动后退出|缺少本地设备权限|Token 无效|日志：/);
        assert.doesNotMatch(parsed.error.message, /\[anyenv:debug\]|workspaces/);
        assert.doesNotMatch(parsed.error.message, /old stale daemon error/);
        assert.equal(parsed.error.code, "local_device_auth_failed");
        return true;
      },
    );
    assert.equal(JSON.parse(run(["status", "--json"], env)).running, false);
  } finally {
    try {
      run(["stop", "--json"], env);
    } catch {}
    wss.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("start runs an account background daemon that connects and can be stopped", async () => {
  const { WebSocketServer } = await import("ws");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const config = path.join(dir, "config.json");
  fs.writeFileSync(config, JSON.stringify({
    apiBase: "http://127.0.0.1:1/api/v1",
    globalToken: "evls_gt_device_background_token",
    projectId: "soulmate",
    clientId: "lc_device_background",
    deviceId: "ld_device_background",
  }));

  let authMessage = null;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      if (req.url === "/api/v1/cli/local-clients/register") {
        res.writeHead(201, { "Content-Type": "application/json", "Connection": "close" });
        res.end(JSON.stringify({
          id: "aloc-device-background",
          projectId: "",
          clientId: body.clientId,
          deviceId: body.deviceId,
          name: body.name,
          status: "online",
          capabilities: body.capabilities,
          workspaces: body.workspaces,
        }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json", "Connection": "close" });
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
      }
    });
  });

  const env = {
    ANYENV_CONFIG: config,
    ANYENV_PROJECT_ID: "soulmate",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  };
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const output = await runAsync([
      "start",
      "--json",
      "--api",
      `http://127.0.0.1:${port}/api/v1`,
      "--name",
      "Background Device",
    ], env);
    const started = JSON.parse(output);
    assert.equal(started.ok, true);
    assert.equal(started.started, true);
    assert.ok(started.pid > 0);
    await waitFor(() => authMessage, 5000);
    assert.equal(authMessage.scope, "account");
    assert.equal(authMessage.token, "evls_gt_device_background_token");
    assert.equal(authMessage.projectId, "");

    const status = JSON.parse(run(["status", "--json"], env));
    assert.equal(status.running, true);
    assert.equal(status.state.pid, started.pid);
    assert.equal(status.state.projectId, "");

    const stopped = JSON.parse(await runAsync(["stop", "--json"], env));
    assert.equal(stopped.ok, true);
    assert.equal(stopped.wasRunning, true);
    assert.equal(JSON.parse(run(["status", "--json"], env)).running, false);
  } finally {
    try {
      run(["stop", "--json"], env);
    } catch {}
    wss.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("json failures emit a parseable error envelope", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const config = path.join(dir, "config.json");
  assert.throws(
    () => run(["local", "status", "--json"], { ANYENV_CONFIG: config }),
    (error) => {
      const parsed = JSON.parse(error.stdout);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.error.code, "token_missing");
      assert.equal(parsed.error.tokenType, "");
      assert.ok(parsed.error.nextStep);
      return true;
    },
  );
});

test("update dry-run defaults to the production download target despite stored local api", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const config = path.join(dir, "config.json");
  const installDir = path.join(dir, "bin");
  fs.writeFileSync(config, JSON.stringify({ apiBase: "http://localhost:36732/api/v1" }));
  const output = run([
    "update",
    "--dry-run",
    "--json",
    "--install-dir",
    installDir,
  ], { ANYENV_CONFIG: config });
  const parsed = JSON.parse(output);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.baseUrl, "https://api.anyenv.cn/api/v1/cli");
  assert.match(parsed.asset, /^anyenv-(darwin|linux|windows)-(x64|arm64)\.(tar\.gz|zip)$/);
  assert.equal(parsed.installDir, installDir);
});

test("update dry-run accepts an explicit private download target", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const config = path.join(dir, "config.json");
  const installDir = path.join(dir, "bin");
  const output = run([
    "update",
    "--dry-run",
    "--json",
    "--base-url",
    "http://localhost:36732/api/v1/cli",
    "--install-dir",
    installDir,
  ], { ANYENV_CONFIG: config });
  const parsed = JSON.parse(output);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.baseUrl, "http://localhost:36732/api/v1/cli");
  assert.equal(parsed.installDir, installDir);
});

test("env activate emits a one-command shell activation script", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const installDir = path.join(dir, "bin with spaces");
  const output = run(["env", "activate", "--install-dir", installDir]);
  assert.match(output, new RegExp(`export PATH='${installDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}':\\$PATH`));
  assert.match(output, /hash -r 2>\/dev\/null \|\| true/);
});

test("upgrade updates the target and prints a single activation command when PATH still points at old anyenv", async () => {
  if (process.platform === "win32") return;
  const tar = spawn("tar", ["--version"], { stdio: "ignore" });
  await new Promise((resolve) => tar.on("close", resolve));
  if (tar.exitCode !== 0) return;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const packageDir = path.join(dir, "package");
  const releaseDir = path.join(dir, "release");
  const installDir = path.join(dir, "new-bin");
  const oldBin = path.join(dir, "old-bin");
  fs.mkdirSync(packageDir);
  fs.mkdirSync(releaseDir);
  fs.mkdirSync(installDir);
  fs.mkdirSync(oldBin);

  const packagedAnyenv = path.join(packageDir, "anyenv");
  fs.writeFileSync(packagedAnyenv, "#!/usr/bin/env sh\nprintf '0.1.11\\n'\n");
  fs.chmodSync(packagedAnyenv, 0o755);
  const oldAnyenv = path.join(oldBin, "anyenv");
  fs.writeFileSync(oldAnyenv, "#!/usr/bin/env sh\nprintf '0.1.2\\n'\n");
  fs.chmodSync(oldAnyenv, 0o755);

  const asset = process.platform === "darwin"
    ? `anyenv-darwin-${process.arch === "arm64" ? "arm64" : "x64"}.tar.gz`
    : `anyenv-linux-${process.arch === "arm64" ? "arm64" : "x64"}.tar.gz`;
  const archive = path.join(releaseDir, asset);
  execFileSync("tar", ["-czf", archive, "-C", packageDir, "anyenv"]);
  const checksum = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");

  const server = http.createServer((req, res) => {
    const url = req.url || "";
    if (url.endsWith("/SHA256SUMS")) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`${checksum}  ${asset}\n`);
      return;
    }
    if (url.endsWith(`/${asset}`)) {
      res.writeHead(200, { "content-type": "application/gzip" });
      fs.createReadStream(archive).pipe(res);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const result = await runAsyncFull([
      "upgrade",
      "--base-url",
      `http://127.0.0.1:${port}/api/v1/cli`,
      "--install-dir",
      installDir,
    ], {
      PATH: `${oldBin}:${installDir}:${process.env.PATH || ""}`,
    });
    const output = result.stdout;
    assert.match(output, /Updated AnyEnv CLI/);
    assert.match(output, /Installed version: 0\.1\.11/);
    assert.match(output, new RegExp(`Active AnyEnv CLI: ${oldAnyenv.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(0\\.1\\.2\\)`));
    assert.match(output, /Your current shell is still using a different AnyEnv CLI binary/);
    assert.match(output, new RegExp(`eval "\\$\\('${path.join(installDir, "anyenv").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}' env activate\\)"`));
    assert.match(result.stderr, /Downloaded SHA256SUMS/);
    assert.match(result.stderr, new RegExp(`Downloading ${asset.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("upgrade rejects a downloaded binary that fails smoke and keeps the old target", async () => {
  if (process.platform === "win32") return;
  const tar = spawn("tar", ["--version"], { stdio: "ignore" });
  await new Promise((resolve) => tar.on("close", resolve));
  if (tar.exitCode !== 0) return;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const packageDir = path.join(dir, "package");
  const releaseDir = path.join(dir, "release");
  const installDir = path.join(dir, "bin");
  fs.mkdirSync(packageDir);
  fs.mkdirSync(releaseDir);
  fs.mkdirSync(installDir);

  const packagedAnyenv = path.join(packageDir, "anyenv");
  fs.writeFileSync(packagedAnyenv, "#!/usr/bin/env sh\nexit 137\n");
  fs.chmodSync(packagedAnyenv, 0o755);
  const installedAnyenv = path.join(installDir, "anyenv");
  fs.writeFileSync(installedAnyenv, "#!/usr/bin/env sh\nprintf '0.1.2\\n'\n");
  fs.chmodSync(installedAnyenv, 0o755);

  const asset = process.platform === "darwin"
    ? `anyenv-darwin-${process.arch === "arm64" ? "arm64" : "x64"}.tar.gz`
    : `anyenv-linux-${process.arch === "arm64" ? "arm64" : "x64"}.tar.gz`;
  const archive = path.join(releaseDir, asset);
  execFileSync("tar", ["-czf", archive, "-C", packageDir, "anyenv"]);
  const checksum = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");

  const server = http.createServer((req, res) => {
    const url = req.url || "";
    if (url.endsWith("/SHA256SUMS")) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`${checksum}  ${asset}\n`);
      return;
    }
    if (url.endsWith(`/${asset}`)) {
      res.writeHead(200, { "content-type": "application/gzip" });
      fs.createReadStream(archive).pipe(res);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    await assert.rejects(
      runAsyncFull([
        "upgrade",
        "--base-url",
        `http://127.0.0.1:${port}/api/v1/cli`,
        "--install-dir",
        installDir,
        "--no-progress",
      ], {
        PATH: `${installDir}:${process.env.PATH || ""}`,
      }),
      (error) => {
        assert.match(error.stderr, /failed smoke test|status 137|137/);
        return true;
      },
    );
    assert.equal(execFileSync(installedAnyenv, ["--version"], { encoding: "utf8" }).trim(), "0.1.2");
    assert.match(fs.readFileSync(installedAnyenv, "utf8"), /0\.1\.2/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("upgrade atomically replaces an existing target instead of overwriting it in place", async () => {
  if (process.platform === "win32") return;
  const tar = spawn("tar", ["--version"], { stdio: "ignore" });
  await new Promise((resolve) => tar.on("close", resolve));
  if (tar.exitCode !== 0) return;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const packageDir = path.join(dir, "package");
  const releaseDir = path.join(dir, "release");
  const installDir = path.join(dir, "bin");
  fs.mkdirSync(packageDir);
  fs.mkdirSync(releaseDir);
  fs.mkdirSync(installDir);

  const packagedAnyenv = path.join(packageDir, "anyenv");
  fs.writeFileSync(packagedAnyenv, "#!/usr/bin/env sh\nprintf '0.1.12\\n'\n");
  fs.chmodSync(packagedAnyenv, 0o755);
  const installedAnyenv = path.join(installDir, "anyenv");
  fs.writeFileSync(installedAnyenv, "#!/usr/bin/env sh\nprintf '0.1.2\\n'\n");
  fs.chmodSync(installedAnyenv, 0o755);
  const beforeInode = fs.statSync(installedAnyenv).ino;

  const asset = process.platform === "darwin"
    ? `anyenv-darwin-${process.arch === "arm64" ? "arm64" : "x64"}.tar.gz`
    : `anyenv-linux-${process.arch === "arm64" ? "arm64" : "x64"}.tar.gz`;
  const archive = path.join(releaseDir, asset);
  execFileSync("tar", ["-czf", archive, "-C", packageDir, "anyenv"]);
  const checksum = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");

  const server = http.createServer((req, res) => {
    const url = req.url || "";
    if (url.endsWith("/SHA256SUMS")) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`${checksum}  ${asset}\n`);
      return;
    }
    if (url.endsWith(`/${asset}`)) {
      res.writeHead(200, { "content-type": "application/gzip" });
      fs.createReadStream(archive).pipe(res);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    await runAsyncFull([
      "upgrade",
      "--base-url",
      `http://127.0.0.1:${port}/api/v1/cli`,
      "--install-dir",
      installDir,
      "--no-progress",
    ], {
      PATH: `${installDir}:${process.env.PATH || ""}`,
    });
    assert.equal(execFileSync(installedAnyenv, ["--version"], { encoding: "utf8" }).trim(), "0.1.12");
    assert.notEqual(fs.statSync(installedAnyenv).ino, beforeInode);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("cleanup removes only anyenv update temp caches and reports PATH binaries", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const tmpRoot = path.join(dir, "tmp");
  const staleUpdate = path.join(tmpRoot, "anyenv-update-stale");
  const unrelated = path.join(tmpRoot, "not-anyenv-update");
  const oldBin = path.join(dir, "old-bin");
  fs.mkdirSync(staleUpdate, { recursive: true });
  fs.mkdirSync(unrelated, { recursive: true });
  fs.writeFileSync(path.join(staleUpdate, "payload"), "cache");
  fs.mkdirSync(oldBin);
  const oldAnyenv = path.join(oldBin, "anyenv");
  fs.writeFileSync(oldAnyenv, "#!/usr/bin/env sh\nprintf '0.1.2\\n'\n");
  fs.chmodSync(oldAnyenv, 0o755);

  const output = run(["cleanup", "--json"], {
    ANYENV_CLEANUP_TMPDIR: tmpRoot,
    PATH: `${oldBin}:${process.env.PATH || ""}`,
  });
  const parsed = JSON.parse(output);
  assert.equal(parsed.dryRun, false);
  assert.equal(fs.existsSync(staleUpdate), false);
  assert.equal(fs.existsSync(unrelated), true);
  assert.ok(parsed.cleaned.some((item) => item.path === staleUpdate && item.removed === true));
  const oldInstall = parsed.installations.find((item) => item.path === oldAnyenv);
  assert.ok(oldInstall);
  assert.equal(oldInstall.version, "0.1.2");
  assert.equal(oldInstall.active, true);
});

test("mcp install dry-run emits merged cursor config without writing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const config = path.join(dir, "config.json");
  const target = path.join(dir, "mcp.json");
  const output = run([
    "mcp",
    "install",
    "--client",
    "cursor",
    "--path",
    target,
    "--dry-run",
    "--json",
  ], { ANYENV_CONFIG: config });
  const parsed = JSON.parse(output);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.path, target);
  assert.equal(parsed.config.mcpServers.anyenv.env.ANYENV_CONFIG, config);
  assert.equal(fs.existsSync(target), false);
});

test("mcp install writes config and can back up an existing file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const config = path.join(dir, "config.json");
  const target = path.join(dir, "mcp.json");
  fs.writeFileSync(target, JSON.stringify({ mcpServers: { other: { command: "other" } } }));
  const output = run([
    "mcp",
    "install",
    "--client",
    "cursor",
    "--path",
    target,
    "--backup",
    "--json",
  ], { ANYENV_CONFIG: config });
  const parsed = JSON.parse(output);
  const stored = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.ok(parsed.backupPath);
  assert.equal(fs.existsSync(parsed.backupPath), true);
  assert.equal(stored.mcpServers.other.command, "other");
  assert.equal(stored.mcpServers.anyenv.env.ANYENV_CONFIG, config);
});

test("logout removes only the local config file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-cli-test-"));
  const config = path.join(dir, "config.json");
  fs.writeFileSync(config, JSON.stringify({ projectToken: "pt_abcdefghijklmnopqrstuvwxyz" }));
  const output = run(["logout", "--json"], { ANYENV_CONFIG: config });
  const parsed = JSON.parse(output);
  assert.equal(parsed.removed, true);
  assert.equal(parsed.configPath, config);
  assert.equal(fs.existsSync(config), false);
});
