# 外部集成

**分析日期：** 2026-07-02

## API 与外部服务

**Anthropic 用量 API：**
- 用途：获取 OAuth 用量/速率限制数据，用于 session、weekly、Sonnet、Opus 与 extra-usage widget
- 端点：`https://api.anthropic.com/api/oauth/usage`
- 实现：`src/utils/usage-fetch.ts`（Node `https.request`）
- 认证：从 Claude Code 凭据中读取 OAuth bearer token
- 代理支持：通过 `https-proxy-agent` 使用 `HTTPS_PROXY` 环境变量

**NPM Registry：**
- 用途：检查最新发布版本，并在 TUI 中驱动更新提示
- 端点：`https://registry.npmjs.org/ccstatusline/latest`
- 实现：`src/utils/update-checker.ts`（Node `https.request`）

**GitHub / GitLab（网页链接）：**
- 用途：渲染指向仓库、分支、PR 与 MR 的 OSC8 终端超链接
- 实现：`src/utils/git-remote.ts`、`src/widgets/GitBranch.ts`、`src/widgets/GitPr.ts`、`src/widgets/Link.tsx`
- 支持 GitHub、GitLab 以及自托管 GitHub/GitLab 实例

**Powerline Fonts 仓库：**
- 用途：在 TUI 中应请求下载并安装 Powerline 字体
- 端点：`https://github.com/powerline/fonts`
- 实现：`src/utils/powerline.ts`（`git clone --depth=1`）

## 数据存储

**数据库：**
- 不适用 —— 未使用数据库

**文件存储：**
- 仅本地文件系统
- 用户设置：`~/.config/ccstatusline/settings.json`（`src/utils/config.ts`）
- Claude Code 设置：`~/.claude/settings.json` 或 `$CLAUDE_CONFIG_DIR/settings.json`（`src/utils/claude-settings.ts`）
- Claude 账户状态：`~/.claude/.claude.json` 或 `$CLAUDE_CONFIG_DIR` 下（`src/utils/claude-settings.ts`）
- 用量缓存：`~/.cache/ccstatusline/usage.json` 与 `~/.cache/ccstatusline/usage.lock`（`src/utils/usage-fetch.ts`）
- Git 缓存：`~/.cache/ccstatusline/git-cache/git-<hash>.json`（`src/utils/git.ts`）
- Git 审查缓存：`~/.cache/ccstatusline/git-review/git-review-<hash>.json`（`src/utils/git-review-cache.ts`）

**缓存：**
- 用量数据与 git 命令输出的内存缓存
- 用量、git 命令、PR/MR 元数据的持久化 JSON 磁盘缓存
- 缓存 TTL：用量 180s、用量锁 30s、git TTL 可配置（默认 5s）、git review 30s

## 认证与身份

**认证提供方：**
- 由 Claude Code 存储的 Anthropic OAuth 凭据
- macOS：从匹配 `Claude Code-credentials*` 的 macOS 钥匙串服务读取（`src/utils/usage-fetch.ts`）
- 其他平台：读取 `~/.claude/.credentials.json` 或 `$CLAUDE_CONFIG_DIR/.credentials.json`
- 无自定义认证流程；该工具复用 Claude Code 已有的 OAuth token

## 监控与可观测性

**错误追踪：**
- 无 —— 错误输出到 stderr 或以内联 widget 文本形式展示

**日志：**
- 仅控制台错误输出（`console.error`）
- 无结构化日志或外部日志聚合

## CI/CD 与部署

**托管：**
- npm registry（`https://www.npmjs.com/package/ccstatusline`）

**CI 流水线：**
- GitHub Actions
- `.github/workflows/ci.yml`：push/PR 时执行 lint/type-check、test、build
- `.github/workflows/publish.yml`：在版本标签（`v*`）上发布到 npm 并创建 GitHub release
- Dependabot：`.github/dependabot.yml` 用于依赖更新

## 环境配置

**必需环境变量：**
- 基本运行无需任何必需环境变量

**可选环境变量：**
- `CLAUDE_CONFIG_DIR` —— 覆盖 Claude Code 配置目录路径
- `HTTPS_PROXY` —— Anthropic 用量 API 请求的代理
- `DEBUG_FONT_INSTALL` —— 设置为 `1` 以强制进入 Powerline 字体安装流程
- `TEST_REQUEST_MODE`、`TEST_RESPONSE_BODY`、`TEST_RESPONSE_HEADERS_JSON`、`TEST_STATUS_CODE`、`TEST_NOW_MS`、`TEST_REQUIRED_FIELDS_JSON` —— `src/utils/__tests__/usage-fetch.test.ts` 的测试控制变量

**密钥位置：**
- macOS 钥匙串（`Claude Code-credentials` 服务及其编号变体）
- `~/.claude/.credentials.json` 或 `$CLAUDE_CONFIG_DIR/.credentials.json`
- 项目不会从仓库文件中读取硬编码密钥

## Webhook 与回调

**入站：**
- 无

**出站：**
- 无 —— 项目仅向 Anthropic 与 npm 发起客户端主动 HTTPS 请求

## CLI 工具集成

**Claude Code：**
- 读写 Claude Code `settings.json` 以安装/卸载状态栏命令
- 读取 `.claude.json` 会话清单以检测远程控制桥状态
- 读取 `.credentials.json` 以获取 Anthropic OAuth token
- 实现：`src/utils/claude-settings.ts`、`src/tui/claude-status.ts`

**Git：**
- 通过 shell 调用 `git` 执行 branch、status、diff、remote、rev-list 操作
- 实现：`src/utils/git.ts`、`src/utils/git-remote.ts`

**Jujutsu（jj）：**
- 通过 shell 调用 `jj` 执行 change、bookmark、workspace、revision widget
- 实现：`src/utils/jj.ts`

**GitHub CLI（`gh`）/ GitLab CLI（`glab`）：**
- `src/utils/git-review-cache.ts` 使用它们获取 PR/MR 数据，供 `git-pr` widget 使用
- CLI 不可用时优雅降级

**包管理器：**
- 检测并使用 `npm`、`npx`、`bun`、`bunx` 进行自我更新操作
- 实现：`src/utils/claude-settings.ts`、`src/utils/package-manager-executable.ts`、`src/utils/update-checker.ts`

---

*集成审计：2026-07-02*
