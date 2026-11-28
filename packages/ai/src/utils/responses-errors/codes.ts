import type { AssistantMessageDiagnostic } from "../diagnostics.ts";

// Keep this cross-package entry in a new directory: Bun processes can hold the old utilities directory across updates.

const PROVIDER_QUOTA_CODES: ReadonlySet<string> = new Set([
	"api_key_spend_limit_exceeded",
	"credit_balance_exhausted",
	"insufficient_quota",
	"organization_spend_limit_exceeded",
	"organization_usage_limit_exceeded",
	"payment_required",
	"project_spend_limit_exceeded",
	"quota_exceeded",
	"servicequotaexceededexception",
	"subscription_sharing_usage_limit_exceeded",
	"subscription_sharing_workplace_individual_usage_limit_exceeded",
	"usage_limit",
	"usage_limit_exceeded",
	"usage_limit_reached",
	"usage_not_included",
	// OpenCode's subscription/free tier and Zhipu/Z.ai's plan limit use HTTP 429.
	"gousagelimiterror",
	"freeusagelimiterror",
	"1308",
]);

export function isProviderQuotaCode(code: unknown): boolean {
	if (typeof code === "number") return PROVIDER_QUOTA_CODES.has(String(code));
	return typeof code === "string" && PROVIDER_QUOTA_CODES.has(code.trim().toLowerCase());
}

/** Explicit provider error codes, independent of HTTP status and display text. */
export function responsesErrorKind(
	code: unknown,
): "context_overflow" | "quota_exhausted" | "rate_limit" | "provider_unavailable" | "request_incompatible" | undefined {
	if (isProviderQuotaCode(code)) return "quota_exhausted";
	if (typeof code !== "string") return undefined;
	switch (code.trim().toLowerCase()) {
		case "context_length_exceeded":
		case "context_window_exceeded":
			return "context_overflow";
		case "rate_limit_exceeded":
		case "slow_down":
			return "rate_limit";
		case "policy_capacity_unavailable":
		case "server_error":
		case "server_is_overloaded":
			return "provider_unavailable";
		case "invalid_prompt":
		case "idempotency_conflict":
			return "request_incompatible";
		default:
			return undefined;
	}
}

/** Account quota or credit exhaustion, not temporary limits (including free text about per-minute quotas). */
export function isProviderQuotaExhaustionText(message: string): boolean {
	// Some SDKs keep the exact quota exception or status but not the JSON body.
	if (
		/^(?:HTTP\s+)?402(?:\s|:|$)|\(402\):|^\s*(?:429[\s:]*)?quota exceeded\.?\s*$|payment[_\s-]*required|insufficient[_\s-]*quota/i.test(
			message,
		)
	)
		return true;
	for (const [name] of message.matchAll(/\b(?:[A-Za-z]+(?:Error|Exception)|subscription_sharing_[a-z_]+)\b/gi)) {
		if (isProviderQuotaCode(name)) return true;
	}
	// Real out-of-credit wording, including Anthropic's HTTP 400 and OpenRouter's affordability error.
	if (
		/credit\s+balance\s+is\s+too\s+low|insufficient[_\s-]*(?:credits?|balance|funds)|(?:requires|purchase|buy|add)\s+more\s+credits|used\s+all\s+(?:of\s+)?(?:your\s+)?available\s+credits|out\s+of\s+(?:credits?|budget)|spending\s+limit|available\s+balance|check\s+your\s+plan\s+and\s+billing|monthly\s+usage\s+limit\s+reached|billing\s+hard\s+limit/i.test(
			message,
		)
	)
		return true;
	if (/"quotaId"\s*:\s*"[^"]*PerDay/i.test(message)) return true;
	for (const [, quotedCode, numericCode] of message.matchAll(
		/"(?:code|type|error_code)"\s*:\s*(?:"([a-z0-9_]+)"|(\d+)(?=\s*[,}\]]|\s*$))/gi,
	)) {
		if (isProviderQuotaCode(quotedCode ?? numericCode)) return true;
	}
	return false;
}

export function responsesErrorRetryability(code: unknown): boolean | undefined {
	const kind = responsesErrorKind(code);
	return kind === undefined ? undefined : kind === "rate_limit" || kind === "provider_unavailable";
}

/** OpenAI SDK HTTP failures expose the API error's code and type on the exception. */
export function skipOpenAIProviderRetry(error: Error): boolean {
	if (!("status" in error) || !("error" in error)) return false;
	const code = "code" in error && typeof error.code === "string" && error.code ? error.code : undefined;
	const type = "type" in error ? error.type : undefined;
	return responsesErrorRetryability(code ?? type) === false;
}

export function responsesDiagnosticCode(diagnostic: AssistantMessageDiagnostic): unknown {
	if (diagnostic.type === "provider_response_failure") return diagnostic.details?.errorCode;
	// Older Codex streams saved their code under this diagnostic instead of the common response failure.
	if (diagnostic.type === "codex_response_failure") return diagnostic.error?.code;
	return undefined;
}
