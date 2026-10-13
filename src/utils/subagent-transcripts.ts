import * as fs from 'fs';
import path from 'node:path';

const SUBAGENT_FILE_PATTERN = /^agent-(.+)\.jsonl$/;
const MAX_SESSION_SUBAGENT_DEPTH = 3;

export interface SubagentTranscriptOptions {
    /**
     * Also return files under the session's own folder that the transcript
     * never references, such as workflow agents.
     */
    includeUnreferenced?: boolean;
}

function readDirEntries(dirPath: string): fs.Dirent[] {
    try {
        return fs.readdirSync(dirPath, { withFileTypes: true })
            .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
        return [];
    }
}

function collectSubagentFiles(
    dirPath: string,
    maxDepth: number,
    accept: (agentId: string) => boolean,
    paths: string[]
): void {
    for (const entry of readDirEntries(dirPath)) {
        const entryPath = path.join(dirPath, entry.name);
        if (entry.isFile()) {
            const agentId = SUBAGENT_FILE_PATTERN.exec(entry.name)?.[1];
            if (agentId && accept(agentId)) {
                paths.push(entryPath);
            }
        } else if (entry.isDirectory() && maxDepth > 0) {
            collectSubagentFiles(entryPath, maxDepth - 1, accept, paths);
        }
    }
}

/**
 * Lists the subagent transcripts that belong to a transcript.
 *
 * @remarks
 * Claude Code has stored them in two places: a legacy `subagents` folder next
 * to the transcript, shared by every session in the project, and the current
 * `<session>/subagents` folder, where workflow agents sit a few levels deeper
 * (`workflows/<run>/`). The shared folder only ever yields referenced ids.
 */
export function listSubagentTranscripts(
    transcriptPath: string,
    referencedAgentIds: ReadonlySet<string>,
    options: SubagentTranscriptOptions = {}
): string[] {
    const transcriptDir = path.dirname(transcriptPath);
    const sharedDir = path.join(transcriptDir, 'subagents');
    const sessionDir = path.join(transcriptDir, path.parse(transcriptPath).name, 'subagents');
    const isReferenced = (agentId: string) => referencedAgentIds.has(agentId);

    const paths: string[] = [];
    if (referencedAgentIds.size > 0) {
        collectSubagentFiles(sharedDir, 0, isReferenced, paths);
    }
    if (options.includeUnreferenced || referencedAgentIds.size > 0) {
        collectSubagentFiles(
            sessionDir,
            MAX_SESSION_SUBAGENT_DEPTH,
            options.includeUnreferenced ? () => true : isReferenced,
            paths
        );
    }
    return paths;
}
