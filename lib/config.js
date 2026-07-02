import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const VERSION = "0.1.22";
export const DEFAULT_API_BASE = "https://api.anyenv.cn/api/v1";
const LEGACY_API_HOST = `api.${"any"}${"env"}.cn`;

export function configPath() {
  return process.env.ANYENV_CONFIG || path.join(os.homedir(), ".anyenv", "config.json");
}

export function normalizeApiBase(value) {
  const raw = String(value || DEFAULT_API_BASE).trim().replace(/\/+$/, "");
  if (!raw) return DEFAULT_API_BASE;
  let normalized = raw;
  if (normalized.endsWith("/api/v1")) {
    // already normalized
  } else if (normalized.endsWith("/api")) {
    normalized = `${normalized}/v1`;
  } else {
    normalized = `${normalized}/api/v1`;
  }
  try {
    const url = new URL(normalized);
    if (url.hostname.toLowerCase() === LEGACY_API_HOST) {
      url.hostname = "api.anyenv.cn";
      return url.toString().replace(/\/+$/, "");
    }
  } catch {
    // Keep non-URL values behaving as before; callers will surface connectivity errors.
  }
  return normalized;
}

export function isLoopbackApiBase(value) {
  try {
    const url = new URL(normalizeApiBase(value));
    const host = url.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

export function createClientId() {
  if (typeof crypto.randomUUID === "function") return `lc_${crypto.randomUUID()}`;
  return `lc_${crypto.randomBytes(16).toString("hex")}`;
}

export function createDeviceId() {
  if (typeof crypto.randomUUID === "function") return `ld_${crypto.randomUUID()}`;
  return `ld_${crypto.randomBytes(16).toString("hex")}`;
}

export function isGlobalToken(token) {
  return String(token || "").trim().startsWith("evls_gt_");
}

export function isProjectToken(token) {
  return String(token || "").trim().startsWith("pt_");
}

export function maskToken(token) {
  const raw = String(token || "");
  if (raw.length <= 10) return raw ? "****" : "";
  return `${raw.slice(0, 3)}****...${raw.slice(-4)}`;
}

function truthy(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on" || raw === "debug";
}

export function debugEnabled(config = {}) {
  return Boolean(config.debug) || truthy(process.env.ANYENV_DEBUG);
}

function sanitizeDebug(value, depth = 0) {
  if (depth > 5) return "[depth-limit]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (/^(pt_|evls_gt_|eyJ)/.test(value)) return maskToken(value);
    return value;
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeDebug(item, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const sensitiveKey = /authorization|secret|password|credential/i.test(key) || /(^token$|token$|_token$)/i.test(key);
    if (sensitiveKey) {
      out[key] = typeof item === "string"
        ? maskToken(item)
        : item === null || item === undefined || typeof item === "boolean" || typeof item === "number"
          ? item
          : "[redacted]";
    } else {
      out[key] = sanitizeDebug(item, depth + 1);
    }
  }
  return out;
}

export function debugLog(config, event, detail = {}) {
  if (!debugEnabled(config)) return;
  const payload = sanitizeDebug(detail);
  const suffix = payload && Object.keys(payload).length ? ` ${JSON.stringify(payload)}` : "";
  process.stderr.write(`[AnyEnv:debug] ${new Date().toISOString()} ${event}${suffix}\n`);
}

export function projectContextPath(cwd = process.cwd()) {
  let current = path.resolve(cwd);
  while (true) {
    const candidate = path.join(current, ".anyenv", "project.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return "";
    current = parent;
  }
}

export function readProjectContext(cwd = process.cwd()) {
  const file = projectContextPath(cwd);
  if (!file) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? { ...parsed, contextPath: file } : {};
  } catch {
    return {};
  }
}

export function writeProjectContext(projectId, cwd = process.cwd()) {
  const dir = path.join(path.resolve(cwd), ".anyenv");
  const file = path.join(dir, "project.json");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify({ projectId }, null, 2)}\n`, { mode: 0o600 });
  return file;
}

export function parseSyncItems(value) {
  const raw = Array.isArray(value) ? value.join(",") : String(value || "memory,knowledge,tools,skills");
  const items = raw.split(",").map((item) => item.trim()).filter(Boolean);
  return [...new Set(items)];
}

export function readConfig() {
  const file = configPath();
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err && err.code === "ENOENT") return {};
    throw err;
  }
}

export function writeConfig(next) {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best effort on platforms without POSIX chmod.
  }
  return file;
}

export function resolveConfig(options = {}) {
  const stored = readConfig();
  const rawToken = options.token || process.env.ANYENV_PROJECT_TOKEN || "";
  const explicitGlobalToken = options.globalToken || options["global-token"] || process.env.ANYENV_GLOBAL_TOKEN || "";
  const storedGlobalToken = stored.globalToken || (isGlobalToken(stored.projectToken) ? stored.projectToken : "");
  const globalToken = explicitGlobalToken || (isGlobalToken(rawToken) ? rawToken : "") || storedGlobalToken || "";
  const token = isProjectToken(rawToken) ? rawToken : process.env.ANYENV_PROJECT_TOKEN && isProjectToken(process.env.ANYENV_PROJECT_TOKEN)
    ? process.env.ANYENV_PROJECT_TOKEN
    : isProjectToken(stored.projectToken) ? stored.projectToken : "";
  const accessToken = options.accessToken || options["access-token"] || process.env.ANYENV_ACCESS_TOKEN || stored.accessToken || "";
  const apiBase = normalizeApiBase(options.api || process.env.ANYENV_API_BASE || stored.apiBase || DEFAULT_API_BASE);
  const clientId = options.clientId || process.env.ANYENV_CLIENT_ID || stored.clientId || createClientId();
  const deviceId = options.deviceId || process.env.ANYENV_DEVICE_ID || stored.deviceId || createDeviceId();
  const context = readProjectContext(options.cwd || process.cwd());
  const projectId = options.project || options["project-id"] || process.env.ANYENV_PROJECT_ID || context.projectId || stored.projectId || "";
  const debug = Boolean(options.debug) || truthy(process.env.ANYENV_DEBUG);
  return {
    ...stored,
    apiBase,
    projectToken: token,
    globalToken,
    accessToken,
    projectId,
    projectContextPath: context.contextPath || "",
    clientId,
    deviceId,
    name: options.name || stored.name || "AnyEnv Local Client",
    type: options.type || stored.type || "custom",
    syncItems: parseSyncItems(options.sync || stored.syncItems),
    debug,
  };
}

export function requireToken(config) {
  if (!config.projectToken && !config.globalToken) {
    throw new Error("缺少 Token。请通过 --token pt_...、--global-token evls_gt_...、ANYENV_PROJECT_TOKEN 或 ANYENV_GLOBAL_TOKEN 提供。");
  }
}

export function requireProjectContext(config) {
  if (!config.projectId) {
    throw new Error("缺少项目上下文。请使用 --project <id>、设置 ANYENV_PROJECT_ID，或在项目目录创建 .anyenv/project.json。");
  }
}

export function cloudAuthToken(config, mode = "user") {
  if (mode === "global") return isGlobalToken(config.globalToken) ? config.globalToken : "";
  if (mode === "auto") return isGlobalToken(config.globalToken) ? config.globalToken : config.accessToken || "";
  return config.accessToken || "";
}

export function requireCloudToken(config, mode = "user") {
  if (!cloudAuthToken(config, mode)) {
    if (mode === "global") {
      throw new Error("缺少全局 Token。请先运行 anyenv login，或设置 ANYENV_GLOBAL_TOKEN。");
    }
    throw new Error("缺少用户访问令牌。该命令需要用户会话，请先运行 anyenv login，或设置 ANYENV_ACCESS_TOKEN。");
  }
}

export function shellQuote(value) {
  const raw = String(value);
  return `'${raw.replace(/'/g, "'\\''")}'`;
}
