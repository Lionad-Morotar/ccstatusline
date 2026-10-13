export interface TokenTotals {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    totalTokens: number;
}

/**
 * Token usage of a whole task: the main session, its subagents, and the
 * external review sessions that flow-agent launched for either of them.
 */
export interface TaskUsageMetrics {
    total: TokenTotals;
    main: TokenTotals;
    subagents: TokenTotals;
    external: TokenTotals;
    subagentTranscriptCount: number;
    externalSessionCount: number;
}
