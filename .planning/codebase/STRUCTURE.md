# 代码库结构

**分析日期：** 2026-07-02

## 目录布局

```
[project-root]/
├── src/                       # 全部源码
│   ├── ccstatusline.ts        # CLI 入口与管线模式编排
│   ├── tui/                   # 交互式 React/Ink 配置器
│   │   ├── components/        # TUI 屏幕组件与菜单
│   │   ├── App.tsx            # TUI 根组件与状态路由
│   │   ├── index.tsx          # TUI 入口导出
│   │   └── claude-status.ts   # Claude Code 状态行状态加载
│   ├── types/                 # Zod schema 与 TypeScript 类型
│   ├── utils/                 # 工具、适配器、渲染引擎
│   └── widgets/               # 所有状态栏 widget 实现
│       └── shared/            # widget 共享辅助函数与编辑器
├── scripts/                   # 构建脚本与示例载荷
├── patches/                   # 依赖补丁（ink@6.2.0）
├── remotion/                  # 演示视频素材
├── docs/                      # 用户文档
├── screenshots/               # 截图与 demo 资源
├── dist/                      # 构建产物（生成，不提交）
├── package.json               # 项目元数据与脚本
├── tsconfig.json              # TypeScript 配置
├── eslint.config.js           # ESLint flat config
├── vitest.config.ts           # 测试配置
└── typedoc.json               # 文档生成配置
```

## 目录用途

**`src/`：**
- 用途：所有业务逻辑与 UI 代码。
- 包含：CLI/TUI 入口、widget、类型、工具。
- 关键文件：`src/ccstatusline.ts`、`src/tui/App.tsx`、`src/utils/renderer.ts`。

**`src/tui/`：**
- 用途：交互式终端用户界面。
- 包含：React/Ink 组件、输入处理器、预览组件。
- 关键文件：`src/tui/App.tsx`、`src/tui/components/StatusLinePreview.tsx`、`src/tui/components/ItemsEditor.tsx`。

**`src/types/`：**
- 用途：数据契约与 Zod schema。
- 包含：`Widget.ts`、`Settings.ts`、`StatusJSON.ts`、`RenderContext.ts` 等。
- 关键文件：`src/types/Widget.ts`、`src/types/Settings.ts`。

**`src/utils/`：**
- 用途：渲染引擎、配置、外部系统适配器。
- 包含：renderer、colors/ansi、config、git、jsonl、claude-settings、hooks、skills、usage、migrations 等。
- 关键文件：`src/utils/renderer.ts`、`src/utils/config.ts`、`src/utils/widgets.ts`、`src/utils/widget-manifest.ts`、`src/utils/git.ts`。

**`src/widgets/`：**
- 用途：每个 widget 的实现。
- 包含：一个文件对应一个 widget 类；`.tsx` 文件表示包含 React 编辑器。
- 关键文件：`src/widgets/Model.ts`、`src/widgets/GitBranch.ts`、`src/widgets/Skills.tsx`、`src/widgets/index.ts`。

**`src/widgets/shared/`：**
- 用途：widget 之间复用的辅助逻辑和小型编辑器组件。
- 包含：metadata 操作、max-width 编辑器、symbol 覆盖、git "no git" 行为、usage 显示等。
- 关键文件：`src/widgets/shared/metadata.ts`、`src/widgets/shared/editor-display.ts`、`src/widgets/shared/max-width.tsx`。

**`scripts/`：**
- 用途：构建时脚本与手动测试载荷。
- 包含：`scripts/replace-version.ts`（构建后替换版本占位符），`scripts/payload.example.json`。

**`patches/`：**
- 用途：运行时依赖补丁。
- 包含：`patches/ink@6.2.0.patch`（修复 macOS 退格键映射）。

**`remotion/`：**
- 用途：项目演示视频的 Remotion 源文件。
- 包含：`remotion/index.ts`、`remotion/root.tsx`、`remotion/tuiDemo.tsx`。

**`docs/`：**
- 用途：面向用户/开发者的 Markdown 文档。
- 包含：`docs/DEVELOPMENT.md`、`docs/USAGE.md`、`docs/WINDOWS.md`。

## 关键文件位置

**入口点：**
- `src/ccstatusline.ts`：主 CLI 入口，区分管线/TUI/`--hook` 模式。
- `src/tui/index.tsx`：TUI 入口，仅导出 `runTUI`。
- `dist/ccstatusline.js`：npm 发布产物（`bun run build` 生成）。

**配置：**
- `package.json`：脚本、依赖、bin 入口、patch 配置。
- `tsconfig.json`：ESNext + bundler mode + JSX react-jsx + Bun 类型。
- `eslint.config.js`：flat config，含 TypeScript/React 规则。
- `vitest.config.ts`：测试运行器配置。
- `typedoc.json`：API 文档生成配置。

**核心逻辑：**
- `src/utils/renderer.ts`：核心渲染管线（预渲染、powerline、flex、截断）。
- `src/utils/ansi.ts`：ANSI 转义、可见宽度、截断、渐变。
- `src/utils/colors.ts`：颜色映射、powerline 主题、颜色代码解析。
- `src/utils/config.ts`：用户 `settings.json` 读写、迁移、原子写入。
- `src/utils/claude-settings.ts`：Claude Code `settings.json` 集成、安装/卸载、刷新间隔。
- `src/utils/hooks.ts`：将 widget 所需 hook 同步到 Claude Code 配置。
- `src/utils/widgets.ts`：widget 注册表与目录过滤。
- `src/utils/widget-manifest.ts`：widget 类型与工厂清单。

**测试：**
- `vitest.config.ts`：测试入口。
- 测试文件与源码同目录，放在 `__tests__/` 子目录中：
  - `src/utils/__tests__/`
  - `src/widgets/__tests__/`
  - `src/types/__tests__/`
  - `src/tui/__tests__/`
  - `src/tui/components/__tests__/`
  - `src/tui/components/color-menu/__tests__/`
  - `src/tui/components/items-editor/__tests__/`
  - `src/widgets/shared/__tests__/`

## 命名约定

**文件：**
- Widget 实现：PascalCase，与导出的类名一致，例如 `GitBranch.ts`、`ContextLength.ts`。
- 工具/辅助函数：camelCase，例如 `jsonl-metrics.ts`、`claude-settings.ts`。
- 包含 JSX 的组件：`.tsx`，例如 `App.tsx`、`CustomCommand.tsx`、`Skills.tsx`。
- 纯类型/逻辑：`.ts`，例如 `Widget.ts`、`renderer.ts`。

**目录：**
- 全小写；多词用连字符，例如 `color-menu`、`items-editor`。

**导出：**
- Widget 类名以 `Widget` 结尾，例如 `GitBranchWidget`、`ModelWidget`。
- 类型/接口使用 PascalCase，例如 `RenderContext`、`Settings`、`WidgetItem`。
- Barrel files 使用 `index.ts` 聚合模块导出（`src/widgets/index.ts`、`src/tui/components/index.ts`）。

**Zod schemas：**
- 推断类型使用 `export type X = z.infer<typeof XSchema>`，例如 `src/types/Settings.ts:91`。

## 新增代码位置

**新增 Widget：**
- 实现：`src/widgets/<WidgetName>.ts`（如需 React 编辑器则用 `.tsx`）。
- 聚合导出：`src/widgets/index.ts`。
- 注册：`src/utils/widget-manifest.ts`。
- 测试：`src/widgets/__tests__/<widgetName>.test.ts`。

**新增 Widget 共享辅助：**
- 逻辑：`src/widgets/shared/<helperName>.ts`。
- React 编辑器片段：`src/widgets/shared/<editorName>.tsx`。
- 测试：`src/widgets/shared/__tests__/<helperName>.test.ts`。

**新增 TUI 屏幕：**
- 组件：`src/tui/components/<ScreenName>.tsx`。
- 聚合导出：`src/tui/components/index.ts`。
- 路由/状态/类型接线：`src/tui/App.tsx`。
- 测试：`src/tui/components/__tests__/<ScreenName>.test.tsx`。

**新增 Settings 字段：**
- Schema 与默认值：`src/types/Settings.ts`。
- 迁移（如为破坏性变更）：`src/utils/migrations.ts`。
- 持久化接线：`src/utils/config.ts`（通常自动通过 schema）。
- TUI 编辑器（如面向用户）：在对应菜单组件中处理。

**新增外部数据适配器：**
- 适配器：`src/utils/<adapterName>.ts`。
- 指标类型：`src/types/RenderContext.ts`。
- 数据填充：`renderMultipleLines()`（`src/ccstatusline.ts:98`）和/或 TUI 预览 context（`src/tui/components/StatusLinePreview.tsx:68`）。
- 消费：通过 `context` 在 widget `render()` 中使用。

**新增测试：**
- 与受测代码并置于 `__tests__/` 目录。
- 单文件运行：`bun test src/path/to/file.test.ts`。
- 全部运行：`bun test`。

## 特殊目录

**`dist/`：**
- 用途：`bun run build` 产出的 Node.js 14+ bundle。
- 生成：是。
- 提交：否（在 `.gitignore` 中）。

**`patches/`：**
- 用途：运行时依赖补丁。
- 生成：否。
- 提交：是。

**`remotion/`：**
- 用途：项目宣传/演示视频源文件。
- 生成：否。
- 提交：是。

**`out/`：**
- 用途：Remotion 渲染输出目录。
- 生成：是。
- 提交：否（通常被 `.gitignore` 忽略；若不存在则会在渲染时创建）。

---

*结构分析：2026-07-02*
