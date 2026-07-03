import type { RenderContext } from '../types/RenderContext';
import type { Settings } from '../types/Settings';
import type {
    Widget,
    WidgetEditorDisplay,
    WidgetItem
} from '../types/Widget';

/**
 * Displays the shell command/alias used to launch the current Claude Code
 * session. The value is supplied by the caller via the
 * CC_CLAUDE_STARTUP_COMMAND environment variable.
 *
 * Note: this widget relies on Claude Code invoking ccstatusline as a child
 * process that inherits the parent environment. If Claude Code ever changes
 * how status-line hooks are executed (e.g. isolated renderer process or IPC
 * instead of fork+exec), this widget will silently return null and should be
 * migrated to read the value from `context.data` if/when that field exists.
 */
export class ClaudeStartupCommandWidget implements Widget {
    getDefaultColor(): string { return 'cyan'; }
    getDescription(): string {
        return 'Shows the command alias used to start this Claude Code session (inherited by child sessions)';
    }

    getDisplayName(): string { return 'Claude Startup Command'; }
    getCategory(): string { return 'Session'; }

    getEditorDisplay(item: WidgetItem): WidgetEditorDisplay {
        return { displayText: this.getDisplayName() };
    }

    render(item: WidgetItem, context: RenderContext, settings: Settings): string | null {
        if (context.isPreview) {
            return item.rawValue ? 'alias' : 'Launch: alias';
        }

        const command = process.env.CC_CLAUDE_STARTUP_COMMAND;
        if (!command) {
            return null;
        }

        return item.rawValue ? command : `Launch: ${command}`;
    }

    supportsRawValue(): boolean { return true; }
    supportsColors(item: WidgetItem): boolean { return true; }
}
