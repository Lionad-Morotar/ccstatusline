import type {
    RenderContext,
    TaskUsageMetrics,
    TokenTotals
} from '../types';
import type { Settings } from '../types/Settings';
import type {
    CustomKeybind,
    HideableState,
    Widget,
    WidgetEditorDisplay,
    WidgetItem
} from '../types/Widget';
import { resolveNumberFormat } from '../utils/number-format';
import { formatTokens } from '../utils/renderer';

import { makeModifierText } from './shared/editor-display';
import { isHidden } from './shared/hideable';
import {
    isMetadataFlagEnabled,
    toggleMetadataFlag
} from './shared/metadata';
import { formatRawOrLabeledValue } from './shared/raw-or-labeled';

const ZERO_HIDEABLE_STATE: HideableState = { key: 'zero', label: 'when token count is zero' };
const BREAKDOWN_KEY = 'breakdown';
const TOGGLE_BREAKDOWN_ACTION = 'toggle-breakdown';

function previewTotals(totalTokens: number): TokenTotals {
    return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens };
}

const PREVIEW_METRICS: TaskUsageMetrics = {
    total: previewTotals(2_150_000),
    main: previewTotals(1_200_000),
    subagents: previewTotals(450_000),
    external: previewTotals(500_000),
    subagentTranscriptCount: 3,
    externalSessionCount: 2
};

function isBreakdownEnabled(item: WidgetItem): boolean {
    return isMetadataFlagEnabled(item, BREAKDOWN_KEY);
}

export class TaskTokensTotalWidget implements Widget {
    getDefaultColor(): string { return 'cyan'; }
    getDescription(): string {
        return 'Shows total tokens for the whole task: the main session, its subagents, and external review sessions launched through flow-agent';
    }

    getDisplayName(): string { return 'Task Tokens Total'; }
    getCategory(): string { return 'Tokens'; }
    getEditorDisplay(item: WidgetItem): WidgetEditorDisplay {
        return {
            displayText: this.getDisplayName(),
            modifierText: makeModifierText(isBreakdownEnabled(item) ? ['breakdown'] : [])
        };
    }

    getHideableStates(): HideableState[] {
        return [ZERO_HIDEABLE_STATE];
    }

    getCustomKeybinds(): CustomKeybind[] {
        return [{ key: 'b', label: '(b)reakdown', action: TOGGLE_BREAKDOWN_ACTION }];
    }

    handleEditorAction(action: string, item: WidgetItem): WidgetItem | null {
        if (action === TOGGLE_BREAKDOWN_ACTION) {
            return toggleMetadataFlag(item, BREAKDOWN_KEY);
        }
        return null;
    }

    render(item: WidgetItem, context: RenderContext, settings: Settings): string | null {
        const metrics = context.isPreview ? PREVIEW_METRICS : context.taskUsageMetrics;
        if (!metrics) {
            return null;
        }
        if (metrics.total.totalTokens === 0 && isHidden(item, ZERO_HIDEABLE_STATE.key)) {
            return null;
        }

        const format = resolveNumberFormat('token', item, settings);
        let value = formatTokens(metrics.total.totalTokens, format);
        if (isBreakdownEnabled(item)) {
            const parts = [
                `main ${formatTokens(metrics.main.totalTokens, format)}`,
                `sub ${formatTokens(metrics.subagents.totalTokens, format)}`,
                `ext ${formatTokens(metrics.external.totalTokens, format)}`
            ];
            value = `${value} (${parts.join(' · ')})`;
        }
        return formatRawOrLabeledValue(item, 'Task: ', value);
    }

    supportsRawValue(): boolean { return true; }
    supportsColors(item: WidgetItem): boolean { return true; }
    supportsNumberFormat(): boolean { return true; }
}
