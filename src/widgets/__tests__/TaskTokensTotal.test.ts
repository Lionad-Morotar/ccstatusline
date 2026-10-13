import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import type {
    RenderContext,
    TaskUsageMetrics,
    TokenTotals
} from '../../types';
import { DEFAULT_SETTINGS } from '../../types/Settings';
import type { WidgetItem } from '../../types/Widget';
import * as renderer from '../../utils/renderer';
import { TaskTokensTotalWidget } from '../TaskTokensTotal';

function totals(totalTokens: number): TokenTotals {
    return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens };
}

function metrics(main: number, subagents: number, external: number): TaskUsageMetrics {
    return {
        total: totals(main + subagents + external),
        main: totals(main),
        subagents: totals(subagents),
        external: totals(external),
        subagentTranscriptCount: 1,
        externalSessionCount: 1
    };
}

const item: WidgetItem = { id: 'task', type: 'task-tokens-total' };
const widget = new TaskTokensTotalWidget();

describe('TaskTokensTotalWidget', () => {
    beforeEach(() => {
        vi.spyOn(renderer, 'formatTokens').mockImplementation((value: number) => `fmt:${value}`);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('renders the task total with a label', () => {
        const context: RenderContext = { taskUsageMetrics: metrics(100, 20, 3) };
        expect(widget.render(item, context, DEFAULT_SETTINGS)).toBe('Task: fmt:123');
    });

    it('renders only the value in raw mode', () => {
        const context: RenderContext = { taskUsageMetrics: metrics(100, 20, 3) };
        expect(widget.render({ ...item, rawValue: true }, context, DEFAULT_SETTINGS)).toBe('fmt:123');
    });

    it('appends the main, subagent, and external split when breakdown is on', () => {
        const context: RenderContext = { taskUsageMetrics: metrics(100, 20, 3) };
        const breakdown = { ...item, metadata: { breakdown: 'true' } };
        expect(widget.render(breakdown, context, DEFAULT_SETTINGS)).toBe('Task: fmt:123 (main fmt:100 · sub fmt:20 · ext fmt:3)');
    });

    it('renders nothing without task metrics', () => {
        expect(widget.render(item, {}, DEFAULT_SETTINGS)).toBeNull();
        expect(widget.render(item, { taskUsageMetrics: null }, DEFAULT_SETTINGS)).toBeNull();
    });

    it('hides a zero total only when asked to', () => {
        const context: RenderContext = { taskUsageMetrics: metrics(0, 0, 0) };
        expect(widget.render(item, context, DEFAULT_SETTINGS)).toBe('Task: fmt:0');
        expect(widget.render({ ...item, metadata: { hide: 'zero' } }, context, DEFAULT_SETTINGS)).toBeNull();
    });

    it('renders sample values in preview', () => {
        expect(widget.render(item, { isPreview: true }, DEFAULT_SETTINGS)).toBe('Task: fmt:2150000');
    });

    it('toggles the breakdown flag through its keybind and shows it in the editor', () => {
        const [keybind] = widget.getCustomKeybinds();
        expect(keybind?.key).toBe('b');

        const toggled = widget.handleEditorAction(keybind?.action ?? '', item);
        expect(toggled?.metadata).toEqual({ breakdown: 'true' });
        expect(widget.getEditorDisplay(toggled ?? item).modifierText).toBe('(breakdown)');
        expect(widget.getEditorDisplay(item).modifierText).toBeUndefined();
        expect(widget.handleEditorAction('unknown', item)).toBeNull();
    });
});
