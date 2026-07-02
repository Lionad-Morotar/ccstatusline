# 测试模式

**分析日期：** 2026-07-02

## 测试框架

**运行器：**

- Vitest 4（`vitest` `^4.0.18`），通过 Bun 执行。
- 配置：`vitest.config.ts`

```typescript
/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['src/**/*.test.ts', 'src/**/*.test.tsx'] } });
```

**断言库：**

- 直接使用 Vitest 内置的 `expect` API。

**运行命令：**

```bash
bun test              # 一次性运行所有测试
bun test --watch      # 以 watch 模式运行测试
bun run lint          # 运行 TypeScript 类型检查 + ESLint（CI 门禁）
bun run lint:fix      # 在明确需要时应用 ESLint 自动修复
```

`.github/workflows/ci.yml` 中的 CI 流程在构建步骤之前运行 `bun run lint` 和 `bun test`。

## 测试文件组织

**位置：**

- 测试与被测代码放在一起，位于 `__tests__` 目录中。
- 示例：
  - `src/utils/__tests__/model-context.test.ts`
  - `src/widgets/__tests__/GitBranch.test.ts`
  - `src/tui/components/__tests__/ColorMenu.test.tsx`
  - `src/widgets/shared/__tests__/usage-display.test.ts`

**命名：**

- 测试文件名与源文件名一致，在扩展名前插入 `.test`：
  - `model-context.ts` → `model-context.test.ts`
  - `ColorMenu.tsx` → `ColorMenu.test.tsx`

**结构：**

```
src/
├── utils/
│   ├── __tests__/
│   │   └── model-context.test.ts
│   └── model-context.ts
├── widgets/
│   ├── __tests__/
│   │   └── GitBranch.test.ts
│   └── GitBranch.ts
└── tui/
    └── components/
        ├── __tests__/
        │   └── ColorMenu.test.tsx
        └── ColorMenu.tsx
```

## 测试结构

**套件组织：**

- 顶层 `describe` 命名被测对象。
- 嵌套 `describe` 对相关行为分组，例如输入变体或边界情况。
- `it` 描述单一预期。
- 参数化用例使用 `it.each`。

示例来自 `src/utils/__tests__/model-context.test.ts`：

```typescript
describe('getContextConfig', () => {
    describe('Status JSON context window size override', () => {
        it('should use context_window_size as max tokens when provided', () => {
            const config = getContextConfig('claude-3-5-sonnet-20241022', 1000000);

            expect(config.maxTokens).toBe(1000000);
            expect(config.usableTokens).toBe(800000);
        });
    });

    describe('Models with [1m] suffix', () => {
        it('should return 1M context window for claude-sonnet-4-5 with [1m] suffix', () => {
            const config = getContextConfig('claude-sonnet-4-5-20250929[1m]');

            expect(config.maxTokens).toBe(1000000);
            expect(config.usableTokens).toBe(800000);
        });
    });
});
```

**Setup 与 Teardown：**

- 使用 `beforeEach` 重置 mock 和临时状态。
- 使用 `afterEach` 恢复 spy 并清理环境变量。
- 当整个套件只需动态导入一次模块时使用 `beforeAll`，例如 `src/utils/__tests__/config.test.ts` 在 `beforeAll` 中导入 `../config`，以便观察到全新的模块状态。

示例来自 `src/widgets/__tests__/GitBranch.test.ts`：

```typescript
describe('GitBranchWidget', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearGitCache();
    });
});
```

## Mock

**框架：** Vitest 内置 mock（`vi.fn`、`vi.mock`、`vi.spyOn`）。

**模块 Mock：**

- 在测试文件顶部使用 `vi.mock` 替换整个文件中需要被替换的模块。
- 示例来自 `src/widgets/__tests__/GitBranch.test.ts`：

```typescript
vi.mock('child_process', () => ({
    execSync: vi.fn(),
    execFileSync: vi.fn(),
    spawnSync: vi.fn()
}));
```

**类型化的 Mock 句柄：**

- 将被 mock 的导入断言为具体类型，以便 `mockReturnValue` 和 `mock.calls` 可被推断。
- 示例来自 `src/widgets/__tests__/GitBranch.test.ts`：

```typescript
const mockExecFileSync = execFileSync as unknown as {
    mock: { calls: unknown[][] };
    mockImplementation: (impl: () => never) => void;
    mockReturnValue: (value: string) => void;
    mockReturnValueOnce: (value: string) => void;
};
```

**Spy：**

- 使用 `vi.spyOn` 进行一次性函数 mock 或环境属性 mock。
- 示例来自 `src/utils/__tests__/claude-settings.test.ts`：

```typescript
vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
vi.spyOn(config, 'getConfigPath').mockReturnValue('/tmp/settings.json');
```

**Mock 清理：**

- 优先在 `afterEach` 中使用 `vi.restoreAllMocks()`，以便 spy 自动恢复。
- 当需要重置调用历史但不清除实现时，在 `beforeEach` 中使用 `vi.clearAllMocks()`。

**应该 Mock 的内容：**

- 外部进程调用（`child_process`）。
- 在测试高层行为时共享的格式化辅助函数，例如 `src/widgets/__tests__/TokensWidgets.test.ts` 中的 `vi.spyOn(renderer, 'formatTokens').mockImplementation(...)`。
- 在断言诊断输出已发出的测试中 mock `console.error`。

**不应该 Mock 的内容：**

- 文件系统操作在真实临时目录上执行，而不是 mock `fs`。
- Widget 类直接实例化，而不是 mock 注册表。

## Fixtures 与 Factories

**测试数据：**

- 大多数测试输入使用内联对象字面量。
- 辅助函数构建常见的 context 和 item，例如 `src/widgets/__tests__/GitBranch.test.ts` 中的 `render` 和 `src/widgets/__tests__/helpers/usage-widget-suites.ts` 中的 `getUsageContext`。

**共享测试套件：**

- 可复用的行为被封装在导出的套件运行器中。
- 示例来自 `src/widgets/__tests__/helpers/usage-widget-suites.ts`：

```typescript
export function runUsagePercentWidgetSuite<TWidget extends UsageWidgetLike>(config: UsagePercentWidgetSuiteConfig<TWidget>): void {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('exposes widget-managed keybinds for time and bar modes', () => {
        const widget = config.createWidget();
        expect(widget.supportsRawValue()).toBe(true);
        // ...
    });

    it.each([/* ... */])('$name', ({ expected, item }) => {
        const widget = config.createWidget();
        const context = getUsageContext(config.usageField, config.usageValue);
        expect(config.render(widget, item, context)).toBe(expected);
    });
}
```

**测试辅助：**

- `src/utils/__tests__/git-test-helpers.ts` 提供 `expectGitExecOptions`，用于断言传给 git 子进程的 options 对象。

## 覆盖率

**要求：**

- `vitest.config.ts` 和 package scripts 中均未强制覆盖率阈值。

**查看覆盖率：**

- 未配置。如需生成覆盖率，请在 Vitest 命令中添加 `--coverage`，并在需要时安装 `@vitest/coverage-v8`。

## 测试类型

**单元测试：**

- 绝大多数测试都是单元测试，覆盖纯函数、widget 渲染、工具模块和 TUI 辅助逻辑。
- Widget 测试直接构造 widget 类，调用 `render`，并比较返回的字符串。

**集成测试：**

- 设置/配置测试在临时目录上执行真实文件 I/O，例如 `src/utils/__tests__/config.test.ts` 和 `src/utils/__tests__/claude-settings.test.ts`。

**E2E 测试：**

- 未使用。

## React / Ink 组件测试

- Ink 组件使用 `ink` 中的 `render()` 在 mock 的 TTY 流上渲染。
- 示例模式来自 `src/tui/components/__tests__/ColorMenu.test.tsx`：

```typescript
class MockTtyStream extends PassThrough {
    isTTY = true;
    columns = 160;
    rows = 40;

    setRawMode() { return this; }
    ref() { return this; }
    unref() { return this; }
}

function createMockStdout(): CapturedWriteStream {
    const stream = new MockTtyStream();
    const chunks: string[] = [];
    stream.on('data', (chunk: Buffer | string) => {
        chunks.push(chunk.toString());
    });
    return Object.assign(stream as unknown as NodeJS.WriteStream, {
        getOutput() { return chunks.join(''); }
    });
}

function flushInk() {
    return new Promise((resolve) => { setTimeout(resolve, 25); });
}
```

- 测试通过向 mock 的 stdin 写入 ANSI 序列来驱动输入，使用 `flushInk` 刷新，并断言捕获的 stdout 帧。

## 常见模式

**测试中的异步导入：**

- 某些测试动态导入被测模块，以避免模块级副作用和 hoisting 问题。
- 示例来自 `src/widgets/__tests__/TokensWidgets.test.ts`：

```typescript
async function loadWidgets() {
    const [{ TokensInputWidget }, { TokensOutputWidget }, { TokensCachedWidget }, { TokensTotalWidget }] = await Promise.all([
        import('../TokensInput'),
        import('../TokensOutput'),
        import('../TokensCached'),
        import('../TokensTotal')
    ]);
    return { TokensCachedWidget, TokensInputWidget, TokensOutputWidget, TokensTotalWidget };
}
```

**环境变量：**

- 在测试用例中设置环境变量，并在 `afterEach` 中清理。
- 示例来自 `src/utils/__tests__/model-context.test.ts`：

```typescript
describe('CCSTATUSLINE_CONTEXT_SIZE_FALLBACK override', () => {
    afterEach(() => {
        delete process.env.CCSTATUSLINE_CONTEXT_SIZE_FALLBACK;
    });

    it('uses the env value as the fallback when no window size is otherwise known', () => {
        process.env.CCSTATUSLINE_CONTEXT_SIZE_FALLBACK = '1000000';
        const config = getContextConfig('claude-sonnet-4-5-20250929');
        expect(config.maxTokens).toBe(1000000);
    });
});
```

**错误测试：**

- 对于异步失败使用 `await expect(...).rejects.toThrow()`。
- 示例来自 `src/utils/__tests__/config.test.ts`：

```typescript
await expect(saveSettings({ ...DEFAULT_SETTINGS })).rejects.toThrow();
```

**参数化用例：**

- 使用 `it.each` 编写紧凑的矩阵测试。
- 示例来自 `src/widgets/__tests__/GitBranch.test.ts`：

```typescript
it.each([
    { name: 'truncates the branch with an ellipsis', maxWidth: 10, expected: 'feature...' },
    { name: 'leaves the branch untouched when it fits', maxWidth: 100, expected: 'feature/worktree' }
])('$name', ({ maxWidth, expected }) => {
    mockExecFileSync.mockReturnValueOnce('true\n');
    mockExecFileSync.mockReturnValueOnce('feature/worktree');
    expect(render({ rawValue: true, maxWidth })).toBe(expected);
});
```

---

*Testing analysis: 2026-07-02*
