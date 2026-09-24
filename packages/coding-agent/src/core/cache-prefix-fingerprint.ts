import { createHash } from "node:crypto";

/** Hash-only fingerprint of one tool declaration, keyed by name for stable attribution. */
export interface CachePrefixToolFingerprint {
	name: string;
	hash: string;
}

/**
 * Hash-only fingerprint of a provider request prefix, computed from the final payload
 * returned by `onPayload` (after extension `before_provider_request` and payload
 * sanitization). Never carries prompt text, tool schemas, or message content: every
 * field is either a hash or a bare tool name. Anthropic `cache_control` breakpoint
 * markers are stripped before hashing, at any depth.
 */
export interface CachePrefixFingerprint {
	modelHash: string;
	tools: CachePrefixToolFingerprint[];
	systemHash: string;
	paramsHash: string;
	messageHashes: string[];
}

export interface CachePrefixModelIdentity {
	provider: string;
	modelId: string;
}

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

const CACHE_BREAKPOINT_KEY = "cache_control";

/** Recursively remove Anthropic `cache_control` breakpoint markers from a payload before hashing. */
function stripCacheBreakpoints(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stripCacheBreakpoints);
	const record = asRecord(value);
	if (!record) return value;
	const cleaned: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(record)) {
		if (key === CACHE_BREAKPOINT_KEY) continue;
		cleaned[key] = stripCacheBreakpoints(entry);
	}
	return cleaned;
}

function extractToolName(tool: unknown): string | undefined {
	const record = asRecord(tool);
	if (!record) return undefined;
	if (typeof record.name === "string") return record.name;
	const fn = asRecord(record.function);
	if (fn && typeof fn.name === "string") return fn.name;
	const toolSpec = asRecord(record.toolSpec);
	if (toolSpec && typeof toolSpec.name === "string") return toolSpec.name;
	return undefined;
}

function extractSystemSegment(payload: Record<string, unknown>): { text: string; consumedFirstMessage: boolean } {
	if (typeof payload.system === "string") return { text: payload.system, consumedFirstMessage: false };
	if (payload.system !== undefined) return { text: JSON.stringify(payload.system), consumedFirstMessage: false };
	const messages = Array.isArray(payload.messages) ? payload.messages : [];
	const first = asRecord(messages[0]);
	if (first?.role === "system") return { text: JSON.stringify(first.content ?? ""), consumedFirstMessage: true };
	return { text: "", consumedFirstMessage: false };
}

/**
 * Compute the hash-only fingerprint of a provider request from its final payload
 * (the value returned by `onPayload`, after extension hooks and sanitization).
 * `cache_control` breakpoint markers are stripped before any hashing.
 */
export function computeCachePrefixFingerprint(
	payload: unknown,
	model: CachePrefixModelIdentity,
): CachePrefixFingerprint {
	const cleaned = asRecord(stripCacheBreakpoints(payload)) ?? {};
	const { text: systemText, consumedFirstMessage } = extractSystemSegment(cleaned);
	const rawTools = Array.isArray(cleaned.tools) ? cleaned.tools : [];
	const tools = rawTools
		.map((tool) => ({ name: extractToolName(tool), hash: hash(JSON.stringify(tool)) }))
		.filter((tool): tool is CachePrefixToolFingerprint => tool.name !== undefined);
	const rawMessages = Array.isArray(cleaned.messages) ? cleaned.messages : [];
	const messages = consumedFirstMessage ? rawMessages.slice(1) : rawMessages;
	const { model: _model, system: _system, tools: _tools, messages: _messages, ...requestParams } = cleaned;
	return {
		modelHash: hash(`${model.provider}/${model.modelId}`),
		tools,
		systemHash: hash(systemText),
		paramsHash: hash(JSON.stringify(requestParams)),
		messageHashes: messages.map((message) => hash(JSON.stringify(message))),
	};
}

/**
 * Describe the first request segment that differs between two fingerprints, in the
 * order model, tools, system prompt, request params, messages. A tool whose name is
 * new is `+name`; a name present before and now absent is `-name`. Changes to
 * existing declarations or tool order are reported without a tool name. Never
 * returns prompt content: tool names are bare identifiers, and rewritten messages
 * are named by their 1-based position only.
 */
export function describeCachePrefixDifference(
	previous: CachePrefixFingerprint | undefined,
	current: CachePrefixFingerprint,
): string {
	if (!previous) return "prefix unchanged";
	if (previous.modelHash !== current.modelHash) return "model switched";
	const previousNames = new Set(previous.tools.map((tool) => tool.name));
	const currentNames = new Set(current.tools.map((tool) => tool.name));
	for (const tool of current.tools) {
		if (!previousNames.has(tool.name)) return `tool list changed: +${tool.name}`;
	}
	for (const tool of previous.tools) {
		if (!currentNames.has(tool.name)) return `tool list changed: -${tool.name}`;
	}
	if (
		previous.tools.some(
			(tool, index) => tool.name !== current.tools[index]?.name || tool.hash !== current.tools[index]?.hash,
		)
	)
		return "tool list changed";
	if (previous.systemHash !== current.systemHash) return "system prompt changed";
	if (previous.paramsHash !== current.paramsHash) return "request params changed";
	const commonLength = Math.min(previous.messageHashes.length, current.messageHashes.length);
	for (let index = 0; index < commonLength; index++) {
		if (previous.messageHashes[index] !== current.messageHashes[index]) return `message ${index + 1} rewritten`;
	}
	return "prefix unchanged";
}

export function isCachePrefixFingerprint(data: unknown): data is CachePrefixFingerprint {
	const candidate = asRecord(data);
	if (!candidate) return false;
	return (
		typeof candidate.modelHash === "string" &&
		Array.isArray(candidate.tools) &&
		candidate.tools.every(
			(tool) =>
				typeof tool === "object" && tool !== null && typeof tool.name === "string" && typeof tool.hash === "string",
		) &&
		typeof candidate.systemHash === "string" &&
		typeof candidate.paramsHash === "string" &&
		Array.isArray(candidate.messageHashes) &&
		candidate.messageHashes.every((entry) => typeof entry === "string")
	);
}

export const CACHE_PREFIX_CUSTOM_TYPE = "cache_prefix";
