import http from "node:http";
import os from "node:os";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { registerClient } from "./api.js";
import { isGlobalToken, isLoopbackApiBase, maskToken, normalizeApiBase, readConfig, writeConfig, writeProjectContext } from "./config.js";

const LEGACY_API_HOST = `api.${"any"}${"env"}.cn`;

function randomState() {
  return crypto.randomBytes(24).toString("base64url");
}

function defaultWebBase(apiBase) {
  try {
    const url = new URL(normalizeApiBase(apiBase));
    const host = url.hostname.toLowerCase();
    if (isLoopbackApiBase(url.toString())) {
      return "http://localhost:58212";
    }
    if (host === LEGACY_API_HOST) return "https://www.anyenv.cn";
    if (host.startsWith("api.")) {
      url.hostname = host.slice(4);
      url.pathname = "";
      url.search = "";
      url.hash = "";
      return url.origin;
    }
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.origin;
  } catch {
    return "https://www.anyenv.cn";
  }
}

function openBrowser(url) {
  const platform = process.platform;
  let command = "xdg-open";
  let args = [url];
  if (platform === "darwin") {
    command = "open";
  } else if (platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  }
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Browser opening is best-effort; the CLI still prints the URL.
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Private-Network": "true",
  });
  res.end(JSON.stringify(body));
}

function isNetworkFailure(message) {
  return /(fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|network|connection)/i.test(String(message || ""));
}

function callbackErrorMessage(err, apiBase) {
  const raw = err?.message || String(err);
  if (!isNetworkFailure(raw)) return raw;
  return [
    `本机 CLI 已收到授权回调，但无法访问 AnyEnv API: ${apiBase}。`,
    "如果你在本地开发环境绑定 CLI，请重新运行:",
    "anyenv login --api http://localhost:36732/api/v1 --web http://localhost:58212",
    "如果你要绑定生产环境，请重新运行:",
    "anyenv login --api https://api.anyenv.cn/api/v1 --web https://www.anyenv.cn",
    `底层错误: ${raw}`,
  ].join(" ");
}

function readRequestBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > limit) {
        reject(new Error("请求体过大"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function loginUrl({ webBase, callbackUrl, state, apiBase, name, type, sync, clientId, tokenName, projectId, account }) {
  const url = new URL("/cli/login", webBase);
  url.searchParams.set("protocol", "global-token-v1");
  url.searchParams.set("callback", callbackUrl);
  url.searchParams.set("state", state);
  url.searchParams.set("apiBase", normalizeApiBase(apiBase));
  url.searchParams.set("name", name);
  url.searchParams.set("type", type);
  url.searchParams.set("sync", Array.isArray(sync) ? sync.join(",") : String(sync || ""));
  url.searchParams.set("clientId", clientId);
  url.searchParams.set("tokenName", tokenName);
  if (account) url.searchParams.set("mode", "account");
  if (projectId) url.searchParams.set("projectId", projectId);
  return url.toString();
}

export async function runBrowserLogin(config, options = {}) {
  const state = randomState();
  const timeoutMs = Math.max(30, Number(options.timeout || 300)) * 1000;
  const tokenName = options.tokenName || `${config.name || "AnyEnv Local Client"} (${os.hostname()})`;
  const webBase = options.web || process.env.ANYENV_WEB_BASE || defaultWebBase(config.apiBase);

  return await new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const server = http.createServer(async (req, res) => {
      if (req.method === "OPTIONS") {
        sendJson(res, 204, {});
        return;
      }
      if (req.method !== "POST" || req.url?.split("?")[0] !== "/callback") {
        sendJson(res, 404, { ok: false, error: "not_found" });
        return;
      }
      let callbackApiBase = config.apiBase;
      try {
        const raw = await readRequestBody(req);
        const body = JSON.parse(raw || "{}");
        if (body.state !== state) {
          sendJson(res, 403, { ok: false, error: "invalid_state" });
          return;
        }
        const projectToken = String(body.projectToken || "");
        const globalToken = String(body.globalToken || (isGlobalToken(projectToken) ? projectToken : ""));
        if (globalToken) {
          const projectId = String(body.projectId || options.projectId || "").trim();
          const bindsProject = Boolean(projectId) && !options.account;
          const nextConfig = {
            ...config,
            apiBase: normalizeApiBase(body.apiBase || config.apiBase),
            accessToken: typeof body.accessToken === "string" && body.accessToken ? body.accessToken : config.accessToken,
            globalToken,
            projectToken: "",
            projectId,
            name: body.name || config.name,
            type: body.type || config.type,
            syncItems: Array.isArray(body.syncItems) && body.syncItems.length ? body.syncItems : config.syncItems,
          };
          callbackApiBase = nextConfig.apiBase;
          const integration = bindsProject ? await registerClient(nextConfig) : null;
          const file = writeConfig({
            ...readConfig(),
            apiBase: nextConfig.apiBase,
            accessToken: nextConfig.accessToken,
            globalToken: nextConfig.globalToken,
            projectToken: "",
            clientId: nextConfig.clientId,
            deviceId: nextConfig.deviceId,
            integrationId: integration?.id || "",
            projectId: integration?.projectId || nextConfig.projectId,
            name: nextConfig.name,
            type: nextConfig.type,
            syncItems: nextConfig.syncItems,
          });
          if (bindsProject && (integration?.projectId || nextConfig.projectId)) {
            writeProjectContext(integration?.projectId || nextConfig.projectId);
          }
          const accountOnly = Boolean(options.account || !bindsProject);
          sendJson(res, 200, {
            ok: true,
            accountOnly,
            tokenType: "global",
            projectRegistered: Boolean(integration),
            projectId: integration?.projectId || nextConfig.projectId || "",
            clientId: integration?.clientId || nextConfig.clientId,
            token: maskToken(nextConfig.globalToken),
            accessTokenConfigured: Boolean(nextConfig.accessToken),
            configPath: file,
          });
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            server.close();
            resolve({
              accountOnly,
              integration,
              tokenType: "global",
              projectRegistered: Boolean(integration),
              configPath: file,
              token: maskToken(nextConfig.globalToken),
              clientId: integration?.clientId || nextConfig.clientId,
              accessTokenConfigured: Boolean(nextConfig.accessToken),
            });
          }
          return;
        }
        if (!projectToken.startsWith("pt_")) {
          if (!options.account) {
            sendJson(res, 422, { ok: false, error: "missing_project_token" });
            return;
          }
          const accessToken = typeof body.accessToken === "string" && body.accessToken ? body.accessToken : config.accessToken;
          if (!accessToken) {
            sendJson(res, 422, { ok: false, error: "missing_access_token" });
            return;
          }
          const nextConfig = {
            ...config,
            apiBase: normalizeApiBase(body.apiBase || config.apiBase),
            accessToken,
            name: body.name || config.name,
            type: body.type || config.type,
            syncItems: Array.isArray(body.syncItems) && body.syncItems.length ? body.syncItems : config.syncItems,
          };
          callbackApiBase = nextConfig.apiBase;
          const file = writeConfig({
            ...readConfig(),
            apiBase: nextConfig.apiBase,
            accessToken: nextConfig.accessToken,
            clientId: nextConfig.clientId,
            deviceId: nextConfig.deviceId,
            name: nextConfig.name,
            type: nextConfig.type,
            syncItems: nextConfig.syncItems,
          });
          sendJson(res, 200, {
            ok: true,
            accountOnly: true,
            tokenType: "access",
            projectRegistered: false,
            clientId: nextConfig.clientId,
            accessTokenConfigured: true,
            configPath: file,
          });
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            server.close();
            resolve({
              accountOnly: true,
              tokenType: "access",
              projectRegistered: false,
              clientId: nextConfig.clientId,
              configPath: file,
              accessTokenConfigured: true,
            });
          }
          return;
        }
        const nextConfig = {
          ...config,
          apiBase: normalizeApiBase(body.apiBase || config.apiBase),
          accessToken: typeof body.accessToken === "string" && body.accessToken ? body.accessToken : config.accessToken,
          projectToken,
          projectId: body.projectId || config.projectId,
          name: body.name || config.name,
          type: body.type || config.type,
          syncItems: Array.isArray(body.syncItems) && body.syncItems.length ? body.syncItems : config.syncItems,
        };
        callbackApiBase = nextConfig.apiBase;
        const integration = await registerClient(nextConfig);
        const file = writeConfig({
          ...readConfig(),
          apiBase: nextConfig.apiBase,
          accessToken: nextConfig.accessToken,
          projectToken: nextConfig.projectToken,
          clientId: nextConfig.clientId,
          deviceId: nextConfig.deviceId,
          integrationId: integration.id,
          projectId: integration.projectId,
          name: nextConfig.name,
          type: nextConfig.type,
          syncItems: nextConfig.syncItems,
        });
        sendJson(res, 200, {
          ok: true,
          projectId: integration.projectId,
          clientId: integration.clientId,
          tokenType: "project",
          projectRegistered: true,
          token: maskToken(nextConfig.projectToken),
          accessTokenConfigured: Boolean(nextConfig.accessToken),
          configPath: file,
        });
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          server.close();
          resolve({
            accountOnly: false,
            integration,
            tokenType: "project",
            projectRegistered: true,
            configPath: file,
            token: maskToken(nextConfig.projectToken),
            clientId: integration.clientId,
            accessTokenConfigured: Boolean(nextConfig.accessToken),
          });
        }
      } catch (err) {
        const message = callbackErrorMessage(err, callbackApiBase);
        sendJson(res, isNetworkFailure(err?.message || String(err)) ? 502 : 500, { ok: false, error: message });
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          server.close();
          reject(new Error(message));
        }
      }
    });

    server.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const callbackUrl = `http://127.0.0.1:${port}/callback`;
      const url = loginUrl({
        webBase,
        callbackUrl,
        state,
        apiBase: config.apiBase,
        name: config.name,
        type: config.type,
        sync: config.syncItems,
        clientId: config.clientId,
        tokenName,
        projectId: options.projectId,
        account: options.account,
      });
      process.stdout.write(`Open this URL to authorize AnyEnv CLI:\n${url}\n`);
      if (!options.noOpen) {
        try {
          openBrowser(url);
        } catch (err) {
          process.stderr.write(`无法自动打开浏览器: ${err.message || String(err)}\n`);
        }
      }
      timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          server.close();
          reject(new Error("登录超时，请重新运行 anyenv login。"));
        }
      }, timeoutMs);
    });
  });
}
