<!-- refreshed: 2026-07-02 -->
# 架构

**分析日期：** 2026-07-02

## 系统概览

```text
┌─────────────────────────────────────────────────────────────┐
│  CLI Entry                       TUI Root                    │
│  `src/ccstatusline.ts`           `src/tui/App.tsx`           │
│  --version / --config / --hook   Interactive React/Ink UI    │
└────────┬─────────────────────────────┬──────────────────────┘
         │                             │
         ▼                             ▼
┌─────────────────────────────────────────────────────────────┐
│              Status Line Orchestration                       │
│   `renderMultipleLines()` in `src/ccstatusline.ts:98`        │
│   `runTUI()` / `<App />` in `src/tui/App.tsx:1352`           │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│              Widget Abstraction Layer                        │
│   `Widget` interface — `src/types/Widget.ts:37`              │
│   Registry — `src/utils/widgets.ts:20`                       │
│   Manifest — `src/utils/widget-manifest.ts:19`               │
│   Implementations — `src/widgets/*.ts` / `*.tsx`             │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│              Rendering Engine                                │
│   `src/utils/renderer.ts` — pre-render / layout / colors     │
│   `src/utils/ansi.ts` — width / truncation / escape codes    │
│   `src/utils/colors.ts` — color map / powerline themes       │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│              Data Sources & External Systems                 │
│   User settings: `~/.config/ccstatusline/settings.json`      │
│   Claude settings: `~/.claude/settings.json`                 │
│   Transcript JSONL, Git commands, Skills hook cache, Usage   │
└─────────────────────────────────────────────────────────────┘
```

## 组件职责

| 组件 | 职责 | 文件 |
|-----------|----------------|------|
| CLI 入口 | 解析参数，检测管线（piped）与 TTY 模式，分发 `--version`、`--config`、`--hook` 以及状态栏渲染路径。 | `src/ccstatusline.ts` |
| TUI 根组件 | 持有 settings/claude/install 状态，管理屏幕导航，保存配置，显示预览。 | `src/tui/App.tsx` |
| Widget 注册表 | 将 widget 类型字符串映射到实际实现；解析旧别名；构建 TUI 目录。 | `src/utils/widgets.ts` |
| Widget 清单 | 静态列出所有可用 widget 及其工厂。 | `src/utils/widget-manifest.ts` |
| 渲染器 | 预渲染 widget，插入分隔符 / Powerline 符号，应用颜色，分配 flex 空间，按终端宽度截断。 | `src/utils/renderer.ts` |
| ANSI 工具 | 计算可见宽度，剥离 / 解析转义序列，截断带样式的文本，应用渐变。 | `src/utils/ansi.ts` |
| 颜色工具 | 按 chalk level 维护颜色映射，解析 `hex:` / `ansi256:` / 渐变规格，管理 Powerline 主题。 | `src/utils/colors.ts` |
| 配置加载器 | 以原子写入方式加载 / 保存 / 迁移 `settings.json`，并在解析错误时安全恢复。 | `src/utils/config.ts` |
| Claude 设置 | 读写 Claude Code `settings.json`；安装 / 卸载状态栏命令；管理刷新间隔。 | `src/utils/claude-settings.ts` |
| Hook 管理器 | 将 widget 所需的 hook 同步到 Claude Code 设置；清理 / 自愈旧 hook。 | `src/utils/hooks.ts` |
| JSONL 指标 | 解析 Claude Code 转录文件，计算 token 总计、上下文长度、速度窗口、会话时长。 | `src/utils/jsonl-metrics.ts` |
| Git 执行器 | 执行 git 命令，支持可选的锁抑制，具备基于内存与持久化 mtime 的缓存。 | `src/utils/git.ts` |
| Skills 缓存 | 在 `--hook` 模式下追加 / 读取 skill 调用记录。 | `src/utils/skills.ts` |
| 类型定义 | 针对 settings、status JSON、widget、render context 的 Zod schema 与 TypeScript 契约。 | `src/types/*.ts` |

## 模式概览

**总体：** 插件式 widget 注册表驱动一个配置驱动的多行状态栏渲染器。

**关键特征：**
- Widget 是基于类的插件，实现统一的 `Widget` 接口。新增 widget 只需创建一个类，从 `src/widgets/index.ts` 导出，并在 `src/utils/widget-manifest.ts` 中注册。
- 状态栏是声明式的：`Settings.lines` 是一个 `WidgetItem[]` 数组；渲染器解释该数组，而非依赖命令式代码。
- 同一份代码库同时面向 Bun 与 Node.js 14+；构建产物为单个 `dist/ccstatusline.js` bundle。
- React/Ink TUI 通过设置 `RenderContext.isPreview = true` 复用与 CLI 相同的渲染引擎。
- 数据适配器（git、JSONL、usage、skills）每轮渲染只查询一次，并通过 `RenderContext` 向下传递，而不是由布局代码直接读取。

## 分层

**入口 / 编排：**
- 用途：决定运行模式并协调高层数据收集。
- 位置：`src/ccstatusline.ts`、`src/tui/index.tsx`、`src/tui/App.tsx`。
- 包含：参数解析、stdin 读取、屏幕路由、全局更新消息处理。
- 依赖：config、renderer、JSONL 指标、git、skills、usage、claude-settings、hooks。
- 使用者：Bin 脚本 `dist/ccstatusline.js` 与 `bun run start`。

**类型 / 契约：**
- 用途：定义外部输入、settings 与 widget 接口的形态。
- 位置：`src/types/*.ts`。
- 包含：Zod schema（`Settings.ts`、`StatusJSON.ts`、`Widget.ts`）、指标接口、`RenderContext`。
- 依赖：仅 Zod。
- 使用者：所有其他分层。

**Widget：**
- 用途：生成纯文本内容并暴露 TUI 元数据 / 编辑器行为。
- 位置：`src/widgets/*.ts`（需要 React 编辑器时为 `*.tsx`）。
- 包含：widget 类、`src/widgets/shared/` 中的共享辅助函数。
- 依赖：`RenderContext`、`Settings`、工具适配器（git、JSONL 等）。
- 使用者：Widget 注册表与渲染器。

**渲染引擎：**
- 用途：将配置好的行与预渲染的 widget 内容转换为最终 ANSI 字符串。
- 位置：`src/utils/renderer.ts`、`src/utils/ansi.ts`、`src/utils/colors.ts`。
- 包含：预渲染阶段、分隔符 / Powerline 布局、颜色应用、flex 展开、截断。
- 依赖：widget、settings、render context。
- 使用者：CLI 渲染路径与 `StatusLinePreview`。

**数据适配器：**
- 用途：读取外部状态并为 widget 计算指标。
- 位置：`src/utils/jsonl*.ts`、`src/utils/git.ts`、`src/utils/skills.ts`、`src/utils/usage*.ts`。
- 包含：JSONL 解析、git 命令包装器、skills hook 缓存、Claude usage 获取。
- 依赖：文件系统、子进程、网络（仅 usage）。
- 使用者：编排层在构建 `RenderContext` 时调用。

**配置 / 安装：**
- 用途：持久化用户设置并与 Claude Code 集成。
- 位置：`src/utils/config.ts`、`src/utils/claude-settings.ts`、`src/utils/hooks.ts`。
- 包含：原子化 settings 写入、迁移逻辑、Claude `settings.json` 操作、hook 同步。
- 依赖：文件系统、`Settings` schema。
- 使用者：CLI、TUI、安装 / 卸载流程。

**TUI 组件：**
- 用途：提供交互式菜单与编辑器。
- 位置：`src/tui/components/*.tsx`。
- 包含：菜单组件、widget 选择器、颜色编辑器、预览组件。
- 依赖：Ink、React、widget 注册表、渲染器。
- 使用者：`App.tsx`。

## 数据流

### 主请求路径（管线状态栏）

1. Claude Code 启动 `ccstatusline` 并通过 stdin 传入 JSON payload；`src/ccstatusline.ts:56` 中的 `readStdin()` 以兼容 Bun 或 Node 的流式方式消费数据。
2. `StatusJSONSchema.safeParse()` 在 `src/ccstatusline.ts:304` 验证输入；若格式错误则退出并报错。
3. `renderMultipleLines()` 通过 `loadSettings()`（`src/utils/config.ts:164`）加载设置，并仅收集当前配置 widget 实际所需的指标：
   - 来自转录路径的 token / 会话指标（`src/utils/jsonl-metrics.ts`）。
   - 若存在速度 widget，则收集速度指标（`src/utils/jsonl-metrics.ts:493`）。
   - 按 `session_id` 收集 skills 指标（`src/utils/skills.ts:20`）。
   - 若存在 `compaction-counter`，则收集压缩统计。
   - 若存在 usage widget，则收集 usage 数据（`src/utils/usage-prefetch.ts`）。
4. 在 `src/ccstatusline.ts:161` 构建单个 `RenderContext` 并在所有行之间共享。
5. `preRenderAllWidgets()` 每行调用一次各 widget 的 `render(item, context, settings)`（`src/utils/renderer.ts:770`）。
6. `renderStatusLine()`（或 `powerline.enabled` 为 true 时的 `renderPowerlineStatusLine()`）组装分隔符、颜色、padding、flex 分隔符，并按有效终端宽度截断（`src/utils/renderer.ts:917`）。
7. 每个非空行都会带上前导 reset 代码输出，并将空格转换为不间断空格以避免编辑器截断（`src/ccstatusline.ts:209-213`）。

### 次要流程（交互式 TUI）

1. 当 stdin 为 TTY 时，`main()` 调用 `runTUI()`（`src/tui/App.tsx:1352`），清空屏幕并渲染 `<App />`。
2. `App` 并行加载 settings、现有 Claude 状态栏命令、刷新间隔、Powerline 字体状态以及更新检查。
3. 通过联合类型 `AppScreen`（`src/tui/App.tsx:107`）选择当前屏幕，并在预览下方按条件渲染。
4. `StatusLinePreview` 通过 `isPreview: true` 复用渲染器，使预览与真实输出一致（`src/tui/components/StatusLinePreview.tsx:68`）。
5. `saveSettings()` 以原子方式写入 `settings.json`，随后将 widget hook 同步到 Claude Code `settings.json`（`src/utils/config.ts:231`）。

### `--hook` 事件路径

1. 当使用 `--hook` 启动时，CLI 调用 `handleHookInput()`（`src/utils/hook-handler.ts:14`）。
2. 它解析 JSON payload，并将 skill 调用（`PreToolUse`/`Skill` 与 `UserPromptSubmit` 斜杠命令）记录到 `~/.cache/ccstatusline/skills/skills-<session_id>.jsonl`。
3. `skills` widget 随后通过 `getSkillsMetrics()`（`src/utils/skills.ts:20`）读取该文件。

**状态管理：**
- `RenderContext` 每轮渲染创建一次，构造后不可变。
- TUI settings 状态位于 `App.tsx` 内的 React hook 中；派生预览状态通过 `StatusLinePreview` 中的 `React.useMemo` 计算。
- 长生命周期缓存为模块级单例：`gitCommandCache`（`src/utils/git.ts:44`）以及 `~/.cache/ccstatusline/git-cache/` 下的持久化 git 缓存文件。

## 关键抽象

**`Widget` 接口：**
- 用途：渲染器与每个状态栏段之间的契约。
- 示例：`src/widgets/Model.ts`、`src/widgets/GitBranch.ts`、`src/widgets/Skills.tsx`。
- 模式：类实现 `getDefaultColor`、`getDescription`、`getDisplayName`、`getEditorDisplay`、`render`、`supportsRawValue`、`supportsColors`；可选 `getHooks`、`renderEditor`、`handleEditorAction`、`getCustomKeybinds`。

**`WidgetItem`：**
- 用途：面向用户的单段配置：类型、颜色、raw value 标志、合并行为、per-widget 元数据等。
- 定义于：`src/types/Widget.ts:7`。
- 模式：可序列化的普通对象，存储在 `settings.json` 中；widget 解释 `metadata`、`rawValue`、`merge`、`maxWidth` 等字段。

**`RenderContext`：**
- 用途：汇总 widget 可能需要的所有数据，使 widget 保持为 `(item, context, settings)` 的纯函数。
- 定义于：`src/types/RenderContext.ts:33`。
- 模式：包含 `StatusJSON`、token / speed / usage / skills / compaction 指标、终端宽度、preview / minimalist 标志，以及每行的 Powerline 索引。

**`Settings` schema：**
- 用途：用户配置的单一事实来源，并支持版本化迁移。
- 定义于：`src/types/Settings.ts:45`。
- 模式：带默认值的 Zod schema；`CURRENT_VERSION = 3`；迁移逻辑位于 `src/utils/migrations.ts`。

## 入口点

**`src/ccstatusline.ts`：**
- 位置：`src/ccstatusline.ts`
- 触发：直接执行、`bun run start`、Claude Code `statusLine.command`、npm bin `ccstatusline`。
- 职责：参数解析、stdin 检测、分发至渲染 / TUI / hook 处理器。

**`src/tui/index.tsx`：**
- 位置：`src/tui/index.tsx`
- 触发：来自 `src/ccstatusline.ts:328` 的 `runTUI()`。
- 职责：重新导出 `runTUI` / `App`，使 CLI 入口不直接依赖 React。

**`dist/ccstatusline.js`：**
- 位置：`dist/ccstatusline.js`（由 `bun run build` 生成）
- 触发：已发布 npm 包、全局安装。
- 职责：兼容 Node.js 14+ 的打包 CLI。

## 架构约束

- **线程：** 单线程事件循环。Git 命令、自定义命令以及部分终端宽度探测使用同步 `execSync`/`execFileSync`。由于每个进程都是短命的，因此可以接受；但长时间运行的命令会阻塞整个渲染。
- **全局状态：**
  - 基于 `settings.colorLevel`，`chalk.level` 在 `src/ccstatusline.ts:103` 与 `src/tui/App.tsx:486` 被全局修改。
  - `COLOR_MAP` 在 `updateColorMap()`（`src/utils/colors.ts:61`）时被重新创建。
  - 模块级 `settingsPath` 与 `lastLoadError` 位于 `src/utils/config.ts:31-32`。
  - `gitCommandCache` Map 位于 `src/utils/git.ts:44`。
  - `widgetRegistry` Map 位于 `src/utils/widgets.ts:20`。
- **循环导入：** 目前未发现静态循环依赖。`config.ts` 在保存时动态导入 `hooks.ts`（`src/utils/config.ts:244`），以避免 config、claude-settings 与 hooks 之间的静态循环。
- **运行时兼容性：** 开发依赖 Bun（`bun install`、`bun test`、`bun run build`）。构建产物目标为 Node.js 14+；代码使用 `typeof Bun` 检查以支持 Bun 特有的 stdin 流式处理。

## 反模式

### 在 widget render 中执行阻塞式外部调用

**会发生什么：** 多个 widget 在 `render()` 中调用 `execFileSync`（git）或 `execSync`（自定义命令）。例如：`GitBranchWidget.render()` 调用 `runGit()`（`src/widgets/GitBranch.ts:104`），`CustomCommandWidget.render()` 派生 shell 命令（`src/widgets/CustomCommand.tsx:57`）。
**为何在此有问题：** 在 TUI 预览路径中，每次设置变更都会执行这些调用，可能导致界面冻结。同时它们也使 widget 更难单元测试。
**应改为：** 尽可能保持 render 方法纯。若 widget 需要外部数据，请将其加入 `RenderContext`（如 `skillsMetrics` 或 `tokenMetrics`），并在 `renderMultipleLines()` 中统一收集一次。对于自定义命令，这是预期行为，但请缓存或防抖昂贵的命令。

### 单体 TUI 根组件

**会发生什么：** `src/tui/App.tsx` 超过 1,350 行，混合了屏幕路由、安装分类、保存保护、更新检查与 UI 渲染。
**为何在此有问题：** 新增一个屏幕需要同时修改 `AppScreen`、`handleMainMenuSelect`、JSX 条件块，以及常常涉及同一文件中的状态类型。
**应改为：** 将屏幕特定的状态 / 逻辑抽取为小型 hook（例如 `useUpdateCheck`、`useInstallationState`），让 `App.tsx` 专注于路由与顶层状态。新屏幕应只添加一个组件引用。

### 全局 color-level 修改

**会发生什么：** 在渲染前全局修改 `chalk.level` 与 `COLOR_MAP`。
**为何在此有问题：** 它将颜色输出与进程级可变状态耦合，可能在测试或并发渲染中引发意外的副作用。
**应改为：** 继续使用现有模式（这是已建立的约定），但不要再引入额外的全局样式状态。若新增样式代码，优先通过 `RenderContext` 显式传递 color level。

## 错误处理

**策略：** 防御性降级，并附带用户可见信号。

**模式：**
- Settings 解析错误返回内存中的默认值，并记录 `lastLoadError`；TUI 显示警告横幅并保护保存操作（`src/utils/config.ts:164`、`src/tui/App.tsx:417-441`）。
- Widget 渲染错误被捕获并跳过（`src/utils/renderer.ts:1047-1087`），避免一个损坏的 widget 拖垮整个状态栏。
- JSONL、git 与 usage 获取失败返回零 / null 指标，而不是抛出（`src/utils/jsonl-metrics.ts`、`src/utils/git.ts:322-348`、`src/utils/usage-prefetch.ts`）。
- TUI 错误以彩色闪存消息与确认对话框形式呈现，而不是堆栈跟踪。

## 跨领域关注点

**日志：** 使用 `console.error` 输出诊断信息（settings 加载失败、缓存错误）。没有结构化日志；保持日志可操作且低频。

**校验：** 外部 JSON 使用 Zod 校验（`StatusJSONSchema`、`SettingsSchema`、`SettingsSchema_v1`）。建议为任何新的外部文件格式添加 Zod schema。

**认证：** 项目不保存凭证。Usage widget 使用 Claude Code 存储在 `~/.claude.json` 中的凭证获取数据；请勿直接读取或记录该文件。

**ANSI / 终端处理：** 所有宽度测量、转义序列剥离、截断与渐变应用都集中在 `src/utils/ansi.ts` 与 `src/utils/colors.ts`。新增布局代码应使用 `getVisibleWidth()` 与 `truncateStyledText()`，而非原生字符串长度。

---

*架构分析：2026-07-02*
