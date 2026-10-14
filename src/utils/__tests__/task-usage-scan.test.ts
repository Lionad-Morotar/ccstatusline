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
    extractFlowAgentLaunches,
    extractWorkflowRunDirs,
    finishTranscriptUsageCollector,
    readFirstUserPrompt,
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

describe('extractFlowAgentLaunches', () => {
    const slugsOf = (command: string) => extractFlowAgentLaunches(command).map(launch => launch.slug);

    it('reads the slug and review folder from a multi-line runner invocation', () => {
        const command = 'node ~/.claude/skills/flow-agent/scripts/run-external-review.ts \\\n'
            + '  --slug 261012-syspolicyd-hook-timeout-review \\\n'
            + '  --review-dir /tmp/reviews/x \\\n'
            + '  --caller-model glm-5.3-flash';
        expect(extractFlowAgentLaunches(command)).toEqual([
            { slug: '261012-syspolicyd-hook-timeout-review', reviewDir: path.normalize('/tmp/reviews/x') }
        ]);
    });

    it('accepts --slug=value and quoted values', () => {
        expect(slugsOf('node run-external-review.ts --slug=260727-a-code-review --caller-model x')).toEqual(['260727-a-code-review']);
        expect(slugsOf('node run-external-review.ts --slug "260727-b" --caller-model x')).toEqual(['260727-b']);
        expect(slugsOf('node run-external-review.ts --slug \'260727-c\' --caller-model x')).toEqual(['260727-c']);
    });

    it('returns every invocation chained in one command', () => {
        const command = 'node run-external-review.ts --slug first-review --caller-model x; '
            + 'node run-external-review.ts --slug second-review --caller-model x';
        expect(slugsOf(command)).toEqual(['first-review', 'second-review']);
    });

    it('ignores commands that only mention the runner without a slug or review folder', () => {
        expect(extractFlowAgentLaunches('node run-external-review.ts --list-models')).toEqual([]);
        expect(extractFlowAgentLaunches('rg -n "projects" ~/.claude/skills/flow-agent/scripts/run-external-review.ts')).toEqual([]);
        expect(extractFlowAgentLaunches('node other-script.ts --slug not-a-runner')).toEqual([]);
    });

    it('drops slugs passed through shell variables but keeps a usable review folder', () => {
        expect(extractFlowAgentLaunches('node run-external-review.ts --slug "$SLUG" --caller-model x')).toEqual([]);
        expect(extractFlowAgentLaunches('node run-external-review.ts --slug ${K}-review --review-dir /tmp/r --caller-model x')).toEqual([
            { slug: null, reviewDir: path.normalize('/tmp/r') }
        ]);
    });

    it('resolves $PWD and relative review folders against the working directory', () => {
        const cwd = path.join(os.tmpdir(), 'repo');
        const reviewDirOf = (command: string, workingDir: string | null = cwd) => extractFlowAgentLaunches(command, workingDir)[0]?.reviewDir;

        expect(reviewDirOf('node run-external-review.ts --slug s --review-dir "$PWD/docs/reviews/a"')).toBe(path.join(cwd, 'docs/reviews/a'));
        expect(reviewDirOf('node run-external-review.ts --slug s --review-dir ${PWD}/docs/reviews/b')).toBe(path.join(cwd, 'docs/reviews/b'));
        expect(reviewDirOf('node run-external-review.ts --slug s --review-dir docs/reviews/c')).toBe(path.join(cwd, 'docs/reviews/c'));
        expect(reviewDirOf('node run-external-review.ts --slug s --review-dir ~/reviews/d')).toBe(path.join(os.homedir(), 'reviews/d'));
        expect(reviewDirOf('node run-external-review.ts --slug s --review-dir docs/reviews/c', null)).toBeNull();
        expect(reviewDirOf('node run-external-review.ts --slug s --review-dir \'$PWD/docs\'')).toBeNull();
        expect(reviewDirOf('node run-external-review.ts --slug s --review-dir "$DIR/docs"')).toBeNull();
    });

    it('resolves variables assigned earlier in the same command', () => {
        expect(slugsOf('K=261013-x; node run-external-review.ts --slug $K-review --caller-model x')).toEqual(['261013-x-review']);
        expect(slugsOf('export SLUG="261013-y"\nnode run-external-review.ts --slug "${SLUG}" --caller-model x')).toEqual(['261013-y']);
        expect(slugsOf('node run-external-review.ts --slug $K --caller-model x; K=late')).toEqual([]);
        expect(slugsOf('K=$(date +%s); node run-external-review.ts --slug $K --caller-model x')).toEqual([]);
    });
});

describe('extractWorkflowRunDirs', () => {
    const runDir = path.join(os.homedir(), '.flow-workflow', 'huashu-report', 'run', '261014', 'a');

    it('reads the run folder of a derive-worker call through an earlier assignment', () => {
        const command = `RUN=${runDir}\n`
            + 'bash ~/.claude/skills/flow-workflow/scripts/run-ts.sh ~/.claude/skills/flow-workflow/scripts/derive-worker.ts '
            + 'launch "$RUN/brief.json" --run-dir "$RUN" --launcher "cg->cq" --cwd "$RUN"';
        expect(extractWorkflowRunDirs(command)).toEqual([runDir]);
    });

    it('expands ~ in an unquoted assignment and resolves relative folders against the working directory', () => {
        const cwd = path.join(os.tmpdir(), 'repo');
        expect(extractWorkflowRunDirs('RUN=~/.flow-workflow/huashu-report/run/261014/a; derive-worker.ts status --run-dir $RUN')).toEqual([runDir]);
        expect(extractWorkflowRunDirs('derive-worker.ts launch doc.md --run-dir run/a', cwd)).toEqual([path.join(cwd, 'run/a')]);
    });

    it('ignores calls without a resolvable run folder', () => {
        expect(extractWorkflowRunDirs('derive-worker.ts --help')).toEqual([]);
        expect(extractWorkflowRunDirs('derive-worker.ts launch doc.md --run-dir "$RUN"')).toEqual([]);
        expect(extractWorkflowRunDirs('node other.ts --run-dir /tmp/run')).toEqual([]);
    });
});

describe('readFirstUserPrompt', () => {
    it('returns the text of the first user message', () => {
        const transcript = writeTranscript([
            '{not json',
            { type: 'queue-operation', operation: 'enqueue' },
            { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'write /tmp/run/worker-001.report.md' }] } },
            { type: 'user', message: { role: 'user', content: 'later' } }
        ]);

        expect(readFirstUserPrompt(transcript)).toBe('write /tmp/run/worker-001.report.md');
    });

    it('returns null for a missing transcript or one without a user message', () => {
        expect(readFirstUserPrompt(path.join(os.tmpdir(), 'does-not-exist-task-usage.jsonl'))).toBeNull();
        expect(readFirstUserPrompt(writeTranscript([assistantLine({ input: 1, output: 1 })]))).toBeNull();
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
            { slug: '261012-a-review', reviewDir: null, timestampMs: Date.parse('2026-10-12T10:00:00.000Z') }
        ]);
        expect(scan.firstTimestampMs).toBe(Date.parse('2026-10-12T09:59:00.000Z'));
    });

    it('records workflow worker calls with the time they were issued', async () => {
        const transcript = writeTranscript([
            assistantLine({
                id: 'msg_1',
                timestamp: '2026-10-12T10:00:00.000Z',
                input: 1,
                output: 1,
                content: bashToolUse('RUN=/tmp/run/a; derive-worker.ts launch "$RUN/brief.json" --run-dir "$RUN"'),
                stopReason: 'tool_use'
            })
        ]);

        const scan = await scanTranscriptUsage(transcript);

        expect(scan.workflowLaunches).toEqual([
            { runDir: path.normalize('/tmp/run/a'), timestampMs: Date.parse('2026-10-12T10:00:00.000Z') }
        ]);
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
            workflowLaunches: [],
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

describe('scanTranscriptUsage compaction requests', () => {
    function compactBoundary(params: { uuid?: string; preTokens?: unknown; isSidechain?: boolean }): Record<string, unknown> {
        return {
            type: 'system',
            subtype: 'compact_boundary',
            ...(params.uuid ? { uuid: params.uuid } : {}),
            ...(params.isSidechain ? { isSidechain: true } : {}),
            timestamp: '2026-10-12T10:05:00.000Z',
            compactMetadata: { trigger: 'auto', preTokens: params.preTokens, postTokens: 32566 }
        };
    }

    function compactSummary(content: unknown): Record<string, unknown> {
        return {
            type: 'user',
            isCompactSummary: true,
            timestamp: '2026-10-12T10:05:00.000Z',
            message: { role: 'user', content }
        };
    }

    it('counts each compaction as one request: the compacted context in, the summary out', async () => {
        const transcript = writeTranscript([
            assistantLine({ id: 'msg_1', requestId: 'req_1', input: 10, output: 20 }),
            compactBoundary({ uuid: 'boundary-1', preTokens: 283759 }),
            { type: 'attachment', timestamp: '2026-10-12T10:05:00.000Z' },
            compactSummary(`${'a'.repeat(400)}压缩摘要`)
        ]);

        const scan = await scanTranscriptUsage(transcript);

        expect(sumUsageEntries(scan.usageEntries)).toEqual({
            inputTokens: 283769,
            outputTokens: 20 + 100 + 4,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            totalTokens: 283769 + 124
        });
    });

    it('reads summaries written as text blocks', async () => {
        const transcript = writeTranscript([
            compactBoundary({ uuid: 'boundary-1', preTokens: 1000 }),
            compactSummary([{ type: 'text', text: 'b'.repeat(40) }, { type: 'text', text: 'c'.repeat(40) }])
        ]);

        const scan = await scanTranscriptUsage(transcript);

        expect(sumUsageEntries(scan.usageEntries).outputTokens).toBe(20);
    });

    it('counts compactions inside subagent transcripts', async () => {
        const transcript = writeTranscript([
            compactBoundary({ uuid: 'boundary-1', preTokens: 500, isSidechain: true })
        ]);

        const scan = await scanTranscriptUsage(transcript);

        expect(sumUsageEntries(scan.usageEntries).inputTokens).toBe(500);
    });

    it('counts a repeated boundary record once', async () => {
        const transcript = writeTranscript([
            compactBoundary({ uuid: 'boundary-1', preTokens: 500 }),
            compactBoundary({ uuid: 'boundary-1', preTokens: 500 })
        ]);

        const scan = await scanTranscriptUsage(transcript);

        expect(scan.usageEntries).toHaveLength(1);
        expect(scan.usageEntries[0]?.key).not.toBeNull();
    });

    it('ignores boundaries without a context size and summaries without a boundary', async () => {
        const transcript = writeTranscript([
            compactSummary('orphan summary text'),
            compactBoundary({ uuid: 'boundary-1' }),
            compactSummary('summary of an unmeasured compaction')
        ]);

        const scan = await scanTranscriptUsage(transcript);

        expect(scan.usageEntries).toEqual([]);
    });
});
