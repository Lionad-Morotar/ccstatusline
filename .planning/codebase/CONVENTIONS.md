# 编码规范

**分析日期：** 2026-07-02

## 命名约定

**文件：**

- Widget 类位于 `src/widgets/`，采用 PascalCase 命名并带 `Widget` 后缀，例如 `GitBranch.ts`。
- TUI 组件位于 `src/tui/components/`，采用 PascalCase 命名，例如 `ColorMenu.tsx`。
- 工具模块位于 `src/utils/`，采用 camelCase 命名，例如 `renderer.ts`、`context-percentage.ts`。
- 测试文件与源码同目录放在 `__tests__` 中，命名为 `*.test.ts` 或 `*.test.tsx`，例如 `src/utils/__tests__/model-context.test.ts`。

**类：**

- Widget 实现类需实现 `Widget` 接口，并以 `Widget` 结尾，例如 `src/widgets/GitBranch.ts` 中的 `GitBranchWidget`。

**函数与方法：**

- 函数、方法和局部变量使用 camelCase。
- 布尔型辅助函数通常以 `is`、`has` 或 `supports` 开头，例如 `isKnownWidgetType`、`hasSessionDurationInStatusJson`、`supportsRawValue`。

**变量与常量：**

- 局部常量使用 camelCase。
- 导出的命令字符串和哨兵值使用 SCREAMING_SNAKE_CASE，例如 `src/utils/claude-settings.ts` 中的 `CCSTATUSLINE_COMMANDS.NPM` 和 `src/utils/renderer.ts` 中的 `FLEX_SENTINEL`。

**类型：**

- 类型名、接口和枚举使用 PascalCase，例如 `WidgetItem`、`RenderContext`、`Settings`。
- 简单别名使用 `type`，需要被实现或扩展的对象形状使用 `interface`，例如 `src/types/Widget.ts`。

## 代码风格

**格式化：**

- 未配置 Prettier。格式化由 ESLint 配合 Stylistic 插件强制执行。
- `eslint.config.js` 配置包括：单引号、要求分号、4 空格缩进、1tbs 大括号风格并允许单行、无尾随逗号、操作符前置换行、每行最多两条语句，以及 `eol-last`。
- JSX 通过 `@stylistic/jsx-quotes` 使用单引号。

**Lint：**

- 运行 `bun run lint` 进行类型检查并执行 lint，要求零警告。
- 仅在明确需要 ESLint 自动修复时运行 `bun run lint:fix`。
- 禁止使用行内注释禁用 lint 规则。本项目明确禁止 `// eslint-disable` 风格的注释。
- `eslint.config.js` 采用 flat 配置，扩展了 `@eslint/js/recommended`、`typescript-eslint/strictTypeChecked`、`typescript-eslint/stylisticTypeChecked`、`import-x/recommended` 以及自定义的 Stylistic 配置。

**TypeScript：**

- `tsconfig.json` 启用了 `strict`、`verbatimModuleSyntax`、`noUncheckedIndexedAccess`、`noImplicitOverride`、`noFallthroughCasesInSwitch`，并采用 bundler 模块解析策略以及 `allowImportingTsExtensions`。
- 避免显式使用 `any`；对于 catch 绑定值和已解析数据优先使用 `unknown`。

## 导入组织

**顺序：**

ESLint 的 `import-x/order` 强制按以下分组，组间留空行：

1. 内置模块和外部模块。
2. 内部模块。
3. 父级相对导入。
4. 同级相对导入。
5. 索引（`./index`）导入。
6. 未知类型。

每组内部，命名导入按字母顺序排列，类型导入放在最后。

**路径别名：**

- 未配置路径别名。导入使用相对路径或包名。

**类型导入：**

- 仅类型导入使用 `import type { ... } from '...'`。
- 当模块同时导出值和类型时，在同一个 import 中使用行内 `type`，例如：

```typescript
import {
    filterFuzzySearchRecords,
    type FuzzySearchRecord
} from './fuzzy';
```

这是 `@typescript-eslint/consistent-type-imports` 的要求。

## 错误处理

**模式：**

- 使用 Zod schema 进行运行时校验。对于可恢复的校验失败优先使用 `safeParse`，并将错误报告到 `console.error`，而不是直接崩溃。
- 对于 I/O 错误，先通过一个小的辅助函数检查错误码，再决定是否恢复。示例来自 `src/utils/config.ts`：

```typescript
function getErrorCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : undefined;
}
```

- 恢复路径返回合理的默认值并保留用户文件。`src/utils/config.ts` 中的 `loadSettings` 在 `settings.json` 无法读取或无效时返回内存中的默认值，且不会覆盖原始文件。
- CLI 解析失败时先打印诊断信息，再调用 `process.exit(1)`，例如 `src/ccstatusline.ts` 中的 `--config requires a file path argument`。
- Widget 的可选输出用 `string | null` 表示，其中 `null` 表示“不渲染任何内容”，而不是抛出异常。
- 故意吞掉错误的 catch 块使用最简形式 `catch { /* ... */ }`，并附带注释说明为何静默处理是安全的。

## 日志

**框架：** `console`

**模式：**

- `console.error` 用于诊断、警告和可恢复的失败。
- `console.log` 保留给实际的程序输出，例如渲染后的状态栏。
- 没有结构化日志或日志级别抽象。

## 注释

**何时注释：**

- 注释解释意图、权衡和非显而易见的顺序约束。不要重复代码做了什么。
- 示例来自 `src/utils/renderer.ts`：

```typescript
// Apply a foreground gradient across the whole line if configured. This runs
// AFTER truncation, not before: truncateStyledText cuts from the right and
// appends a raw "..." with no trailing reset, so a gradient applied earlier
// would have its closing \x1b[39m sliced off — leaking the last color past the
// line.
```

**避免事项：**

- 不要添加 TODO、FIXME、HACK、XXX 或 issue ID、阶段标签等外部追踪标记。
- 不要写 changelog 风格的注释。

**JSDoc/TSDoc：**

- 对于导出函数且其合约非平凡时，使用 JSDoc 块注释，例如 `src/utils/config.ts` 中的 `loadSettings` 会说明恢复合约。
- 大多数内部辅助函数使用行内注释而非 JSDoc。

## 函数设计

**大小：**

- 偏好小型、聚焦的函数。项目指导意见是文件超过 300 行时考虑拆分；`src/utils/renderer.ts` 是一个已知例外，因为渲染管线本质上是顺序执行的。

**参数：**

- 传递数据对象而非长位置参数列表。Widget 的 `render` 方法接收 `(item, context, settings)`。

**返回值：**

- 在 widget 中返回 `null` 表示“没有内容可渲染”。
- 当调用方需要元数据时，返回包含结构化结果的对象，例如 `src/utils/renderer.ts` 中的 `RenderResult`。

**控制流：**

- 偏好提前返回，避免深层嵌套条件。
- 仅在 Stylistic 的 `allowSingleLine` 允许时使用无大括号的 `if`；否则始终使用大括号。

## 模块设计

**导出：**

- 使用命名导出。本代码库不使用默认导出。
- 通过桶文件重新导出公共成员：
  - `src/types/index.ts` 用于共享类型。
  - `src/widgets/index.ts` 用于 widget 类。
  - `src/tui/components/index.ts` 用于 TUI 组件。

**桶文件：**

- 保持桶文件显式；逐个列出导出项，而不是对 widget 使用通配符重新导出。
- 示例来自 `src/widgets/index.ts`：

```typescript
export { GitBranchWidget } from './GitBranch';
export { GitChangesWidget } from './GitChanges';
```

**状态：**

- 除配置缓存和仅初始化一次的注册表外，避免可变模块级状态，例如 `src/utils/widgets.ts` 中的 `widgetRegistry`。

---

*Convention analysis: 2026-07-02*
