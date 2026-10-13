/**
 * Adds every non-empty `agentId` string found anywhere in a transcript record.
 *
 * @remarks
 * Claude Code has moved the subagent id between record shapes across
 * versions (progress payloads, `toolUseResult`), so the walk is structural
 * rather than tied to one path.
 */
export function collectAgentIds(value: unknown, agentIds: Set<string>): void {
    if (!value || typeof value !== 'object') {
        return;
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            collectAgentIds(item, agentIds);
        }
        return;
    }

    for (const [key, nestedValue] of Object.entries(value)) {
        if (key === 'agentId' && typeof nestedValue === 'string' && nestedValue.trim() !== '') {
            agentIds.add(nestedValue);
            continue;
        }

        collectAgentIds(nestedValue, agentIds);
    }
}
