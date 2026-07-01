#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { anyenvApiError, heartbeatClient, getWorkspace, registerClient, summarizeWorkspace } from "../lib/api.js";
import {
  DEFAULT_API_BASE,
  VERSION,
  cloudAuthToken,
  configPath,
  isGlobalToken,
  isLoopbackApiBase,
  maskToken,
  debugLog,
  readConfig,
  resolveConfig,
  shellQuote,
  writeConfig,
  writeProjectContext,
} from "../lib/config.js";
import { runBrowserLogin } from "../lib/browser-login.js";
import { daemonStatus, isProcessRunning, spawnDaemon, stopDaemon } from "../lib/daemon.js";
import { connectDevice, localDevicePayload, registerAccountDevice, websocketBaseFromApiBase } from "../lib/device.js";
import { startMcp } from "../lib/mcp.js";
import { activationScript, cleanupCliArtifacts, formatBytes, resolveInstallDir, updateCli } from "../lib/update.js";
import {
  createCredential,
  createDeployment,
  createProject,
  createSession,
  deployReadiness,
  getDeployment,
  getProject,
  getProjectWorkspace,
  getSandbox,
  getSandboxLogs,
  listCredentials,
  listAccountLocalClients,
  listDeployments,
  listProjects,
  registerAccountLocalClient,
  anyenvCloudApiError,
  rollbackDeployment,
  sendCodingMessage,
  setAgentDefaultCredential,
  startSandbox,
  stopSandbox,
  updateCredential,
} from "../lib/cloud-api.js";

let activeArgs = null;

function usage() {
  return `AnyEnv CLI ${VERSION}

Connect IDE/MCP:
  anyenv setup ide --project <id> --client cursor|claude|vscode
  anyenv login [--project-id <id>] [--name <name>] [--type cursor|claude_desktop|vscode|custom]
  anyenv local doctor [--json]
  anyenv local workspace [--json]
  anyenv mcp
  anyenv mcp config [--client cursor|claude|vscode|generic] [--json]
  anyenv mcp install --client cursor|claude|vscode [--path <file>] [--dry-run] [--backup] [--json]

Import local folder:
  anyenv setup local-project <path> [--name <name>] [--read-only]
  anyenv login [--name <name>]
  anyenv local workspace add <path> [--name <name>] [--read-only] [--json]
  anyenv local workspace list [--json]

Cloud operations (uses user access token):
  anyenv auth token set --token <access-token>
  anyenv auth status [--json]
  anyenv projects list [--json]
  anyenv projects create --name <name> [--workspace-id <id>] [--json]
  anyenv projects get --project <id> [--json]
  anyenv credentials import --provider codex|claude|cursor|qwen|opencode|qoder [--token <token>|--from-env <name>|--from-file <path>|--from-local] [--name <name>] [--dry-run] [--yes] [--json]
  anyenv credentials import --all [--from-local] [--dry-run] [--yes] [--json]
  anyenv coding --project <id> [--prompt <text>] [--session <id>] [--agent <id>] [--model <model>] [--json]
  anyenv deploy list|create|status|rollback|readiness --project <id> [--json]
  anyenv sandbox status|start|stop|logs --project <id> [--remove] [--tail 200] [--json]
  anyenv context workspace --project <id> [--json]

Device agent (local command execution is experimental and off by default):
  anyenv start [--workspace <path>] [--name <name>] [--debug] [--json]
  anyenv start --allow-local-commands [--workspace <path>] [--command-root <path>] [--command-timeout <sec>]
  anyenv start --allow-remote-desktop [--vnc-port 5900]
  anyenv start --foreground [--workspace <path>] [--name <name>] [--json]
  anyenv status [--json]
  anyenv logs [--tail 80] [--follow] [--json]
  anyenv stop [--json]
  anyenv restart [--workspace <path>] [--name <name>] [--json]
  anyenv device doctor [--json]
  anyenv device register [--name <name>] [--json]
  anyenv device connect [--name <name>] [--ws <url>] [--json]

Auth/config/update:
  anyenv doctor [--json]
  anyenv token set --token <pt_...|evls_gt_...> [--project <id>] [--name <name>] [--type cursor|vscode|custom] [--no-register]
  anyenv local register --token <pt_...|evls_gt_...> [--project <id>] [--name <name>] [--type cursor|vscode|custom] [--sync memory,knowledge,tools,skills]
  anyenv local status [--json]
  anyenv local heartbeat [--json]
  anyenv config path
  anyenv config show [--json]
  anyenv update|upgrade [--version <version>] [--base-url <url>] [--install-dir <dir>] [--dry-run] [--no-progress] [--json]
  anyenv cleanup [--dry-run] [--json]
  anyenv env activate [--install-dir <dir>]
  anyenv logout [--json]

Environment:
  ANYENV_API_BASE        API base, e.g. https://api.anyenv.cn/api/v1
  ANYENV_WEB_BASE        Web base for anyenv login, e.g. https://www.anyenv.cn
  ANYENV_ACCESS_TOKEN    User access token for cloud resource operations
  ANYENV_GLOBAL_TOKEN    Global token with explicit account/project permissions
  ANYENV_PROJECT_ID      Project context for global token CLI/MCP commands
  ANYENV_PROJECT_TOKEN   Project token created in AnyEnv project detail
  ANYENV_CLIENT_ID       Stable local client id
  ANYENV_DEVICE_ID       Stable local device id for local-device connection
  ANYENV_INSTALL_DIR     CLI update/install target directory
  ANYENV_CONFIG          Config path, default ~/.anyenv/config.json
  ANYENV_DEBUG           Enable detailed debug logs without exposing token secrets
`;
}

function parseArgs(argv) {
  const args = { _: [] };
  const repeatable = new Set(["workspace", "dir"]);
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) {
      args._.push(item);
      continue;
    }
    const key = item.slice(2);
    if (key === "json" || key === "debug" || key === "no-save" || key === "no-open" || key === "no-register" || key === "dry-run" || key === "backup" || key === "once" || key === "read-only" || key === "allow-local-commands" || key === "allow-remote-desktop" || key === "follow" || key === "from-local" || key === "scan-local") {
      args[key] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    if (repeatable.has(key) && args[key] !== undefined) {
      args[key] = Array.isArray(args[key]) ? [...args[key], next] : [args[key], next];
    } else {
      args[key] = next;
    }
    i += 1;
  }
  return args;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printSummary(summary) {
  const client = summary.registeredClient;
  process.stdout.write(`Project: ${summary.project.name || summary.project.id || "(unknown)"}\n`);
  process.stdout.write(`Sandbox: ${summary.project.sandboxRunning ? "running" : "not running"} ${summary.project.sandboxLifecycleState || ""}\n`);
  process.stdout.write(`Sync: ${summary.allowedItems.join(", ") || "(none)"}\n`);
  process.stdout.write(`Memory: ${summary.memoryCount}\n`);
  process.stdout.write(`Knowledge: ${summary.knowledgeCount}\n`);
  process.stdout.write(`Skills: ${summary.skillsCount}\n`);
  process.stdout.write(`Tools: ${summary.toolIds.length ? summary.toolIds.join(", ") : "(none)"}\n`);
  if (summary.deniedReason) process.stdout.write(`Sync note: ${summary.deniedReason}\n`);
  if (client) {
    process.stdout.write(`Client: ${client.name} (${client.clientId}) ${client.clientVersion || ""}\n`);
    process.stdout.write(`Last seen: ${client.clientLastSeenAt || "(never)"}\n`);
  } else {
    process.stdout.write("Client: not registered\n");
  }
}

function sanitizedConfig(config) {
  return {
    ...config,
    accessToken: maskToken(config.accessToken),
    globalToken: maskToken(config.globalToken),
    projectToken: maskToken(config.projectToken),
  };
}

function configFieldSources(args = {}) {
  const stored = readConfig();
  const source = (flagValue, envName, configKey, fallbackValue = "") => {
    if (flagValue !== undefined && flagValue !== "") return "flag";
    if (process.env[envName]) return "env";
    if (stored[configKey] !== undefined && stored[configKey] !== "") return "config";
    return fallbackValue ? "default" : "empty";
  };
  return {
    apiBase: source(args.api, "ANYENV_API_BASE", "apiBase", DEFAULT_API_BASE),
    accessToken: source(args.accessToken || args["access-token"], "ANYENV_ACCESS_TOKEN", "accessToken"),
    globalToken: source(args.globalToken || args["global-token"], "ANYENV_GLOBAL_TOKEN", "globalToken"),
    projectToken: source(args.token, "ANYENV_PROJECT_TOKEN", "projectToken"),
    projectId: source(args.project || args["project-id"], "ANYENV_PROJECT_ID", "projectId"),
    clientId: source(args["client-id"], "ANYENV_CLIENT_ID", "clientId", "generated"),
    deviceId: source(args["device-id"], "ANYENV_DEVICE_ID", "deviceId", "generated"),
    name: args.name ? "flag" : stored.name ? "config" : "default",
    type: args.type ? "flag" : stored.type ? "config" : "default",
    syncItems: args.sync ? "flag" : stored.syncItems ? "config" : "default",
    debug: args.debug ? "flag" : process.env.ANYENV_DEBUG ? "env" : "empty",
  };
}

function debugConfigFieldSources(args = {}) {
  return Object.fromEntries(
    Object.entries(configFieldSources(args)).map(([key, value]) => (
      /token/i.test(key) ? [`${key}Source`, value] : [key, value]
    )),
  );
}

function printConfig(config) {
  const entries = [
    ["configPath", configPath()],
    ["apiBase", config.apiBase || ""],
    ["accessToken", maskToken(config.accessToken)],
    ["globalToken", maskToken(config.globalToken)],
    ["projectToken", maskToken(config.projectToken)],
    ["clientId", config.clientId || ""],
    ["deviceId", config.deviceId || ""],
    ["deviceName", config.deviceName || ""],
    ["integrationId", config.integrationId || ""],
    ["projectId", config.projectId || ""],
    ["name", config.name || ""],
    ["type", config.type || ""],
    ["syncItems", Array.isArray(config.syncItems) ? config.syncItems.join(",") : ""],
  ];
  for (const [key, value] of entries) {
    process.stdout.write(`${key}: ${value || "(empty)"}\n`);
  }
}

function addCheck(checks, level, name, message, detail = undefined) {
  checks.push({ level, name, message, ...(detail === undefined ? {} : { detail }) });
}

function printChecks(checks) {
  for (const check of checks) {
    const marker = check.level === "ok" ? "OK" : check.level === "warn" ? "WARN" : "ERROR";
    process.stdout.write(`[${marker}] ${check.name}: ${check.message}\n`);
  }
}

function currentMcpServerConfig(args = {}) {
  const configEnv = args["config-path"] || configPath();
  const stored = readConfig();
  const resolved = resolveConfig(args);
  const resolvedProjectId = resolved.projectId || "";
  const explicitGlobalToken = args["global-token"] || args.globalToken || process.env.ANYENV_GLOBAL_TOKEN || "";
  const explicitProjectToken = args.token || process.env.ANYENV_PROJECT_TOKEN || "";
  let command = args.command || "";
  let commandArgs = [];
  if (!command) {
    const invoked = process.argv[1] || "anyenv";
    const base = path.basename(invoked).toLowerCase();
    if (process.pkg) {
      command = process.execPath;
      commandArgs = ["mcp"];
    } else if (base === "anyenv.js") {
      command = process.execPath;
      commandArgs = [invoked, "mcp"];
    } else {
      command = "anyenv";
      commandArgs = ["mcp"];
    }
  } else {
    commandArgs = ["mcp"];
  }
  return {
    command,
    args: commandArgs,
    env: {
      ANYENV_CONFIG: configEnv,
      ...(explicitGlobalToken && !stored.globalToken ? { ANYENV_GLOBAL_TOKEN: explicitGlobalToken } : {}),
      ...(explicitProjectToken && !stored.projectToken ? { ANYENV_PROJECT_TOKEN: explicitProjectToken } : {}),
      ...(resolvedProjectId ? { ANYENV_PROJECT_ID: resolvedProjectId } : {}),
    },
  };
}

function mcpConfigPayload(args = {}) {
  const client = String(args.client || "generic").toLowerCase();
  const server = currentMcpServerConfig(args);
  if (client === "vscode" || client === "vs_code") {
    return {
      servers: {
        anyenv: server,
      },
    };
  }
  if (client === "cursor" || client === "claude" || client === "claude_desktop" || client === "generic") {
    return {
      mcpServers: {
        anyenv: server,
      },
    };
  }
  return {
    client,
    mcpServers: {
      anyenv: server,
    },
  };
}

function mcpConfigKey(client) {
  return client === "vscode" || client === "vs_code" ? "servers" : "mcpServers";
}

function defaultMcpInstallPath(client) {
  const home = os.homedir();
  if (client === "cursor") return path.join(home, ".cursor", "mcp.json");
  if (client === "claude" || client === "claude_desktop") {
    if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
    return path.join(home, ".config", "Claude", "claude_desktop_config.json");
  }
  if (client === "vscode" || client === "vs_code") return path.join(process.cwd(), ".vscode", "mcp.json");
  throw new Error("Unsupported MCP client. Use --client cursor, claude, or vscode.");
}

function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err && err.code === "ENOENT") return {};
    throw new Error(`无法读取 MCP 配置 ${file}: ${err.message || String(err)}`);
  }
}

function backupPathFor(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${file}.bak-${stamp}`;
}

async function cmdRegister(args) {
  const config = resolveConfig({
    api: args.api,
    token: args.token,
    globalToken: args["global-token"],
    project: args.project || args["project-id"],
    clientId: args["client-id"],
    name: args.name,
    type: args.type,
    sync: args.sync,
  });
  const integration = await registerClient(config);
  if (!args["no-save"]) {
    writeConfig({
      ...readConfig(),
      apiBase: config.apiBase,
      projectToken: config.projectToken,
      globalToken: config.globalToken,
      clientId: config.clientId,
      deviceId: config.deviceId,
      integrationId: integration.id,
      projectId: integration.projectId,
      name: config.name,
      type: config.type,
      syncItems: config.syncItems,
    });
  }
  if (config.globalToken && integration.projectId) writeProjectContext(integration.projectId);
  if (args.json) {
    printJson({ integration, configPath: configPath(), token: maskToken(config.globalToken || config.projectToken) });
    return;
  }
  process.stdout.write(`Registered ${integration.name} for project ${integration.projectId}\n`);
  process.stdout.write(`Client ID: ${integration.clientId}\n`);
  process.stdout.write(`Token: ${maskToken(config.globalToken || config.projectToken)}\n`);
  process.stdout.write(`Config: ${configPath()}\n`);
}

async function cmdLogin(args) {
  const explicitProjectId = String(args.project || args["project-id"] || "").trim();
  const config = resolveConfig({
    api: args.api,
    globalToken: args["global-token"],
    project: explicitProjectId,
    clientId: args["client-id"],
    name: args.name,
    type: args.type,
    sync: args.sync,
  });
  if (!args.api && !process.env.ANYENV_API_BASE && isLoopbackApiBase(config.apiBase)) {
    config.apiBase = DEFAULT_API_BASE;
  }
  const result = await runBrowserLogin(config, {
    web: args.web,
    noOpen: args["no-open"],
    timeout: args.timeout,
    tokenName: args["token-name"],
    projectId: explicitProjectId,
    account: Boolean(args.account),
  });
  if (args.json) {
    printJson({
      accountOnly: Boolean(result.accountOnly),
      integration: result.integration || null,
      configPath: result.configPath,
      token: result.token || null,
      tokenType: result.tokenType || null,
      projectRegistered: Boolean(result.projectRegistered),
      accessTokenConfigured: Boolean(result.accessTokenConfigured),
    });
    return result;
  }
  if (result.accountOnly) {
    const tokenLabel = result.token ? "Global token configured for account-level CLI access." : "Account access token configured for local workspace registration.";
    process.stdout.write(`\nLogin complete. ${tokenLabel}\n`);
    process.stdout.write(`Client ID: ${result.clientId}\n`);
    if (result.token) process.stdout.write(`Token: ${result.token}\n`);
    process.stdout.write(`Cloud access token: ${result.accessTokenConfigured ? "configured" : "not configured"}\n`);
    process.stdout.write(`Config: ${result.configPath}\n`);
    return result;
  }
  process.stdout.write(`\nLogin complete. Registered ${result.integration.name} for project ${result.integration.projectId}\n`);
  process.stdout.write(`Client ID: ${result.integration.clientId}\n`);
  process.stdout.write(`Token: ${result.token}\n`);
  process.stdout.write(`Cloud access token: ${result.accessTokenConfigured ? "configured" : "not configured"}\n`);
  process.stdout.write(`Config: ${result.configPath}\n`);
  return result;
}

async function cmdTokenSet(args) {
  const providedToken = args.token || process.env.ANYENV_GLOBAL_TOKEN || process.env.ANYENV_PROJECT_TOKEN || "";
  if (!providedToken) {
    throw new Error("缺少 Token。请使用 anyenv token set --token <pt_...|evls_gt_...>。");
  }
  const config = resolveConfig({
    api: args.api,
    token: providedToken,
    globalToken: isGlobalToken(providedToken) ? providedToken : args["global-token"],
    project: args.project || args["project-id"],
    clientId: args["client-id"],
    name: args.name,
    type: args.type,
    sync: args.sync,
  });
  if (!args["no-register"]) return cmdRegister({
    ...args,
    token: config.projectToken || undefined,
    "global-token": config.globalToken || undefined,
    project: config.projectId || args.project,
  });
  const file = writeConfig({
    ...readConfig(),
    apiBase: config.apiBase,
    projectToken: config.projectToken,
    globalToken: config.globalToken,
    projectId: config.projectId,
    clientId: config.clientId,
    deviceId: config.deviceId,
    name: config.name,
    type: config.type,
    syncItems: config.syncItems,
  });
  if (config.globalToken && config.projectId) writeProjectContext(config.projectId);
  if (args.json) {
    printJson({ configPath: file, token: maskToken(config.globalToken || config.projectToken), registered: false, projectId: config.projectId || null });
    return;
  }
  process.stdout.write(`Token saved: ${maskToken(config.globalToken || config.projectToken)}\n`);
  if (config.projectId) process.stdout.write(`Project: ${config.projectId}\n`);
  process.stdout.write(`Config: ${file}\n`);
}

function projectIdFromArgs(args) {
  const config = resolveConfig(args);
  const value = args.project || args["project-id"] || args.preoject || args.p || config.projectId || "";
  if (!value) throw new Error("缺少项目 ID。请使用 --project <id>、ANYENV_PROJECT_ID 或 .anyenv/project.json。");
  return String(value);
}

function deploymentIdFromArgs(args) {
  const value = args.deployment || args["deployment-id"] || args.d || "";
  if (!value) throw new Error("缺少部署 ID。请使用 --deployment <id>。");
  return String(value);
}

function commandPrompt(args, startIndex = 1) {
  return String(args.prompt || args.message || args._.slice(startIndex).join(" ") || "").trim();
}

function printProject(project) {
  process.stdout.write(`${project.id}\t${project.name || ""}\t${project.status || ""}\n`);
}

const CREDENTIAL_IMPORT_PROVIDERS = {
  codex: {
    provider: "codex",
    label: "Codex",
    agentId: "codex",
    aiProvider: "openai",
    envVars: ["OPENAI_API_KEY"],
    name: "Codex OpenAI API Key",
    modelIds: [],
  },
  claude: {
    provider: "claude",
    label: "Claude Code",
    agentId: "claude",
    aiProvider: "anthropic",
    envVars: ["ANTHROPIC_API_KEY"],
    name: "Claude Code Anthropic API Key",
    modelIds: [],
  },
  cursor: {
    provider: "cursor",
    label: "Cursor Agent",
    agentId: "cursor",
    aiProvider: "cursor",
    envVars: ["CURSOR_API_KEY"],
    name: "Cursor Agent CLI 访问令牌",
    modelIds: [],
  },
  qwen: {
    provider: "qwen",
    label: "Qwen Code",
    agentId: "qwen",
    aiProvider: "dashscope",
    envVars: ["DASHSCOPE_API_KEY", "OPENAI_API_KEY"],
    envProviderMap: {
      DASHSCOPE_API_KEY: "dashscope",
      OPENAI_API_KEY: "openai",
    },
    baseUrlByProvider: {
      dashscope: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      openai: "https://api.openai.com/v1",
    },
    name: "Qwen Code API Key",
    modelIds: [],
  },
  opencode: {
    provider: "opencode",
    label: "OpenCode",
    agentId: "opencode",
    aiProvider: "openai",
    envVars: ["OPENAI_API_KEY"],
    name: "OpenCode OpenAI API Key",
    modelIds: [],
  },
  qoder: {
    provider: "qoder",
    label: "Qoder CLI",
    agentId: "qoder",
    aiProvider: "qoder",
    envVars: ["QODER_PERSONAL_ACCESS_TOKEN"],
    name: "Qoder CLI 访问令牌",
    modelIds: [],
  },
};

function normalizeCredentialImportProvider(value) {
  const raw = String(value || "").trim().toLowerCase();
  const aliases = {
    "claude-code": "claude",
    "cursor-agent": "cursor",
    qodercli: "qoder",
    qwencli: "qwen",
    qwen_code: "qwen",
    "qwen-code": "qwen",
    openai: "codex",
  };
  return aliases[raw] || raw;
}

function knownCredentialImportProviders() {
  return Object.keys(CREDENTIAL_IMPORT_PROVIDERS).join("|");
}

function credentialHomeDir() {
  return process.env.HOME || os.homedir();
}

function expandCredentialHome(rawPath) {
  if (!rawPath) return "";
  if (rawPath === "~") return credentialHomeDir();
  if (rawPath.startsWith("~/")) return path.join(credentialHomeDir(), rawPath.slice(2));
  return rawPath;
}

function displayCredentialPath(file) {
  const home = credentialHomeDir();
  if (file === home) return "~";
  if (file.startsWith(`${home}${path.sep}`)) return `~/${file.slice(home.length + 1)}`;
  return file;
}

function readCredentialJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function jsonStringAt(value, pathParts) {
  let cur = value;
  for (const part of pathParts) {
    if (!cur || typeof cur !== "object") return "";
    cur = cur[part];
  }
  if (typeof cur === "string") return cur.trim();
  if (typeof cur === "number" || typeof cur === "boolean") return String(cur).trim();
  return "";
}

function firstJsonString(value, paths) {
  for (const parts of paths) {
    const found = jsonStringAt(value, Array.isArray(parts) ? parts : [parts]);
    if (found) return found;
  }
  return "";
}

function sqlStringLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function readSqliteItemTableValue(file, key) {
  if (!fs.existsSync(file)) return { value: "", error: "" };
  const sql = `select value from ItemTable where key = ${sqlStringLiteral(key)} limit 1;`;
  const result = spawnSync("sqlite3", ["-json", file, sql], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.error) return { value: "", error: result.error.code || result.error.message };
  if (result.status !== 0) return { value: "", error: (result.stderr || "").trim() || `sqlite3 exited ${result.status}` };
  try {
    const rows = JSON.parse(result.stdout || "[]");
    return { value: String(rows?.[0]?.value || "").trim(), error: "" };
  } catch {
    return { value: "", error: "sqlite parse failed" };
  }
}

function credentialLocalCandidate(provider, options = {}) {
  const token = String(options.token || "").trim();
  return {
    provider: provider.provider,
    label: provider.label,
    source: "local",
    sourceName: options.sourceName || "",
    sourceKind: options.sourceKind || "local",
    importable: options.importable !== false && Boolean(token),
    token,
    aiProvider: options.aiProvider || provider.aiProvider,
    name: options.name || provider.name,
    note: options.note || "",
    reason: options.reason || "",
  };
}

function maskedCredentialLocalCandidate(candidate) {
  return {
    provider: candidate.provider,
    label: candidate.label,
    source: candidate.source,
    sourceName: candidate.sourceName,
    sourceKind: candidate.sourceKind,
    importable: Boolean(candidate.importable),
    aiProvider: candidate.aiProvider,
    name: candidate.name,
    token: candidate.token ? maskToken(candidate.token) : "",
    note: candidate.note,
    reason: candidate.reason,
  };
}

function pushJsonTokenCandidate(out, provider, rawPath, paths, options = {}) {
  const file = expandCredentialHome(rawPath);
  if (!fs.existsSync(file)) return "";
  const parsed = readCredentialJson(file);
  if (!parsed) return "";
  const token = firstJsonString(parsed, paths);
  if (!token) return "";
  out.push(credentialLocalCandidate(provider, {
    token,
    sourceName: `${displayCredentialPath(file)}:${options.keyLabel || paths[0].join?.(".") || paths[0]}`,
    sourceKind: options.sourceKind || "api-key",
    aiProvider: options.aiProvider,
    name: options.name,
    note: options.note,
  }));
  return token;
}

function pushLoginStateCandidate(out, provider, rawPath, paths, options = {}) {
  const file = expandCredentialHome(rawPath);
  if (!fs.existsSync(file)) return;
  const parsed = readCredentialJson(file);
  if (!parsed) return;
  const token = firstJsonString(parsed, paths);
  if (!token) return;
  out.push(credentialLocalCandidate(provider, {
    token,
    sourceName: `${displayCredentialPath(file)}:${options.keyLabel || paths[0].join?.(".") || paths[0]}`,
    sourceKind: options.sourceKind || "desktop-login",
    importable: false,
    note: options.note,
    reason: options.reason || "发现的是桌面/网页登录态，不是该 agent 运行时需要的 API Key 或 CLI 访问令牌。",
  }));
}

function readClaudeAuthStatus() {
  const result = spawnSync("claude", ["auth", "status"], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 512 * 1024,
  });
  if (result.error || result.status !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout || "{}");
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function credentialLocalCandidates(provider) {
  const out = [];
  if (provider.provider === "codex") {
    pushJsonTokenCandidate(out, provider, "~/.codex/auth.json", [
      ["OPENAI_API_KEY"],
      ["env", "OPENAI_API_KEY"],
    ], {
      keyLabel: "OPENAI_API_KEY",
      sourceKind: "api-key",
      note: "Codex 本机 OpenAI API Key",
    });
    pushLoginStateCandidate(out, provider, "~/.codex/auth.json", [
      ["tokens", "access_token"],
      ["tokens", "refresh_token"],
    ], {
      keyLabel: "tokens",
      note: "Codex ChatGPT 登录态",
      reason: "Codex ChatGPT 登录态不能作为 OPENAI_API_KEY 注入到云端运行环境。",
    });
  } else if (provider.provider === "claude") {
    pushJsonTokenCandidate(out, provider, "~/.claude/settings.json", [
      ["env", "ANTHROPIC_API_KEY"],
      ["ANTHROPIC_API_KEY"],
    ], {
      keyLabel: "ANTHROPIC_API_KEY",
      sourceKind: "api-key",
      note: "Claude Code 本机 Anthropic API Key",
    });
    const authStatus = readClaudeAuthStatus();
    if (authStatus?.loggedIn) {
      const detail = [
        authStatus.authMethod ? `auth=${authStatus.authMethod}` : "",
        authStatus.apiProvider ? `provider=${authStatus.apiProvider}` : "",
        authStatus.subscriptionType ? `plan=${authStatus.subscriptionType}` : "",
      ].filter(Boolean).join(", ");
      out.push(credentialLocalCandidate(provider, {
        sourceName: "claude auth status",
        sourceKind: "local-cli-login",
        importable: false,
        note: `Claude Code 本机已登录${detail ? ` (${detail})` : ""}`,
        reason: "本机 Claude Code 登录态可被本机 CLI 使用，但不能作为 ANTHROPIC_API_KEY 上传；云端项目需在项目 Terminal/VNC 内完成 Claude Code 登录，或导入 Anthropic API Key。",
      }));
    }
    pushLoginStateCandidate(out, provider, "~/Library/Application Support/Claude/config.json", [
      ["oauth:tokenCache"],
    ], {
      keyLabel: "oauth:tokenCache",
      note: "Claude Desktop OAuth 登录态",
      reason: "Claude Desktop OAuth 缓存不能作为 ANTHROPIC_API_KEY 注入到云端运行环境。",
    });
  } else if (provider.provider === "cursor") {
    pushJsonTokenCandidate(out, provider, "~/.cursor/cli-config.json", [
      ["CURSOR_API_KEY"],
      ["cursorApiKey"],
      ["accessToken"],
      ["access_token"],
      ["token"],
    ], {
      keyLabel: "CURSOR_API_KEY/token",
      sourceKind: "cli-token",
      note: "Cursor CLI 本机访问令牌",
    });
    const sqliteFile = expandCredentialHome("~/Library/Application Support/Cursor/User/globalStorage/state.vscdb");
    const sqliteValue = readSqliteItemTableValue(sqliteFile, "cursorAuth/accessToken");
    if (sqliteValue.value) {
      out.push(credentialLocalCandidate(provider, {
        token: sqliteValue.value,
        sourceName: `${displayCredentialPath(sqliteFile)}:cursorAuth/accessToken`,
        sourceKind: "desktop-token",
        note: "Cursor Desktop 登录访问令牌",
      }));
    } else if (sqliteValue.error) {
      out.push(credentialLocalCandidate(provider, {
        sourceName: `${displayCredentialPath(sqliteFile)}:cursorAuth/accessToken`,
        sourceKind: "desktop-store",
        importable: false,
        reason: `无法读取 Cursor Desktop sqlite 存储: ${sqliteValue.error}`,
      }));
    }
  } else if (provider.provider === "qwen") {
    pushJsonTokenCandidate(out, provider, "~/.qwen/settings.json", [
      ["env", "DASHSCOPE_API_KEY"],
      ["DASHSCOPE_API_KEY"],
      ["apiKey"],
      ["api_key"],
    ], {
      keyLabel: "DASHSCOPE_API_KEY",
      sourceKind: "api-key",
      aiProvider: "dashscope",
      note: "Qwen Code 本机 DashScope API Key",
    });
    pushJsonTokenCandidate(out, provider, "~/.qwen/config.json", [
      ["env", "DASHSCOPE_API_KEY"],
      ["DASHSCOPE_API_KEY"],
      ["apiKey"],
      ["api_key"],
    ], {
      keyLabel: "DASHSCOPE_API_KEY",
      sourceKind: "api-key",
      aiProvider: "dashscope",
      note: "Qwen Code 本机 DashScope API Key",
    });
  } else if (provider.provider === "opencode") {
    pushJsonTokenCandidate(out, provider, "~/.opencode/auth.json", [
      ["OPENAI_API_KEY"],
      ["env", "OPENAI_API_KEY"],
      ["apiKey"],
      ["api_key"],
    ], {
      keyLabel: "OPENAI_API_KEY",
      sourceKind: "api-key",
      note: "OpenCode 本机 OpenAI API Key",
    });
    pushJsonTokenCandidate(out, provider, "~/.opencode/config.json", [
      ["OPENAI_API_KEY"],
      ["env", "OPENAI_API_KEY"],
      ["apiKey"],
      ["api_key"],
    ], {
      keyLabel: "OPENAI_API_KEY",
      sourceKind: "api-key",
      note: "OpenCode 本机 OpenAI API Key",
    });
  } else if (provider.provider === "qoder") {
    pushJsonTokenCandidate(out, provider, "~/.qoder/credentials.json", [
      ["QODER_PERSONAL_ACCESS_TOKEN"],
      ["personalAccessToken"],
      ["personal_access_token"],
      ["token"],
    ], {
      keyLabel: "QODER_PERSONAL_ACCESS_TOKEN/token",
      sourceKind: "cli-token",
      note: "Qoder CLI 本机访问令牌",
    });
    pushJsonTokenCandidate(out, provider, "~/Library/Application Support/Qoder/SharedClientCache/cache/machine_token.json", [
      ["token"],
    ], {
      keyLabel: "token",
      sourceKind: "desktop-token",
      note: "Qoder Desktop machine token",
    });
  }
  return out;
}

function readCredentialTokenFile(file) {
  const raw = fs.readFileSync(path.resolve(file), "utf8").trim();
  if (!raw) return "";
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      const keys = [
        "token",
        "accessToken",
        "access_token",
        "apiKey",
        "api_key",
        "key",
        "secret",
        "personalAccessToken",
        "personal_access_token",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "DASHSCOPE_API_KEY",
        "CURSOR_API_KEY",
        "QODER_PERSONAL_ACCESS_TOKEN",
      ];
      for (const key of keys) {
        const value = String(parsed?.[key] || "").trim();
        if (value) return value;
      }
    } catch {}
  }
  return raw;
}

function credentialImportToken(args, provider) {
  if (args.token) return { token: String(args.token).trim(), source: "flag", sourceName: "--token" };
  const fromEnv = args["from-env"] || args.fromEnv || "";
  if (fromEnv) {
    return {
      token: String(process.env[fromEnv] || "").trim(),
      source: "env",
      sourceName: fromEnv,
    };
  }
  const fromFile = args["from-file"] || args.fromFile || "";
  if (fromFile) {
    return {
      token: readCredentialTokenFile(fromFile),
      source: "file",
      sourceName: path.resolve(fromFile),
    };
  }
  if (args["from-local"] || args.fromLocal || args["scan-local"] || args.scanLocal) {
    const candidates = credentialLocalCandidates(provider);
    const importable = candidates.find((candidate) => candidate.importable && candidate.token);
    if (importable) {
      return {
        token: importable.token,
        source: "local",
        sourceName: importable.sourceName,
        sourceKind: importable.sourceKind,
        aiProvider: importable.aiProvider,
        name: importable.name,
        note: importable.note,
        skipped: candidates.filter((candidate) => candidate !== importable).map(maskedCredentialLocalCandidate),
      };
    }
    return {
      token: "",
      source: "local",
      sourceName: "",
      skipped: candidates.map(maskedCredentialLocalCandidate),
    };
  }
  for (const envName of provider.envVars || []) {
    const token = String(process.env[envName] || "").trim();
    if (token) return { token, source: "env", sourceName: envName };
  }
  return { token: "", source: "", sourceName: "" };
}

function credentialImportBody(args, provider, tokenInfo) {
  const providerFromEnv = provider.envProviderMap?.[tokenInfo.sourceName] || "";
  const aiProvider = args["ai-provider"] || args.aiProvider || tokenInfo.aiProvider || providerFromEnv || provider.aiProvider;
  const model = args.model || args["model-id"] || "";
  const body = {
    type: "api-key",
    name: args.name || tokenInfo.name || provider.name,
    aiProvider,
    modelIds: model ? [model] : [...(provider.modelIds || [])],
    secret: tokenInfo.token,
    secretConfigured: true,
  };
  const baseUrl = args["base-url"] || args.baseUrl || provider.baseUrlByProvider?.[aiProvider] || "";
  if (baseUrl) body.baseUrl = baseUrl;
  return body;
}

function sameImportCredential(item, body) {
  if (!item || item.system === true || item.type !== "api-key") return false;
  return String(item.name || "") === String(body.name || "")
    && String(item.aiProvider || "") === String(body.aiProvider || "");
}

async function confirmCredentialImport(args, plan) {
  if (args["dry-run"]) return;
  if (args.yes || args.confirm) return;
  if (!process.stdin.isTTY) {
    throw new Error("导入凭证会把本机 token 加密同步到云端凭证管理。请在确认后加 --yes，或先用 --dry-run 预览。");
  }
  const rl = readline.createInterface({ input, output });
  try {
    const names = plan.map((item) => `${item.provider.label}(${item.body.name})`).join(", ");
    const answer = (await rl.question(`确认同步以下本机凭证到 AnyEnv 云端凭证管理？${names} [y/N] `)).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") throw new Error("已取消导入。");
  } finally {
    rl.close();
  }
}

function credentialImportPlan(args) {
  const all = Boolean(args.all || args.provider === "all");
  const providerIds = all
    ? Object.keys(CREDENTIAL_IMPORT_PROVIDERS)
    : [normalizeCredentialImportProvider(args.provider || args._[2])];
  if (!providerIds[0]) {
    throw new Error(`缺少 provider。请使用 --provider ${knownCredentialImportProviders()}，或 --all。`);
  }
  const plan = [];
  const missing = [];
  const skipped = [];
  for (const providerId of providerIds) {
    const provider = CREDENTIAL_IMPORT_PROVIDERS[providerId];
    if (!provider) throw new Error(`未知凭证导入 provider: ${providerId}。支持: ${knownCredentialImportProviders()}`);
    const tokenInfo = credentialImportToken(args, provider);
    if (tokenInfo.skipped?.length) {
      skipped.push({
        provider: provider.provider,
        label: provider.label,
        sources: tokenInfo.skipped,
      });
    }
    if (!tokenInfo.token) {
      missing.push({
        provider,
        envVars: provider.envVars || [],
      });
      continue;
    }
    const body = credentialImportBody(args, provider, tokenInfo);
    plan.push({
      provider,
      tokenInfo: {
        source: tokenInfo.source,
        sourceName: tokenInfo.sourceName,
        sourceKind: tokenInfo.sourceKind || "",
        token: maskToken(tokenInfo.token),
        note: tokenInfo.note || "",
      },
      body,
    });
  }
  if (!plan.length && !args["dry-run"]) {
    throw new Error(missingCredentialImportMessage(missing, skipped));
  }
  return { items: plan, missing, skipped };
}

function missingCredentialImportMessage(missing, skipped = []) {
  const hint = missing
    .map((item) => `${item.provider.label}: ${item.envVars.join(" / ")}`)
    .join("; ");
  const skippedHint = skipped
    .flatMap((item) => item.sources || [])
    .filter((source) => source.reason)
    .map((source) => `${source.sourceName}: ${source.reason}`)
    .join("; ");
  return [
    "没有发现可导入的本机凭证。请设置环境变量、使用 --token、--from-file，或用 --from-local 扫描本机工具配置。",
    hint ? `默认环境变量: ${hint}` : "",
    skippedHint ? `已发现但未导入: ${skippedHint}` : "",
  ].filter(Boolean).join(" ");
}

async function syncCredentialImport(config, item, args, existingCredentials) {
  const existing = existingCredentials.find((credential) => sameImportCredential(credential, item.body));
  const credential = existing
    ? await updateCredential(config, existing.id, item.body)
    : await createCredential(config, item.body);
  let defaultResult = null;
  if (!args["no-default"] && item.provider.agentId && credential?.id) {
    defaultResult = await setAgentDefaultCredential(config, item.provider.agentId, credential.id);
  }
  return {
    action: existing ? "updated" : "created",
    provider: item.provider.provider,
    label: item.provider.label,
    aiProvider: item.body.aiProvider,
    source: item.tokenInfo.source,
    sourceName: item.tokenInfo.sourceName,
    sourceKind: item.tokenInfo.sourceKind,
    token: item.tokenInfo.token,
    note: item.tokenInfo.note,
    defaultAgentId: defaultResult ? item.provider.agentId : "",
    credential,
  };
}

async function cmdCredentials(args) {
  const action = args._[1] || "list";
  if (action !== "import") throw new Error(`未知 credentials 命令: ${action}`);
  const config = resolveConfig(args);
  const importPlan = credentialImportPlan(args);
  const plan = importPlan.items;
  if (args["dry-run"]) {
    const preview = plan.map((item) => ({
      provider: item.provider.provider,
      label: item.provider.label,
      aiProvider: item.body.aiProvider,
      name: item.body.name,
      source: item.tokenInfo.source,
      sourceName: item.tokenInfo.sourceName,
      sourceKind: item.tokenInfo.sourceKind,
      token: item.tokenInfo.token,
      note: item.tokenInfo.note,
      setDefaultAgentId: args["no-default"] ? "" : item.provider.agentId,
    }));
    if (args.json) printJson({ dryRun: true, items: preview, skipped: importPlan.skipped, missing: importPlan.missing.map((item) => ({ provider: item.provider.provider, label: item.provider.label, envVars: item.envVars })) });
    else for (const item of preview) {
      process.stdout.write(`${item.label}: ${item.name} (${item.aiProvider}) from ${item.sourceName || item.source}; token ${item.token}${item.note ? `; ${item.note}` : ""}\n`);
    }
    if (!args.json && importPlan.skipped.length) {
      for (const group of importPlan.skipped) for (const source of group.sources || []) {
        process.stdout.write(`Skipped ${group.label}: ${source.sourceName} ${source.reason || source.note || "not importable"}${source.token ? `; token ${source.token}` : ""}\n`);
      }
    }
    return;
  }
  await confirmCredentialImport(args, plan);
  const existing = await listCredentials(config);
  const existingItems = Array.isArray(existing) ? existing : existing.items || [];
  const results = [];
  for (const item of plan) {
    results.push(await syncCredentialImport(config, item, args, existingItems));
  }
  if (args.json) {
    printJson({ ok: true, items: results });
    return;
  }
  for (const item of results) {
    process.stdout.write(`${item.action === "updated" ? "Updated" : "Created"} credential: ${item.credential.name} (${item.aiProvider})\n`);
    process.stdout.write(`Source: ${item.sourceName || item.source}; token ${item.token}${item.note ? `; ${item.note}` : ""}\n`);
    if (item.defaultAgentId) process.stdout.write(`Default agent credential: ${item.defaultAgentId}\n`);
  }
}

function printDeployment(deployment) {
  process.stdout.write(`${deployment.id}\t${deployment.name || ""}\t${deployment.status || ""}\t${deployment.url || deployment.previewUrl || ""}\n`);
}

function printSandboxStatus(status) {
  process.stdout.write(`Sandbox: ${status.running ? "running" : "not running"}\n`);
  process.stdout.write(`Lifecycle: ${status.lifecycleState || status.sandboxLifecycleState || "(unknown)"}\n`);
  if (status.billable !== undefined) process.stdout.write(`Billable: ${status.billable ? "yes" : "no"}\n`);
  if (status.previewUrl) process.stdout.write(`Preview: ${status.previewUrl}\n`);
}

function cmdAuthTokenSet(args) {
  const token = args.token || args["access-token"] || process.env.ANYENV_ACCESS_TOKEN || "";
  if (!token) throw new Error("缺少用户 access token。请使用 anyenv auth token set --token <accessToken>。");
  const config = resolveConfig({ api: args.api, accessToken: token });
  const file = writeConfig({
    ...readConfig(),
    apiBase: config.apiBase,
    accessToken: token,
  });
  if (args.json) {
    printJson({ ok: true, configPath: file, accessToken: maskToken(token), apiBase: config.apiBase });
    return;
  }
  process.stdout.write(`User access token saved: ${maskToken(token)}\n`);
  process.stdout.write(`Config: ${file}\n`);
}

function cmdAuthStatus(args) {
  const config = resolveConfig(args);
  const payload = {
    apiBase: config.apiBase,
    accessToken: maskToken(config.accessToken),
    globalToken: maskToken(config.globalToken),
    hasAccessToken: Boolean(config.accessToken),
    hasGlobalToken: Boolean(config.globalToken),
    projectId: config.projectId || "",
    configPath: configPath(),
  };
  if (args.json) printJson(payload);
  else {
    process.stdout.write(`API: ${payload.apiBase}\n`);
    process.stdout.write(`Access token: ${payload.hasAccessToken ? payload.accessToken : "(empty)"}\n`);
    process.stdout.write(`Global token: ${payload.hasGlobalToken ? payload.globalToken : "(empty)"}\n`);
    process.stdout.write(`Project: ${payload.projectId || "(empty)"}\n`);
    process.stdout.write(`Config: ${payload.configPath}\n`);
  }
}

async function cmdProjectsList(args) {
  const config = resolveConfig(args);
  const page = await listProjects(config, { limit: args.limit, offset: args.offset });
  const items = Array.isArray(page) ? page : page.items || [];
  if (args.json) {
    printJson(page);
    return;
  }
  for (const project of items) printProject(project);
}

async function cmdProjectsCreate(args) {
  const config = resolveConfig(args);
  const name = args.name || commandPrompt(args, 2);
  if (!name) throw new Error("缺少项目名称。请使用 anyenv projects create --name <name>。");
  const workspaceId = args["workspace-id"] || args.workspaceId || "";
  const localImport = workspaceId ? {
    clientId: args["client-id"] || config.localClientId || config.clientId,
    workspaceId,
    mode: args.mode || "bind",
  } : undefined;
  const project = await createProject(config, {
    name,
    description: args.description || "",
    stack: args.stack || "",
    defaultAgentId: args.agent || "codex",
    autoCommit: args["auto-commit"] !== false,
    autoPush: Boolean(args["auto-push"]),
    toolIds: [],
    tags: [],
    ...(localImport ? { localImport } : {}),
  });
  if (project?.id) writeProjectContext(project.id);
  if (args.json) {
    printJson(project);
    return project;
  }
  printProject(project);
  return project;
}

async function cmdProjectsGet(args) {
  const config = resolveConfig(args);
  const project = await getProject(config, projectIdFromArgs(args));
  if (args.json) printJson(project);
  else printProject(project);
}

async function sendCodingTurn(config, projectId, sessionId, prompt, args = {}) {
  const response = await sendCodingMessage(config, projectId, sessionId, {
    content: prompt,
    agentId: args.agent,
    model: args.model,
    credentialId: args["credential-id"],
    source: "cli",
  });
  if (args.json) {
    printJson(response);
    return;
  }
  if (response.accepted) {
    process.stdout.write(`Accepted cloud coding task: ${response.task?.id || "(task pending)"}\n`);
    process.stdout.write(`Session: ${response.session?.id || sessionId}\n`);
    return;
  }
  const assistant = response.assistantMessage;
  if (assistant?.content) process.stdout.write(`${assistant.content}\n`);
  else process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
}

async function cmdCoding(args) {
  const config = resolveConfig(args);
  const projectId = projectIdFromArgs(args);
  let sessionId = args.session || args["session-id"] || "";
  if (!sessionId) {
    const session = await createSession(config, projectId, {
      title: args.title || "CLI Coding",
      agentId: args.agent,
    });
    sessionId = session.id;
    if (!args.json) process.stdout.write(`Created cloud coding session: ${sessionId}\n`);
  }
  const prompt = commandPrompt(args);
  if (prompt) {
    await sendCodingTurn(config, projectId, sessionId, prompt, args);
    return;
  }
  if (!process.stdin.isTTY) throw new Error("缺少 prompt。请使用 --prompt <text>，或在交互式终端运行 anyenv coding。");
  process.stdout.write(`AnyEnv cloud coding mode. Project: ${projectId}, session: ${sessionId}\n`);
  process.stdout.write("Type a request and press Enter. Type /exit to quit.\n");
  const rl = readline.createInterface({ input, output });
  try {
    while (true) {
      const line = (await rl.question("AnyEnv coding> ")).trim();
      if (!line || line === "/exit" || line === "/quit") break;
      await sendCodingTurn(config, projectId, sessionId, line, args);
    }
  } finally {
    rl.close();
  }
}

async function cmdDeploy(args) {
  const config = resolveConfig(args);
  const action = args._[1] || "list";
  const projectId = projectIdFromArgs(args);
  if (action === "list") {
    const page = await listDeployments(config, projectId, { limit: args.limit, offset: args.offset });
    const items = Array.isArray(page) ? page : page.items || [];
    if (args.json) printJson(page);
    else for (const deployment of items) printDeployment(deployment);
    return;
  }
  if (action === "create") {
    const deployment = await createDeployment(config, projectId, { name: args.name });
    if (args.json) printJson(deployment);
    else printDeployment(deployment);
    return;
  }
  if (action === "status" || action === "get") {
    const deployment = await getDeployment(config, projectId, deploymentIdFromArgs(args));
    if (args.json) printJson(deployment);
    else printDeployment(deployment);
    return;
  }
  if (action === "rollback") {
    const deployment = await rollbackDeployment(config, projectId, deploymentIdFromArgs(args));
    if (args.json) printJson(deployment);
    else printDeployment(deployment);
    return;
  }
  if (action === "readiness" || action === "doctor") {
    const report = await deployReadiness(config, projectId, {});
    if (args.json) printJson(report);
    else process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  throw new Error(`未知 deploy 命令: ${action}`);
}

async function cmdSandbox(args) {
  const config = resolveConfig(args);
  const action = args._[1] || "status";
  const projectId = projectIdFromArgs(args);
  if (action === "status") {
    const status = await getSandbox(config, projectId);
    if (args.json) printJson(status);
    else printSandboxStatus(status);
    return;
  }
  if (action === "start") {
    const status = await startSandbox(config, projectId);
    if (args.json) printJson(status);
    else {
      process.stdout.write("Sandbox start requested.\n");
      printSandboxStatus(status);
    }
    return;
  }
  if (action === "stop") {
    const status = await stopSandbox(config, projectId, { remove: args.remove });
    if (args.json) printJson(status);
    else {
      process.stdout.write("Sandbox stop requested.\n");
      printSandboxStatus(status);
    }
    return;
  }
  if (action === "logs") {
    const logs = await getSandboxLogs(config, projectId, { tail: Number(args.tail || 200) });
    if (args.json) {
      printJson(logs);
      return;
    }
    for (const entry of logs || []) {
      if (typeof entry === "string") process.stdout.write(`${entry}\n`);
      else process.stdout.write(`${entry.time || ""} ${entry.message || JSON.stringify(entry)}\n`.trimStart());
    }
    return;
  }
  throw new Error(`未知 sandbox 命令: ${action}`);
}

async function cmdContext(args) {
  const config = resolveConfig(args);
  const action = args._[1] || "workspace";
  const projectId = projectIdFromArgs(args);
  if (action !== "workspace") throw new Error(`未知 context 命令: ${action}`);
  const workspace = await getProjectWorkspace(config, projectId);
  if (args.json) {
    printJson(workspace);
    return;
  }
  const project = workspace.project || {};
  process.stdout.write(`Project: ${project.name || project.id || projectId}\n`);
  process.stdout.write(`Files: ${Array.isArray(workspace.files) ? workspace.files.length : 0}\n`);
  process.stdout.write(`Memory: ${Array.isArray(workspace.memory) ? workspace.memory.length : 0}\n`);
  process.stdout.write(`Knowledge: ${Array.isArray(workspace.knowledge) ? workspace.knowledge.length : 0}\n`);
  process.stdout.write(`Tools: ${Array.isArray(workspace.toolIds) ? workspace.toolIds.join(", ") : "(unknown)"}\n`);
}

function gitValue(cwd, gitArgs) {
  const result = spawnSync("git", ["-C", cwd, ...gitArgs], {
    encoding: "utf8",
    timeout: 3000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return "";
  return String(result.stdout || "").trim();
}

function localWorkspaceDescriptor(clientId, targetPath, args = {}) {
  const absPath = path.resolve(targetPath);
  const stat = fs.statSync(absPath);
  if (!stat.isDirectory()) throw new Error(`本地目录不存在或不是目录: ${absPath}`);
  const gitRoot = gitValue(absPath, ["rev-parse", "--show-toplevel"]);
  const branch = gitValue(absPath, ["branch", "--show-current"]);
  const remote = gitValue(absPath, ["config", "--get", "remote.origin.url"]);
  const id = `lw_${Buffer.from(`${clientId}:${absPath}`).toString("base64url").slice(0, 24)}`;
  return {
    id,
    path: absPath,
    name: args.name || path.basename(absPath) || absPath,
    permissions: args["read-only"] ? ["read"] : ["read", "write"],
    git: {
      insideWorkTree: Boolean(gitRoot),
      root: gitRoot,
      branch,
      remote,
    },
    metadata: {
      registeredFrom: process.cwd(),
    },
  };
}

function argList(value) {
  if (Array.isArray(value)) return value.flatMap((item) => argList(item));
  if (value === undefined || value === null || value === true || value === "") return [];
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function startWorkspaceDescriptors(config, args = {}) {
  const explicitPaths = [...argList(args.workspace), ...argList(args.dir)];
  if (explicitPaths.length) {
    return explicitPaths.map((targetPath) => localWorkspaceDescriptor(config.clientId, targetPath, args));
  }
  const stored = readConfig();
  return Array.isArray(stored.localWorkspaces) ? stored.localWorkspaces : [];
}

function mergeLocalWorkspaces(workspaces) {
  if (!Array.isArray(workspaces) || workspaces.length === 0) return;
  const stored = readConfig();
  const existing = Array.isArray(stored.localWorkspaces) ? stored.localWorkspaces : [];
  const merged = [
    ...existing.filter((item) => !workspaces.some((workspace) => workspace.id === item.id || workspace.path === item.path)),
    ...workspaces,
  ];
  writeConfig({ ...stored, localWorkspaces: merged });
}

function startCommandOptions(args = {}, workspaces = []) {
  const commandRoot = args["command-root"]
    ? path.resolve(String(args["command-root"]))
    : (workspaces[0]?.path ? path.resolve(String(workspaces[0].path)) : "");
  return {
    allowLocalCommands: Boolean(args["allow-local-commands"]),
    allowRemoteDesktop: Boolean(args["allow-remote-desktop"]),
    commandRoot,
    commandTimeoutSeconds: args["command-timeout"] || args["command-timeout-seconds"],
    commandMaxOutputBytes: args["command-max-output-bytes"],
    vncPort: args["vnc-port"],
  };
}

async function registerAccountLocalClientWithWorkspaces(config, workspaces, args = {}) {
  const payload = localDevicePayload(config, { name: args.name });
  return registerAccountLocalClient(config, {
    clientId: config.clientId,
    deviceId: config.deviceId,
    name: args.name || config.deviceName || config.name || payload.name,
    clientVersion: VERSION,
    tools: payload.tools,
    capabilities: ["account-local-client", "local-workspace", "tool-discovery"],
    metadata: payload.metadata,
    workspaces,
  });
}

function printAccountLocalClients(page) {
  const items = page.items || [];
  if (!items.length) {
    process.stdout.write("No local clients registered.\n");
    return;
  }
  for (const client of items) {
    process.stdout.write(`${client.clientId}\t${client.name || ""}\t${client.status || ""}\n`);
    for (const workspace of client.workspaces || []) {
      process.stdout.write(`  ${workspace.id}\t${workspace.name || ""}\t${workspace.path || ""}\n`);
    }
  }
}

async function cmdDoctor(args) {
  const checks = [];
  const file = configPath();
  const stored = readConfig();
  const config = resolveConfig(args);

  try {
    const stat = fs.statSync(file);
    addCheck(checks, "ok", "config", `配置文件存在: ${file}`);
    if (process.platform !== "win32") {
      const mode = stat.mode & 0o777;
      if ((mode & 0o077) === 0) {
        addCheck(checks, "ok", "config-permission", "配置文件权限未向 group/other 开放");
      } else {
        addCheck(checks, "warn", "config-permission", `建议 chmod 600 ${file}`, mode.toString(8));
      }
    }
  } catch (err) {
    if (err && err.code === "ENOENT") addCheck(checks, "warn", "config", `配置文件不存在: ${file}`);
    else addCheck(checks, "error", "config", err.message || String(err));
  }

  if (config.globalToken) addCheck(checks, "ok", "global-token", `全局 Token 已配置: ${maskToken(config.globalToken)}`);
  if (config.projectToken) addCheck(checks, "ok", "project-token", `项目 Token 已配置: ${maskToken(config.projectToken)}`);
  if (!config.projectToken && !config.globalToken) addCheck(checks, "error", "token", "缺少 Token。请先运行 anyenv login，或使用 anyenv token set --token <fullToken>");
  if (config.globalToken && config.projectId) addCheck(checks, "ok", "project-context", config.projectId);
  else if (config.globalToken) addCheck(checks, "error", "project-context", "全局 Token 需要项目上下文：--project、ANYENV_PROJECT_ID 或 .anyenv/project.json");

  addCheck(checks, "ok", "service", config.apiBase);
  if (!stored.clientId && !process.env.ANYENV_CLIENT_ID && !args["client-id"]) {
    addCheck(checks, "warn", "client-id", "当前未保存 clientId；运行 register 后可获得稳定客户端身份");
  } else {
    addCheck(checks, "ok", "client-id", config.clientId);
  }

  let workspace = null;
  if (config.projectToken || config.globalToken) {
    try {
      workspace = await getWorkspace(config, { memoryLimit: 1, knowledgeLimit: 1 });
      const summary = summarizeWorkspace(workspace);
      addCheck(checks, "ok", "workspace", `项目 ${summary.project.name || summary.project.id || "(unknown)"} 可访问`);
      if (summary.registeredClient) {
        addCheck(checks, "ok", "registered-client", `${summary.registeredClient.name} 已登记`);
      } else {
        addCheck(checks, "warn", "registered-client", "当前 clientId 尚未登记；运行 anyenv login 或 anyenv token set 可登记到项目详情页");
      }
    } catch (err) {
      addCheck(checks, "error", "workspace", err.message || String(err));
    }
  }

  if (workspace?.sync?.registeredClient) {
    try {
      const result = await heartbeatClient(config);
      addCheck(checks, "ok", "heartbeat", `最近心跳 ${result.clientLastSeenAt || "(unknown)"}`);
    } catch (err) {
      addCheck(checks, "warn", "heartbeat", err.message || String(err));
    }
  }

  const hasError = checks.some((check) => check.level === "error");
  if (args.json) printJson({ ok: !hasError, checks, config: sanitizedConfig(config) });
  else printChecks(checks);
  if (hasError) process.exitCode = 1;
}

async function cmdStatus(args) {
  const config = resolveConfig(args);
  await heartbeatClient(config).catch(() => null);
  const workspace = await getWorkspace(config, { memoryLimit: 1, knowledgeLimit: 1 });
  const summary = summarizeWorkspace(workspace);
  if (args.json) printJson(summary);
  else printSummary(summary);
}

function cmdConfigPath() {
  process.stdout.write(`${configPath()}\n`);
}

function cmdConfigShow(args) {
  const config = resolveConfig(args);
  if (args.json) printJson({ configPath: configPath(), config: sanitizedConfig(config), sources: configFieldSources(args) });
  else printConfig(config);
}

function cmdMcpConfig(args) {
  const payload = mcpConfigPayload(args);
  if (args.json) {
    printJson(payload);
    return;
  }
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function cmdMcpInstall(args) {
  const client = String(args.client || "").toLowerCase();
  if (!client) throw new Error("缺少 MCP client。请使用 --client cursor、claude 或 vscode。");
  const target = path.resolve(args.path || defaultMcpInstallPath(client));
  const existing = readJsonIfExists(target);
  const key = mcpConfigKey(client);
  const server = currentMcpServerConfig(args);
  const next = {
    ...existing,
    [key]: {
      ...(existing[key] && typeof existing[key] === "object" ? existing[key] : {}),
      anyenv: server,
    },
  };
  const payload = {
    client,
    path: target,
    dryRun: Boolean(args["dry-run"]),
    backupPath: null,
    config: next,
  };
  if (args["dry-run"]) {
    if (args.json) printJson(payload);
    else {
      process.stdout.write(`MCP config target: ${target}\n`);
      process.stdout.write(`${JSON.stringify(next, null, 2)}\n`);
    }
    return payload;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (args.backup && fs.existsSync(target)) {
    payload.backupPath = backupPathFor(target);
    fs.copyFileSync(target, payload.backupPath);
  }
  fs.writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`);
  if (args.json) printJson(payload);
  else {
    process.stdout.write(`Installed AnyEnv MCP config for ${client}: ${target}\n`);
    if (payload.backupPath) process.stdout.write(`Backup: ${payload.backupPath}\n`);
  }
  return payload;
}

async function cmdWorkspace(args) {
  const config = resolveConfig(args);
  const subcommand = args._[2] || "";
  if (subcommand === "add") {
    const targetPath = args.path || args._[3] || "";
    if (!targetPath) throw new Error("缺少本地目录。请使用 anyenv local workspace add <path>。");
    const workspace = localWorkspaceDescriptor(config.clientId, targetPath, args);
    const result = await registerAccountLocalClientWithWorkspaces(config, [workspace], args);
    const stored = readConfig();
    const existing = Array.isArray(stored.localWorkspaces) ? stored.localWorkspaces : [];
    const merged = [
      ...existing.filter((item) => item.id !== workspace.id && item.path !== workspace.path),
      workspace,
    ];
    writeConfig({
      ...stored,
      apiBase: config.apiBase,
      accessToken: config.accessToken,
      globalToken: config.globalToken,
      projectId: config.projectId,
      clientId: config.clientId,
      deviceId: config.deviceId,
      deviceName: result.name,
      localClientId: result.clientId,
      localWorkspaces: merged,
    });
    if (args.json) {
      printJson({ ok: true, client: result, workspace, configPath: configPath() });
      return { ok: true, client: result, workspace, configPath: configPath() };
    }
    process.stdout.write(`Registered local workspace: ${workspace.name}\n`);
    process.stdout.write(`Path: ${workspace.path}\n`);
    process.stdout.write(`Workspace ID: ${workspace.id}\n`);
    process.stdout.write(`Client ID: ${result.clientId}\n`);
    return { ok: true, client: result, workspace, configPath: configPath() };
  }
  if (subcommand === "list") {
    const page = await listAccountLocalClients(config);
    if (args.json) {
      printJson(page);
      return page;
    }
    printAccountLocalClients(page);
    return page;
  }
  const workspace = await getWorkspace(config);
  if (args.json) {
    printJson(workspace);
    return workspace;
  }
  printSummary(summarizeWorkspace(workspace));
  return workspace;
}

async function cmdHeartbeat(args) {
  const config = resolveConfig(args);
  const result = await heartbeatClient(config);
  if (args.json) printJson(result);
  else process.stdout.write(`Heartbeat OK: ${result.clientId} ${result.clientLastSeenAt}\n`);
}

function setupClient(value) {
  const client = String(value || "cursor").toLowerCase();
  if (client === "claude" || client === "claude_desktop") return { client: "claude", type: "claude_desktop" };
  if (client === "vscode" || client === "vs_code") return { client: "vscode", type: "vscode" };
  if (client === "cursor") return { client: "cursor", type: "cursor" };
  throw new Error("不支持的 setup client。请使用 --client cursor、claude 或 vscode。");
}

async function cmdSetup(args) {
  if (args.json) {
    throw new Error("setup 是交互式向导入口，不支持 --json。CI 请直接使用 login/token/mcp/local 子命令。");
  }
  const action = args._[1] || "";
  if (action === "ide") {
    const projectId = projectIdFromArgs(args);
    const selected = setupClient(args.client || args.type);
    const name = args.name || `AnyEnv ${selected.client} Client`;
    await cmdLogin({
      ...args,
      json: false,
      "project-id": projectId,
      project: projectId,
      name,
      type: selected.type,
    });
    process.stdout.write("\nInstalling local MCP config...\n");
    await cmdMcpInstall({
      ...args,
      json: false,
      client: selected.client,
      backup: args.backup !== false,
    });
    process.stdout.write("\nNext checks:\n");
    process.stdout.write("  anyenv local doctor\n");
    process.stdout.write(`  anyenv mcp config --client ${selected.client}\n`);
    return;
  }
  if (action === "local-project") {
    const targetPath = args.path || args._[2] || "";
    if (!targetPath) throw new Error("缺少本地目录。请使用 anyenv setup local-project <path>。");
    const config = resolveConfig(args);
    if (!cloudAuthToken(config, "auto")) {
      process.stdout.write("CLI login is required before registering a local folder.\n");
      await cmdLogin({
        ...args,
        json: false,
        name: args.name || "AnyEnv Local Client",
      });
    }
    await cmdWorkspace({
      ...args,
      json: false,
      _: ["local", "workspace", "add", targetPath],
    });
    process.stdout.write("\nOpen the web app, create a project, and choose \"连接本地项目\".\n");
    return;
  }
  throw new Error("未知 setup 命令。请使用 anyenv setup ide 或 anyenv setup local-project。");
}

async function cmdGlobalDoctor(args) {
  const checks = [];
  const config = resolveConfig(args);
  const stored = readConfig();
  if (config.globalToken) addCheck(checks, "ok", "global-token", `全局 Token 已配置: ${maskToken(config.globalToken)}`);
  if (config.accessToken) addCheck(checks, "ok", "access-token", `用户令牌已配置: ${maskToken(config.accessToken)}`);
  if (!config.globalToken && !config.accessToken) addCheck(checks, "warn", "cloud-token", "云端业务命令需要全局 Token 或用户令牌；运行 anyenv login 或 anyenv auth token set");
  if (config.projectToken) addCheck(checks, "ok", "project-token", `项目 Token 已配置: ${maskToken(config.projectToken)}`);
  else if (!config.globalToken) addCheck(checks, "warn", "project-token", "IDE/MCP 同步需要项目 Token 或全局 Token；运行 anyenv login --project-id <id>");
  if (config.globalToken && config.projectId) addCheck(checks, "ok", "project-context", config.projectId);
  else if (config.globalToken) addCheck(checks, "warn", "project-context", "全局 Token 未设置项目上下文");
  addCheck(checks, "ok", "api-base", config.apiBase);
  if (stored.clientId || process.env.ANYENV_CLIENT_ID) addCheck(checks, "ok", "client-id", config.clientId);
  else addCheck(checks, "warn", "client-id", "clientId 尚未保存；完成 login/token set 后会稳定写入配置");

  if (config.projectToken || (config.globalToken && config.projectId)) {
    try {
      const workspace = await getWorkspace(config, { memoryLimit: 1, knowledgeLimit: 1 });
      const summary = summarizeWorkspace(workspace);
      addCheck(checks, "ok", "workspace", `项目 ${summary.project.name || summary.project.id || "(unknown)"} 可访问`);
      if (summary.deniedReason) addCheck(checks, "warn", "workspace-sync", summary.deniedReason);
    } catch (err) {
      addCheck(checks, "error", "workspace", err.message || String(err));
    }
  }

  const device = localDevicePayload(config, { name: args.name });
  const foundTools = device.tools.filter((tool) => tool.found);
  addCheck(checks, foundTools.length ? "ok" : "warn", "device-tools", foundTools.length ? `发现 ${foundTools.length} 个 AI CLI` : "未发现本机 AI CLI");

  const hasError = checks.some((check) => check.level === "error");
  if (args.json) printJson({ ok: !hasError, checks, config: sanitizedConfig(config), sources: configFieldSources(args), device });
  else printChecks(checks);
  if (hasError) process.exitCode = 1;
}

async function cmdUpdate(args) {
  const onProgress = !args.json && !args["dry-run"] && !args["no-progress"] ? createProgressReporter() : null;
  const result = await updateCli({ ...args, onProgress });
  if (args.json) {
    printJson(result);
    return;
  }
  if (result.dryRun) {
    process.stdout.write(`AnyEnv CLI update dry run\n`);
    process.stdout.write(`Current version: ${result.currentVersion}\n`);
    process.stdout.write(`Download: ${result.baseUrl}/releases/${result.version}/download/${result.asset}\n`);
    process.stdout.write(`Install target: ${result.targetPath}\n`);
    if (result.path?.activePath) process.stdout.write(`Active AnyEnv CLI: ${result.path.activePath}${result.path.activeVersion ? ` (${result.path.activeVersion})` : ""}\n`);
    return;
  }
  process.stdout.write(`Updated AnyEnv CLI ${result.currentVersion} -> ${result.version}\n`);
  process.stdout.write(`Installed: ${result.targetPath}\n`);
  if (result.path?.targetVersion) process.stdout.write(`Installed version: ${result.path.targetVersion}\n`);
  process.stdout.write(`Archive checksum: ${result.checksum}\n`);
  if (result.binaryChecksum) process.stdout.write(`Installed checksum: ${result.binaryChecksum}\n`);
  if (result.signed) process.stdout.write("macOS signature: refreshed\n");
  if (result.path?.activePath) {
    process.stdout.write(`Active AnyEnv CLI: ${result.path.activePath}${result.path.activeVersion ? ` (${result.path.activeVersion})` : ""}\n`);
  }
  if (result.path && !result.path.activeMatchesInstall) {
    process.stdout.write("Your current shell is still using a different AnyEnv CLI binary.\n");
    process.stdout.write("Run this one command to activate the updated CLI in this terminal:\n");
    process.stdout.write(`  ${result.path.activationCommand}\n`);
  }
}

function createProgressReporter() {
  const supportsCarriageReturn = Boolean(process.stderr.isTTY);
  let lastLine = "";
  const render = (event) => {
    const label = event.label || "download";
    const total = Number(event.total || 0);
    const loaded = Number(event.loaded || 0);
    if (event.text || !total) {
      if (event.done) process.stderr.write(`Downloaded ${label} (${formatBytes(loaded)})\n`);
      else if (event.started) process.stderr.write(`Downloading ${label}...\n`);
      return;
    }
    const ratio = Math.max(0, Math.min(1, loaded / total));
    const percent = Math.round(ratio * 100);
    const width = 20;
    const filled = Math.round(ratio * width);
    const bar = `${"#".repeat(filled)}${"-".repeat(width - filled)}`;
    const line = `Downloading ${label} [${bar}] ${percent}% ${formatBytes(loaded)}/${formatBytes(total)}`;
    if (!supportsCarriageReturn) {
      if (event.started) process.stderr.write(`Downloading ${label}...\n`);
      if (event.done) process.stderr.write(`${line}\n`);
      return;
    }
    process.stderr.write(`\r${line}${" ".repeat(Math.max(0, lastLine.length - line.length))}`);
    lastLine = line;
    if (event.done) {
      process.stderr.write("\n");
      lastLine = "";
    }
  };
  return render;
}

function cmdEnv(args) {
  const action = args._[1];
  if (action !== "activate") {
    process.stderr.write("Usage: anyenv env activate [--install-dir <dir>]\n");
    process.exitCode = 2;
    return;
  }
  const installDir = resolveInstallDir(args);
  const script = activationScript(installDir);
  if (args.json) {
    printJson({ installDir, script });
    return;
  }
  process.stdout.write(`${script}\n`);
}

function cmdCleanup(args) {
  const result = cleanupCliArtifacts(args);
  if (args.json) {
    printJson(result);
    return;
  }

  process.stdout.write(result.dryRun ? "AnyEnv cleanup dry run\n" : "AnyEnv cleanup\n");
  process.stdout.write("Shell config and tokens were not changed.\n");
  if (result.cleaned.length) {
    for (const item of result.cleaned) {
      const state = result.dryRun ? "would remove" : item.removed ? "removed" : "kept";
      process.stdout.write(`[${state}] ${item.path}${item.error ? ` (${item.error})` : ""}\n`);
    }
  } else {
    process.stdout.write("No temporary AnyEnv update cache found.\n");
  }

  if (result.installations.length) {
    process.stdout.write("AnyEnv CLI binaries on PATH:\n");
    for (const item of result.installations) {
      const flags = [
        item.active ? "active" : "",
        item.temporary ? "temporary" : "",
      ].filter(Boolean).join(", ");
      process.stdout.write(`  ${item.path}${item.version ? ` (${item.version})` : ""}${flags ? ` [${flags}]` : ""}\n`);
    }
  }

  const temporaryActive = result.installations.find((item) => item.active && item.temporary);
  if (temporaryActive) {
    process.stdout.write("The active AnyEnv CLI is in a temporary directory. Run anyenv upgrade from the stable CLI after installing it.\n");
  }
}

function cmdLogout(args) {
  const file = configPath();
  const existed = fs.existsSync(file);
  if (existed) fs.rmSync(file, { force: true });
  if (args.json) {
    printJson({ ok: true, configPath: file, removed: existed });
    return;
  }
  process.stdout.write(existed ? `Removed local AnyEnv config: ${file}\n` : `Local AnyEnv config did not exist: ${file}\n`);
  process.stdout.write("Remote tokens are unchanged. Revoke global developer tokens or project tokens in the web app if access should be removed.\n");
}

function printDevicePayload(payload) {
  process.stdout.write(`Device: ${payload.name} (${payload.deviceId})\n`);
  process.stdout.write(`Platform: ${payload.metadata.platform}/${payload.metadata.arch}\n`);
  process.stdout.write(`Hostname: ${payload.metadata.hostname}\n`);
  const found = payload.tools.filter((tool) => tool.found);
  process.stdout.write(`AI tools: ${found.length ? found.map((tool) => `${tool.id}${tool.version ? ` ${tool.version}` : ""}`).join(", ") : "(none found)"}\n`);
  for (const tool of payload.tools) {
    const marker = tool.found ? "OK" : "--";
    process.stdout.write(`[${marker}] ${tool.name}: ${tool.path || "not found"}${tool.version ? ` (${tool.version})` : ""}\n`);
  }
}

function cmdDeviceDoctor(args) {
  const config = resolveConfig(args);
  const payload = localDevicePayload(config, { name: args.name });
  if (args.json) {
    printJson({ ok: true, ...payload, websocketUrl: websocketBaseFromApiBase(config.apiBase) });
    return;
  }
  printDevicePayload(payload);
  process.stdout.write(`WebSocket: ${websocketBaseFromApiBase(config.apiBase)}\n`);
}

function resolveDeviceConfig(args) {
  const explicitProject = args.project || args["project-id"] || "";
  if (explicitProject) {
    throw new Error("本地设备在线已切换为账号级 CLI 能力，不再支持 --project。请运行 anyenv login --account 后使用 anyenv start --workspace <path>。");
  }
  const config = resolveConfig({
    api: args.api,
    token: args.token,
    "global-token": args["global-token"] || args.globalToken,
    project: "",
    clientId: args["client-id"],
    name: args.name || "AnyEnv Local Device",
    type: args.type || "custom",
    sync: args.sync,
    debug: args.debug,
  });
  const accountConfig = { ...config, projectId: "", projectToken: "" };
  debugLog(config, "config.resolve.device", {
    apiBase: config.apiBase,
    projectId: config.projectId || "",
    projectContextPath: config.projectContextPath || "",
    globalTokenConfigured: Boolean(config.globalToken),
    projectTokenConfigured: Boolean(config.projectToken),
    clientId: config.clientId,
    deviceId: config.deviceId,
    sources: debugConfigFieldSources(args),
  });
  debugLog(accountConfig, "config.resolve.device.scope", {
    scope: "account",
    ignoredProjectId: config.projectId || "",
    ignoredProjectToken: Boolean(config.projectToken),
  });
  return accountConfig;
}

function assertDeviceCanConnect(config) {
  if (!config.globalToken) {
    throw new Error("缺少账号级 global token。请先运行 anyenv login --account。项目 Token 仅用于项目同步/MCP，不用于本地设备在线或命令执行。");
  }
}

function preserveStartArg(result, args, key, flag = `--${key}`) {
  const value = args[key];
  if (value === undefined || value === "" || value === true) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item !== undefined && item !== "" && item !== true) result.push(flag, String(item));
    }
    return;
  }
  result.push(flag, String(value));
}

function daemonChildArgs(args) {
  const result = ["start", "--foreground"];
  preserveStartArg(result, args, "api");
  preserveStartArg(result, args, "name");
  preserveStartArg(result, args, "type");
  preserveStartArg(result, args, "sync");
  preserveStartArg(result, args, "ws");
  preserveStartArg(result, args, "client-id");
  preserveStartArg(result, args, "heartbeat", "--heartbeat");
  preserveStartArg(result, args, "heartbeat-seconds", "--heartbeat-seconds");
  preserveStartArg(result, args, "workspace", "--workspace");
  preserveStartArg(result, args, "dir", "--dir");
  preserveStartArg(result, args, "command-root", "--command-root");
  preserveStartArg(result, args, "command-timeout", "--command-timeout");
  preserveStartArg(result, args, "command-timeout-seconds", "--command-timeout-seconds");
  preserveStartArg(result, args, "command-max-output-bytes", "--command-max-output-bytes");
  preserveStartArg(result, args, "vnc-port", "--vnc-port");
  if (args["allow-local-commands"]) result.push("--allow-local-commands");
  if (args["allow-remote-desktop"]) result.push("--allow-remote-desktop");
  if (args.debug) result.push("--debug");
  return result;
}

function rejectBackgroundCliSecrets(args) {
  if (args.token || args["global-token"] || args.globalToken) {
    throw new Error("后台运行不会通过命令行参数传递 Token，避免 Token 出现在进程列表中。请先运行 anyenv login 或 anyenv token set 保存 Token，或使用环境变量。");
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processExitedWithin(pid, timeoutMs) {
  const deadline = Date.now() + Math.max(500, Number(timeoutMs || 5000));
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) return true;
    await wait(100);
  }
  return !isProcessRunning(pid);
}

function daemonLogTail(logPath, maxChars = 1600, options = {}) {
  try {
    const raw = fs.readFileSync(logPath, "utf8").trim();
    if (!raw) return "";
    const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (options.includeDebug) {
      const tail = lines.slice(-Math.max(1, Number(options.lines || 40))).join("\n");
      return tail.length > maxChars ? tail.slice(-maxChars) : tail;
    }
    const nonDebug = lines.filter((line) => !/^\[(?:anyenv|AnyEnv):debug\]/.test(line));
    const authFailure = [...nonDebug].reverse().find((line) => isLocalDeviceAuthFailure(line) && !/^Next steps?:/i.test(line));
    if (authFailure) return authFailure;
    if (nonDebug.length) return nonDebug[nonDebug.length - 1];
    return raw.length > maxChars ? raw.slice(-maxChars) : raw;
  } catch {
    return "";
  }
}

function daemonLogLines(logPath, options = {}) {
  try {
    const raw = fs.readFileSync(logPath, "utf8").trim();
    if (!raw) return [];
    const count = Math.max(1, Number(options.lines || 80));
    const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const visible = options.includeDebug
      ? lines
      : lines.filter((line) => !/^\[(?:anyenv|AnyEnv):debug\]/.test(line));
    return visible.slice(-count);
  } catch {
    return [];
  }
}

function followDaemonLog(logPath) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(logPath)) fs.writeFileSync(logPath, "");
  let offset = fs.statSync(logPath).size;
  const readNewBytes = () => {
    let fd = null;
    try {
      const stat = fs.statSync(logPath);
      if (stat.size < offset) offset = 0;
      if (stat.size === offset) return;
      fd = fs.openSync(logPath, "r");
      const buffer = Buffer.alloc(stat.size - offset);
      fs.readSync(fd, buffer, 0, buffer.length, offset);
      offset = stat.size;
      process.stdout.write(buffer.toString("utf8"));
    } catch {
      // Keep following; the daemon may rotate or recreate the file.
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {}
      }
    }
  };
  fs.watchFile(logPath, { interval: 1000 }, readNewBytes);
  return new Promise((resolve) => {
    const stop = () => {
      fs.unwatchFile(logPath, readNewBytes);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function localDeviceAuthHelp(workspaceArg = ".") {
  const workspace = Array.isArray(workspaceArg) ? workspaceArg[0] || "." : workspaceArg || ".";
  return [
    "Reason: the configured account token is invalid, revoked, or missing local-client permission.",
    "Next steps:",
    "  1. Run: anyenv login --account",
    `  2. Run: anyenv start --workspace ${shellQuote(workspace)}`,
    "  3. If it still fails, run: anyenv start --workspace . --debug",
    "Diagnostics:",
    "  anyenv config show",
    "  anyenv doctor --json",
  ].join("\n");
}

function isLocalDeviceAuthFailure(message) {
  return /Token is invalid|missing local-device permission|local-device permission|Local device connection authentication failed|auth failed|authentication failed/i.test(String(message || ""));
}

function daemonStaleDiagnostic(status) {
  const logTail = normalizeCliErrorMessage(daemonLogTail(status.logPath));
  if (!logTail) return null;
  const authFailure = isLocalDeviceAuthFailure(logTail);
  return {
    lastLog: logTail,
    code: authFailure ? "local_device_auth_failed" : "daemon_exited",
    nextStep: authFailure
      ? "Run anyenv login --account, then retry anyenv start --workspace ."
      : `Inspect ${status.logPath}, then run anyenv restart --workspace .`,
  };
}

function normalizeCliErrorMessage(value) {
  let message = String(value || "");
  const replacements = [
    [/AnyEnv daemon 启动后退出。?/g, "AnyEnv daemon exited immediately after startup."],
    [/日志：/g, "Log: "],
    [/请查看日志：/g, "Check the log: "],
    [/Token 无效、已撤销或缺少本地设备权限/g, "Token is invalid, revoked, or missing local-device permission"],
    [/缺少全局 Token。请先运行 anyenv login，或设置 ANYENV_GLOBAL_TOKEN。?/g, "Missing global token. Run anyenv login or set ANYENV_GLOBAL_TOKEN."],
    [/缺少用户访问令牌。该命令需要用户会话，请先运行 anyenv login，或设置 ANYENV_ACCESS_TOKEN。?/g, "Missing user access token. This command requires a user session; run anyenv login or set ANYENV_ACCESS_TOKEN."],
    [/缺少用户访问令牌。请先运行 anyenv auth token set --token <accessToken>，或设置 ANYENV_ACCESS_TOKEN。?/g, "Missing user access token. Run anyenv auth token set --token <accessToken> or set ANYENV_ACCESS_TOKEN."],
    [/缺少 Token。请先运行 anyenv login，或使用 anyenv token set --token <pt_...|evls_gt_...>。?/g, "Missing token. Run anyenv login or use anyenv token set --token <pt_...|evls_gt_...>."],
    [/缺少 Token。请使用 anyenv token set --token <pt_...|evls_gt_...>。?/g, "Missing token. Use anyenv token set --token <pt_...|evls_gt_...>."],
    [/本地设备连接认证超时/g, "Local device connection authentication timed out"],
    [/本地设备连接认证失败/g, "Local device connection authentication failed"],
    [/本地设备连接已关闭/g, "Local device connection closed"],
  ];
  for (const [pattern, replacement] of replacements) {
    message = message.replace(pattern, replacement);
  }
  return message;
}

async function runDeviceForeground(args) {
  const config = resolveDeviceConfig(args);
  assertDeviceCanConnect(config);
  const workspaces = startWorkspaceDescriptors(config, args);
  mergeLocalWorkspaces(workspaces);
  const commandOptions = startCommandOptions(args, workspaces);
  const result = await connectDevice(config, {
    name: args.name,
    once: Boolean(args.once),
    ws: args.ws,
    heartbeatSeconds: args.heartbeat || args["heartbeat-seconds"],
    workspaces,
    ...commandOptions,
  });
  return result;
}

async function cmdStart(args) {
  if (args.foreground || args.fg) {
    const result = await runDeviceForeground(args);
    if (args.json) {
      printJson({
        ok: true,
        mode: "foreground",
        connected: true,
        websocketUrl: result.websocketUrl,
        runId: result.runId,
        connectionId: result.connectionId,
        integration: result.integration,
        device: result.payload,
        auth: result.auth,
      });
      return;
    }
    process.stdout.write(`Connected local device: ${result.payload.name}\n`);
    process.stdout.write(`Device ID: ${result.payload.deviceId}\n`);
    process.stdout.write(`Connection ID: ${result.connectionId}\n`);
    process.stdout.write(`Scope: ${result.auth.scope || (result.auth.projectId ? "project" : "account")}\n`);
    if (result.auth.projectId) process.stdout.write(`Project: ${result.auth.projectId}\n`);
    process.stdout.write(`WebSocket: ${result.websocketUrl}\n`);
    if (result.payload.metadata?.commandExecution?.enabled) {
      process.stdout.write(`Local commands: enabled (root: ${result.payload.metadata.commandExecution.root})\n`);
    }
    if (result.payload.metadata?.remoteDesktop?.enabled) {
      process.stdout.write(`Remote desktop: enabled (AnyEnv WebSocket relay, local VNC source 127.0.0.1:${result.payload.metadata.remoteDesktop.port || 5900})\n`);
    }
    if (!args.once) process.stdout.write("Connection is active. Press Ctrl+C to stop.\n");
    return;
  }

  rejectBackgroundCliSecrets(args);
  const config = resolveDeviceConfig(args);
  assertDeviceCanConnect(config);
  const workspaces = startWorkspaceDescriptors(config, args);
  mergeLocalWorkspaces(workspaces);
  const commandOptions = startCommandOptions(args, workspaces);
  const current = daemonStatus();
  if (current.running && !args.force) {
    throw new Error(`AnyEnv 已在后台运行，PID ${current.state.pid}。请先运行 anyenv status 或 anyenv restart。`);
  }
  if (current.state && !current.running) {
    await stopDaemon({ timeoutMs: 500, kill: false });
  }
  const childArgs = daemonChildArgs(args);
  if (args["dry-run"]) {
    const payload = {
      ok: true,
      dryRun: true,
      args: childArgs,
      configPath: configPath(),
      websocketUrl: websocketBaseFromApiBase(config.apiBase),
      scope: "account",
      projectId: null,
      workspaces,
      commandExecution: {
        enabled: commandOptions.allowLocalCommands,
        root: commandOptions.commandRoot || null,
        timeoutSeconds: Number(commandOptions.commandTimeoutSeconds || 3600),
      },
      remoteDesktop: {
        enabled: commandOptions.allowRemoteDesktop,
        protocol: "vnc",
        host: "127.0.0.1",
        port: Number(commandOptions.vncPort || 5900),
      },
    };
    if (args.json) printJson(payload);
    else {
      process.stdout.write(`AnyEnv daemon dry run\n`);
      process.stdout.write(`Args: ${childArgs.join(" ")}\n`);
      process.stdout.write(`WebSocket: ${payload.websocketUrl}\n`);
    }
    return;
  }
  const spawned = spawnDaemon(childArgs, {
    projectId: config.projectId || "",
    scope: "account",
    workspaceIds: workspaces.map((workspace) => workspace.id).filter(Boolean),
    deviceId: config.deviceId,
    clientId: config.clientId,
    websocketUrl: websocketBaseFromApiBase(config.apiBase),
  });
  if (await processExitedWithin(spawned.state.pid, args["startup-timeout-ms"] || 5000)) {
    const logTail = normalizeCliErrorMessage(daemonLogTail(spawned.logPath));
    const parts = [
      "AnyEnv daemon exited immediately after startup.",
      logTail ? `Log: ${logTail}` : `Check the log: ${spawned.logPath}`,
    ];
    if (isLocalDeviceAuthFailure(logTail)) {
      parts.push(localDeviceAuthHelp(args.workspace || "."));
    } else {
      parts.push("Next steps:");
      parts.push("  anyenv status");
      parts.push("  anyenv start --workspace . --debug");
      parts.push(`  tail -n 80 ${shellQuote(spawned.logPath)}`);
    }
    if (args.debug && !args.json) {
      const debugTail = normalizeCliErrorMessage(daemonLogTail(spawned.logPath, 5000, { includeDebug: true, lines: 80 }));
      if (debugTail) parts.push("Debug log tail:", debugTail);
    } else {
      parts.push(`Debug: run anyenv start --workspace . --debug, or inspect ${spawned.logPath}`);
    }
    throw new Error(parts.join("\n"));
  }
  const payload = {
    ok: true,
    started: true,
    running: true,
    pid: spawned.state.pid,
    statePath: spawned.statePath,
    logPath: spawned.logPath,
    websocketUrl: spawned.state.websocketUrl,
  };
  if (args.json) {
    printJson(payload);
    return;
  }
  process.stdout.write("Started AnyEnv local device daemon.\n");
  process.stdout.write(`PID: ${payload.pid}\n`);
  process.stdout.write(`WebSocket: ${payload.websocketUrl}\n`);
  process.stdout.write(`Log: ${payload.logPath}\n`);
  if (commandOptions.allowLocalCommands) {
    process.stdout.write(`Local commands: enabled (root: ${commandOptions.commandRoot || process.cwd()})\n`);
  }
  if (commandOptions.allowRemoteDesktop) {
    process.stdout.write(`Remote desktop: enabled (AnyEnv WebSocket relay, local VNC source 127.0.0.1:${Number(commandOptions.vncPort || 5900)})\n`);
  }
  process.stdout.write("Use anyenv status, anyenv stop, or anyenv restart to manage it.\n");
}

function cmdDaemonStatus(args) {
  const status = daemonStatus();
  status.recentLogs = daemonLogLines(status.logPath, { lines: 12, includeDebug: true });
  if (status.stale) {
    status.diagnostic = daemonStaleDiagnostic(status);
  }
  if (args.json) {
    printJson(status);
    return;
  }
  if (status.running) {
    process.stdout.write(`AnyEnv daemon is running (PID ${status.state.pid}).\n`);
    process.stdout.write(`WebSocket: ${status.state.websocketUrl || "(unknown)"}\n`);
    process.stdout.write(`Log: ${status.logPath}\n`);
    if (status.recentLogs.length) {
      process.stdout.write("Recent log:\n");
      for (const line of status.recentLogs.slice(-5)) process.stdout.write(`  ${line}\n`);
    }
    return;
  }
  if (status.stale) {
    process.stdout.write(`AnyEnv daemon is not running; stale state found for PID ${status.state.pid}.\n`);
    if (status.diagnostic?.lastLog) {
      process.stdout.write(`Last log: ${status.diagnostic.lastLog}\n`);
    }
    if (status.diagnostic?.nextStep) {
      process.stdout.write(`Next step: ${status.diagnostic.nextStep}\n`);
    }
    process.stdout.write(`Run anyenv start or anyenv restart to reconnect.\n`);
    return;
  }
  process.stdout.write("AnyEnv daemon is not running.\n");
}

async function cmdDaemonLogs(args) {
  const status = daemonStatus();
  const tail = Math.max(1, Number(args.tail || 80));
  const lines = daemonLogLines(status.logPath, { lines: tail, includeDebug: true });
  if (args.json) {
    printJson({
      ok: true,
      running: status.running,
      stale: status.stale,
      logPath: status.logPath,
      lines,
    });
    return;
  }
  if (!lines.length) {
    process.stdout.write(`No AnyEnv daemon logs found at ${status.logPath}.\n`);
  } else {
    for (const line of lines) process.stdout.write(`${line}\n`);
  }
  if (args.follow) await followDaemonLog(status.logPath);
}

async function cmdStop(args) {
  const result = await stopDaemon({ timeoutMs: Number(args.timeout || 5000) });
  if (args.json) {
    printJson(result);
    return;
  }
  if (result.reason === "not_running") {
    process.stdout.write("AnyEnv daemon is not running.\n");
  } else if (result.reason === "stale_state_removed") {
    process.stdout.write("Removed stale AnyEnv daemon state.\n");
  } else {
    process.stdout.write(`Stopped AnyEnv daemon (PID ${result.state?.pid || "unknown"}).\n`);
  }
}

async function cmdRestart(args) {
  await stopDaemon({ timeoutMs: Number(args.timeout || 5000) });
  return cmdStart(args);
}

async function cmdDeviceRegister(args) {
  const config = resolveDeviceConfig(args);
  const workspaces = startWorkspaceDescriptors(config, args);
  mergeLocalWorkspaces(workspaces);
  const result = await registerAccountDevice(config, { name: args.name, workspaces });
  if (args.json) {
    printJson({
      ok: true,
      scope: "account",
      integration: result.integration,
      device: result.payload,
      websocketUrl: websocketBaseFromApiBase(config.apiBase),
    });
    return;
  }
  process.stdout.write(`Registered local device: ${result.payload.name}\n`);
  process.stdout.write(`Device ID: ${result.payload.deviceId}\n`);
  process.stdout.write(`Integration: ${result.integration.id}\n`);
  process.stdout.write("Scope: account\n");
  process.stdout.write(`WebSocket: ${websocketBaseFromApiBase(config.apiBase)}\n`);
}

async function cmdDeviceConnect(args) {
  const result = await runDeviceForeground(args);
  if (args.json) {
    printJson({
      ok: true,
      connected: true,
      websocketUrl: result.websocketUrl,
      runId: result.runId,
      connectionId: result.connectionId,
      integration: result.integration,
      device: result.payload,
      auth: result.auth,
    });
    return;
  }
  process.stdout.write(`Connected local device: ${result.payload.name}\n`);
  process.stdout.write(`Device ID: ${result.payload.deviceId}\n`);
  process.stdout.write(`Connection ID: ${result.connectionId}\n`);
  process.stdout.write(`Scope: ${result.auth.scope || (result.auth.projectId ? "project" : "account")}\n`);
  if (result.auth.projectId) process.stdout.write(`Project: ${result.auth.projectId}\n`);
  process.stdout.write(`WebSocket: ${result.websocketUrl}\n`);
  if (result.payload.metadata?.commandExecution?.enabled) {
    process.stdout.write(`Local commands: enabled (root: ${result.payload.metadata.commandExecution.root})\n`);
  }
  if (!args.once) process.stdout.write("Connection is active. Press Ctrl+C to stop.\n");
}

function printInstallHints() {
  const abs = process.argv[1] || "anyenv";
  process.stdout.write("Local MCP command example:\n");
  process.stdout.write(`  node ${shellQuote(abs)} mcp\n`);
}

function errorEnvelope(err) {
  const message = normalizeCliErrorMessage(err?.message || String(err));
  const isProjectApi = err instanceof anyenvApiError || err?.tokenType === "project";
  const isCloudApi = err instanceof anyenvCloudApiError || err?.tokenType === "access";
  const isGlobalApi = err?.tokenType === "global";
  let code = "cli_error";
  let tokenType = err?.tokenType || "";
  let nextStep = "Run anyenv doctor --json for a complete diagnosis.";
  if (err?.status) {
    code = `api_${err.status}`;
    tokenType = tokenType || (isProjectApi ? "project" : isCloudApi ? "access" : "");
    if (err.status === 401 || err.status === 403) {
      nextStep = isGlobalApi
        ? "Check the global token permissions and project context, then run anyenv doctor --json."
        : isProjectApi
        ? "Re-run anyenv login --project-id <id>, or recreate the project Token in the project detail page."
        : "Re-run anyenv login, or refresh ANYENV_ACCESS_TOKEN.";
    }
  } else if (/缺少 Token/i.test(message)) {
    code = "token_missing";
    nextStep = "Run anyenv token set --token <pt_...|evls_gt_...>, or configure ANYENV_GLOBAL_TOKEN/ANYENV_PROJECT_TOKEN.";
  } else if (/Token 无效|已撤销|缺少本地设备权限|local-device permission|device permission|auth failed|authentication failed/i.test(message)) {
    code = "local_device_auth_failed";
    tokenType = tokenType || "global";
    nextStep = "Run anyenv login --account once; if this still fails immediately after login, deploy the account-level local-client WebSocket server.";
  } else if (/全局 Token|global token|ANYENV_GLOBAL_TOKEN|项目上下文|project context|ANYENV_PROJECT_ID/i.test(message)) {
    code = /项目上下文|project context|ANYENV_PROJECT_ID/i.test(message) ? "project_context_missing" : "global_token_missing";
    tokenType = "global";
    nextStep = "Configure ANYENV_GLOBAL_TOKEN and ANYENV_PROJECT_ID, or run anyenv token set --token <evls_gt_...> --project <id>.";
  } else if (/项目 Token|project token|ANYENV_PROJECT_TOKEN/i.test(message)) {
    code = "project_token_missing";
    tokenType = "project";
    nextStep = "Run anyenv login --project-id <id>, or anyenv token set --token <fullToken>.";
  } else if (/用户访问令牌|access token|ANYENV_ACCESS_TOKEN/i.test(message)) {
    code = "access_token_missing";
    tokenType = "access";
    nextStep = "Run anyenv login, anyenv auth token set --token <accessToken>, or set ANYENV_ACCESS_TOKEN.";
  } else if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|network|connection/i.test(message)) {
    code = "api_unreachable";
    nextStep = "Check ANYENV_API_BASE and network access, then run anyenv config show.";
  }
  return {
    code,
    message,
    tokenType,
    endpoint: err?.endpoint || "",
    status: err?.status || null,
    nextStep,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  activeArgs = args;
  const [scope, action] = args._;
  if (args.version || scope === "version" || scope === "--version" || scope === "-v") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (args.help || !scope || scope === "help" || scope === "--help" || scope === "-h") {
    process.stdout.write(usage());
    printInstallHints();
    return;
  }
  if (scope === "setup") return cmdSetup(args);
  if (scope === "doctor") return cmdGlobalDoctor(args);
  if (scope === "login") return cmdLogin(args);
  if (scope === "auth" && action === "token" && args._[2] === "set") return cmdAuthTokenSet(args);
  if (scope === "auth" && action === "status") return cmdAuthStatus(args);
  if (scope === "token" && action === "set") return cmdTokenSet(args);
  if (scope === "projects" && (!action || action === "list")) return cmdProjectsList(args);
  if (scope === "projects" && action === "create") return cmdProjectsCreate(args);
  if (scope === "projects" && action === "get") return cmdProjectsGet(args);
  if (scope === "credentials") return cmdCredentials(args);
  if (scope === "coding") return cmdCoding(args);
  if (scope === "deploy") return cmdDeploy(args);
  if (scope === "sandbox") return cmdSandbox(args);
  if (scope === "context") return cmdContext(args);
  if (scope === "update" || scope === "upgrade") return cmdUpdate(args);
  if (scope === "cleanup") return cmdCleanup(args);
  if (scope === "env") return cmdEnv(args);
  if (scope === "logout") return cmdLogout(args);
  if (scope === "start") return cmdStart(args);
  if (scope === "status") return cmdDaemonStatus(args);
  if (scope === "logs") return cmdDaemonLogs(args);
  if (scope === "stop") return cmdStop(args);
  if (scope === "restart") return cmdRestart(args);
  if (scope === "local" && action === "register") return cmdRegister(args);
  if (scope === "local" && action === "status") return cmdStatus(args);
  if (scope === "local" && action === "doctor") return cmdDoctor(args);
  if (scope === "local" && action === "workspace") return cmdWorkspace(args);
  if (scope === "local" && action === "heartbeat") return cmdHeartbeat(args);
  if (scope === "device" && (!action || action === "doctor")) return cmdDeviceDoctor(args);
  if (scope === "device" && action === "register") return cmdDeviceRegister(args);
  if (scope === "device" && action === "connect") return cmdDeviceConnect(args);
  if (scope === "config" && action === "path") return cmdConfigPath(args);
  if (scope === "config" && action === "show") return cmdConfigShow(args);
  if (scope === "mcp" && action === "install") return cmdMcpInstall(args);
  if (scope === "mcp" && action === "config") return cmdMcpConfig(args);
  if (scope === "mcp") {
    const config = resolveConfig({
      api: args.api,
      token: args.token,
      "global-token": args["global-token"] || args.globalToken,
      project: args.project || args["project-id"],
      clientId: args["client-id"],
      name: args.name || "AnyEnv MCP",
      type: args.type || "custom",
      sync: args.sync,
    });
    return startMcp(config);
  }
  process.stderr.write(usage());
  process.exitCode = 2;
}

main().catch((err) => {
  const envelope = errorEnvelope(err);
  if (activeArgs?.json) {
    printJson({ ok: false, error: envelope, meta: { configPath: configPath() } });
  } else {
    process.stderr.write(`${envelope.message}\n`);
    if (envelope.nextStep && !envelope.message.includes(envelope.nextStep) && !/Next steps?:/i.test(envelope.message)) {
      process.stderr.write(`Next step: ${envelope.nextStep}\n`);
    }
  }
  process.exitCode = 1;
});
