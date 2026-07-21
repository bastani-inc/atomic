const CODEX_INVALIDATED_TOKEN_PATTERN = /\binvalidated\s+(?:oauth|auth)\s+token\b|\btoken_revoked\b/i;
const CODEX_RECOVERY_GUIDANCE =
	"This Codex session may no longer be valid. Retry the request once in case the rejection is transient. If it persists, run `/logout` and select OpenAI ChatGPT Plus/Pro. Then run `/login`, authenticate OpenAI ChatGPT Plus/Pro again, and retry the request.";

export function isCodexTokenInvalidationError(provider: string, errorMessage: string | undefined): boolean {
	return provider === "openai-codex" && errorMessage !== undefined && CODEX_INVALIDATED_TOKEN_PATTERN.test(errorMessage);
}

export function formatCodexProviderError(provider: string, errorMessage: string): string {
	if (!isCodexTokenInvalidationError(provider, errorMessage) || errorMessage.includes(CODEX_RECOVERY_GUIDANCE)) {
		return errorMessage;
	}
	return `${errorMessage}\n\n${CODEX_RECOVERY_GUIDANCE}`;
}
