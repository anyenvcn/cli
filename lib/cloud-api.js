import { cloudAuthToken, debugLog, isGlobalToken, requireCloudToken } from "./config.js";

export class anyenvCloudApiError extends Error {
  constructor(status, message, body, endpoint = "") {
    super(`AnyEnv Cloud API ${status}: ${message}`);
    this.status = status;
    this.body = body;
    this.endpoint = endpoint;
    this.tokenType = "access";
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
    const message = typeof value.message === "string" ? value.message : "";
    const parts = [message, missing, project, reason].filter(Boolean);
    if (parts.length) return parts.join("；");
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export async function cloudRequest(config, path, { method = "GET", body, query, auth = "user" } = {}) {
  requireCloudToken(config, auth);
  const token = cloudAuthToken(config, auth);
  const qs = query ? `?${new URLSearchParams(query).toString()}` : "";
  const url = `${config.apiBase}${path}${qs}`;
  const startedAt = Date.now();
  debugLog(config, "http.request", { method, path, auth, url, body });
  const res = await fetch(url, {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-anyenv-Client": "anyenv-cli/cloud",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  debugLog(config, "http.response", { method, path, auth, status: res.status, durationMs: Date.now() - startedAt });
  if (!res.ok) {
    const err = await readError(res);
    debugLog(config, "http.error", { method, path, auth, status: res.status, error: err.body });
    const apiErr = new anyenvCloudApiError(res.status, err.message, err.body, path);
    apiErr.tokenType = auth === "global" ? "global" : "access";
    throw apiErr;
  }
  if (res.status === 204) return null;
  return res.json();
}

export function listProjects(config, options = {}) {
  const global = isGlobalToken(config.globalToken);
  return cloudRequest(config, global ? "/cli/projects" : "/projects", {
    auth: global ? "global" : "user",
    query: {
      paginated: "true",
      limit: String(options.limit ?? 50),
      offset: String(options.offset ?? 0),
    },
  });
}

export function createProject(config, body = {}) {
  const global = isGlobalToken(config.globalToken);
  return cloudRequest(config, global ? "/cli/projects" : "/projects", {
    auth: global ? "global" : "user",
    method: "POST",
    body,
  });
}

export function getProject(config, projectId) {
  const global = isGlobalToken(config.globalToken);
  return cloudRequest(
    config,
    global
      ? `/cli/projects/${encodeURIComponent(projectId)}`
      : `/projects/${encodeURIComponent(projectId)}`,
    { auth: global ? "global" : "user" },
  );
}

export function listAccountLocalClients(config) {
  return cloudRequest(config, "/cli/local-clients", {
    auth: "global",
  });
}

export function registerAccountLocalClient(config, payload) {
  return cloudRequest(config, "/cli/local-clients/register", {
    auth: "global",
    method: "POST",
    body: payload,
  });
}

export function getProjectWorkspace(config, projectId) {
  if (isGlobalToken(config.globalToken)) {
    return cloudRequest(config, `/projects/${encodeURIComponent(projectId)}/cli/workspace`, {
      auth: "global",
      query: {
        clientId: config.clientId || "",
      },
    });
  }
  return cloudRequest(config, `/projects/${encodeURIComponent(projectId)}/workspace`);
}

export function listCredentials(config) {
  return cloudRequest(config, "/credentials");
}

export function createCredential(config, body = {}) {
  return cloudRequest(config, "/credentials", {
    method: "POST",
    body,
  });
}

export function updateCredential(config, credentialId, body = {}) {
  return cloudRequest(config, `/credentials/${encodeURIComponent(credentialId)}`, {
    method: "PUT",
    body,
  });
}

export function setAgentDefaultCredential(config, agentId, credentialId) {
  return cloudRequest(config, `/credentials/defaults/${encodeURIComponent(agentId)}`, {
    method: "PUT",
    body: { credentialId },
  });
}

export function createSession(config, projectId, body = {}) {
  return cloudRequest(config, `/projects/${encodeURIComponent(projectId)}/sessions`, {
    method: "POST",
    body,
  });
}

export function sendCodingMessage(config, projectId, sessionId, body) {
  return cloudRequest(
    config,
    `/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/messages`,
    {
      method: "POST",
      body,
    },
  );
}

export function listDeployments(config, projectId, options = {}) {
  return cloudRequest(config, `/projects/${encodeURIComponent(projectId)}/deployments`, {
    query: {
      paginated: "true",
      limit: String(options.limit ?? 20),
      offset: String(options.offset ?? 0),
    },
  });
}

export function createDeployment(config, projectId, body = {}) {
  return cloudRequest(config, `/projects/${encodeURIComponent(projectId)}/deployments`, {
    method: "POST",
    body,
  });
}

export function getDeployment(config, projectId, deploymentId) {
  return cloudRequest(
    config,
    `/projects/${encodeURIComponent(projectId)}/deployments/${encodeURIComponent(deploymentId)}`,
  );
}

export function rollbackDeployment(config, projectId, deploymentId) {
  return cloudRequest(
    config,
    `/projects/${encodeURIComponent(projectId)}/deployments/${encodeURIComponent(deploymentId)}/rollback`,
    { method: "POST" },
  );
}

export function deployReadiness(config, projectId, body = {}) {
  return cloudRequest(config, `/projects/${encodeURIComponent(projectId)}/deploy/readiness`, {
    method: "POST",
    body,
  });
}

export function getSandbox(config, projectId) {
  return cloudRequest(config, `/projects/${encodeURIComponent(projectId)}/sandbox`);
}

export function startSandbox(config, projectId) {
  return cloudRequest(config, `/projects/${encodeURIComponent(projectId)}/sandbox/start`, {
    method: "POST",
  });
}

export function stopSandbox(config, projectId, options = {}) {
  return cloudRequest(config, `/projects/${encodeURIComponent(projectId)}/sandbox/stop`, {
    method: "POST",
    body: { remove: Boolean(options.remove) },
  });
}

export function getSandboxLogs(config, projectId, options = {}) {
  return cloudRequest(config, `/projects/${encodeURIComponent(projectId)}/sandbox/logs`, {
    query: { tail: String(options.tail ?? 200) },
  });
}
