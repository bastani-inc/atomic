const COPILOT_PROMPT_LIMIT_PATTERN = /\bprompt token count of ([\d,]+) exceeds the limit of ([\d,]+)/i;
const COPILOT_LONG_CONTEXT_GUIDANCE_MARKER = "Copilot long-context/usage-based billing";

export interface CopilotPromptLimitError {
	promptTokens: number;
	limitTokens: number;
}

function parseTokenCount(value: string): number {
	return Number(value.replace(/,/g, ""));
}

export function parseCopilotPromptLimitError(errorMessage: string): CopilotPromptLimitError | undefined {
	const match = COPILOT_PROMPT_LIMIT_PATTERN.exec(errorMessage);
	if (!match) return undefined;
	const promptTokenText = match[1];
	const limitTokenText = match[2];
	if (!promptTokenText || !limitTokenText) return undefined;
	const promptTokens = parseTokenCount(promptTokenText);
	const limitTokens = parseTokenCount(limitTokenText);
	if (!Number.isFinite(promptTokens) || !Number.isFinite(limitTokens)) return undefined;
	return { promptTokens, limitTokens };
}

export function isCopilotPromptLimitError(errorMessage: string): boolean {
	return parseCopilotPromptLimitError(errorMessage) !== undefined;
}

export function formatCopilotPromptLimitError(errorMessage: string): string {
	if (!isCopilotPromptLimitError(errorMessage) || errorMessage.includes(COPILOT_LONG_CONTEXT_GUIDANCE_MARKER)) {
		return errorMessage;
	}

	return `${errorMessage}\n\nGitHub Copilot rejected this prompt at the API/server context cap. Atomic raises the local token budget for selected larger context windows and sends X-GitHub-Api-Version: 2026-06-01 so Copilot can choose its long-context tier server-side by prompt token count, but GitHub still requires the account to have Copilot long-context/usage-based billing entitlement enabled. Long-context Copilot requests consume higher-cost AI credits. Reduce the session context, choose a smaller context window/model, or enable the required Copilot long-context/usage-based billing entitlement for this account.`;
}

export function formatCopilotProviderError(modelProvider: string, errorMessage: string): string {
	return modelProvider === "github-copilot" ? formatCopilotPromptLimitError(errorMessage) : errorMessage;
}
