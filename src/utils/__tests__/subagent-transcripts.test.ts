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

import { listSubagentTranscripts } from '../subagent-transcripts';

let root = '';
let transcriptPath = '';

function touch(...segments: string[]): string {
    const filePath = path.join(root, ...segments);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '');
    return filePath;
}

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-transcripts-'));
    transcriptPath = path.join(root, 'session.jsonl');
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

describe('listSubagentTranscripts', () => {
    it('returns referenced agents from both the shared and the session folder', () => {
        const shared = touch('subagents', 'agent-a.jsonl');
        touch('subagents', 'agent-other.jsonl');
        const own = touch('session', 'subagents', 'agent-b.jsonl');
        touch('session', 'subagents', 'agent-unreferenced.jsonl');

        expect(listSubagentTranscripts(transcriptPath, new Set(['a', 'b']))).toEqual([shared, own]);
    });

    it('finds referenced workflow agents nested under the session folder', () => {
        const nested = touch('session', 'subagents', 'workflows', 'wf_1', 'agent-w.jsonl');

        expect(listSubagentTranscripts(transcriptPath, new Set(['w']))).toEqual([nested]);
    });

    it('returns nothing when no agent is referenced and unreferenced files are not wanted', () => {
        touch('session', 'subagents', 'agent-b.jsonl');

        expect(listSubagentTranscripts(transcriptPath, new Set())).toEqual([]);
    });

    it('returns every session agent, but still only referenced shared ones, when unreferenced files are wanted', () => {
        touch('subagents', 'agent-other.jsonl');
        const own = touch('session', 'subagents', 'agent-b.jsonl');
        const nested = touch('session', 'subagents', 'workflows', 'wf_1', 'agent-w.jsonl');
        touch('session', 'subagents', 'workflows', 'wf_1', 'journal.jsonl');
        touch('session', 'subagents', 'agent-b.meta.json');

        expect(listSubagentTranscripts(transcriptPath, new Set(), { includeUnreferenced: true })).toEqual([own, nested]);
    });

    it('stops descending past three folder levels', () => {
        const deepest = touch('session', 'subagents', 'l1', 'l2', 'l3', 'agent-ok.jsonl');
        touch('session', 'subagents', 'l1', 'l2', 'l3', 'l4', 'agent-too-deep.jsonl');

        expect(listSubagentTranscripts(transcriptPath, new Set(), { includeUnreferenced: true })).toEqual([deepest]);
    });
});
