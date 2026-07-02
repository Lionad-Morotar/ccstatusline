# 技术栈

**分析日期：** 2026-07-02

## 编程语言

**主要：**
- TypeScript 5.x（严格模式）—— 整个源码树位于 `src/`
- TSX/JSX（`react-jsx` 转换）—— 用于 `src/tui/` 和 `src/widgets/` 中的 Ink TUI React 组件

**次要：**
- Shell（bash）—— 运行时被调用，用于 git、jj、自定义命令、包管理器安装
- JSON —— 设置 schema、transcript 解析、缓存文件

## 运行时

**环境：**
- Bun（首选）—— `bun install`、`bun run`、`bun test`、`bun build`
- Node.js 14+（发布包的目标运行时）—— 通过 `package.json` 构建脚本中的 `--target=node --target-version=14` 配置

**包管理器：**
- Bun —— 锁文件 `bun.lock`
- npm（仅发布时使用）—— `.github/workflows/publish.yml` 中的 `npm publish`
- 锁文件：已存在（`bun.lock`）

## 框架

**核心：**
- React 19.2.7 —— 交互式 TUI 的组件模型
- Ink 6.2.0 —— 终端 UI 的 React 渲染器（通过 `patches/ink@6.2.0.patch` 修复 macOS 退格键处理）
- Zod 4.0.17 —— 设置、状态 JSON、用量 API 响应的运行时 schema 校验

**测试：**
- Vitest 4.0.18 —— 测试运行器，配置于 `vitest.config.ts`

**构建/开发：**
- Bun bundler —— 将 `src/ccstatusline.ts` 打包为 `dist/ccstatusline.js`，使用 `--packages=external`
- TypeScript 6.0.2（`typescript-eslint`）—— 类型检查与代码检查
- ESLint 10（flat config，`eslint.config.js`）—— 代码检查，包含 TypeScript、React 与 import 规则
- TypeDoc 0.28.12 —— 文档生成（`typedoc.json`）
- Remotion 4.0.459 —— 视频演示生成（`remotion/`）

## 关键依赖

**核心依赖：**
- `chalk` 5.5.0 —— ANSI 颜色渲染；`chalk.level` 在 `src/ccstatusline.ts` 中根据用户设置进行设置
- `ink` 6.2.0、`ink-select-input` 6.2.0、`ink-gradient` 4.0.0 —— TUI 构建模块
- `react` 19.2.7 / `react-dom` 19.2.7 —— TUI 的 React 运行时
- `zod` 4.0.17 —— 设置、JSONL payload、API 响应的 schema 校验
- `https-proxy-agent` 8.0.0 —— `src/utils/usage-fetch.ts` 中 Anthropic 用量 API 调用的代理支持

**基础设施：**
- `strip-ansi` 7.1.0 —— 测试与 widget 渲染中的 ANSI 剥离
- `pluralize` 8.0.0 —— token/时间复数化辅助
- `tinyglobby` 0.2.14 —— glob 工具
- `globals` 17.3.0 —— ESLint 全局变量

## 配置

**环境：**
- 不提交也不需要在运行时使用 `.env` 文件
- Bun 会自动加载 `.env`（如果存在），但项目不使用 `dotenv`
- 主要运行时环境变量：`CLAUDE_CONFIG_DIR`、`HTTPS_PROXY`、`DEBUG_FONT_INSTALL`、`TEST_*`（仅测试使用）

**构建：**
- `tsconfig.json` —— `module: "Preserve"`、`moduleResolution: "bundler"`、`jsx: "react-jsx"`、`types: ["bun"]`
- `eslint.config.js` —— flat config，包含 `@typescript-eslint`、`import-x`、`@stylistic` 与 React 规则
- `vitest.config.ts` —— 包含 `src/**/*.test.ts` 与 `src/**/*.test.tsx`
- `typedoc.json` —— 文档输出到 `typedoc/`，排除 TUI 与测试
- `package.json` 脚本：
  - `start` —— `bun run src/ccstatusline.ts`
  - `build` —— 打包到 `dist/ccstatusline.js`，目标 Node.js 14+
  - `postbuild` —— `bun run scripts/replace-version.ts`，注入 `__PACKAGE_VERSION__`
  - `lint` / `lint:fix` —— 类型检查 + ESLint
  - `test` —— 通过 Bun 运行 Vitest
  - `video:*` —— Remotion 演示生成

## 平台要求

**开发环境：**
- Bun 运行时
- macOS、Linux 或 Windows
- Git —— git widget 与 Powerline 字体安装必需
- 可选：`gh` / `glab` CLI —— 用于 PR/MR 审查 widget

**生产环境：**
- 以单个打包文件 `dist/ccstatusline.js` 分发
- 作为 npm 包 `ccstatusline` 发布
- 通过 `npx -y ccstatusline@latest`、`bunx -y ccstatusline@latest` 或全局安装到 Claude Code

---

*技术栈分析：2026-07-02*
