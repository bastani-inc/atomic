import type { Api, CacheRetention, Model } from "@bastani/atomic-ai/compat";

// Extended retention is model-specific, not implied by ordinary prompt caching.
// https://developers.openai.com/api/docs/guides/prompt-caching#extended-retention-models
const OPENAI_EXTENDED_RETENTION_MODELS = [
	"gpt-5.5",
	"gpt-5.5-pro",
	"gpt-5.4",
	"gpt-5.2",
	"gpt-5.1-codex-max",
	"gpt-5.1",
	"gpt-5.1-codex",
	"gpt-5.1-codex-mini",
	"gpt-5.1-chat-latest",
	"gpt-5",
	"gpt-5-codex",
	"gpt-4.1",
];

function supportsOpenAILongCache(model: Model<"openai-responses" | "openai-completions">): boolean {
	const compat = model.compat;
	if (compat?.supportsLongCacheRetention !== undefined) return compat.supportsLongCacheRetention;
	if (
		model.api === "openai-responses" &&
		compat &&
		"supportsExplicitPromptCacheMode" in compat &&
		compat.supportsExplicitPromptCacheMode
	)
		return true;
	const upstreamId = model.fastRoute?.upstreamModelId ?? model.id;
	// Built-in gateways can route OpenAI models without an openai/ ID prefix.
	const gatewayOpenAI =
		["cloudflare-ai-gateway", "github-copilot", "opencode", "opencode-go"].includes(model.provider) &&
		/^(?:gpt-|o\d)/.test(upstreamId);
	if (
		model.provider !== "openai" &&
		!gatewayOpenAI &&
		!model.baseUrl.includes("api.openai.com") &&
		!upstreamId.startsWith("openai/")
	)
		return true;
	// Accept gateway prefixes, pinned snapshots and fast routes, but not unsupported mini/nano variants.
	const id = upstreamId.replace(/^openai\//, "").replace(/-\d{4}-\d{2}-\d{2}$/, "");
	return OPENAI_EXTENDED_RETENTION_MODELS.includes(id);
}

function supportsBedrockLongCache(model: Model<Api>): boolean {
	// IDs include regional prefixes and ARN paths. Application profiles instead use the display name.
	// https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html#prompt-caching-models
	const candidates = [model.id, model.name].map((value) => value.toLowerCase().replace(/[.\s_]+/g, "-"));
	return candidates.some((value) =>
		/claude-(?:(?:opus|sonnet|haiku)-4-[5-9](?:\D|$)|(?:opus|sonnet|fable|mythos)-5(?:\D|$)|mythos-preview)/.test(
			value,
		),
	);
}

/** Only the implicit session default is inferred; explicit preferences remain provider-controlled. */
export function getDefaultCacheRetention(model: Model<Api>): CacheRetention {
	switch (model.api) {
		case "openai-responses":
		case "openai-completions":
			return supportsOpenAILongCache(model as Model<"openai-responses" | "openai-completions">) ? "long" : "short";
		case "bedrock-converse-stream":
			return supportsBedrockLongCache(model) ? "long" : "short";
		default:
			// Other APIs retain their existing provider capability gates.
			return "long";
	}
}
