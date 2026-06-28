import { heartbeatClient, getWorkspace, registerClient, summarizeWorkspace } from "./api.js";
import { VERSION } from "./config.js";

function asText(value) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function textContent(value) {
  return [{ type: "text", text: asText(value) }];
}

function jsonResource(uri, name, value) {
  return {
    contents: [
      {
        uri,
        name,
        mimeType: "application/json",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

const TOOL_DEFS = [
  {
    name: "anyenv_status",
    description: "Return the AnyEnv project sync status for the configured project context and sync authorization.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "anyenv_workspace",
    description: "Return project summary, enabled memory, knowledge, skills and tool ids from AnyEnv.",
    inputSchema: {
      type: "object",
      properties: {
        memoryLimit: { type: "number", minimum: 1, maximum: 200 },
        knowledgeLimit: { type: "number", minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "anyenv_memory",
    description: "Return synced project memory entries.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", minimum: 1, maximum: 200 } },
      additionalProperties: false,
    },
  },
  {
    name: "anyenv_knowledge",
    description: "Return synced project knowledge records.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", minimum: 1, maximum: 200 } },
      additionalProperties: false,
    },
  },
  {
    name: "anyenv_skills",
    description: "Return synced project skills as SKILL.md-ready records.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", minimum: 1, maximum: 200 } },
      additionalProperties: false,
    },
  },
];

export class McpServer {
  constructor(config, { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}) {
    this.config = config;
    this.stdin = stdin;
    this.stdout = stdout;
    this.stderr = stderr;
    this.buffer = Buffer.alloc(0);
  }

  async start() {
    await this.ensureRegistered();
    this.stdin.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
      void this.drain();
    });
    this.stdin.resume();
  }

  async ensureRegistered() {
    try {
      await registerClient({ ...this.config, name: this.config.name || "AnyEnv MCP", type: this.config.type || "custom" });
    } catch (err) {
      this.stderr.write(`[AnyEnv MCP] register failed: ${err.message}\n`);
    }
  }

  async drain() {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("utf8");
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buffer = Buffer.alloc(0);
        throw new Error("Invalid MCP frame: missing Content-Length");
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (this.buffer.length < bodyEnd) return;
      const raw = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
      this.buffer = this.buffer.subarray(bodyEnd);
      let message;
      try {
        message = JSON.parse(raw);
      } catch (err) {
        this.sendError(null, -32700, `Parse error: ${err.message}`);
        continue;
      }
      await this.handle(message);
    }
  }

  send(payload) {
    const body = JSON.stringify(payload);
    this.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  }

  sendResult(id, result) {
    if (id === undefined || id === null) return;
    this.send({ jsonrpc: "2.0", id, result });
  }

  sendError(id, code, message) {
    if (id === undefined || id === null) return;
    this.send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  async handle(message) {
    const { id, method, params = {} } = message;
    if (!method) {
      this.sendError(id, -32600, "Invalid request");
      return;
    }
    try {
      switch (method) {
        case "initialize":
          this.sendResult(id, {
            protocolVersion: params.protocolVersion || "2024-11-05",
            capabilities: {
              tools: {},
              resources: {},
            },
            serverInfo: { name: "anyenv", version: VERSION },
          });
          return;
        case "notifications/initialized":
          return;
        case "tools/list":
          this.sendResult(id, { tools: TOOL_DEFS });
          return;
        case "tools/call":
          this.sendResult(id, await this.callTool(params));
          return;
        case "resources/list":
          this.sendResult(id, {
            resources: [
              { uri: "anyenv://workspace", name: "AnyEnv workspace", mimeType: "application/json" },
              { uri: "anyenv://memory", name: "AnyEnv memory", mimeType: "application/json" },
              { uri: "anyenv://knowledge", name: "AnyEnv knowledge", mimeType: "application/json" },
              { uri: "anyenv://skills", name: "AnyEnv skills", mimeType: "application/json" },
              { uri: "anyenv://tools", name: "AnyEnv tool ids", mimeType: "application/json" },
            ],
          });
          return;
        case "resources/read":
          this.sendResult(id, await this.readResource(params.uri));
          return;
        case "ping":
          await heartbeatClient(this.config).catch(() => null);
          this.sendResult(id, {});
          return;
        default:
          this.sendError(id, -32601, `Method not found: ${method}`);
      }
    } catch (err) {
      this.sendError(id, -32000, err.message || String(err));
    }
  }

  async callTool(params) {
    const name = params.name;
    const args = params.arguments || {};
    if (name === "anyenv_status") {
      await heartbeatClient(this.config).catch(() => null);
      const workspace = await getWorkspace(this.config, { memoryLimit: 1, knowledgeLimit: 1 });
      return { content: textContent(summarizeWorkspace(workspace)) };
    }
    if (name === "anyenv_workspace") {
      const workspace = await getWorkspace(this.config, {
        memoryLimit: args.memoryLimit || 100,
        knowledgeLimit: args.knowledgeLimit || 100,
      });
      return { content: textContent(workspace) };
    }
    if (name === "anyenv_memory") {
      const workspace = await getWorkspace(this.config, { memoryLimit: args.limit || 100, knowledgeLimit: 1 });
      return { content: textContent(workspace.memory || []) };
    }
    if (name === "anyenv_knowledge") {
      const workspace = await getWorkspace(this.config, { memoryLimit: 1, knowledgeLimit: args.limit || 100 });
      return { content: textContent(workspace.knowledge || []) };
    }
    if (name === "anyenv_skills") {
      const workspace = await getWorkspace(this.config, { memoryLimit: 1, knowledgeLimit: 1 });
      return { content: textContent((workspace.skills || []).slice(0, args.limit || 100)) };
    }
    throw new Error(`Unknown tool: ${name}`);
  }

  async readResource(uri) {
    const workspace = await getWorkspace(this.config);
    if (uri === "anyenv://workspace") return jsonResource(uri, "AnyEnv workspace", workspace);
    if (uri === "anyenv://memory") return jsonResource(uri, "AnyEnv memory", workspace.memory || []);
    if (uri === "anyenv://knowledge") return jsonResource(uri, "AnyEnv knowledge", workspace.knowledge || []);
    if (uri === "anyenv://skills") return jsonResource(uri, "AnyEnv skills", workspace.skills || []);
    if (uri === "anyenv://tools") return jsonResource(uri, "AnyEnv tool ids", workspace.toolIds || []);
    throw new Error(`Unknown resource: ${uri}`);
  }
}

export async function startMcp(config) {
  const server = new McpServer(config);
  await server.start();
}
