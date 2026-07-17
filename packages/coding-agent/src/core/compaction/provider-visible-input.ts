import type { Api } from "@earendil-works/pi-ai/compat";

export type ProviderProjectionFamily =
	| "openai-responses"
	| "openai-chat"
	| "anthropic"
	| "google"
	| "bedrock"
	| "mistral"
	| "generic";

export interface ProviderVisibleInputProjection {
	value: unknown;
	family: ProviderProjectionFamily;
	source: string;
	sequenceKey?: "input" | "messages" | "contents";
	explicit: boolean;
	mediaUnbounded: boolean;
}

type JsonRecord = Record<string, unknown>;

const RESPONSE_KEYS = [
	"instructions", "input", "tools", "tool_choice", "text", "response_format", "reasoning",
	"temperature", "top_p", "parallel_tool_calls", "previous_response_id", "conversation", "modalities",
] as const;
const CHAT_KEYS = [
	"messages", "tools", "tool_choice", "response_format", "reasoning", "reasoning_effort", "thinking",
	"enable_thinking", "chat_template_kwargs", "temperature", "top_p", "top_k", "parallel_tool_calls",
	"stop", "seed", "verbosity",
] as const;
const ANTHROPIC_KEYS = [
	"system", "messages", "tools", "tool_choice", "thinking", "output_config", "temperature", "top_p",
	"top_k", "stop_sequences",
] as const;
const BEDROCK_KEYS = [
	"system", "messages", "toolConfig", "additionalModelRequestFields", "guardrailConfig",
] as const;
const BEDROCK_INFERENCE_KEYS = ["temperature", "topP", "stopSequences"] as const;
const MISTRAL_KEYS = [
	"messages", "tools", "toolChoice", "responseFormat", "promptMode", "reasoningEffort",
	"temperature", "topP", "parallelToolCalls",
] as const;
const GOOGLE_CONFIG_KEYS = [
	"systemInstruction", "tools", "toolConfig", "thinkingConfig", "temperature", "topP", "topK",
	"responseMimeType", "responseSchema", "responseJsonSchema", "stopSequences", "seed", "safetySettings",
] as const;
const MEDIA_BLOCK_TYPES = new Set([
	"image", "image_url", "input_image", "file", "input_file", "input_audio", "audio", "inline_data", "inlineData",
]);

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function select(record: JsonRecord, keys: readonly string[]): JsonRecord {
	const selected: JsonRecord = {};
	for (const key of keys) {
		if (Object.hasOwn(record, key) && record[key] !== undefined) selected[key] = record[key];
	}
	return selected;
}

function googleProjection(record: JsonRecord): JsonRecord {
	const selected: JsonRecord = {};
	if (record.contents !== undefined) selected.contents = record.contents;
	if (isRecord(record.config)) {
		const config = select(record.config, GOOGLE_CONFIG_KEYS);
		if (Object.keys(config).length > 0) selected.config = config;
	}
	return selected;
}

function bedrockProjection(record: JsonRecord): JsonRecord {
	const selected = select(record, BEDROCK_KEYS);
	if (isRecord(record.inferenceConfig)) {
		const inferenceConfig = select(record.inferenceConfig, BEDROCK_INFERENCE_KEYS);
		if (Object.keys(inferenceConfig).length > 0) selected.inferenceConfig = inferenceConfig;
	}
	return selected;
}

function hasUnboundedMedia(value: unknown, ancestors: WeakSet<object>): boolean {
	if (!value || typeof value !== "object") return false;
	if (ancestors.has(value)) return false;
	ancestors.add(value);
	try {
		if (Array.isArray(value)) return value.some((item) => hasUnboundedMedia(item, ancestors));
		const record = value as JsonRecord;
		if (typeof record.type === "string" && MEDIA_BLOCK_TYPES.has(record.type)) return true;
		if (record.inlineData !== undefined || record.inline_data !== undefined) return true;
		return Object.values(record).some((item) => hasUnboundedMedia(item, ancestors));
	} finally {
		ancestors.delete(value);
	}
}

function explicitProjection(
	value: JsonRecord,
	family: Exclude<ProviderProjectionFamily, "generic">,
	source: string,
	sequenceKey: ProviderVisibleInputProjection["sequenceKey"],
): ProviderVisibleInputProjection {
	return {
		value, family, source, sequenceKey, explicit: true,
		mediaUnbounded: hasUnboundedMedia(value, new WeakSet<object>()),
	};
}

/**
 * Select only model-visible input fields from installed adapter payload families.
 * Media blocks are marked unbounded because serialized base64/URLs do not provide
 * a defensible token upper bound; callers must degrade to unavailable confidence.
 */
export function projectProviderVisibleInput(payload: unknown, api: Api): ProviderVisibleInputProjection {
	if (!isRecord(payload)) {
		return {
			value: payload, family: "generic", source: "generic-provider-payload-unavailable",
			explicit: false, mediaUnbounded: false,
		};
	}
	if (api === "openai-responses" || api === "openai-codex-responses" || api === "azure-openai-responses") {
		return explicitProjection(select(payload, RESPONSE_KEYS), "openai-responses", "openai-responses-provider-visible-input", "input");
	}
	if (api === "openai-completions") {
		return explicitProjection(select(payload, CHAT_KEYS), "openai-chat", "openai-chat-provider-visible-input", "messages");
	}
	if (api === "anthropic-messages") {
		return explicitProjection(select(payload, ANTHROPIC_KEYS), "anthropic", "anthropic-provider-visible-input", "messages");
	}
	if (api === "google-generative-ai" || api === "google-vertex") {
		return explicitProjection(googleProjection(payload), "google", "google-provider-visible-input", "contents");
	}
	if (api === "bedrock-converse-stream") {
		return explicitProjection(bedrockProjection(payload), "bedrock", "bedrock-provider-visible-input", "messages");
	}
	if (api === "mistral-conversations") {
		return explicitProjection(select(payload, MISTRAL_KEYS), "mistral", "mistral-provider-visible-input", "messages");
	}
	return {
		value: payload, family: "generic", source: "generic-provider-payload-heuristic", explicit: false,
		mediaUnbounded: hasUnboundedMedia(payload, new WeakSet<object>()),
	};
}
