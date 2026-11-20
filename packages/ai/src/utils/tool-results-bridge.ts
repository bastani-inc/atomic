/**
 * The fixed assistant message some endpoints need between tool results and a following user message, because their
 * templates reject a user message directly after a tool message. It is the same text on every request, so a cached
 * prefix that includes it stays valid.
 */
export const TOOL_RESULTS_BRIDGE_TEXT = "I have processed the tool results.";
