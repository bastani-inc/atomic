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
 * field is either a hash or a bare tool name. Anthropic `cache_control` and Bedrock
 * `cachePoint` breakpoint markers are stripped before hashing, at any depth.
 *
 * The message segment is stored as a delta against the immediately preceding request's
 * fingerprint, not as a full per-request array: `unchangedPrefixCount` is how many
 * leading messages are confirmed identical to that previous fingerprint's own full
 * message list, and `tailMessageHashes` holds hashes for every message from that point
 * on (ordinary new messages for an append-only turn, or a changed message and
 * everything after it when history was rewritten). Reconstructing the full message-hash
 * list for any fingerprint costs one hash-array concatenation per step back to a known
 * baseline (see `reconstructMessageHashes`); an ordinary session only ever pays that
 * proportional to how much actually changed, so persisted bytes per request are bounded
 * by the delta, and the running total across a session grows with total message count,
 * not with (turns × messages).
 */
export interface CachePrefixFingerprint {
	modelHash: string;
	tools: CachePrefixToolFingerprint[];
	systemHash: string;
	paramsHash: string;
	messageCount: number;
	unchangedPrefixCount: number;
	tailMessageHashes: string[];
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

/** The provider-specific field carrying the message list: Anthropic/Bedrock/Chat Completions
 * use `messages`, OpenAI Responses/Codex uses `input`, Google uses `contents`. */
function extractMessageList(payload: Record<string, unknown>): unknown[] {
	if (Array.isArray(payload.messages)) return payload.messages;
	if (Array.isArray(payload.input)) return payload.input;
	if (Array.isArray(payload.contents)) return payload.contents;
	return [];
}

/** The provider-specific field carrying tool declarations: top-level `tools`
 * (Anthropic/OpenAI/Chat Completions), Bedrock's `toolConfig.tools`, or Google's
 * `config.tools[].functionDeclarations[]`. */
function extractToolsSegment(payload: Record<string, unknown>): unknown[] {
	if (Array.isArray(payload.tools)) return payload.tools;
	const toolConfig = asRecord(payload.toolConfig);
	if (toolConfig && Array.isArray(toolConfig.tools)) return toolConfig.tools;
	const config = asRecord(payload.config);
	if (config && Array.isArray(config.tools)) {
		const flattened: unknown[] = [];
		for (const entry of config.tools) {
			const record = asRecord(entry);
			const declarations = record?.functionDeclarations;
			if (Array.isArray(declarations)) flattened.push(...declarations);
			else flattened.push(entry);
		}
		return flattened;
	}
	return [];
}

function extractSystemSegment(payload: Record<string, unknown>): { text: string; consumedFirstMessage: boolean } {
	if (typeof payload.system === "string") return { text: payload.system, consumedFirstMessage: false };
	if (payload.system !== undefined) return { text: JSON.stringify(payload.system), consumedFirstMessage: false };
	if (typeof payload.instructions === "string") return { text: payload.instructions, consumedFirstMessage: false };
	const config = asRecord(payload.config);
	if (config?.systemInstruction !== undefined) {
		const instruction = config.systemInstruction;
		return {
			text: typeof instruction === "string" ? instruction : JSON.stringify(instruction),
			consumedFirstMessage: false,
		};
	}
	const first = asRecord(extractMessageList(payload)[0]);
	if (first?.role === "system" || first?.role === "developer")
		return { text: JSON.stringify(first.content ?? ""), consumedFirstMessage: true };
	return { text: "", consumedFirstMessage: false };
}

/** Fields outside `toolConfig.tools`/`config.{systemInstruction,tools}` still count as
 * prompt-affecting request params (for example Bedrock `toolConfig.toolChoice` or a
 * Google generation-config field) rather than being silently dropped. */
function residualNestedParams(nested: Record<string, unknown> | undefined, ...omit: string[]): Record<string, unknown> {
	if (!nested) return {};
	const rest: Record<string, unknown> = { ...nested };
	for (const key of omit) delete rest[key];
	return rest;
}

/**
 * Compute the hash-only fingerprint of a provider request from its final payload
 * (the value returned by `onPayload`, after extension hooks and sanitization).
 * `cache_control`/`cachePoint` breakpoint markers are stripped before any hashing.
 *
 * `previousMessageHashes`, when given, is the full reconstructed message-hash list
 * (see `reconstructMessageHashes`) for the immediately preceding request's fingerprint
 * in the same session: it lets this call store only the delta (`tailMessageHashes`)
 * instead of every message hash again. Omit it for a standalone/first-request
 * fingerprint, which then stores its complete message list as the initial delta.
 */
export function computeCachePrefixFingerprint(
	payload: unknown,
	model: CachePrefixModelIdentity,
	previousMessageHashes?: readonly string[],
): CachePrefixFingerprint {
	const cleaned = asRecord(stripCacheBreakpoints(payload)) ?? {};
	const { text: systemText, consumedFirstMessage } = extractSystemSegment(cleaned);
	const tools = extractToolsSegment(cleaned)
		.map((tool) => ({ name: extractToolName(tool), hash: hash(JSON.stringify(tool)) }))
		.filter((tool): tool is CachePrefixToolFingerprint => tool.name !== undefined);
	const rawMessages = extractMessageList(cleaned);
	const messages = consumedFirstMessage ? rawMessages.slice(1) : rawMessages;
	const {
		model: _model,
		system: _system,
		instructions: _instructions,
		tools: _tools,
		toolConfig,
		config,
		messages: _messages,
		input: _input,
		contents: _contents,
		...requestParams
	} = cleaned;
	const params = {
		...requestParams,
		...residualNestedParams(asRecord(toolConfig), "tools"),
		...residualNestedParams(asRecord(config), "systemInstruction", "tools"),
	};
	const messageHashes = messages.map((message) => hash(JSON.stringify(message)));
	const previous = previousMessageHashes ?? [];
	const commonLength = Math.min(previous.length, messageHashes.length);
	let unchangedPrefixCount = 0;
	while (unchangedPrefixCount < commonLength && previous[unchangedPrefixCount] === messageHashes[unchangedPrefixCount])
		unchangedPrefixCount++;
	return {
		modelHash: hash(`${model.provider}/${model.modelId}`),
		tools,
		systemHash: hash(systemText),
		paramsHash: hash(JSON.stringify(params)),
		messageCount: messageHashes.length,
		unchangedPrefixCount,
		tailMessageHashes: messageHashes.slice(unchangedPrefixCount),
	};
}

/**
 * Reconstruct a fingerprint's full message-hash list from its stored delta and the
 * full list for the fingerprint immediately before it (`[]` for the first request in a
 * session). Each call does only as much work as that one fingerprint's own delta, so
 * walking a whole session's chain costs proportional to its total message count, not
 * to (turns × messages).
 */
export function reconstructMessageHashes(
	fingerprint: CachePrefixFingerprint,
	previousMessageHashes: readonly string[],
): string[] {
	return [...previousMessageHashes.slice(0, fingerprint.unchangedPrefixCount), ...fingerprint.tailMessageHashes];
}

/**
 * Describe the first request segment that differs between the request immediately
 * before `current` and `current` itself, in the order model, tools, system prompt,
 * request params, messages. `previousMessageHashes` is the full reconstructed message
 * list for that previous request (`[]` when there is none). A tool whose name is new
 * is `+name`; a name present before and now absent is `-name`. Changes to existing
 * declarations or tool order are reported without a tool name. Never returns prompt
 * content: tool names are bare identifiers, and a rewritten message is named by its
 * exact 1-based position, regardless of how far back in history it is.
 */
export function describeCachePrefixDifference(
	previous: CachePrefixFingerprint | undefined,
	previousMessageHashes: readonly string[],
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
		typeof candidate.unchangedPrefixCount === "number" &&
		Array.isArray(candidate.tailMessageHashes) &&
		candidate.tailMessageHashes.every((entry) => typeof entry === "string")
	);
}

export const CACHE_PREFIX_CUSTOM_TYPE = "cache_prefix";
