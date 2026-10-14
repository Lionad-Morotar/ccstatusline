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

/**
 * A flow-workflow `derive-worker` call found in a tool call.
 *
 * @remarks
 * `runDir` holds one `worker-NNN.meta.json` per worker the run dispatched.
 */
export interface WorkflowLaunch {
    runDir: string;
    timestampMs: number | null;
}

/** Everything the task-usage graph needs from one transcript file. */
export interface TranscriptUsageScan {
    usageEntries: UsageEntry[];
    agentIds: string[];
    flowAgentInvocations: FlowAgentInvocation[];
    workflowLaunches: WorkflowLaunch[];
    firstTimestampMs: number | null;
}

export interface TranscriptUsageCollector {
    keyedEntries: Map<string, UsageEntry>;
    anonymousEntries: UsageEntry[];
    agentIds: Set<string>;
    flowAgentInvocations: FlowAgentInvocation[];
    workflowLaunches: WorkflowLaunch[];
    firstTimestampMs: number | null;
    /** Latest compaction still waiting for the summary it produced. */
    pendingCompaction: UsageEntry | null;
}

const RUNNER_PATTERN = /run-external-review(?:\.[cm]?[jt]s)?\b/g;
const WORKFLOW_WORKER_PATTERN = /derive-worker(?:\.[cm]?[jt]s)?\b/g;
// An invocation ends at the next unescaped newline or shell separator, so an
// argument belonging to a later command is never attributed to it.
const COMMAND_END_PATTERN = /(?<!\\)\n|;|&&|\|/;
const SLUG_ARGUMENT_PATTERN = /--slug(?:=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))/;
const REVIEW_DIR_ARGUMENT_PATTERN = /--review-dir(?:=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))/;
const RUN_DIR_ARGUMENT_PATTERN = /--run-dir(?:=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))/;
const ASSIGNMENT_PATTERN = /(?:^|[\n;&|(]|\bexport)[ \t]*([A-Za-z_]\w*)=(?:"([^"]*)"|'([^']*)'|([^\s;&|)]*))/g;
const VARIABLE_PATTERN = /\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g;
const VALID_SLUG_PATTERN = /^[\w.-]+$/;

interface ShellArgument {
    value: string;
    singleQuoted: boolean;
    unquoted: boolean;
}

interface ShellContext {
    cwd: string | null;
    /** Variables assigned earlier in the same command. */
    variables: Map<string, string>;
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

function lookupVariable(name: string, context: ShellContext): string | null {
    if (name === 'PWD') {
        return context.cwd;
    }
    return context.variables.get(name) ?? (name === 'HOME' ? os.homedir() : null);
}

function expandVariables(value: string, context: ShellContext): string | null {
    for (const match of value.matchAll(VARIABLE_PATTERN)) {
        if (lookupVariable(match[1] ?? match[2] ?? '', context) === null) {
            return null;
        }
    }
    const expanded = value.replace(
        VARIABLE_PATTERN,
        (_match, braced: string | undefined, bare: string | undefined) => lookupVariable(braced ?? bare ?? '', context) ?? ''
    );
    return /[$`]/.test(expanded) ? null : expanded;
}

// Only plain `NAME=value` assignments are followed; a value built from a
// command substitution or an unknown variable leaves the name unresolved.
function readShellAssignments(commandPrefix: string, cwd: string | null): Map<string, string> {
    const variables = new Map<string, string>();
    for (const match of commandPrefix.matchAll(ASSIGNMENT_PATTERN)) {
        const name = match[1] ?? '';
        const singleQuoted = match[3];
        const unquoted = match[4];
        const value = singleQuoted ?? (unquoted === undefined
            ? expandVariables(match[2] ?? '', { cwd, variables })
            : resolveShellValue({ value: unquoted, singleQuoted: false, unquoted: true }, { cwd, variables }));
        if (value === null || /[$`]/.test(value)) {
            variables.delete(name);
        } else {
            variables.set(name, value);
        }
    }
    return variables;
}

// Mirrors what the shell would have passed: variables expand unless
// single-quoted, `~` expands only unquoted, and anything the shell would still
// have had to evaluate cannot be resolved afterwards.
function resolveShellValue(argument: ShellArgument, context: ShellContext): string | null {
    if (argument.singleQuoted) {
        return /[$`]/.test(argument.value) ? null : argument.value;
    }
    let value = argument.value;
    if (argument.unquoted && (value === '~' || value.startsWith('~/'))) {
        value = path.join(os.homedir(), value.slice(1));
    }
    return expandVariables(value, context);
}

function resolveShellPath(argument: ShellArgument, context: ShellContext): string | null {
    const value = resolveShellValue(argument, context);
    if (value === null) {
        return null;
    }
    if (path.isAbsolute(value)) {
        return path.normalize(value);
    }
    return context.cwd === null ? null : path.resolve(context.cwd, value);
}

function* iterateInvocations(command: string, pattern: RegExp, cwd: string | null): Generator<{ invocation: string; context: ShellContext }> {
    for (const match of command.matchAll(pattern)) {
        const rest = command.slice(match.index + match[0].length);
        const end = COMMAND_END_PATTERN.exec(rest);
        yield {
            invocation: end ? rest.slice(0, end.index) : rest,
            context: { cwd, variables: readShellAssignments(command.slice(0, match.index), cwd) }
        };
    }
}

/**
 * Returns every flow-agent runner launch in a shell command.
 *
 * @remarks
 * Arguments are expanded with `$PWD`, `$HOME` and variables assigned earlier
 * in the same command; anything else only the shell could expand is dropped,
 * and a launch with neither a usable slug nor a usable review folder is skipped.
 *
 * @param cwd - Working directory the command ran in, for `$PWD` and relative paths
 */
export function extractFlowAgentLaunches(command: string, cwd: string | null = null): FlowAgentLaunch[] {
    const launches: FlowAgentLaunch[] = [];
    for (const { invocation, context } of iterateInvocations(command, RUNNER_PATTERN, cwd)) {
        const slugArgument = readShellArgument(SLUG_ARGUMENT_PATTERN, invocation);
        const slugValue = slugArgument ? resolveShellValue(slugArgument, context) : null;
        const slug = slugValue !== null && VALID_SLUG_PATTERN.test(slugValue) ? slugValue : null;
        const reviewDirArgument = readShellArgument(REVIEW_DIR_ARGUMENT_PATTERN, invocation);
        const reviewDir = reviewDirArgument ? resolveShellPath(reviewDirArgument, context) : null;
        if (slug !== null || reviewDir !== null) {
            launches.push({ slug, reviewDir });
        }
    }
    return launches;
}

/**
 * Returns the `--run-dir` of every flow-workflow `derive-worker` call in a
 * shell command, resolved the same way as {@link extractFlowAgentLaunches}.
 */
export function extractWorkflowRunDirs(command: string, cwd: string | null = null): string[] {
    const runDirs: string[] = [];
    for (const { invocation, context } of iterateInvocations(command, WORKFLOW_WORKER_PATTERN, cwd)) {
        const runDirArgument = readShellArgument(RUN_DIR_ARGUMENT_PATTERN, invocation);
        const runDir = runDirArgument ? resolveShellPath(runDirArgument, context) : null;
        if (runDir !== null) {
            runDirs.push(runDir);
        }
    }
    return runDirs;
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
        workflowLaunches: [],
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
            for (const runDir of extractWorkflowRunDirs(command, cwd)) {
                collector.workflowLaunches.push({ runDir, timestampMs });
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
        workflowLaunches: collector.workflowLaunches.slice(),
        firstTimestampMs: collector.firstTimestampMs
    };
}

const FIRST_PROMPT_READ_LIMIT_BYTES = 256 * 1024;

/**
 * Returns the text of a transcript's first user message, the prompt a
 * headless session was started with.
 *
 * @remarks
 * Reads at most the head of the file; null when no user message starts there.
 */
export function readFirstUserPrompt(filePath: string): string | null {
    let head: string;
    try {
        const fd = fs.openSync(filePath, 'r');
        try {
            const buffer = Buffer.alloc(Math.min(FIRST_PROMPT_READ_LIMIT_BYTES, fs.fstatSync(fd).size));
            const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
            head = buffer.subarray(0, bytesRead).toString('utf-8');
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        return null;
    }

    for (const line of head.split('\n')) {
        const record = asRecord(parseJsonlLine(line));
        if (record?.type !== 'user') {
            continue;
        }
        const message = asRecord(record.message);
        return message ? getMessageText(message.content) : null;
    }
    return null;
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
