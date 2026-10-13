import * as fs from 'fs';

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

/** A flow-agent `run-external-review` launch found in a tool call. */
export interface FlowAgentInvocation {
    slug: string;
    timestampMs: number | null;
}

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
}

const RUNNER_PATTERN = /run-external-review(?:\.[cm]?[jt]s)?\b/g;
// A runner invocation ends at the next unescaped newline or shell separator,
// so a `--slug` belonging to a later command is never attributed to it.
const COMMAND_END_PATTERN = /(?<!\\)\n|;|&&|\|/;
const SLUG_ARGUMENT_PATTERN = /--slug(?:=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))/;
const VALID_SLUG_PATTERN = /^[\w.-]+$/;

/**
 * Returns the `--slug` of every flow-agent runner invocation in a shell command.
 *
 * @remarks
 * Slugs that are not literal (shell variables, substitutions) cannot be
 * resolved to a run directory and are skipped.
 */
export function extractFlowAgentSlugs(command: string): string[] {
    const slugs: string[] = [];
    for (const match of command.matchAll(RUNNER_PATTERN)) {
        const rest = command.slice(match.index + match[0].length);
        const end = COMMAND_END_PATTERN.exec(rest);
        const invocation = end ? rest.slice(0, end.index) : rest;
        const slugMatch = SLUG_ARGUMENT_PATTERN.exec(invocation);
        const slug = slugMatch?.[1] ?? slugMatch?.[2] ?? slugMatch?.[3];
        if (slug && VALID_SLUG_PATTERN.test(slug)) {
            slugs.push(slug);
        }
    }
    return slugs;
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
        firstTimestampMs: null
    };
}

export function collectTranscriptUsageRecord(collector: TranscriptUsageCollector, data: unknown): void {
    const record = asRecord(data);
    if (!record) {
        return;
    }

    const timestampMs = parseTimestampMs(record.timestamp);
    collector.firstTimestampMs ??= timestampMs;
    collectAgentIds(record, collector.agentIds);

    const message = asRecord(record.message);
    if (!message) {
        return;
    }

    if (record.type === 'assistant') {
        for (const command of getToolCommands(message)) {
            for (const slug of extractFlowAgentSlugs(command)) {
                collector.flowAgentInvocations.push({ slug, timestampMs });
            }
        }
    }

    const usage = asRecord(message.usage);
    if (!usage) {
        return;
    }

    const tokens = parseUsageTokens(usage);
    const messageId = typeof message.id === 'string' && message.id !== '' ? message.id : null;
    const requestId = typeof record.requestId === 'string' ? record.requestId : '';
    const key = messageId === null ? null : `${messageId}\u0000${requestId}`;
    const entry: UsageEntry = {
        key,
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        cacheReadTokens: tokens.read,
        cacheCreationTokens: tokens.creation
    };

    if (key === null) {
        collector.anonymousEntries.push(entry);
    } else {
        // Later copies of a streamed response carry the settled counts.
        collector.keyedEntries.set(key, entry);
    }
}

export function finishTranscriptUsageCollector(collector: TranscriptUsageCollector): TranscriptUsageScan {
    return {
        usageEntries: [...collector.keyedEntries.values(), ...collector.anonymousEntries],
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
