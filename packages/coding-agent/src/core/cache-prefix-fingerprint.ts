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
 * field is a hash, a bare tool name, a count, or a short attribution label. Anthropic
 * `cache_control` and Bedrock `cachePoint` breakpoint markers are stripped before hashing.
 *
 * The message segment is a sparse delta: `messageChanges` holds `[index, hash]` pairs
 * only for positions that differ from the baseline list (rewritten or appended
 * messages), and `messageCount` truncates the baseline. With `baselineReset` the
 * baseline is empty (first request, or first request after a compaction/branch-summary
 * boundary); otherwise it is the previous request's reconstructed list.
 *
 * `attribution` is the first-differing-segment label computed when the request was
 * sent, or absent without a previous fingerprint; live and resumed notices agree.
 */
export interface CachePrefixFingerprint {
	modelHash: string;
	tools: CachePrefixToolFingerprint[];
	systemHash: string;
	paramsHash: string;
	shapeUnknown?: true;
	messageCount: number;
	baselineReset: boolean;
	messageChanges: Array<[number, string]>;
	attribution?: string;
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

const CACHE_BREAKPOINT_KEYS = new Set(["cache_control", "cachePoint"]);

function isEmptyRecord(value: unknown): boolean {
	const record = asRecord(value);
	return record !== undefined && Object.keys(record).length === 0;
}

/**
 * Recursively remove Anthropic `cache_control` and Bedrock `cachePoint` breakpoint
 * markers from a payload before hashing. A breakpoint carried as an object key
 * (Anthropic) is deleted from that object; a breakpoint carried as its own array
 * element (Bedrock's `{ cachePoint: {...} }` entries in `system`, `toolConfig.tools`,
 * and message `content` arrays, which move position between requests) collapses to
 * an empty object and is filtered out of the array entirely.
 */
function stripCacheBreakpoints(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(stripCacheBreakpoints).filter((entry) => !isEmptyRecord(entry));
	}
	const record = asRecord(value);
	if (!record) return value;
	const cleaned: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(record)) {
		if (CACHE_BREAKPOINT_KEYS.has(key)) continue;
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

interface PayloadSegments {
	systemText: string;
	tools: unknown[];
	messages: unknown[];
	params: Record<string, unknown>;
	shapeKnown: boolean;
}

const OUTPUT_LIMIT_KEYS = new Set([
	"max_tokens",
	"max_output_tokens",
	"max_completion_tokens",
	"maxTokens",
	"maxOutputTokens",
]);

function withoutOutputLimits(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutOutputLimits);
	const record = asRecord(value);
	if (!record) return value;
	const cleaned: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(record)) {
		if (OUTPUT_LIMIT_KEYS.has(key)) continue;
		cleaned[key] = withoutOutputLimits(entry);
	}
	return cleaned;
}

function omit(record: Record<string, unknown> | undefined, ...keys: string[]): Record<string, unknown> {
	if (!record) return {};
	const rest: Record<string, unknown> = { ...record };
	for (const key of keys) delete rest[key];
	return rest;
}

function stringify(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value ?? "");
}

/** Radius `pi-messages`: `{ model, context: { messages }, options }`, whose leading system message declares the base prompt and tools. */
function transcriptSegments(payload: Record<string, unknown>, context: Record<string, unknown>): PayloadSegments {
	const messages = Array.isArray(context.messages) ? context.messages : [];
	const head = asRecord(messages[0]);
	const headIsSystem = head?.role === "system";
	return {
		systemText: headIsSystem ? stringify({ content: head.content, sections: head.sections }) : "",
		tools: headIsSystem && Array.isArray(head.toolsAdded) ? head.toolsAdded : [],
		messages: headIsSystem ? messages.slice(1) : messages,
		params: { ...omit(payload, "model", "context"), ...omit(context, "messages") },
		shapeKnown: true,
	};
}

/**
 * Split a final provider payload into segments. Message lists: Anthropic/Bedrock/Chat
 * Completions/Mistral `messages`, OpenAI Responses/Codex `input`, Google `contents`,
 * Radius `context.messages`. Tools: top-level `tools`, Bedrock `toolConfig.tools`, Google
 * `config.tools[].functionDeclarations`. A payload with none of these is `shapeKnown: false`.
 */
function extractSegments(payload: Record<string, unknown>): PayloadSegments {
	const context = asRecord(payload.context);
	if (context && Array.isArray(context.messages)) return transcriptSegments(payload, context);
	const rawMessages = Array.isArray(payload.messages)
		? payload.messages
		: Array.isArray(payload.input)
			? payload.input
			: Array.isArray(payload.contents)
				? payload.contents
				: undefined;
	const toolConfig = asRecord(payload.toolConfig);
	const config = asRecord(payload.config);
	let tools: unknown[] = [];
	if (Array.isArray(payload.tools)) tools = payload.tools;
	else if (toolConfig && Array.isArray(toolConfig.tools)) tools = toolConfig.tools;
	else if (config && Array.isArray(config.tools)) {
		for (const entry of config.tools) {
			const declarations = asRecord(entry)?.functionDeclarations;
			if (Array.isArray(declarations)) tools.push(...declarations);
			else tools.push(entry);
		}
	}
	let systemText = "";
	let messages = rawMessages ?? [];
	if (payload.system !== undefined) systemText = stringify(payload.system);
	else if (typeof payload.instructions === "string") systemText = payload.instructions;
	else if (config?.systemInstruction !== undefined) systemText = stringify(config.systemInstruction);
	else {
		const first = asRecord(messages[0]);
		if (first?.role === "system" || first?.role === "developer") {
			systemText = stringify(first.content ?? "");
			messages = messages.slice(1);
		}
	}
	return {
		systemText,
		tools,
		messages,
		params: {
			...omit(
				payload,
				"model",
				"system",
				"instructions",
				"tools",
				"toolConfig",
				"config",
				"messages",
				"input",
				"contents",
			),
			...omit(toolConfig, "tools"),
			...omit(config, "systemInstruction", "tools"),
		},
		shapeKnown: rawMessages !== undefined,
	};
}

/** Equate only the Anthropic single-text-block wire form with its plain-string form. */
function messageForHash(message: unknown): unknown {
	const record = asRecord(message);
	const content = record?.content;
	if (!Array.isArray(content) || content.length !== 1) return message;
	const block = asRecord(content[0]);
	if (block?.type !== "text" || typeof block.text !== "string" || Object.keys(block).length !== 2) return message;
	return { ...record, content: block.text };
}

/**
 * Compute the hash-only fingerprint of a provider request from its final payload
 * (the value returned by `onPayload`, after extension hooks and sanitization).
 * Breakpoint markers and output-token limits are excluded before hashing.
 *
 * `previousMessageHashes` is the previous request's full reconstructed message-hash
 * list (see `reconstructMessageHashes`); only differing and appended positions are
 * stored. Omit it for a first request or after a compaction boundary, which stores a
 * snapshot against an empty baseline.
 */
export function computeCachePrefixFingerprint(
	payload: unknown,
	model: CachePrefixModelIdentity,
	previousMessageHashes?: readonly string[],
): CachePrefixFingerprint {
	const cleaned = asRecord(stripCacheBreakpoints(payload)) ?? {};
	const segments = extractSegments(cleaned);
	const tools = segments.tools
		.map((tool) => ({ name: extractToolName(tool), hash: hash(JSON.stringify(tool)) }))
		.filter((tool): tool is CachePrefixToolFingerprint => tool.name !== undefined);
	const messageHashes = segments.messages.map((message) => hash(JSON.stringify(messageForHash(message))));
	const baseline = previousMessageHashes ?? [];
	const messageChanges: Array<[number, string]> = [];
	messageHashes.forEach((messageHash, index) => {
		if (baseline[index] !== messageHash) messageChanges.push([index, messageHash]);
	});
	return {
		modelHash: hash(`${model.provider}/${model.modelId}`),
		tools,
		systemHash: hash(segments.systemText),
		paramsHash: hash(JSON.stringify(withoutOutputLimits(segments.params))),
		...(segments.shapeKnown ? {} : { shapeUnknown: true as const }),
		messageCount: messageHashes.length,
		baselineReset: previousMessageHashes === undefined,
		messageChanges,
	};
}

/**
 * Reconstruct a fingerprint's full message-hash list from its sparse delta and the
 * previous request's full list (ignored when the fingerprint reset its baseline).
 */
export function reconstructMessageHashes(
	fingerprint: CachePrefixFingerprint,
	previousMessageHashes: readonly string[],
): string[] {
	const hashes = fingerprint.baselineReset ? [] : previousMessageHashes.slice(0, fingerprint.messageCount);
	for (const [index, messageHash] of fingerprint.messageChanges) hashes[index] = messageHash;
	hashes.length = fingerprint.messageCount;
	return hashes;
}

/**
 * Describe the first request segment that differs between the previous request and
 * `current`, in the order model, tools, system prompt, request params, messages.
 * `previousMessageHashes` is the previous request's full reconstructed message list.
 * Never returns prompt content: tool names are bare identifiers and a rewritten message
 * is named by its exact 1-based position.
 */
export function describeCachePrefixDifference(
	previous: CachePrefixFingerprint | undefined,
	previousMessageHashes: readonly string[],
	current: CachePrefixFingerprint,
): string | undefined {
	if (!previous) return undefined;
	if (previous.modelHash !== current.modelHash) return "model switched";
	if (previous.shapeUnknown || current.shapeUnknown) return "request shape unknown";
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
	const currentMessageHashes = reconstructMessageHashes(current, previousMessageHashes);
	const commonLength = Math.min(previousMessageHashes.length, currentMessageHashes.length);
	for (let index = 0; index < commonLength; index++) {
		if (previousMessageHashes[index] !== currentMessageHashes[index]) return `message ${index + 1} rewritten`;
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
		typeof candidate.messageCount === "number" &&
		typeof candidate.baselineReset === "boolean" &&
		Array.isArray(candidate.messageChanges) &&
		candidate.messageChanges.every(
			(change) =>
				Array.isArray(change) &&
				change.length === 2 &&
				typeof change[0] === "number" &&
				typeof change[1] === "string",
		) &&
		(candidate.attribution === undefined || typeof candidate.attribution === "string")
	);
}

export const CACHE_PREFIX_CUSTOM_TYPE = "cache_prefix";
