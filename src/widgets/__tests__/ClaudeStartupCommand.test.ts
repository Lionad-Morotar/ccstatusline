import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it
} from 'vitest';

import type {
    RenderContext,
    WidgetItem
} from '../../types';
import { DEFAULT_SETTINGS } from '../../types/Settings';
import { ClaudeStartupCommandWidget } from '../ClaudeStartupCommand';

const ORIGINAL_ENV = process.env.CC_CLAUDE_STARTUP_COMMAND;

function render(options: {
    rawValue?: boolean;
    isPreview?: boolean;
    envValue?: string;
} = {}): string | null {
    const {
        rawValue = false,
        isPreview = false,
        envValue
    } = options;

    if (envValue === undefined) {
        delete process.env.CC_CLAUDE_STARTUP_COMMAND;
    } else {
        process.env.CC_CLAUDE_STARTUP_COMMAND = envValue;
    }

    const widget = new ClaudeStartupCommandWidget();
    const context: RenderContext = { isPreview };
    const item: WidgetItem = {
        id: 'claude-startup-command',
        type: 'claude-startup-command',
        rawValue
    };

    return widget.render(item, context, DEFAULT_SETTINGS);
}

describe('ClaudeStartupCommandWidget', () => {
    beforeEach(() => {
        delete process.env.CC_CLAUDE_STARTUP_COMMAND;
    });

    afterEach(() => {
        if (ORIGINAL_ENV === undefined) {
            delete process.env.CC_CLAUDE_STARTUP_COMMAND;
        } else {
            process.env.CC_CLAUDE_STARTUP_COMMAND = ORIGINAL_ENV;
        }
    });

    it('renders the startup command with a prefix by default', () => {
        expect(render({ envValue: 'ck' })).toBe('Launch: ck');
    });

    it('renders only the command name when rawValue is enabled', () => {
        expect(render({ rawValue: true, envValue: 'cg' })).toBe('cg');
    });

    it('returns null when the environment variable is not set', () => {
        expect(render()).toBeNull();
    });

    it('returns null when the environment variable is empty', () => {
        expect(render({ envValue: '' })).toBeNull();
    });

    it('renders preview text in preview mode', () => {
        expect(render({ isPreview: true })).toBe('Launch: alias');
    });

    it('renders raw preview text in preview mode when rawValue is enabled', () => {
        expect(render({ isPreview: true, rawValue: true })).toBe('alias');
    });

    it('ignores the real env value in preview mode', () => {
        expect(render({ isPreview: true, envValue: 'should-not-appear' })).toBe('Launch: alias');
    });

    it('passes through special characters without transformation', () => {
        expect(render({ envValue: 'my cmd' })).toBe('Launch: my cmd');
    });
});
