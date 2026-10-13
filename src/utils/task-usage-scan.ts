import * as fs from 'fs';
import os from 'node:os';
import path from 'node:path';

import type { TokenTotals } from '../types';

import { parseUsageTokens } from './context-window';
import { collectAgentIds } from './jsonl-agent-ids';
import {
    iterateJsonlLines,
    parseJsonlLine
} from './jsonl-lines';

/**
 * Token usage of one API response.
 *
 * @remarks
 * `key` identifies the response (`message.id` plus `requestId`) so repeated
 * copies collapse to one; it is null when the record carries no message id,
 * in which case the entry always counts on its own.
 */
export interface UsageEntry {
    key: string | null;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
}

/** Where a flow-agent `run-external-review` launch records its sessions. */
export interface FlowAgentLaunch {
    /** Literal `--slug`, naming the run folder that holds `review-*.session`. */
    slug: string | null;
    /** Absolute `--review-dir`, which holds the runner's `runner-result*.json`. */
    reviewDir: string | null;
}

/** A flow-agent launch found in a tool call, with the time it was issued. */
export interface FlowAgentInvocation extends FlowAgentLaunch { timestampMs: number | null }

/** Everything the task-usage graph needs from one transcript file. */
export interface TranscriptUsageScan {
    usageEntries: UsageEntry[];
    agentIds: string[];
    flowAgentInvocations: FlowAgentInvocation[];
    firstTimestampMs: number | null;
}

export interface TranscriptUsageCollector {
    keyedEntries: Map<string, UsageEntry>;
    anonymousEntries: UsageEntry[];
    agentIds: Set<string>;
    flowAgentInvocations: FlowAgentInvocation[];
    firstTimestampMs: number | null;
    /** Latest compaction still waiting for the summary it produced. */
    pendingCompaction: UsageEntry | null;
}

const RUNNER_PATTERN = /run-external-review(?:\.[cm]?[jt]s)?\b/g;
// A runner invocation ends at the next unescaped newline or shell separator,
// so a `--slug` belonging to a later command is never attributed to it.
const COMMAND_END_PATTERN = /(?<!\\)\n|;|&&|\|/;
const SLUG_ARGUMENT_PATTERN = /--slug(?:=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))/;
const REVIEW_DIR_ARGUMENT_PATTERN = /--review-dir(?:=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))/;
const VALID_SLUG_PATTERN = /^[\w.-]+$/;
const PWD_PREFIX_PATTERN = /^\$(?:PWD|\{PWD\})(?=[/\\]|$)/;

interface ShellArgument {
    value: string;
    singleQuoted: boolean;
    unquoted: boolean;
}

function readShellArgument(pattern: RegExp, invocation: string): ShellArgument | null {
    const match = pattern.exec(invocation);
    if (!match) {
        return null;
    }
    const value = match[1] ?? match[2] ?? match[3];
    if (value === undefined || value === '') {
        return null;
    }
    return { value, singleQuoted: match[2] !== undefined, unquoted: match[3] !== undefined };
}

// Mirrors what the shell would have passed: `$PWD` is the command's working
// directory unless single-quoted, `~` expands only unquoted, and anything else
// that still needs the shell to expand cannot be resolved afterwards.
function resolveReviewDir(argument: ShellArgument, cwd: string | null): string | null {
    let value = argument.value;
    const pwdPrefix = argument.singleQuoted ? null : PWD_PREFIX_PATTERN.exec(value);
    if (pwdPrefix) {
        if (cwd === null) {
            return null;
        }
        value = cwd + value.slice(pwdPrefix[0].length);
    } else if (argument.unquoted && (value === '~' || value.startsWith('~/'))) {
        value = path.join(os.homedir(), value.slice(1));
    }
    if (/[$`]/.test(value)) {
        return null;
    }
    if (path.isAbsolute(value)) {
        return path.normalize(value);
    }
    return cwd === null ? null : path.resolve(cwd, value);
}

/**
 * Returns every flow-agent runner launch in a shell command.
 *
 * @remarks
 * Arguments that only the shell could expand (variables other than `$PWD`,
 * substitutions) are dropped; a launch with neither a usable slug nor a usable
 * review folder is skipped.
 *
 * @param cwd - Working directory the command ran in, for `$PWD` and relative paths
 */
export function extractFlowAgentLaunches(command: string, cwd: string | null = null): FlowAgentLaunch[] {
    const launches: FlowAgentLaunch[] = [];
    for (const match of command.matchAll(RUNNER_PATTERN)) {
        const rest = command.slice(match.index + match[0].length);
        const end = COMMAND_END_PATTERN.exec(rest);
        const invocation = end ? rest.slice(0, end.index) : rest;

        const slugArgument = readShellArgument(SLUG_ARGUMENT_PATTERN, invocation);
        const slug = slugArgument && VALID_SLUG_PATTERN.test(slugArgument.value) ? slugArgument.value : null;
        const reviewDirArgument = readShellArgument(REVIEW_DIR_ARGUMENT_PATTERN, invocation);
        const reviewDir = reviewDirArgument ? resolveReviewDir(reviewDirArgument, cwd) : null;
        if (slug !== null || reviewDir !== null) {
            launches.push({ slug, reviewDir });
        }
    }
    return launches;
}

/**
 * Identifies the API response a usage record belongs to.
 *
 * @remarks
 * Claude Code writes each content block of a response as its own line, every
 * one repeating the response's full usage, so usage must be summed per
 * response rather than per line. Null when the record carries no message id.
 */
export function getResponseUsageKey(messageId: unknown, requestId: unknown): string | null {
    if (typeof messageId !== 'string' || messageId === '') {
        return null;
    }
    return `${messageId}\u0000${typeof requestId === 'string' ? requestId : ''}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function getToolCommands(message: Record<string, unknown>): string[] {
    const content = message.content;
    if (!Array.isArray(content)) {
        return [];
    }

    const commands: string[] = [];
    for (const block of content) {
        const record = asRecord(block);
        if (record?.type !== 'tool_use') {
            continue;
        }
        const command = asRecord(record.input)?.command;
        if (typeof command === 'string') {
            commands.push(command);
        }
    }
    return commands;
}

function parseTimestampMs(value: unknown): number | null {
    if (typeof value !== 'string') {
        return null;
    }
    const timestampMs = Date.parse(value);
    return Number.isNaN(timestampMs) ? null : timestampMs;
}

export function createTranscriptUsageCollector(): TranscriptUsageCollector {
    return {
        keyedEntries: new Map(),
        anonymousEntries: [],
        agentIds: new Set(),
        flowAgentInvocations: [],
        firstTimestampMs: null,
        pendingCompaction: null
    };
}

const CJK_CHARACTER_PATTERN = /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g;

/** Rough token count of model-written text: one per CJK character, one per four other characters. */
export function estimateTextTokens(text: string): number {
    const cjkCount = text.match(CJK_CHARACTER_PATTERN)?.length ?? 0;
    return cjkCount + Math.ceil((text.length - cjkCount) / 4);
}

function getMessageText(content: unknown): string {
    if (typeof content === 'string') {
        return content;
    }
    if (!Array.isArray(content)) {
        return '';
    }
    return content
        .map(block => asRecord(block)?.text)
        .filter((text): text is string => typeof text === 'string')
        .join('');
}

function addEntry(collector: TranscriptUsageCollector, entry: UsageEntry): void {
    if (entry.key === null) {
        collector.anonymousEntries.push(entry);
    } else {
        // Later copies of a streamed response carry the settled counts.
        collector.keyedEntries.set(entry.key, entry);
    }
}

// Claude Code writes no usage for the request that summarises the context, so
// it is reconstructed: the boundary records the context size sent in, and the
// summary that follows it is the request's output.
function collectCompaction(collector: TranscriptUsageCollector, record: Record<string, unknown>): boolean {
    if (record.type === 'system' && record.subtype === 'compact_boundary') {
        const preTokens = asRecord(record.compactMetadata)?.preTokens;
        if (typeof preTokens !== 'number' || !Number.isFinite(preTokens) || preTokens <= 0) {
            collector.pendingCompaction = null;
            return true;
        }
        const entry: UsageEntry = {
            key: typeof record.uuid === 'string' && record.uuid !== '' ? `compact\u0000${record.uuid}` : null,
            inputTokens: preTokens,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0
        };
        addEntry(collector, entry);
        collector.pendingCompaction = entry;
        return true;
    }

    if (record.isCompactSummary === true) {
        if (collector.pendingCompaction) {
            collector.pendingCompaction.outputTokens = estimateTextTokens(getMessageText(asRecord(record.message)?.content));
            collector.pendingCompaction = null;
        }
        return true;
    }

    return false;
}

export function collectTranscriptUsageRecord(collector: TranscriptUsageCollector, data: unknown): void {
    const record = asRecord(data);
    if (!record) {
        return;
    }

    const timestampMs = parseTimestampMs(record.timestamp);
    collector.firstTimestampMs ??= timestampMs;
    collectAgentIds(record, collector.agentIds);

    if (collectCompaction(collector, record)) {
        return;
    }

    const message = asRecord(record.message);
    if (!message) {
        return;
    }

    if (record.type === 'assistant') {
        const cwd = typeof record.cwd === 'string' && record.cwd !== '' ? record.cwd : null;
        for (const command of getToolCommands(message)) {
            for (const launch of extractFlowAgentLaunches(command, cwd)) {
                collector.flowAgentInvocations.push({ ...launch, timestampMs });
            }
        }
    }

    const usage = asRecord(message.usage);
    if (!usage) {
        return;
    }

    const tokens = parseUsageTokens(usage);
    const entry: UsageEntry = {
        key: getResponseUsageKey(message.id, record.requestId),
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        cacheReadTokens: tokens.read,
        cacheCreationTokens: tokens.creation
    };
    addEntry(collector, entry);
}

export function finishTranscriptUsageCollector(collector: TranscriptUsageCollector): TranscriptUsageScan {
    return {
        // Copies, because a summary arriving after this scan still fills in
        // its compaction's output on the collector's own entry.
        usageEntries: [...collector.keyedEntries.values(), ...collector.anonymousEntries].map(entry => ({ ...entry })),
        agentIds: Array.from(collector.agentIds),
        flowAgentInvocations: collector.flowAgentInvocations.slice(),
        firstTimestampMs: collector.firstTimestampMs
    };
}

export interface TranscriptUsageRead {
    scan: TranscriptUsageScan;
    /** False when the file was missing or reading stopped on an error. */
    complete: boolean;
}

/**
 * Streams one transcript into a {@link TranscriptUsageScan}, reporting
 * whether the whole file was read.
 *
 * @remarks
 * A missing file yields an empty scan; a read error mid-file keeps whatever
 * was collected before it, so a partially readable transcript still counts.
 */
export async function readTranscriptUsage(filePath: string): Promise<TranscriptUsageRead> {
    const collector = createTranscriptUsageCollector();
    if (!fs.existsSync(filePath)) {
        return { scan: finishTranscriptUsageCollector(collector), complete: false };
    }

    let complete = true;
    try {
        for await (const line of iterateJsonlLines(filePath)) {
            collectTranscriptUsageRecord(collector, parseJsonlLine(line));
        }
    } catch {
        complete = false;
    }

    return { scan: finishTranscriptUsageCollector(collector), complete };
}

/** {@link readTranscriptUsage} without the completeness flag. */
export async function scanTranscriptUsage(filePath: string): Promise<TranscriptUsageScan> {
    return (await readTranscriptUsage(filePath)).scan;
}

export function createEmptyTokenTotals(): TokenTotals {
    return {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 0
    };
}

export function addUsageEntry(totals: TokenTotals, entry: UsageEntry): void {
    totals.inputTokens += entry.inputTokens;
    totals.outputTokens += entry.outputTokens;
    totals.cacheReadTokens += entry.cacheReadTokens;
    totals.cacheCreationTokens += entry.cacheCreationTokens;
    totals.totalTokens += entry.inputTokens + entry.outputTokens + entry.cacheReadTokens + entry.cacheCreationTokens;
}

export function sumUsageEntries(entries: UsageEntry[]): TokenTotals {
    const totals = createEmptyTokenTotals();
    for (const entry of entries) {
        addUsageEntry(totals, entry);
    }
    return totals;
}
