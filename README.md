# AnyEnv CLI

AnyEnv CLI 是本地终端、IDE、容器、CI、sandbox 与 AnyEnv 云端项目之间的可信边界层。它不是单个 MCP 启动脚本，而是一组按业务场景组织的命令：云开发、部署、云端 sandbox、项目上下文、本地目录登记、项目同步授权、本地设备发现和 stdio MCP。

默认 API 地址是 `https://api.anyenv.cn/api/v1`。命令名、安装包、配置目录和环境变量统一使用 `anyenv` / `ANYENV_*`。

## 源码开发

需要 Node.js 18 或更高版本。

```bash
npm install
npm test
node bin/anyenv.js --help
```

本地链接到当前源码:

```bash
npm link
anyenv --version
```

不要提交 `~/.anyenv/config.json`、真实 token、私钥或本机凭证。

## 安装

macOS / Linux:

```bash
curl -fsSL https://api.anyenv.cn/api/v1/cli/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://api.anyenv.cn/api/v1/cli/install.ps1 | iex
```

平台安装包:

| 平台 | 文件 |
|---|---|
| macOS Apple Silicon | `anyenv-darwin-arm64.tar.gz` |
| macOS Intel | `anyenv-darwin-x64.tar.gz` |
| Linux x64 | `anyenv-linux-x64.tar.gz` |
| Linux arm64 | `anyenv-linux-arm64.tar.gz` |
| Windows x64 | `anyenv-windows-x64.zip` |

安装脚本会下载 `SHA256SUMS` 校验归档。macOS / Linux 默认安装到 `~/.local/bin/anyenv`，Windows 默认安装到 `~/.anyenv/bin/anyenv.exe`。

安装脚本会自动把安装目录写入 shell profile，并在配置不存在或尚未绑定 token 时，把安装入口对应的 API base 写入 `~/.anyenv/config.json`。`curl | sh` 不能修改父 shell 的当前 PATH，所以当前终端可能还需要临时执行:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

验证:

```bash
anyenv --version
anyenv --help
```

账号级本地客户端最快路径:

```bash
# 授权登录
anyenv login

# 登记本地目录
anyenv local workspace add /path/to/project --name "Local Project"

# 保持在线:网页、手机和 IM 可看到本机在线、目录和工具状态
anyenv start --workspace /path/to/project

# 可选:允许网页/手机/IM 请求本机命令行
anyenv restart --workspace /path/to/project \
  --allow-local-commands \
  --command-root /path/to/project \
  --command-timeout 120
```

默认只登记目录和在线状态，不开放本机命令。参数名是复数 `--allow-local-commands`；`--command-root` 会限制远程命令允许进入和执行的目录范围。

自定义安装位置:

```bash
ANYENV_INSTALL_DIR=/usr/local/bin curl -fsSL https://api.anyenv.cn/api/v1/cli/install.sh | sh
```

本地开发环境使用本地后端安装:

```bash
curl -fsSL http://127.0.0.1:36732/api/v1/cli/install.sh | sh
```

升级:

```bash
anyenv update --dry-run
anyenv update
```

安装脚本和 `anyenv update` 都是覆盖更新 CLI 二进制，并保留现有 `~/.anyenv/config.json`。更新 CLI 不需要重新登录；只有首次使用、切换账号或切换生产/本地环境时才需要重新运行 `anyenv login`。

如果 `anyenv --version` 仍显示旧版本，先确认当前 shell 命中的二进制:

```bash
command -v anyenv
which -a anyenv
```

安装脚本会优先覆盖当前 PATH 命中的可写、非临时目录 `anyenv`；如果旧二进制在更靠前的临时目录或不可写目录，请把新版安装目录移到 PATH 前面:

```bash
export PATH="$HOME/.local/bin:$PATH"
hash -r
```

## 配置文件

默认配置文件:

```text
~/.anyenv/config.json
```

POSIX 系统会尽量写成 `0600`。不要把该文件提交到 Git 仓库。

常用环境变量:

| 变量 | 用途 |
|---|---|
| `ANYENV_API_BASE` | 覆盖 API 根地址，例如 `http://localhost:36732/api/v1` |
| `ANYENV_CLI_BASE_URL` | 覆盖 CLI 下载地址，例如 `http://localhost:36732/api/v1/cli` |
| `ANYENV_CONFIG` | 覆盖配置文件路径 |
| `ANYENV_ACCESS_TOKEN` | 用户 access token，用于云端业务命令 |
| `ANYENV_GLOBAL_TOKEN` | 全局 Token，用于账号级 CLI 权限和项目同步 grant |
| `ANYENV_PROJECT_ID` | 全局 Token 执行项目同步时的项目上下文 |
| `ANYENV_PROJECT_TOKEN` | 项目 Token，用于本地同步 / MCP |
| `ANYENV_CLIENT_ID` | 固定本地客户端 ID |
| `ANYENV_DEVICE_ID` | 固定本地设备 ID |
| `ANYENV_INSTALL_DIR` | 安装或更新目标目录 |

查看配置:

```bash
anyenv config path
anyenv config show
anyenv config show --json
```

`config show` 会掩码显示 Token，不会打印明文。

## 登录与授权模型

AnyEnv CLI 有两类令牌:

| 令牌 | 来源 | 用途 | 权限边界 |
|---|---|---|---|
| 用户 access token | Web 登录或手动写入 | `projects`、`coding`、`deploy`、`sandbox` 等云端业务命令 | 遵循用户账号、项目成员权限、计费和审批 |
| 全局 Token | `anyenv login` 或凭证页「平台访问令牌」创建 | 列出项目、创建项目、登记本地目录；可按项目授予同步/MCP 权限 | 账号级权限与项目级 grant 分离，没有项目 grant 时不能同步项目 workspace |
| 项目 Token | 项目详情创建或手动写入 | 项目级 workspace 同步、MCP、项目客户端登记和心跳 | 只能访问 `/project-token/*`，不能管理账单、成员、凭证、部署、本地设备在线或本机命令执行 |

推荐网页登录绑定:

```bash
anyenv login
```

流程:

1. CLI 在 `127.0.0.1` 启动一次性回调服务。
2. 浏览器打开 Web 登录页。
3. Web 创建账号级全局 Token，并可在 URL 显式带 `projectId` 时额外授予该项目同步/MCP 权限。
4. Web 通过本地 POST 回调把全局 Token 和用户 access token 交给 CLI；明文不进 URL。
5. CLI 写入本机配置；有项目上下文时同步登记项目客户端。

为已有项目接入 IDE/MCP 时显式带项目:

```bash
anyenv login --project-id '<projectId>' --name 'Cursor Sync' --type cursor
```

只写入用户 access token，不创建全局 Token:

```bash
anyenv login --account
```

该模式只写入账号访问凭证；登记本机目录和创建本地项目推荐直接使用默认 `anyenv login` 创建全局 Token。

如果没有通过本地后端安装，但需要连接本地开发环境，显式指定 API 和 Web 地址:

```bash
anyenv login --api http://localhost:36732/api/v1 --web http://localhost:58212
```

手动写入用户 access token:

```bash
anyenv auth token set --token '<accessToken>'
anyenv auth status
```

手动写入项目 Token:

```bash
anyenv token set --token '<fullToken>' --name 'Cursor Sync' --type cursor
```

只保存项目 Token，不登记到项目详情:

```bash
anyenv token set --token '<fullToken>' --no-register
```

退出本机配置:

```bash
anyenv logout
```

`logout` 只删除本机配置，不远程撤销 Token。远程撤销需要在项目详情删除对应项目 Token。

## 云端业务命令

云端业务命令使用用户 access token。适合从终端、CI 或运维脚本操作 AnyEnv 项目资源。

项目:

```bash
anyenv projects list
anyenv projects list --json
anyenv projects get --project '<projectId>'
```

云开发:

```bash
anyenv coding --project '<projectId>'
anyenv coding --project '<projectId>' --prompt '修复登录页错误提示'
anyenv coding --project '<projectId>' --session '<sessionId>' --agent codex --model '<model>' --prompt '继续修复测试'
```

真实场景:

- 在本地终端触发云端 AI coding 会话。
- 复用已有 session 继续开发。
- 从 CI 或自动化系统发起一次受控代码修改任务。

部署:

```bash
anyenv deploy readiness --project '<projectId>'
anyenv deploy list --project '<projectId>'
anyenv deploy create --project '<projectId>' --name 'prod release'
anyenv deploy status --project '<projectId>' --deployment '<deploymentId>'
anyenv deploy rollback --project '<projectId>' --deployment '<deploymentId>'
```

真实场景:

- 发布前检查凭证、构建产物、账单和运行时约束。
- 创建部署并轮询状态。
- 线上异常时回滚到指定部署。

云端 sandbox:

```bash
anyenv sandbox status --project '<projectId>'
anyenv sandbox start --project '<projectId>'
anyenv sandbox logs --project '<projectId>' --tail 200
anyenv sandbox stop --project '<projectId>'
anyenv sandbox stop --project '<projectId>' --remove
```

真实场景:

- 在终端查看项目云端运行环境状态。
- 启动开发 sandbox。
- 查看最近日志定位启动失败。
- 停止或释放运行资源。

项目上下文:

```bash
anyenv context workspace --project '<projectId>'
anyenv context workspace --project '<projectId>' --json
```

用于查看项目摘要、记忆、知识库和工具配置，不依赖 MCP 客户端。

## 同步本机 AI Coding 凭证

如果本机已经有 Codex、Claude Code、Cursor Agent、Qwen Code、OpenCode 或 Qoder CLI 的 API Key / 访问令牌，可以通过 CLI 显式同步到「凭证与管理」。同步会复用同名同 provider 的已有凭证；存在则更新，不存在则创建。同步成功后默认把对应 agent 的默认凭证指向它，Workbench 可直接使用。

预览，不上传:

```bash
anyenv credentials import --provider qoder --dry-run
anyenv credentials import --all --dry-run --json
anyenv credentials import --all --from-local --dry-run --json
```

同步单个 provider:

```bash
anyenv credentials import --provider codex --yes
anyenv credentials import --provider qoder --yes
```

显式传入 token 或文件:

```bash
anyenv credentials import --provider qoder --token '<token>' --yes
anyenv credentials import --provider codex --from-file ./openai-key.txt --yes
```

从本机已安装工具扫描:

```bash
anyenv credentials import --provider qoder --from-local --dry-run
anyenv credentials import --provider cursor --from-local --yes
anyenv credentials import --all --from-local --yes
```

`--from-local` 会读取常见 CLI / Desktop 配置位置并只在命令确认后上传。当前会自动导入明确可用于运行环境的 API Key / CLI 访问令牌，例如 `~/.codex/auth.json` 中的 `OPENAI_API_KEY`、`~/.claude/settings.json` 中的 `ANTHROPIC_API_KEY`、Cursor Desktop 的 `cursorAuth/accessToken`、Qoder Desktop 的 `machine_token.json`。Codex ChatGPT 登录态、Claude Code 本机登录状态、Claude Desktop OAuth 缓存这类账号登录态会在 `--dry-run --json` 的 `skipped` 里展示为“已发现但未导入”，不会被当作 `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` 上传；云端项目如需使用账号登录态，应在项目 Terminal/VNC 内完成对应 CLI 官方登录，让登录态落到该项目的持久 CLI home。

默认识别的环境变量:

| provider | 默认环境变量 | 写入凭证 provider |
|---|---|---|
| `codex` | `OPENAI_API_KEY` | `openai` |
| `claude` | `ANTHROPIC_API_KEY` | `anthropic` |
| `cursor` | `CURSOR_API_KEY` | `cursor` |
| `qwen` | `DASHSCOPE_API_KEY` / `OPENAI_API_KEY` | `dashscope` / `openai` |
| `opencode` | `OPENAI_API_KEY` | `openai` |
| `qoder` | `QODER_PERSONAL_ACCESS_TOKEN` | `qoder` |

如果只想同步凭证、不修改默认 agent:

```bash
anyenv credentials import --provider qoder --no-default --yes
```

该命令只在用户明确运行时上传 token。默认只读取显式传入、环境变量或 `--from-file`；只有加 `--from-local` 时才会读取本机工具配置。系统 Keychain 和各家完整网页登录态文件仍不会被自动上传。

## 本地目录登记

账号级本地目录登记用于把本机已有项目作为云端新项目的导入来源。该能力必须使用 `anyenv login` 创建的全局 Token；用户 access token 只能用于云端业务命令，不能登记本地目录。

```bash
anyenv login
anyenv local workspace add /path/to/project --name 'Local Project'
anyenv local workspace list
```

CLI 会登记:

- 本地客户端 ID 和设备 ID。
- 操作系统、架构、主机名、Node 版本。
- 本地目录路径、名称、只读状态。
- Git root、branch、remote。
- 本机可发现的 AI coding CLI，例如 Claude Code、Qwen Code、Codex CLI、Cursor Agent、OpenCode、Qoder CLI。

网页只展示 CLI 主动登记的目录。浏览器登录态可以查看或踢下线客户端，但不能提交新的目录 allowlist。

网页端创建项目时选择「连接本地项目」，即可选择这个客户端和目录。网页端不会自动扫描磁盘，必须由本机 CLI 显式登记。

## 项目同步授权

推荐使用全局 Token 加项目同步 grant 接入已有项目:

```bash
anyenv login --project-id '<projectId>' --name 'Local Client' --type cursor
anyenv local status
anyenv local workspace
anyenv local doctor
anyenv local heartbeat
```

项目 Token 可作为高级/手动同步路径。创建 Token 后，明文 `fullToken` 只展示一次。

```bash
anyenv token set --token '<fullToken>' --name 'Local Client' --type cursor
anyenv local status
anyenv local workspace
anyenv local doctor
anyenv local heartbeat
```

底层登记命令:

```bash
anyenv local register --token '<fullToken>' --name 'Local Client' --type cursor
```

可同步项目:

```bash
anyenv local register --token '<fullToken>' --sync memory,knowledge,tools,skills
```

排障:

```bash
anyenv local doctor --json
```

`doctor` 会检查配置文件、项目 Token、API 连接、项目同步登记状态、workspace 可读性和心跳能力。

## 本地设备发现与连接

本地设备命令用于发现本机 AI coding CLI，并让本机主动保持账号级出站 WebSocket 连接。`anyenv start` 用于登记设备在线、工具清单和显式允许的本地目录；项目 Token 只用于项目同步/MCP，不参与设备在线或本地命令执行。

```bash
anyenv device doctor
anyenv device register --name 'My Mac Studio'
anyenv start --workspace /path/to/project
anyenv start --foreground --workspace /path/to/project
anyenv status
anyenv restart
anyenv stop
```

真实场景:

- 在账号级凭证 / 本地客户端里看到本机是否在线。
- 在账号级在线 CLI 客户端里看到本机是否在线。
- 看到本机已安装哪些 AI coding CLI。
- 后续为受控远程任务打基础。

当前边界:

- 本地设备通过出站连接访问云端，不要求本机暴露公网端口。
- `anyenv start` 只使用账号级 `local_client:write` 权限；项目 Token 只用于项目同步/MCP，不用于本地设备在线。
- `--workspace` / `--dir` 是本地目录 allowlist；网页不会自动扫描磁盘，WebSocket 心跳也不能扩大这个 allowlist。
- 默认不开放云端任意命令执行；只有显式带 `--allow-local-commands` 在线时，网页、手机或 IM 才能在 `--command-root` 范围内请求本机命令。
- 远程执行必须具备权限、审计、超时和可撤销边界；远程桌面只需要显式带 `--allow-remote-desktop` 并先在本机开启 VNC 或系统屏幕共享。`--vnc-port` 只是本机 VNC 源端口的可选覆盖，浏览器始终通过 AnyEnv WebSocket 中继连接，不要求本机暴露公网端口或登记额外目录。

## MCP

生成 MCP 配置:

```bash
anyenv mcp config --client cursor --json
anyenv mcp config --client claude --json
anyenv mcp config --client generic --json
```

写入常见客户端配置:

```bash
anyenv mcp install --client cursor --dry-run
anyenv mcp install --client cursor --backup
anyenv mcp install --client claude --backup
anyenv mcp install --client vscode --path .vscode/mcp.json --backup
```

手动配置示例:

```json
{
  "mcpServers": {
    "anyenv": {
      "command": "anyenv",
      "args": ["mcp"],
      "env": {
        "ANYENV_CONFIG": "/Users/you/.anyenv/config.json"
      }
    }
  }
}
```

启动 stdio MCP:

```bash
anyenv mcp
```

MCP 暴露的资源:

- `anyenv://workspace`
- `anyenv://memory`
- `anyenv://knowledge`
- `anyenv://skills`
- `anyenv://tools`

MCP 暴露的工具:

- `anyenv_status`
- `anyenv_workspace`
- `anyenv_memory`
- `anyenv_knowledge`
- `anyenv_skills`

## 容器、CI 和 sandbox

容器中建议显式设置 API 地址和配置路径:

```bash
curl -fsSL http://host.docker.internal:36732/api/v1/cli/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
export ANYENV_API_BASE="http://host.docker.internal:36732/api/v1"
export ANYENV_CONFIG="/tmp/anyenv-config.json"
anyenv token set --token '<fullToken>' --name 'Docker Client' --type custom
anyenv local workspace --json
anyenv mcp config --client cursor --json
```

Compose 同网络访问后端:

```bash
export ANYENV_API_BASE="http://anyenv-backend:36732/api/v1"
```

CI 中不要把项目 Token 写入镜像或仓库，使用运行时 secret 或环境变量注入。

## 常见问题

`anyenv: command not found`

安装目录不在当前 shell 的 PATH。安装脚本会写入 shell profile；当前终端立即使用可执行:

```bash
export PATH="$HOME/.local/bin:$PATH"
anyenv --version
```

MCP 客户端找不到 `anyenv`

在 MCP 配置中使用绝对路径:

```json
{
  "command": "/Users/you/.local/bin/anyenv",
  "args": ["mcp"]
}
```

`401` 或 `403`

- 项目 Token 可能被删除或复制错误。
- 用户 access token 可能过期。
- 当前账号可能不是项目成员或没有 owner 权限。

`fullToken` 关闭后找不到

项目 Token 明文只展示一次。删除旧 Token 后重新创建。

安装脚本 404

说明对应环境没有部署 CLI 下载路由，或 `latest` 产物没有同步到下载目录。发布后至少验证:

```bash
curl -I https://api.anyenv.cn/api/v1/cli/install.sh
curl -I https://api.anyenv.cn/api/v1/cli/releases/latest/download/SHA256SUMS
```

网页登录显示 `fetch failed`

如果授权页显示本机 CLI 已收到回调但无法访问 API，通常是 CLI 配置仍指向不可达的 API base。检查:

```bash
anyenv config show
```

本地开发环境重新绑定:

```bash
anyenv login --api http://localhost:36732/api/v1 --web http://localhost:58212
```

生产环境重新绑定:

```bash
anyenv login --api https://api.anyenv.cn/api/v1 --web https://www.anyenv.cn
```

`0.1.5` 起，如果配置文件里残留 `http://localhost:36732/api/v1`，裸 `anyenv login` 会默认回到生产环境。若仍打开 localhost，请先检查当前命中的 CLI 版本，以及是否设置了 `ANYENV_API_BASE` / `ANYENV_WEB_BASE`。

## 测试与打包

CLI 单测:

```bash
npm test
```

生成单文件 bundle:

```bash
npm run bundle
node dist/anyenv.cjs --version
```

全平台二进制和归档打包:

```bash
npm run package
```

默认目标包括 macOS x64/arm64、Linux x64/arm64 和 Windows x64。可以通过 `ANYENV_CLI_TARGETS` 限定目标:

```bash
ANYENV_CLI_TARGETS=node20-linux-x64 npm run package
```

macOS 目标需要在 macOS 上进行 ad-hoc codesign。非 macOS 环境仅做本地诊断时可显式设置:

```bash
ANYENV_ALLOW_UNSIGNED_MACOS=1 npm run package:binaries
```

同步下载目录:

```bash
npm run publish:download-dir
```

该命令会先执行 `package`，再把 `dist/artifacts` 发布到下载目录并校验 `latest` 与版本目录的 SHA。独立仓库默认写入 `dist/downloads/cli`；在 AnyEnv monorepo 中默认写入 `../backend/data/downloads/cli`。也可以显式指定目录:

```bash
ANYENV_CLI_DOWNLOAD_DIR=/path/to/downloads/cli npm run publish:download-dir
```

只校验下载目录:

```bash
npm run verify:backend-data
```
