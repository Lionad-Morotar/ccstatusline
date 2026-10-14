import * as fs from 'fs';
import { createHash } from 'node:crypto';
import * as os from 'os';
import * as path from 'path';

import type { TaskUsageMetrics } from '../types';

import {
    getTaskUsageMetrics,
    type TaskUsageOptions
} from './task-usage';
import {
    readTranscriptUsage,
    scanTranscriptUsage,
    type FlowAgentInvocation,
    type TranscriptUsageScan,
    type UsageEntry,
    type WorkflowLaunch
} from './task-usage-scan';

const CACHE_VERSION = 4;
// Cache files belong to one main transcript each; once that session has been
// idle this long nobody repaints it, so the file is only taking disk space.
const STALE_CACHE_FILE_MS = 14 * 24 * 60 * 60 * 1000;

type StoredUsageEntry = [string | null, number, number, number, number];
type StoredInvocation = [string | null, string | null, number | null];
type StoredWorkflowLaunch = [string, number | null];

interface StoredScan {
    entries: StoredUsageEntry[];
    agentIds: string[];
    invocations: StoredInvocation[];
    workflowLaunches: StoredWorkflowLaunch[];
    firstTimestampMs: number | null;
}

interface StoredFile {
    size: number;
    mtimeMs: number;
    scan: StoredScan;
}

interface StoredCache {
    version: number;
    files: Record<string, StoredFile>;
    locations: Record<string, string>;
}

export interface TaskUsageCache {
    /** Hooks to pass to {@link getTaskUsageMetrics}. */
    options: Required<Pick<TaskUsageOptions, 'scanFile' | 'locateSessionTranscript'>>;
    /** Persists what this run used and drops everything it did not. */
    save: () => void;
}

export function getTaskUsageCacheDir(): string {
    return path.join(os.homedir(), '.cache', 'ccstatusline', 'task-usage');
}

export function getTaskUsageCachePath(mainTranscriptPath: string): string {
    const hash = createHash('sha256')
        .update(path.resolve(mainTranscriptPath))
        .digest('hex')
        .slice(0, 16);
    return path.join(getTaskUsageCacheDir(), `${hash}.json`);
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isStoredUsageEntry(value: unknown): value is StoredUsageEntry {
    return Array.isArray(value)
        && value.length === 5
        && (value[0] === null || typeof value[0] === 'string')
        && value.slice(1).every(isFiniteNumber);
}

function isStoredInvocation(value: unknown): value is StoredInvocation {
    return Array.isArray(value)
        && value.length === 3
        && (value[0] === null || typeof value[0] === 'string')
        && (value[1] === null || typeof value[1] === 'string')
        && (value[2] === null || isFiniteNumber(value[2]));
}

function isStoredWorkflowLaunch(value: unknown): value is StoredWorkflowLaunch {
    return Array.isArray(value)
        && value.length === 2
        && typeof value[0] === 'string'
        && (value[1] === null || isFiniteNumber(value[1]));
}

function isStoredFile(value: unknown): value is StoredFile {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const file = value as Partial<StoredFile>;
    const scan = file.scan as Partial<StoredScan> | undefined;
    return isFiniteNumber(file.size)
        && isFiniteNumber(file.mtimeMs)
        && !!scan
        && Array.isArray(scan.entries) && scan.entries.every(isStoredUsageEntry)
        && Array.isArray(scan.agentIds) && scan.agentIds.every(id => typeof id === 'string')
        && Array.isArray(scan.invocations) && scan.invocations.every(isStoredInvocation)
        && Array.isArray(scan.workflowLaunches) && scan.workflowLaunches.every(isStoredWorkflowLaunch)
        && (scan.firstTimestampMs === null || isFiniteNumber(scan.firstTimestampMs));
}

// Keys come from transcript paths and session ids found on disk; a
// prototype-less record keeps an id such as `__proto__` an ordinary key.
function createEmptyCache(): StoredCache {
    return {
        version: CACHE_VERSION,
        files: Object.create(null) as Record<string, StoredFile>,
        locations: Object.create(null) as Record<string, string>
    };
}

function readStoredCache(cachePath: string): StoredCache {
    const empty = createEmptyCache();
    let parsed: unknown;
    try {
        parsed = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    } catch {
        return empty;
    }
    if (!parsed || typeof parsed !== 'object') {
        return empty;
    }
    const stored = parsed as Partial<StoredCache>;
    if (stored.version !== CACHE_VERSION) {
        return empty;
    }

    const cache = empty;
    if (stored.files && typeof stored.files === 'object') {
        for (const [filePath, file] of Object.entries(stored.files)) {
            if (isStoredFile(file)) {
                cache.files[filePath] = file;
            }
        }
    }
    if (stored.locations && typeof stored.locations === 'object') {
        for (const [sessionId, filePath] of Object.entries(stored.locations)) {
            if (typeof filePath === 'string') {
                cache.locations[sessionId] = filePath;
            }
        }
    }
    return cache;
}

function toStoredScan(scan: TranscriptUsageScan): StoredScan {
    return {
        entries: scan.usageEntries.map(entry => [
            entry.key,
            entry.inputTokens,
            entry.outputTokens,
            entry.cacheReadTokens,
            entry.cacheCreationTokens
        ]),
        agentIds: scan.agentIds,
        invocations: scan.flowAgentInvocations.map(invocation => [invocation.slug, invocation.reviewDir, invocation.timestampMs]),
        workflowLaunches: scan.workflowLaunches.map(launch => [launch.runDir, launch.timestampMs]),
        firstTimestampMs: scan.firstTimestampMs
    };
}

function fromStoredScan(stored: StoredScan): TranscriptUsageScan {
    return {
        usageEntries: stored.entries.map((entry): UsageEntry => ({
            key: entry[0],
            inputTokens: entry[1],
            outputTokens: entry[2],
            cacheReadTokens: entry[3],
            cacheCreationTokens: entry[4]
        })),
        agentIds: stored.agentIds.slice(),
        flowAgentInvocations: stored.invocations.map((invocation): FlowAgentInvocation => ({
            slug: invocation[0],
            reviewDir: invocation[1],
            timestampMs: invocation[2]
        })),
        workflowLaunches: stored.workflowLaunches.map((launch): WorkflowLaunch => ({
            runDir: launch[0],
            timestampMs: launch[1]
        })),
        firstTimestampMs: stored.firstTimestampMs
    };
}

function statFile(filePath: string): { size: number; mtimeMs: number } | null {
    try {
        const stat = fs.statSync(filePath);
        return stat.isFile() ? { size: stat.size, mtimeMs: stat.mtimeMs } : null;
    } catch {
        return null;
    }
}

function removeStaleCacheFiles(cacheDir: string, keepPath: string, nowMs: number): void {
    let names: string[];
    try {
        names = fs.readdirSync(cacheDir);
    } catch {
        return;
    }
    for (const name of names) {
        const filePath = path.join(cacheDir, name);
        if (filePath === keepPath || !(name.endsWith('.json') || name.endsWith('.json.tmp'))) {
            continue;
        }
        const stat = statFile(filePath);
        if (stat && nowMs - stat.mtimeMs > STALE_CACHE_FILE_MS) {
            try {
                fs.unlinkSync(filePath);
            } catch {
                // Another process may have removed it first.
            }
        }
    }
}

/**
 * Opens the per-transcript scan cache used by the task usage graph.
 *
 * @remarks
 * Each transcript scan is reused while the file keeps the same size and
 * modification time, so a repaint only rescans transcripts that grew. Located
 * external sessions are remembered by id because finding one may otherwise
 * probe every project folder.
 */
export function openTaskUsageCache(mainTranscriptPath: string): TaskUsageCache {
    const cachePath = getTaskUsageCachePath(mainTranscriptPath);
    const stored = readStoredCache(cachePath);
    const next = createEmptyCache();
    let changed = false;

    const scanFile = async (filePath: string): Promise<TranscriptUsageScan> => {
        const stat = statFile(filePath);
        if (!stat) {
            return scanTranscriptUsage(filePath);
        }

        const cached = stored.files[filePath];
        if (cached?.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
            next.files[filePath] = cached;
            return fromStoredScan(cached.scan);
        }

        // Stat before scanning: a file that grows mid-scan then mismatches on
        // the next run and is rescanned, rather than being trusted as complete.
        // A read that failed part-way is used once but never stored, or a
        // finished transcript would keep its truncated totals indefinitely.
        const { scan, complete } = await readTranscriptUsage(filePath);
        if (complete) {
            next.files[filePath] = { ...stat, scan: toStoredScan(scan) };
            changed = true;
        }
        return scan;
    };

    const locateSessionTranscript = (sessionId: string, search: () => string | null): string | null => {
        const cachedPath = stored.locations[sessionId];
        if (cachedPath && fs.existsSync(cachedPath)) {
            next.locations[sessionId] = cachedPath;
            return cachedPath;
        }
        const found = search();
        if (found) {
            next.locations[sessionId] = found;
            changed = true;
        }
        return found;
    };

    const save = (): void => {
        const pruned = Object.keys(stored.files).some(filePath => !(filePath in next.files))
            || Object.keys(stored.locations).some(sessionId => !(sessionId in next.locations));
        if (!changed && !pruned) {
            return;
        }
        // One stable temp name per cache file, as in git.ts: a handle held by
        // a virus scanner or sync client can fail both rename and unlink, and
        // a per-process name would then leak a file on every write.
        const cacheDir = path.dirname(cachePath);
        const tempPath = `${cachePath}.tmp`;
        try {
            fs.mkdirSync(cacheDir, { recursive: true });
            fs.writeFileSync(tempPath, JSON.stringify(next), 'utf-8');
            fs.renameSync(tempPath, cachePath);
        } catch {
            try {
                fs.unlinkSync(tempPath);
            } catch {
                // The next write truncates it.
            }
            return;
        }
        removeStaleCacheFiles(cacheDir, cachePath, Date.now());
    };

    return {
        options: { scanFile, locateSessionTranscript },
        save
    };
}

/**
 * {@link getTaskUsageMetrics} backed by the on-disk scan cache.
 *
 * @param mainScan - Scan of the main transcript when the caller already reads
 *   it; without one the main transcript goes through the cache like any other
 */
export async function getCachedTaskUsageMetrics(
    mainTranscriptPath: string,
    mainScan?: TranscriptUsageScan,
    options: Omit<TaskUsageOptions, 'scanFile' | 'locateSessionTranscript'> = {}
): Promise<TaskUsageMetrics> {
    const cache = openTaskUsageCache(mainTranscriptPath);
    const metrics = await getTaskUsageMetrics(mainTranscriptPath, mainScan, { ...options, ...cache.options });
    cache.save();
    return metrics;
}
