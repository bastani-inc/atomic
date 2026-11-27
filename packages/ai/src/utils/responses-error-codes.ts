import type { AssistantMessageDiagnostic } from "./diagnostics.ts";

/** Explicit OpenAI Responses and Codex codes, independent of HTTP status and display text. */
export function responsesErrorKind(
	code: unknown,
): "context_overflow" | "quota_exhausted" | "rate_limit" | "provider_unavailable" | "request_incompatible" | undefined {
	if (typeof code !== "string") return undefined;
	switch (code.trim().toLowerCase()) {
		case "context_length_exceeded":
		case "context_window_exceeded":
			return "context_overflow";
		case "api_key_spend_limit_exceeded":
		case "credit_balance_exhausted":
		case "insufficient_quota":
		case "organization_spend_limit_exceeded":
		case "organization_usage_limit_exceeded":
		case "project_spend_limit_exceeded":
		case "quota_exceeded":
		case "usage_limit":
		case "usage_limit_exceeded":
		case "usage_limit_reached":
		case "usage_not_included":
			return "quota_exhausted";
		case "rate_limit_exceeded":
		case "slow_down":
			return "rate_limit";
		case "policy_capacity_unavailable":
		case "server_error":
		case "server_is_overloaded":
			return "provider_unavailable";
		case "invalid_prompt":
			return "request_incompatible";
		default:
			return undefined;
	}
}

export function responsesErrorRetryability(code: unknown): boolean | undefined {
	const kind = responsesErrorKind(code);
	return kind === undefined ? undefined : kind === "rate_limit" || kind === "provider_unavailable";
}

export function responsesDiagnosticCode(diagnostic: AssistantMessageDiagnostic): unknown {
	if (diagnostic.type === "provider_response_failure") return diagnostic.details?.errorCode;
	// Older Codex streams saved their code under this diagnostic instead of the common response failure.
	if (diagnostic.type === "codex_response_failure") return diagnostic.error?.code;
	return undefined;
}
