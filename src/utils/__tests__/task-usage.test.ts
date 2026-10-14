import * as fs from 'fs';
import os from 'os';
import path from 'path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it
} from 'vitest';

import {
    getProjectDirName,
    getTaskUsageMetrics
} from '../task-usage';
import { scanTranscriptUsage } from '../task-usage-scan';

interface Fixture {
    projectsRoot: string;
    flowDevHome: string;
    projectDir: string;
    mainPath: string;
}

let fixture: Fixture;
const tempDirs: string[] = [];

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

function runnerCommandLine(id: string, command: string, timestamp: string, cwd?: string): Record<string, unknown> {
    return {
        type: 'assistant',
        timestamp,
        ...(cwd === undefined ? {} : { cwd }),
        requestId: `req_${id}`,
        message: {
            id,
            stop_reason: 'tool_use',
            content: [{
                type: 'tool_use',
                id: `call_${id}`,
                name: 'Bash',
                input: { command, run_in_background: true }
            }],
            usage: { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
        }
    };
}

function runnerCall(id: string, slug: string, timestamp = '2026-10-12T10:00:00.000Z'): Record<string, unknown> {
    return runnerCommandLine(id, `node ~/.claude/skills/flow-agent/scripts/run-external-review.ts --slug ${slug} --caller-model glm-5.3`, timestamp);
}

function writeRunnerResult(reviewDir: string, fileName: string, sessionIds: string[]): void {
    fs.mkdirSync(reviewDir, { recursive: true });
    fs.writeFileSync(path.join(reviewDir, fileName), JSON.stringify({
        slug: 'whatever',
        reviews: sessionIds.map(sessionId => ({ target_model: 'glm-5.3-flash', status: 'success', session_id: sessionId }))
    }));
}

function writeRunSessions(slug: string, files: Record<string, string[]>): void {
    const runDir = path.join(fixture.flowDevHome, 'runs', slug);
    fs.mkdirSync(runDir, { recursive: true });
    for (const [model, ids] of Object.entries(files)) {
        fs.writeFileSync(path.join(runDir, `review-${model}.session`), `${ids.join('\n')}\n`);
    }
}

function workerReportPath(runDir: string, worker: string): string {
    return path.join(runDir, `worker-${worker}.report.md`);
}

function writeWorkflowWorker(runDir: string, worker: string, cwd: string): void {
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, `worker-${worker}.meta.json`), JSON.stringify({
        worker,
        reportPath: workerReportPath(runDir, worker),
        launcher: 'cg',
        cwd
    }));
}

function workerPrompt(runDir: string, worker: string, timestamp = '2026-10-12T10:00:05.000Z'): Record<string, unknown> {
    return {
        type: 'user',
        timestamp,
        message: { role: 'user', content: `Do the research. Write the report to ${workerReportPath(runDir, worker)}.` }
    };
}

function sessionPath(projectDir: string, sessionId: string): string {
    return path.join(projectDir, `${sessionId}.jsonl`);
}

function subagentPath(transcriptPath: string, agentId: string): string {
    return path.join(path.dirname(transcriptPath), path.parse(transcriptPath).name, 'subagents', `agent-${agentId}.jsonl`);
}

async function metrics() {
    return getTaskUsageMetrics(fixture.mainPath, undefined, {
        projectsRoot: fixture.projectsRoot,
        flowDevHome: fixture.flowDevHome
    });
}

beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-usage-'));
    tempDirs.push(root);
    const projectsRoot = path.join(root, 'projects');
    const projectDir = path.join(projectsRoot, '-Users-me-repo');
    fixture = {
        projectsRoot,
        flowDevHome: path.join(root, '.flow-dev'),
        projectDir,
        mainPath: sessionPath(projectDir, 'main-session')
    };
});

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe('getTaskUsageMetrics', () => {
    it('reports only the main session when nothing else was spawned', async () => {
        writeJsonl(fixture.mainPath, [usageLine('m1', 100), usageLine('m2', 50)]);

        const result = await metrics();

        expect(result.total.totalTokens).toBe(150);
        expect(result.main.totalTokens).toBe(150);
        expect(result.subagents.totalTokens).toBe(0);
        expect(result.external.totalTokens).toBe(0);
        expect(result.subagentTranscriptCount).toBe(0);
        expect(result.externalSessionCount).toBe(0);
    });

    it('adds every subagent transcript stored under the session', async () => {
        writeJsonl(fixture.mainPath, [usageLine('m1', 100)]);
        writeJsonl(subagentPath(fixture.mainPath, 'aaa111'), [usageLine('s1', 30)]);
        writeJsonl(subagentPath(fixture.mainPath, 'nested-bbb222'), [usageLine('s2', 20)]);

        const result = await metrics();

        expect(result.subagents.totalTokens).toBe(50);
        expect(result.subagentTranscriptCount).toBe(2);
        expect(result.total.totalTokens).toBe(150);
    });

    it('adds workflow agents stored in nested folders under the session subagents', async () => {
        writeJsonl(fixture.mainPath, [usageLine('m1', 100)]);
        const workflowDir = path.join(fixture.projectDir, 'main-session', 'subagents', 'workflows', 'wf_1');
        writeJsonl(path.join(workflowDir, 'agent-w1.jsonl'), [usageLine('w1', 11)]);
        writeJsonl(path.join(workflowDir, 'journal.jsonl'), [usageLine('j1', 1000)]);

        const result = await metrics();

        expect(result.subagents.totalTokens).toBe(11);
        expect(result.subagentTranscriptCount).toBe(1);
    });

    it('takes only referenced subagents from the legacy shared subagents folder', async () => {
        writeJsonl(fixture.mainPath, [
            usageLine('m1', 100),
            { type: 'user', timestamp: '2026-10-12T10:01:00.000Z', toolUseResult: { agentId: 'mine' } }
        ]);
        writeJsonl(path.join(fixture.projectDir, 'subagents', 'agent-mine.jsonl'), [usageLine('s1', 7)]);
        writeJsonl(path.join(fixture.projectDir, 'subagents', 'agent-other.jsonl'), [usageLine('s2', 1000)]);

        const result = await metrics();

        expect(result.subagents.totalTokens).toBe(7);
        expect(result.subagentTranscriptCount).toBe(1);
    });

    it('adds external review sessions launched from the main session', async () => {
        writeJsonl(fixture.mainPath, [usageLine('m1', 100), runnerCall('m2', '261012-a-review')]);
        writeRunSessions('261012-a-review', { 'deepseek-v4-flash': ['ext-1'] });
        writeJsonl(sessionPath(fixture.projectDir, 'ext-1'), [usageLine('e1', 400, '2026-10-12T10:00:10.000Z')]);
        writeJsonl(sessionPath(fixture.projectDir, 'unrelated'), [usageLine('u1', 9999, '2026-10-12T10:00:10.000Z')]);

        const result = await metrics();

        expect(result.main.totalTokens).toBe(101);
        expect(result.external.totalTokens).toBe(400);
        expect(result.externalSessionCount).toBe(1);
        expect(result.total.totalTokens).toBe(501);
    });

    it('adds external sessions launched by a subagent, even when they live in another project folder', async () => {
        writeJsonl(fixture.mainPath, [usageLine('m1', 100)]);
        writeJsonl(subagentPath(fixture.mainPath, 'dev'), [usageLine('s1', 10), runnerCall('s2', '261012-b-review')]);
        writeRunSessions('261012-b-review', { 'glm-5.3': ['ext-2'] });
        const worktreeProject = path.join(fixture.projectsRoot, '-Users-me-repo--claude-worktrees-feature');
        writeJsonl(sessionPath(worktreeProject, 'ext-2'), [usageLine('e1', 300, '2026-10-12T10:00:30.000Z')]);

        const result = await metrics();

        expect(result.subagents.totalTokens).toBe(11);
        expect(result.external.totalTokens).toBe(300);
        expect(result.total.totalTokens).toBe(411);
    });

    it('counts the subagents of an external session as external usage', async () => {
        writeJsonl(fixture.mainPath, [runnerCall('m1', '261012-c-review')]);
        writeRunSessions('261012-c-review', { 'glm-5.3': ['ext-3'] });
        const externalPath = sessionPath(fixture.projectDir, 'ext-3');
        writeJsonl(externalPath, [usageLine('e1', 200, '2026-10-12T10:00:10.000Z')]);
        writeJsonl(subagentPath(externalPath, 'helper'), [usageLine('es1', 25, '2026-10-12T10:00:20.000Z')]);

        const result = await metrics();

        expect(result.external.totalTokens).toBe(225);
        expect(result.subagents.totalTokens).toBe(0);
        expect(result.externalSessionCount).toBe(1);
    });

    it('counts a session listed by several fallback models once', async () => {
        writeJsonl(fixture.mainPath, [runnerCall('m1', '261012-d-review')]);
        writeRunSessions('261012-d-review', {
            'kimi-k2.8': ['ext-first', 'ext-second'],
            'deepseek-v4-flash': ['ext-first', 'ext-second']
        });
        writeJsonl(sessionPath(fixture.projectDir, 'ext-first'), [usageLine('e1', 40, '2026-10-12T10:00:10.000Z')]);
        writeJsonl(sessionPath(fixture.projectDir, 'ext-second'), [usageLine('e2', 60, '2026-10-12T10:10:00.000Z')]);

        const result = await metrics();

        expect(result.external.totalTokens).toBe(100);
        expect(result.externalSessionCount).toBe(2);
    });

    it('does not count history that a resumed review copied into its forked transcript twice', async () => {
        writeJsonl(fixture.mainPath, [runnerCall('m1', '261012-e-review'), runnerCall('m2', '261012-e-review', '2026-10-12T11:00:00.000Z')]);
        writeRunSessions('261012-e-review', { 'glm-5.3': ['ext-original', 'ext-fork'] });
        writeJsonl(sessionPath(fixture.projectDir, 'ext-original'), [usageLine('e1', 80, '2026-10-12T10:00:10.000Z')]);
        writeJsonl(sessionPath(fixture.projectDir, 'ext-fork'), [
            usageLine('e1', 80, '2026-10-12T10:00:10.000Z'),
            usageLine('e2', 20, '2026-10-12T11:00:10.000Z')
        ]);

        const result = await metrics();

        expect(result.external.totalTokens).toBe(100);
    });

    it('ignores a session recorded under the slug long after this task launched it', async () => {
        writeJsonl(fixture.mainPath, [runnerCall('m1', '261012-f-review')]);
        writeRunSessions('261012-f-review', { 'glm-5.3': ['ext-later'] });
        writeJsonl(sessionPath(fixture.projectDir, 'ext-later'), [usageLine('e1', 500, '2026-10-14T10:00:00.000Z')]);

        const result = await metrics();

        expect(result.external.totalTokens).toBe(0);
        expect(result.externalSessionCount).toBe(0);
    });

    it('ignores a session that started well before this task launched the review', async () => {
        writeJsonl(fixture.mainPath, [runnerCall('m1', '261012-g-review')]);
        writeRunSessions('261012-g-review', { 'glm-5.3': ['ext-earlier'] });
        writeJsonl(sessionPath(fixture.projectDir, 'ext-earlier'), [usageLine('e1', 500, '2026-10-11T10:00:00.000Z')]);

        const result = await metrics();

        expect(result.external.totalTokens).toBe(0);
    });

    it('skips session ids that would escape the projects folder', async () => {
        writeJsonl(fixture.mainPath, [runnerCall('m1', '261012-h-review')]);
        writeRunSessions('261012-h-review', { 'glm-5.3': ['../outside'] });
        writeJsonl(path.join(fixture.projectsRoot, 'outside.jsonl'), [usageLine('e1', 500, '2026-10-12T10:00:10.000Z')]);

        const result = await metrics();

        expect(result.external.totalTokens).toBe(0);
    });

    it('keeps the available parts when run folders or transcripts are missing', async () => {
        writeJsonl(fixture.mainPath, [usageLine('m1', 100), runnerCall('m2', 'no-such-run'), runnerCall('m3', '261012-i-review')]);
        writeRunSessions('261012-i-review', { 'glm-5.3': ['never-written'] });

        const result = await metrics();

        expect(result.main.totalTokens).toBe(102);
        expect(result.external.totalTokens).toBe(0);
        expect(result.total.totalTokens).toBe(102);
    });

    it('recovers a review whose session file a later run under the same slug overwrote', async () => {
        const reviewDir = path.join(path.dirname(fixture.projectsRoot), 'repo', 'docs', 'reviews', 'shared');
        const command = `node run-external-review.ts --slug 261013-j-review --review-dir ${reviewDir} --caller-model x`;
        writeJsonl(fixture.mainPath, [
            runnerCommandLine('m1', command, '2026-10-12T10:00:00.000Z'),
            runnerCommandLine('m2', `${command} --tag s2`, '2026-10-12T10:30:00.000Z')
        ]);
        writeRunSessions('261013-j-review', { 'glm-5.3-flash': ['ext-s2'] });
        writeRunnerResult(reviewDir, 'runner-result.json', ['ext-s1']);
        writeRunnerResult(reviewDir, 'runner-result-2.json', ['ext-s2']);
        writeJsonl(sessionPath(fixture.projectDir, 'ext-s1'), [usageLine('e1', 70, '2026-10-12T10:00:10.000Z')]);
        writeJsonl(sessionPath(fixture.projectDir, 'ext-s2'), [usageLine('e2', 30, '2026-10-12T10:30:10.000Z')]);

        const result = await metrics();

        expect(result.external.totalTokens).toBe(100);
        expect(result.externalSessionCount).toBe(2);
    });

    it('finds review sessions through a review folder given relative to the working directory', async () => {
        const repoDir = path.join(path.dirname(fixture.projectsRoot), 'repo');
        writeJsonl(fixture.mainPath, [
            runnerCommandLine('m1', 'node run-external-review.ts --slug "$SLUG" --review-dir "$PWD/docs/reviews/k" --caller-model x', '2026-10-12T10:00:00.000Z', repoDir)
        ]);
        writeRunnerResult(path.join(repoDir, 'docs', 'reviews', 'k'), 'runner-result.json', ['ext-k']);
        writeJsonl(sessionPath(fixture.projectDir, 'ext-k'), [usageLine('e1', 40, '2026-10-12T10:00:10.000Z')]);

        const result = await metrics();

        expect(result.external.totalTokens).toBe(40);
    });

    it('ignores sessions a reused review folder recorded for an earlier task', async () => {
        const reviewDir = path.join(path.dirname(fixture.projectsRoot), 'repo', 'docs', 'reviews', 'reused');
        writeJsonl(fixture.mainPath, [
            runnerCommandLine('m1', `node run-external-review.ts --review-dir ${reviewDir} --caller-model x`, '2026-10-12T10:00:00.000Z')
        ]);
        writeRunnerResult(reviewDir, 'runner-result.json', ['ext-old']);
        writeRunnerResult(reviewDir, 'runner-result-2.json', ['ext-new']);
        writeJsonl(sessionPath(fixture.projectDir, 'ext-old'), [usageLine('e1', 500, '2026-10-11T10:00:00.000Z')]);
        writeJsonl(sessionPath(fixture.projectDir, 'ext-new'), [usageLine('e2', 9, '2026-10-12T10:00:10.000Z')]);

        const result = await metrics();

        expect(result.external.totalTokens).toBe(9);
        expect(result.externalSessionCount).toBe(1);
    });

    it('adds the sessions of flow-workflow workers dispatched into a run folder', async () => {
        const runDir = path.join(path.dirname(fixture.projectsRoot), '.flow-workflow', 'report', 'run', '261014', 'a');
        writeJsonl(fixture.mainPath, [
            usageLine('m1', 100),
            runnerCommandLine('m2', `RUN=${runDir}\nderive-worker.ts launch "$RUN/brief.json" --run-dir "$RUN" --cwd "$RUN"`, '2026-10-12T10:00:00.000Z')
        ]);
        writeWorkflowWorker(runDir, '001', runDir);
        writeWorkflowWorker(runDir, '002', runDir);
        const workerDir = path.join(fixture.projectsRoot, getProjectDirName(runDir));
        writeJsonl(path.join(workerDir, 'w1.jsonl'), [workerPrompt(runDir, '001'), usageLine('w1', 300, '2026-10-12T10:00:20.000Z')]);
        writeJsonl(path.join(workerDir, 'w2.jsonl'), [workerPrompt(runDir, '002'), usageLine('w2', 200, '2026-10-12T10:05:00.000Z')]);
        writeJsonl(subagentPath(path.join(workerDir, 'w2.jsonl'), 'bbb222'), [usageLine('w2s', 7, '2026-10-12T10:06:00.000Z')]);
        writeJsonl(path.join(workerDir, 'other.jsonl'), [
            { type: 'user', timestamp: '2026-10-12T10:00:10.000Z', message: { content: 'unrelated work in the same folder' } },
            usageLine('o1', 999, '2026-10-12T10:00:30.000Z')
        ]);

        const result = await metrics();

        expect(result.main.totalTokens).toBe(101);
        expect(result.external.totalTokens).toBe(507);
        expect(result.externalSessionCount).toBe(2);
        expect(result.subagentTranscriptCount).toBe(0);
    });

    it('ignores worker sessions from before the workflow calls of this task', async () => {
        const runDir = path.join(path.dirname(fixture.projectsRoot), '.flow-workflow', 'report', 'run', '261014', 'b');
        writeJsonl(fixture.mainPath, [
            runnerCommandLine('m1', `derive-worker.ts status --run-dir ${runDir} --worker 001`, '2026-10-12T10:00:00.000Z')
        ]);
        writeWorkflowWorker(runDir, '001', runDir);
        const workerDir = path.join(fixture.projectsRoot, getProjectDirName(runDir));
        writeJsonl(path.join(workerDir, 'early.jsonl'), [workerPrompt(runDir, '001', '2026-10-11T10:00:00.000Z'), usageLine('w1', 300, '2026-10-11T10:00:20.000Z')]);
        const stalePath = path.join(workerDir, 'stale.jsonl');
        writeJsonl(stalePath, [workerPrompt(runDir, '001'), usageLine('w2', 200, '2026-10-12T10:00:20.000Z')]);
        const staleTime = new Date('2026-10-11T10:00:00.000Z');
        fs.utimesSync(stalePath, staleTime, staleTime);

        const result = await metrics();

        expect(result.external.totalTokens).toBe(0);
        expect(result.externalSessionCount).toBe(0);
    });

    it('reports zero usage when the main transcript is missing', async () => {
        const result = await metrics();

        expect(result.total.totalTokens).toBe(0);
    });

    it('uses a provided main scan instead of reading the main transcript again', async () => {
        writeJsonl(fixture.mainPath, [usageLine('m1', 100), runnerCall('m2', '261012-a-review')]);
        writeJsonl(subagentPath(fixture.mainPath, 'aaa111'), [usageLine('s1', 30)]);
        writeRunSessions('261012-a-review', { 'deepseek-v4-flash': ['ext-1'] });
        writeJsonl(sessionPath(fixture.projectDir, 'ext-1'), [usageLine('e1', 400, '2026-10-12T10:00:10.000Z')]);
        const mainScan = await scanTranscriptUsage(fixture.mainPath);
        const scannedPaths: string[] = [];

        const result = await getTaskUsageMetrics(fixture.mainPath, mainScan, {
            projectsRoot: fixture.projectsRoot,
            flowDevHome: fixture.flowDevHome,
            scanFile: (filePath) => {
                scannedPaths.push(filePath);
                return scanTranscriptUsage(filePath);
            }
        });

        expect(scannedPaths).not.toContain(fixture.mainPath);
        expect(result).toEqual(await metrics());
        expect(result.main.totalTokens).toBe(101);
        expect(result.subagents.totalTokens).toBe(30);
        expect(result.external.totalTokens).toBe(400);
    });
});
