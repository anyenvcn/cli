# Contributing

感谢你对 AnyEnv CLI 的关注。这个仓库只维护 CLI、MCP stdio server、本地设备连接和跨平台安装包相关代码。

## 开发环境

需要 Node.js 18 或更高版本。

```bash
npm install
npm test
node bin/anyenv.js --help
```

## 提交前检查

```bash
npm test
```

如果改动涉及打包、安装脚本或更新逻辑，也请在当前平台至少运行:

```bash
npm run bundle
node dist/anyenv.cjs --version
```

## 安全边界

- 不要提交真实 token、账号凭证、私钥或本机 `~/.anyenv/config.json`。
- 本地命令执行和远程桌面能力默认关闭；修改相关逻辑时请补充测试。
- CLI 输出中必须继续掩码显示 token。

## Pull Request

PR 描述请包含:

- 改动目的。
- 用户可见行为变化。
- 已运行的测试命令。
