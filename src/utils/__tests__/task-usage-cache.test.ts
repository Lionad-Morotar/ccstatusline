import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import {
    getCachedTaskUsageMetrics,
    getTaskUsageCacheDir,
    getTaskUsageCachePath,
    openTaskUsageCache
} from '../task-usage-cache';

let root = '';
let projectDir = '';
let mainPath = '';

function writeJsonl(filePath: string, lines: unknown[]): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, lines.map(line => JSON.stringify(line)).join('\n'));
}

function usageLine(id: string, total: number, timestamp = '2026-10-12T10:00:00.000Z'): Record<string, unknown> {
    return {
        type: 'assistant',
        timestamp,
        requestId: `req_${id}`,
        message: {
            id,
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'ok' }],
            usage: { input_tokens: total, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
        }
    };
}

function runnerCall(id: string, slug: string): Record<string, unknown> {
    return {
        type: 'assistant',
        timestamp: '2026-10-12T10:00:00.000Z',
        requestId: `req_${id}`,
        message: {
            id,
            stop_reason: 'tool_use',
            content: [{
                type: 'tool_use',
                id: `call_${id}`,
                name: 'Bash',
                input: { command: `node run-external-review.ts --slug ${slug}` }
            }],
            usage: { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
        }
    };
}

function readCacheFile(): { files: Record<string, unknown>; locations: Record<string, string> } {
    return JSON.parse(fs.readFileSync(getTaskUsageCachePath(mainPath), 'utf-8')) as {
        files: Record<string, unknown>;
        locations: Record<string, string>;
    };
}

function setMtime(filePath: string, seconds: number): void {
    fs.utimesSync(filePath, seconds, seconds);
}

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-usage-cache-'));
    vi.spyOn(os, 'homedir').mockReturnValue(path.join(root, 'home'));
    projectDir = path.join(root, 'projects', '-Users-me-repo');
    mainPath = path.join(projectDir, 'main-session.jsonl');
});

afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
});

describe('openTaskUsageCache', () => {
    it('stores the cache under ~/.cache/ccstatusline/task-usage', () => {
        expect(getTaskUsageCachePath(mainPath).startsWith(
            path.join(root, 'home', '.cache', 'ccstatusline', 'task-usage') + path.sep
        )).toBe(true);
    });

    it('reuses a scan while the file keeps its size and mtime', async () => {
        const filePath = path.join(projectDir, 'sub.jsonl');
        writeJsonl(filePath, [usageLine('a', 10)]);
        setMtime(filePath, 1_700_000_000);

        const first = openTaskUsageCache(mainPath);
        expect((await first.options.scanFile(filePath)).usageEntries).toHaveLength(1);
        first.save();

        // Same size and mtime with different content: only a cache hit returns the old scan.
        writeJsonl(filePath, [usageLine('b', 20)]);
        setMtime(filePath, 1_700_000_000);

        const second = openTaskUsageCache(mainPath);
        const scan = await second.options.scanFile(filePath);
        expect(scan.usageEntries.map(entry => entry.key)).toEqual(['a\u0000req_a']);
    });

    it('rescans a file whose size or mtime changed', async () => {
        const filePath = path.join(projectDir, 'sub.jsonl');
        writeJsonl(filePath, [usageLine('a', 10)]);
        setMtime(filePath, 1_700_000_000);
        const first = openTaskUsageCache(mainPath);
        await first.options.scanFile(filePath);
        first.save();

        writeJsonl(filePath, [usageLine('a', 10), usageLine('b', 20)]);
        setMtime(filePath, 1_700_000_100);

        const second = openTaskUsageCache(mainPath);
        const scan = await second.options.scanFile(filePath);
        expect(scan.usageEntries).toHaveLength(2);
    });

    it('round-trips every scan field through the cache', async () => {
        const filePath = path.join(projectDir, 'sub.jsonl');
        writeJsonl(filePath, [
            { type: 'user', timestamp: '2026-10-12T09:00:00.000Z', toolUseResult: { agentId: 'child' } },
            runnerCall('r1', 'my-slug'),
            { type: 'assistant', message: { usage: { input_tokens: 3, output_tokens: 4 } } }
        ]);
        const first = openTaskUsageCache(mainPath);
        const fresh = await first.options.scanFile(filePath);
        first.save();

        const second = openTaskUsageCache(mainPath);
        const cached = await second.options.scanFile(filePath);
        expect(cached).toEqual(fresh);
        expect(cached.agentIds).toEqual(['child']);
        expect(cached.flowAgentInvocations).toEqual([{ slug: 'my-slug', timestampMs: Date.parse('2026-10-12T10:00:00.000Z') }]);
    });

    it('drops entries for files the latest run did not visit', async () => {
        const kept = path.join(projectDir, 'kept.jsonl');
        const dropped = path.join(projectDir, 'dropped.jsonl');
        writeJsonl(kept, [usageLine('a', 10)]);
        writeJsonl(dropped, [usageLine('b', 10)]);

        const first = openTaskUsageCache(mainPath);
        await first.options.scanFile(kept);
        await first.options.scanFile(dropped);
        first.save();
        expect(Object.keys(readCacheFile().files).sort()).toEqual([dropped, kept].sort());

        const second = openTaskUsageCache(mainPath);
        await second.options.scanFile(kept);
        second.save();
        expect(Object.keys(readCacheFile().files)).toEqual([kept]);
    });

    it('remembers located sessions and searches again once the file is gone', () => {
        const located = path.join(projectDir, 'ext.jsonl');
        writeJsonl(located, [usageLine('e', 1)]);
        const search = vi.fn(() => located);

        const first = openTaskUsageCache(mainPath);
        expect(first.options.locateSessionTranscript('ext', search)).toBe(located);
        first.save();
        expect(readCacheFile().locations).toEqual({ ext: located });

        const second = openTaskUsageCache(mainPath);
        expect(second.options.locateSessionTranscript('ext', search)).toBe(located);
        expect(search).toHaveBeenCalledTimes(1);

        fs.rmSync(located);
        const missing = vi.fn(() => null);
        const third = openTaskUsageCache(mainPath);
        expect(third.options.locateSessionTranscript('ext', missing)).toBeNull();
        expect(missing).toHaveBeenCalledTimes(1);
    });

    it('ignores a corrupt or outdated cache file', async () => {
        const filePath = path.join(projectDir, 'sub.jsonl');
        writeJsonl(filePath, [usageLine('a', 10)]);
        const stat = fs.statSync(filePath);
        const cachePath = getTaskUsageCachePath(mainPath);
        fs.mkdirSync(path.dirname(cachePath), { recursive: true });

        for (const content of [
            'not json',
            JSON.stringify({ version: 0, files: {}, locations: {} }),
            JSON.stringify({
                version: 1,
                files: { [filePath]: { size: stat.size, mtimeMs: stat.mtimeMs, scan: { entries: [['x', 99, 0, 0, 0]], agentIds: [], invocations: [], firstTimestampMs: null } } },
                locations: {}
            }),
            JSON.stringify({
                version: 2,
                files: { [filePath]: { size: stat.size, mtimeMs: stat.mtimeMs, scan: { entries: [['x', 'NaN', 0, 0, 0]], agentIds: [], invocations: [], firstTimestampMs: null } } },
                locations: {}
            })
        ]) {
            fs.writeFileSync(cachePath, content);
            const cache = openTaskUsageCache(mainPath);
            const scan = await cache.options.scanFile(filePath);
            expect(scan.usageEntries.map(entry => entry.inputTokens)).toEqual([10]);
        }
    });

    it('scans a missing file without caching it', async () => {
        const cache = openTaskUsageCache(mainPath);
        const scan = await cache.options.scanFile(path.join(projectDir, 'missing.jsonl'));
        expect(scan.usageEntries).toEqual([]);
        cache.save();
        expect(fs.existsSync(getTaskUsageCachePath(mainPath))).toBe(false);
    });

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('does not store a scan that stopped on a read error', async () => {
        const filePath = path.join(projectDir, 'sub.jsonl');
        writeJsonl(filePath, [usageLine('a', 10)]);
        fs.chmodSync(filePath, 0o000);
        try {
            const first = openTaskUsageCache(mainPath);
            expect((await first.options.scanFile(filePath)).usageEntries).toEqual([]);
            first.save();
        } finally {
            fs.chmodSync(filePath, 0o600);
        }

        const second = openTaskUsageCache(mainPath);
        expect((await second.options.scanFile(filePath)).usageEntries).toHaveLength(1);
    });

    it('keeps a session id such as __proto__ as an ordinary cache key', () => {
        const located = path.join(projectDir, '__proto__.jsonl');
        writeJsonl(located, [usageLine('e', 1)]);
        const search = vi.fn(() => located);

        const first = openTaskUsageCache(mainPath);
        expect(first.options.locateSessionTranscript('__proto__', search)).toBe(located);
        first.save();

        const second = openTaskUsageCache(mainPath);
        expect(second.options.locateSessionTranscript('__proto__', search)).toBe(located);
        expect(search).toHaveBeenCalledTimes(1);
    });

    it('writes through one stable temp file and removes it when the write fails', async () => {
        const filePath = path.join(projectDir, 'sub.jsonl');
        writeJsonl(filePath, [usageLine('a', 10)]);
        const cachePath = getTaskUsageCachePath(mainPath);
        const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
            throw new Error('EPERM');
        });

        const cache = openTaskUsageCache(mainPath);
        await cache.options.scanFile(filePath);
        cache.save();

        expect(rename).toHaveBeenCalledWith(`${cachePath}.tmp`, cachePath);
        expect(fs.readdirSync(path.dirname(cachePath))).toEqual([]);
    });

    it('removes cache and temp files of sessions idle for over two weeks', async () => {
        const cacheDir = getTaskUsageCacheDir();
        fs.mkdirSync(cacheDir, { recursive: true });
        const stale = path.join(cacheDir, 'stale.json');
        const staleTemp = path.join(cacheDir, 'stale.json.tmp');
        const recent = path.join(cacheDir, 'recent.json');
        const unrelated = path.join(cacheDir, 'notes.txt');
        const nowSeconds = Date.now() / 1000;
        for (const [file, ageDays] of [[stale, 15], [staleTemp, 15], [recent, 13], [unrelated, 30]] as const) {
            fs.writeFileSync(file, '{}');
            setMtime(file, nowSeconds - ageDays * 24 * 60 * 60);
        }

        const filePath = path.join(projectDir, 'sub.jsonl');
        writeJsonl(filePath, [usageLine('a', 10)]);
        const cache = openTaskUsageCache(mainPath);
        await cache.options.scanFile(filePath);
        cache.save();

        expect(fs.existsSync(stale)).toBe(false);
        expect(fs.existsSync(staleTemp)).toBe(false);
        expect(fs.existsSync(recent)).toBe(true);
        expect(fs.existsSync(unrelated)).toBe(true);
    });
});

describe('getCachedTaskUsageMetrics', () => {
    it('matches the uncached totals and serves the second run from cache', async () => {
        const flowDevHome = path.join(root, '.flow-dev');
        const externalDir = path.join(root, 'projects', '-Users-me-repo--claude-worktrees-wt');
        writeJsonl(mainPath, [usageLine('m1', 100), runnerCall('r1', 'slug-a')]);
        writeJsonl(path.join(projectDir, 'main-session', 'subagents', 'agent-s1.jsonl'), [usageLine('s1', 20)]);
        writeJsonl(path.join(externalDir, 'ext-1.jsonl'), [usageLine('e1', 7)]);
        fs.mkdirSync(path.join(flowDevHome, 'runs', 'slug-a'), { recursive: true });
        fs.writeFileSync(path.join(flowDevHome, 'runs', 'slug-a', 'review-x.session'), 'ext-1\n');

        const first = await getCachedTaskUsageMetrics(mainPath, undefined, { flowDevHome });
        expect(first.main.totalTokens).toBe(101);
        expect(first.subagents.totalTokens).toBe(20);
        expect(first.external.totalTokens).toBe(7);
        expect(readCacheFile().locations).toEqual({ 'ext-1': path.join(externalDir, 'ext-1.jsonl') });

        const readdir = vi.spyOn(fs, 'readdirSync');
        const second = await getCachedTaskUsageMetrics(mainPath, undefined, { flowDevHome });
        expect(second).toEqual(first);
        const projectsRoot = path.join(root, 'projects');
        expect(readdir).toHaveBeenCalled();
        expect(readdir.mock.calls.some(call => call[0] === projectsRoot)).toBe(false);
    });
});
