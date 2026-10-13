import * as fs from 'fs';
import os from 'os';
import path from 'path';
import {
    afterEach,
    describe,
    expect,
    it
} from 'vitest';

import {
    collectTranscriptUsageRecord,
    createTranscriptUsageCollector,
    extractFlowAgentSlugs,
    finishTranscriptUsageCollector,
    readTranscriptUsage,
    scanTranscriptUsage,
    sumUsageEntries
} from '../task-usage-scan';

const tempDirs: string[] = [];

function writeTranscript(lines: unknown[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-usage-scan-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, 'session.jsonl');
    fs.writeFileSync(filePath, lines.map(line => typeof line === 'string' ? line : JSON.stringify(line)).join('\n'));
    return filePath;
}

function assistantLine(params: {
    id?: string;
    requestId?: string;
    timestamp?: string;
    input: number;
    output: number;
    cacheRead?: number;
    cacheCreate?: number;
    content?: unknown[];
    stopReason?: string | null;
}): Record<string, unknown> {
    return {
        type: 'assistant',
        timestamp: params.timestamp ?? '2026-10-12T10:00:00.000Z',
        ...(params.requestId ? { requestId: params.requestId } : {}),
        message: {
            ...(params.id ? { id: params.id } : {}),
            stop_reason: params.stopReason === undefined ? 'end_turn' : params.stopReason,
            content: params.content ?? [{ type: 'text', text: 'ok' }],
            usage: {
                input_tokens: params.input,
                output_tokens: params.output,
                cache_read_input_tokens: params.cacheRead ?? 0,
                cache_creation_input_tokens: params.cacheCreate ?? 0
            }
        }
    };
}

function bashToolUse(command: string): unknown[] {
    return [{ type: 'tool_use', id: 'call_1', name: 'Bash', input: { command } }];
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe('extractFlowAgentSlugs', () => {
    it('reads the slug from a multi-line runner invocation', () => {
        const command = 'node ~/.claude/skills/flow-agent/scripts/run-external-review.ts \\\n'
            + '  --slug 261012-syspolicyd-hook-timeout-review \\\n'
            + '  --review-dir /tmp/reviews/x \\\n'
            + '  --caller-model glm-5.3-flash';
        expect(extractFlowAgentSlugs(command)).toEqual(['261012-syspolicyd-hook-timeout-review']);
    });

    it('accepts --slug=value and quoted values', () => {
        expect(extractFlowAgentSlugs('node run-external-review.ts --slug=260727-a-code-review --caller-model x')).toEqual(['260727-a-code-review']);
        expect(extractFlowAgentSlugs('node run-external-review.ts --slug "260727-b" --caller-model x')).toEqual(['260727-b']);
        expect(extractFlowAgentSlugs('node run-external-review.ts --slug \'260727-c\' --caller-model x')).toEqual(['260727-c']);
    });

    it('returns every invocation chained in one command', () => {
        const command = 'node run-external-review.ts --slug first-review --caller-model x; '
            + 'node run-external-review.ts --slug second-review --caller-model x';
        expect(extractFlowAgentSlugs(command)).toEqual(['first-review', 'second-review']);
    });

    it('ignores commands that only mention the runner without a slug', () => {
        expect(extractFlowAgentSlugs('node run-external-review.ts --list-models')).toEqual([]);
        expect(extractFlowAgentSlugs('rg -n "projects" ~/.claude/skills/flow-agent/scripts/run-external-review.ts')).toEqual([]);
        expect(extractFlowAgentSlugs('node other-script.ts --slug not-a-runner')).toEqual([]);
    });

    it('skips slugs passed through shell variables', () => {
        expect(extractFlowAgentSlugs('node run-external-review.ts --slug "$SLUG" --caller-model x')).toEqual([]);
        expect(extractFlowAgentSlugs('node run-external-review.ts --slug ${K}-review --caller-model x')).toEqual([]);
    });
});

describe('scanTranscriptUsage', () => {
    it('counts an API response once even when it is split across several lines', async () => {
        const transcript = writeTranscript([
            assistantLine({ id: 'msg_1', requestId: 'req_1', input: 4, output: 259, cacheCreate: 7157, content: [{ type: 'thinking', thinking: '' }], stopReason: 'tool_use' }),
            assistantLine({ id: 'msg_1', requestId: 'req_1', input: 4, output: 259, cacheCreate: 7157, content: [{ type: 'tool_use', name: 'Read', input: {} }], stopReason: 'tool_use' }),
            assistantLine({ id: 'msg_2', requestId: 'req_2', input: 10, output: 20, cacheRead: 7157 })
        ]);

        const scan = await scanTranscriptUsage(transcript);

        expect(sumUsageEntries(scan.usageEntries)).toEqual({
            inputTokens: 14,
            outputTokens: 279,
            cacheReadTokens: 7157,
            cacheCreationTokens: 7157,
            totalTokens: 14607
        });
    });

    it('keeps the final usage of a streamed response whose early lines carry partial output', async () => {
        const transcript = writeTranscript([
            assistantLine({ id: 'msg_1', requestId: 'req_1', input: 5, output: 1, stopReason: null }),
            assistantLine({ id: 'msg_1', requestId: 'req_1', input: 5, output: 300, stopReason: 'end_turn' })
        ]);

        const scan = await scanTranscriptUsage(transcript);

        expect(sumUsageEntries(scan.usageEntries).outputTokens).toBe(300);
        expect(sumUsageEntries(scan.usageEntries).totalTokens).toBe(305);
    });

    it('takes the settled line over a streaming snapshot that folds cache reads into input', async () => {
        const snapshot = assistantLine({ id: 'msg_641147593c802db1ca40fe57', requestId: 'req_1', input: 38734, output: 0 });
        delete (snapshot.message as Record<string, unknown>).stop_reason;
        const transcript = writeTranscript([
            snapshot,
            assistantLine({ id: 'msg_641147593c802db1ca40fe57', requestId: 'req_1', input: 5371, output: 356, cacheRead: 33472, stopReason: 'tool_use' })
        ]);

        const scan = await scanTranscriptUsage(transcript);

        expect(sumUsageEntries(scan.usageEntries)).toEqual({
            inputTokens: 5371,
            outputTokens: 356,
            cacheReadTokens: 33472,
            cacheCreationTokens: 0,
            totalTokens: 39199
        });
    });

    it('counts usage lines without a message id individually', async () => {
        const transcript = writeTranscript([
            assistantLine({ input: 1, output: 2 }),
            assistantLine({ input: 1, output: 2 })
        ]);

        const scan = await scanTranscriptUsage(transcript);

        expect(sumUsageEntries(scan.usageEntries).totalTokens).toBe(6);
    });

    it('records runner invocations with the time they were issued', async () => {
        const transcript = writeTranscript([
            { type: 'user', timestamp: '2026-10-12T09:59:00.000Z', message: { content: 'review it' } },
            assistantLine({
                id: 'msg_1',
                timestamp: '2026-10-12T10:00:00.000Z',
                input: 1,
                output: 1,
                content: bashToolUse('node ~/.claude/skills/flow-agent/scripts/run-external-review.ts --slug 261012-a-review --caller-model glm-5.3'),
                stopReason: 'tool_use'
            }),
            assistantLine({
                id: 'msg_2',
                timestamp: '2026-10-12T11:00:00.000Z',
                input: 1,
                output: 1,
                content: [{ type: 'text', text: 'node run-external-review.ts --slug only-prose' }]
            })
        ]);

        const scan = await scanTranscriptUsage(transcript);

        expect(scan.flowAgentInvocations).toEqual([
            { slug: '261012-a-review', timestampMs: Date.parse('2026-10-12T10:00:00.000Z') }
        ]);
        expect(scan.firstTimestampMs).toBe(Date.parse('2026-10-12T09:59:00.000Z'));
    });

    it('collects the subagent ids referenced by tool results', async () => {
        const transcript = writeTranscript([
            { type: 'user', timestamp: '2026-10-12T10:00:00.000Z', toolUseResult: { agentId: 'a1b2c3', status: 'completed' } }
        ]);

        const scan = await scanTranscriptUsage(transcript);

        expect(scan.agentIds).toEqual(['a1b2c3']);
    });

    it('skips malformed lines and still reads the rest', async () => {
        const transcript = writeTranscript([
            '{not json',
            assistantLine({ id: 'msg_1', input: 3, output: 4 })
        ]);

        const scan = await scanTranscriptUsage(transcript);

        expect(sumUsageEntries(scan.usageEntries).totalTokens).toBe(7);
    });

    it('keeps a finished scan unchanged when the collector is fed further records', () => {
        const collector = createTranscriptUsageCollector();
        collectTranscriptUsageRecord(collector, assistantLine({ id: 'msg_1', input: 1, output: 1, content: bashToolUse('node run-external-review.ts --slug first'), stopReason: 'tool_use' }));
        const firstScan = finishTranscriptUsageCollector(collector);

        collectTranscriptUsageRecord(collector, assistantLine({ id: 'msg_2', input: 1, output: 1, content: bashToolUse('node run-external-review.ts --slug second'), stopReason: 'tool_use' }));

        expect(firstScan.flowAgentInvocations.map(invocation => invocation.slug)).toEqual(['first']);
        expect(firstScan.usageEntries).toHaveLength(1);
    });

    it('returns an empty scan for a missing transcript', async () => {
        const scan = await scanTranscriptUsage(path.join(os.tmpdir(), 'does-not-exist-task-usage.jsonl'));

        expect(scan).toEqual({
            usageEntries: [],
            agentIds: [],
            flowAgentInvocations: [],
            firstTimestampMs: null
        });
    });

    it('reports whether the whole transcript was read', async () => {
        const transcript = writeTranscript([assistantLine({ id: 'msg_1', input: 3, output: 4 })]);

        expect((await readTranscriptUsage(transcript)).complete).toBe(true);
        expect((await readTranscriptUsage(path.join(os.tmpdir(), 'does-not-exist-task-usage.jsonl'))).complete).toBe(false);
    });

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('flags a transcript that could not be read as incomplete', async () => {
        const transcript = writeTranscript([assistantLine({ id: 'msg_1', input: 3, output: 4 })]);
        fs.chmodSync(transcript, 0o000);
        try {
            const read = await readTranscriptUsage(transcript);
            expect(read.complete).toBe(false);
            expect(read.scan.usageEntries).toEqual([]);
        } finally {
            fs.chmodSync(transcript, 0o600);
        }
    });
});
