import * as fs from 'fs';
import os from 'node:os';
import path from 'node:path';

import type {
    TaskUsageMetrics,
    TokenTotals
} from '../types';

import { listSubagentTranscripts } from './subagent-transcripts';
import {
    addUsageEntry,
    createEmptyTokenTotals,
    readFirstUserPrompt,
    scanTranscriptUsage,
    type FlowAgentInvocation,
    type TranscriptUsageScan,
    type WorkflowLaunch
} from './task-usage-scan';

type UsageCategory = 'main' | 'subagents' | 'external';

export interface TaskUsageOptions {
    /** Claude Code `projects` folder; defaults to the main transcript's grandparent. */
    projectsRoot?: string;
    /** flow-dev state root; defaults to `$FLOW_DEV_HOME`, then `~/.flow-dev`. */
    flowDevHome?: string;
    /** Scanner for every transcript the caller did not already scan. */
    scanFile?: (filePath: string) => Promise<TranscriptUsageScan>;
    /**
     * Resolves an external session id to its transcript; `search` runs the
     * default lookup, so a cache can skip it for ids it has seen before.
     */
    locateSessionTranscript?: (sessionId: string, search: () => string | null) => string | null;
}

interface TranscriptNode {
    filePath: string;
    category: UsageCategory;
    /** Project folder the transcript's own runner calls most likely wrote to. */
    projectDir: string;
    scan?: TranscriptUsageScan;
}

interface InvocationWindow {
    startMs: number | null;
    endMs: number | null;
}

/** One place a runner records session ids, with the launches that point at it. */
interface SessionSource {
    readSessionIds: () => string[];
    window: InvocationWindow;
}

/** A flow-workflow worker, as recorded in its `worker-NNN.meta.json`. */
interface WorkflowWorker {
    cwd: string;
    reportPath: string;
}

// The runner probes launchers before the review session writes its first
// record, and a fallback chain can run several models back to back, so the
// accepted start window is generous on the late side.
const EXTERNAL_SESSION_LEAD_MS = 5 * 60 * 1000;
const EXTERNAL_SESSION_TRAIL_MS = 6 * 60 * 60 * 1000;
const SESSION_ID_PATTERN = /^[\w-]+$/;
const SESSION_FILE_PATTERN = /^review-.+\.session$/;
const RUNNER_RESULT_PATTERN = /^runner-result(?:-\d+)?\.json$/;
const WORKER_META_PATTERN = /^worker-\d+\.meta\.json$/;
export function getFlowDevHome(): string {
    return process.env.FLOW_DEV_HOME ?? path.join(os.homedir(), '.flow-dev');
}

function readDirNames(dirPath: string): string[] {
    try {
        return fs.readdirSync(dirPath).sort();
    } catch {
        return [];
    }
}

function readRunSessionIds(flowDevHome: string, slug: string): string[] {
    if (slug === '.' || slug === '..') {
        return [];
    }

    const runDir = path.join(flowDevHome, 'runs', slug);
    const sessionIds = new Set<string>();
    for (const name of readDirNames(runDir)) {
        if (!SESSION_FILE_PATTERN.test(name)) {
            continue;
        }
        let content: string;
        try {
            content = fs.readFileSync(path.join(runDir, name), 'utf-8');
        } catch {
            continue;
        }
        for (const line of content.split('\n')) {
            const sessionId = line.trim();
            if (SESSION_ID_PATTERN.test(sessionId)) {
                sessionIds.add(sessionId);
            }
        }
    }
    return Array.from(sessionIds);
}

// The runner overwrites `review-*.session` on every run of a slug, but numbers
// its result files instead, so this survives a slug reused for a later review.
function readRunnerResultSessionIds(reviewDir: string): string[] {
    const sessionIds = new Set<string>();
    for (const name of readDirNames(reviewDir)) {
        if (!RUNNER_RESULT_PATTERN.test(name)) {
            continue;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(fs.readFileSync(path.join(reviewDir, name), 'utf-8'));
        } catch {
            continue;
        }
        const reviews = (parsed as { reviews?: unknown } | null)?.reviews;
        if (!Array.isArray(reviews)) {
            continue;
        }
        for (const review of reviews) {
            const sessionId = (review as { session_id?: unknown } | null)?.session_id;
            if (typeof sessionId === 'string' && SESSION_ID_PATTERN.test(sessionId)) {
                sessionIds.add(sessionId);
            }
        }
    }
    return Array.from(sessionIds);
}

function locateSessionTranscript(projectsRoot: string, preferredDirs: string[], sessionId: string): string | null {
    const fileName = `${sessionId}.jsonl`;
    for (const dir of preferredDirs) {
        const candidate = path.join(dir, fileName);
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    // The runner records transcripts under its own working directory, which
    // differs from the caller's project folder when the call ran in a worktree.
    for (const name of readDirNames(projectsRoot)) {
        const candidate = path.join(projectsRoot, name, fileName);
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return null;
}

function collectSessionSources(invocations: FlowAgentInvocation[], flowDevHome: string): SessionSource[] {
    const sources = new Map<string, SessionSource>();
    const addLaunch = (key: string, readSessionIds: () => string[], timestampMs: number | null): void => {
        let source = sources.get(key);
        if (!source) {
            source = { readSessionIds, window: { startMs: null, endMs: null } };
            sources.set(key, source);
        }
        widenWindow(source.window, timestampMs);
    };

    for (const { slug, reviewDir, timestampMs } of invocations) {
        if (slug !== null) {
            addLaunch(`run\u0000${slug}`, () => readRunSessionIds(flowDevHome, slug), timestampMs);
        }
        if (reviewDir !== null) {
            addLaunch(`dir\u0000${reviewDir}`, () => readRunnerResultSessionIds(reviewDir), timestampMs);
        }
    }
    return Array.from(sources.values());
}

function widenWindow(window: InvocationWindow, timestampMs: number | null): void {
    if (timestampMs !== null) {
        window.startMs = window.startMs === null ? timestampMs : Math.min(window.startMs, timestampMs);
        window.endMs = window.endMs === null ? timestampMs : Math.max(window.endMs, timestampMs);
    }
}

function groupWorkflowWindows(launches: WorkflowLaunch[]): Map<string, InvocationWindow> {
    const windows = new Map<string, InvocationWindow>();
    for (const { runDir, timestampMs } of launches) {
        const window = windows.get(runDir) ?? { startMs: null, endMs: null };
        widenWindow(window, timestampMs);
        windows.set(runDir, window);
    }
    return windows;
}

/** Claude Code's `projects` folder name for a working directory. */
export function getProjectDirName(cwd: string): string {
    return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function readWorkflowWorkers(runDir: string): WorkflowWorker[] {
    const workers: WorkflowWorker[] = [];
    for (const name of readDirNames(runDir)) {
        if (!WORKER_META_PATTERN.test(name)) {
            continue;
        }
        let meta: { cwd?: unknown; reportPath?: unknown } | null;
        try {
            meta = JSON.parse(fs.readFileSync(path.join(runDir, name), 'utf-8')) as { cwd?: unknown; reportPath?: unknown } | null;
        } catch {
            continue;
        }
        if (typeof meta?.cwd === 'string' && path.isAbsolute(meta.cwd)
            && typeof meta.reportPath === 'string' && meta.reportPath !== '') {
            workers.push({ cwd: meta.cwd, reportPath: meta.reportPath });
        }
    }
    return workers;
}

// A worker records no session id, but it runs headless in its `cwd` with the
// derived prompt as its first message, and that prompt always names the
// worker's report file. Files untouched since before the launch window cannot
// be one of its sessions, which keeps the prompt reads to recent transcripts.
function findWorkerTranscripts(projectsRoot: string, worker: WorkflowWorker, window: InvocationWindow): string[] {
    const projectDir = path.join(projectsRoot, getProjectDirName(worker.cwd));
    const activeSinceMs = window.startMs === null ? null : window.startMs - EXTERNAL_SESSION_LEAD_MS;
    const matches: string[] = [];
    for (const name of readDirNames(projectDir)) {
        if (!name.endsWith('.jsonl')) {
            continue;
        }
        const filePath = path.join(projectDir, name);
        if (activeSinceMs !== null) {
            let mtimeMs: number;
            try {
                mtimeMs = fs.statSync(filePath).mtimeMs;
            } catch {
                continue;
            }
            if (mtimeMs < activeSinceMs) {
                continue;
            }
        }
        if (readFirstUserPrompt(filePath)?.includes(worker.reportPath)) {
            matches.push(filePath);
        }
    }
    return matches;
}

function startedWithinWindow(firstTimestampMs: number | null, window: InvocationWindow): boolean {
    if (firstTimestampMs === null || window.startMs === null || window.endMs === null) {
        return true;
    }
    return firstTimestampMs >= window.startMs - EXTERNAL_SESSION_LEAD_MS
        && firstTimestampMs <= window.endMs + EXTERNAL_SESSION_TRAIL_MS;
}

function resolveVisitKey(filePath: string): string {
    try {
        return fs.realpathSync(filePath);
    } catch {
        return path.resolve(filePath);
    }
}

/**
 * Sums token usage across the task rooted at a main transcript.
 *
 * @remarks
 * Walks the main session, every subagent transcript, every external review
 * session that a `run-external-review` call in any of those transcripts
 * recorded under `<flowDevHome>/runs/<slug>/review-*.session` or in
 * `<review-dir>/runner-result*.json`, and every flow-workflow worker session
 * dispatched into a `--run-dir` that a `derive-worker` call named.
 * Usage is de-duplicated across all files by API response, so a resumed
 * review that copies earlier history into a forked transcript adds nothing.
 * Compactions count as estimated requests, since none carries recorded usage.
 *
 * @param mainScan - Scan of the main transcript when the caller already has one
 */
export async function getTaskUsageMetrics(
    mainTranscriptPath: string,
    mainScan?: TranscriptUsageScan,
    options: TaskUsageOptions = {}
): Promise<TaskUsageMetrics> {
    const projectsRoot = options.projectsRoot ?? path.dirname(path.dirname(mainTranscriptPath));
    const flowDevHome = options.flowDevHome ?? getFlowDevHome();
    const scanFile = options.scanFile ?? scanTranscriptUsage;
    const locateSession = options.locateSessionTranscript ?? ((_sessionId: string, search: () => string | null) => search());

    const totals: Record<UsageCategory, TokenTotals> = {
        main: createEmptyTokenTotals(),
        subagents: createEmptyTokenTotals(),
        external: createEmptyTokenTotals()
    };
    const seenUsageKeys = new Set<string>();
    const visited = new Set<string>([resolveVisitKey(mainTranscriptPath)]);
    let subagentTranscriptCount = 0;
    let externalSessionCount = 0;

    const queue: TranscriptNode[] = [{
        filePath: mainTranscriptPath,
        category: 'main',
        projectDir: path.dirname(mainTranscriptPath),
        scan: mainScan
    }];

    for (let node = queue.shift(); node; node = queue.shift()) {
        const scan = node.scan ?? await scanFile(node.filePath);

        for (const entry of scan.usageEntries) {
            if (entry.key !== null) {
                if (seenUsageKeys.has(entry.key)) {
                    continue;
                }
                seenUsageKeys.add(entry.key);
            }
            addUsageEntry(totals[node.category], entry);
        }

        const subagentPaths = listSubagentTranscripts(node.filePath, new Set(scan.agentIds), { includeUnreferenced: true });
        for (const subagentPath of subagentPaths) {
            const visitKey = resolveVisitKey(subagentPath);
            if (visited.has(visitKey)) {
                continue;
            }
            visited.add(visitKey);
            if (node.category !== 'external') {
                subagentTranscriptCount += 1;
            }
            queue.push({
                filePath: subagentPath,
                category: node.category === 'external' ? 'external' : 'subagents',
                projectDir: node.projectDir
            });
        }

        const addExternalSession = async (externalPath: string, window: InvocationWindow): Promise<void> => {
            const visitKey = resolveVisitKey(externalPath);
            if (visited.has(visitKey)) {
                return;
            }
            const externalScan = await scanFile(externalPath);
            if (!startedWithinWindow(externalScan.firstTimestampMs, window)) {
                return;
            }
            visited.add(visitKey);
            externalSessionCount += 1;
            queue.push({
                filePath: externalPath,
                category: 'external',
                projectDir: path.dirname(externalPath),
                scan: externalScan
            });
        };

        for (const { readSessionIds, window } of collectSessionSources(scan.flowAgentInvocations, flowDevHome)) {
            for (const sessionId of readSessionIds()) {
                const preferredDir = node.projectDir;
                const externalPath = locateSession(
                    sessionId,
                    () => locateSessionTranscript(projectsRoot, [preferredDir], sessionId)
                );
                if (externalPath) {
                    await addExternalSession(externalPath, window);
                }
            }
        }

        for (const [runDir, window] of groupWorkflowWindows(scan.workflowLaunches)) {
            for (const worker of readWorkflowWorkers(runDir)) {
                for (const workerPath of findWorkerTranscripts(projectsRoot, worker, window)) {
                    await addExternalSession(workerPath, window);
                }
            }
        }
    }

    const total = createEmptyTokenTotals();
    for (const part of Object.values(totals)) {
        total.inputTokens += part.inputTokens;
        total.outputTokens += part.outputTokens;
        total.cacheReadTokens += part.cacheReadTokens;
        total.cacheCreationTokens += part.cacheCreationTokens;
        total.totalTokens += part.totalTokens;
    }

    return {
        total,
        main: totals.main,
        subagents: totals.subagents,
        external: totals.external,
        subagentTranscriptCount,
        externalSessionCount
    };
}
