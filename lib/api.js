import os from "node:os";
import { VERSION, debugLog, isGlobalToken, requireProjectContext, requireToken } from "./config.js";

export class anyenvApiError extends Error {
  constructor(status, message, body, endpoint = "") {
    super(`AnyEnv API ${status}: ${message}`);
    this.status = status;
    this.body = body;
    this.endpoint = endpoint;
    this.tokenType = "project";
  }
}

async function readError(res) {
  const text = await res.text();
  try {
    const parsed = JSON.parse(text);
    return {
      message: errorMessage(parsed.detail) || errorMessage(parsed.message) || text,
      body: parsed,
    };
  } catch {
    return { message: text || res.statusText, body: text };
  }
}

function errorMessage(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    const missing = value.missingPermission ? `缺少权限 ${value.missingPermission}` : "";
    const project = value.projectId ? `项目 ${value.projectId}` : "";
    const reason = value.reason ? String(value.reason) : "";
    const parts = [missing, project, reason].filter(Boolean);
    if (parts.length) return parts.join("；");
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export async function apiRequest(config, path, { method = "GET", body, query } = {}) {
  requireToken(config);
  const token = isGlobalToken(config.globalToken) ? config.globalToken : config.projectToken;
  const qs = query ? `?${new URLSearchParams(query).toString()}` : "";
  const url = `${config.apiBase}${path}${qs}`;
  const startedAt = Date.now();
  debugLog(config, "http.request", { method, path, auth: isGlobalToken(config.globalToken) ? "global" : "project", url, body });
  const res = await fetch(url, {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-anyenv-Client": `anyenv-cli/${VERSION}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  debugLog(config, "http.response", { method, path, status: res.status, durationMs: Date.now() - startedAt });
  if (!res.ok) {
    const err = await readError(res);
    debugLog(config, "http.error", { method, path, status: res.status, error: err.body });
    const apiErr = new anyenvApiError(res.status, err.message, err.body, path);
    apiErr.tokenType = isGlobalToken(config.globalToken) ? "global" : "project";
    throw apiErr;
  }
  if (res.status === 204) return null;
  return res.json();
}

function projectCliPath(config, suffix) {
  requireProjectContext(config);
  return `/projects/${encodeURIComponent(config.projectId)}/cli${suffix}`;
}

function usesGlobalToken(config) {
  return isGlobalToken(config.globalToken);
}

export async function registerClient(config) {
  const path = usesGlobalToken(config) ? projectCliPath(config, "/clients/register") : "/project-token/clients/register";
  return apiRequest(config, path, {
    method: "POST",
    body: {
      name: config.name,
      type: config.type,
      clientId: config.clientId,
      clientVersion: VERSION,
      syncItems: config.syncItems,
      capabilities: ["workspace", "mcp", "resources"],
      metadata: {
        platform: os.platform(),
        arch: os.arch(),
        node: process.version,
        cwd: process.cwd(),
      },
    },
  });
}

export async function heartbeatClient(config) {
  const path = usesGlobalToken(config) ? projectCliPath(config, "/clients/heartbeat") : "/project-token/clients/heartbeat";
  return apiRequest(config, path, {
    method: "POST",
    body: {
      clientId: config.clientId,
      clientVersion: VERSION,
    },
  });
}

export async function getWorkspace(config, options = {}) {
  const query = {
    paginated: "true",
    memoryLimit: String(options.memoryLimit ?? 100),
    memoryOffset: String(options.memoryOffset ?? 0),
    knowledgeLimit: String(options.knowledgeLimit ?? 100),
    knowledgeOffset: String(options.knowledgeOffset ?? 0),
    clientId: config.clientId,
  };
  const path = usesGlobalToken(config) ? projectCliPath(config, "/workspace") : "/project-token/workspace";
  return apiRequest(config, path, { query });
}

export function summarizeWorkspace(workspace) {
  const project = workspace.project || {};
  const sync = workspace.sync || {};
  return {
    project: {
      id: project.id,
      name: project.name,
      sandboxRunning: Boolean(project.sandboxRunning),
      sandboxLifecycleState: project.sandboxLifecycleState || "",
    },
    memoryCount: Array.isArray(workspace.memory) ? workspace.memory.length : 0,
    knowledgeCount: Array.isArray(workspace.knowledge) ? workspace.knowledge.length : 0,
    skillsCount: Array.isArray(workspace.skills) ? workspace.skills.length : 0,
    toolIds: workspace.toolIds || [],
    allowedItems: sync.allowedItems || [],
    deniedReason: sync.deniedReason || "",
    registeredClient: sync.registeredClient || null,
  };
}
