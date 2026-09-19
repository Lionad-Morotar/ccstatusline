import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { RenderContext } from '../types/RenderContext';
import type { Settings } from '../types/Settings';
import type {
    Widget,
    WidgetEditorDisplay,
    WidgetItem
} from '../types/Widget';

// 状态栏刷新频率远高于内存数据的参考变化速度：2s 跨进程缓存让高频刷新
// 免于每次 fork 一个 vm_stat 子进程。多会话并发写靠 temp+rename 保证原子性。
const MEM_CACHE_TTL_MS = 2000;

function getMemCachePath(): string {
    const cacheDir = process.env.CCSTATUSLINE_CACHE_DIR ?? path.join(os.homedir(), '.cache', 'ccstatusline');
    return path.join(cacheDir, 'mem-cache.json');
}

function readMemCache(): number | null {
    try {
        const raw = fs.readFileSync(getMemCachePath(), 'utf8');
        const entry = JSON.parse(raw) as { usedBytes?: unknown; createdAt?: unknown };
        if (typeof entry.usedBytes !== 'number' || typeof entry.createdAt !== 'number')
            return null;

        return Date.now() - entry.createdAt < MEM_CACHE_TTL_MS ? entry.usedBytes : null;
    } catch {
        return null;
    }
}

function writeMemCache(usedBytes: number): void {
    try {
        const cachePath = getMemCachePath();
        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        const tempPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tempPath, JSON.stringify({ usedBytes, createdAt: Date.now() }), 'utf8');
        fs.renameSync(tempPath, cachePath);
    } catch {
        // Best-effort cache; rendering must never fail because of it.
    }
}

function formatBytes(bytes: number): string {
    const GB = 1024 ** 3;
    const MB = 1024 ** 2;
    const KB = 1024;

    if (bytes >= GB)
        return `${(bytes / GB).toFixed(1)}G`;
    if (bytes >= MB)
        return `${(bytes / MB).toFixed(0)}M`;
    if (bytes >= KB)
        return `${(bytes / KB).toFixed(0)}K`;
    return `${bytes}B`;
}

// Get memory usage like htop does on macOS (Active + Wired)
function getUsedMemoryMacOS(): number | null {
    const cached = readMemCache();
    if (cached !== null)
        return cached;

    try {
        const output = execSync('vm_stat', { encoding: 'utf8', windowsHide: true });
        const lines = output.split('\n');

        // Parse page size from first line: "Mach Virtual Memory Statistics: (page size of 16384 bytes)"
        const firstLine = lines[0];
        if (!firstLine)
            return null;

        const pageSizeMatch = /page size of (\d+) bytes/.exec(firstLine);
        const pageSizeString = pageSizeMatch?.[1];
        if (!pageSizeString)
            return null;
        const pageSize = parseInt(pageSizeString, 10);

        // Parse page counts
        let activePages = 0;
        let wiredPages = 0;

        for (const line of lines) {
            const activeMatch = /Pages active:\s+(\d+)/.exec(line);
            const activeValue = activeMatch?.[1];
            if (activeValue)
                activePages = parseInt(activeValue, 10);
            const wiredMatch = /Pages wired down:\s+(\d+)/.exec(line);
            const wiredValue = wiredMatch?.[1];
            if (wiredValue)
                wiredPages = parseInt(wiredValue, 10);
        }

        const usedBytes = (activePages + wiredPages) * pageSize;
        writeMemCache(usedBytes);
        return usedBytes;
    } catch {
        return null;
    }
}

export class FreeMemoryWidget implements Widget {
    getDefaultColor(): string { return 'cyan'; }
    getDescription(): string { return 'Shows system memory usage (used/total)'; }
    getDisplayName(): string { return 'Memory Usage'; }
    getCategory(): string { return 'Environment'; }
    getEditorDisplay(item: WidgetItem): WidgetEditorDisplay {
        return { displayText: this.getDisplayName() };
    }

    render(item: WidgetItem, context: RenderContext, settings: Settings): string | null {
        if (context.isPreview) {
            return item.rawValue ? '12.4G/16.0G' : 'Mem: 12.4G/16.0G';
        }

        const total = os.totalmem();
        let used: number;

        if (os.platform() === 'darwin') {
            // Use htop-style calculation on macOS
            used = getUsedMemoryMacOS() ?? (total - os.freemem());
        } else {
            // Fallback for other platforms
            used = total - os.freemem();
        }

        const value = `${formatBytes(used)}/${formatBytes(total)}`;

        return item.rawValue ? value : `Mem: ${value}`;
    }

    supportsRawValue(): boolean { return true; }
    supportsColors(item: WidgetItem): boolean { return true; }
}
