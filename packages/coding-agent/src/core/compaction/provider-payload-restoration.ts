import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { CompactionRequestPrefix } from "./compaction-types.js";
import { projectProviderVisibleInput } from "./provider-visible-input.js";

type JsonRecord = Record<string, unknown>;
type SequenceKey = "input" | "messages";

export type CapturedPrefixRestoration =
	| { ok: true; payload: JsonRecord }
	| { ok: false; reason: string };

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		&& Object.getPrototypeOf(value) === Object.prototype;
}

/** Clone with the same omission/null semantics as AgentSession payload capture. */
export function cloneJsonWire<T>(value: T, ancestors = new WeakSet<object>(), arraySlot = false): T {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return (Number.isFinite(value) ? value : null) as T;
	if (value === undefined && arraySlot) return null as T;
	if (typeof value !== "object") throw new TypeError("Provider payload is not plain JSON data");
	if (ancestors.has(value)) throw new TypeError("Provider payload contains a cycle");
	const array = Array.isArray(value);
	if (array ? Object.getPrototypeOf(value) !== Array.prototype : Object.getPrototypeOf(value) !== Object.prototype) {
		throw new TypeError("Provider payload has a custom prototype");
	}
	ancestors.add(value);
	try {
		if (array) {
			const target: unknown[] = [];
			for (let index = 0; index < value.length; index++) {
				const item = Object.hasOwn(value, index) ? value[index] : undefined;
				target.push(cloneJsonWire(item, ancestors, true));
			}
			return target as T;
		}
		const target: JsonRecord = {};
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key !== "string") throw new TypeError("Provider payload has a symbol key");
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor?.enumerable || !("value" in descriptor)) throw new TypeError("Provider payload has a non-JSON property");
			if (descriptor.value === undefined) continue;
			target[key] = cloneJsonWire(descriptor.value, ancestors);
		}
		return target as T;
	} finally {
		ancestors.delete(value);
	}
}

function sequenceKey(api: Api): SequenceKey | undefined {
	if (api === "openai-responses" || api === "openai-codex-responses" || api === "azure-openai-responses") return "input";
	if (api === "anthropic-messages" || api === "openai-completions") return "messages";
	return undefined;
}

function equalIgnoringCacheMarkers(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (Array.isArray(left) && Array.isArray(right)) {
		return left.length === right.length && left.every((item, index) => equalIgnoringCacheMarkers(item, right[index]));
	}
	if (!isRecord(left) || !isRecord(right)) return false;
	const ignored = new Set(["cache_control", "prompt_cache_breakpoint"]);
	const leftKeys = Object.keys(left).filter((key) => !ignored.has(key)).sort();
	const rightKeys = Object.keys(right).filter((key) => !ignored.has(key)).sort();
	return leftKeys.length === rightKeys.length
		&& leftKeys.every((key, index) => key === rightKeys[index] && equalIgnoringCacheMarkers(left[key], right[key]));
}

function itemText(item: unknown, blockType: string): string | undefined {
	if (!isRecord(item) || !Array.isArray(item.content) || item.content.length !== 1) return undefined;
	const block = item.content[0];
	return isRecord(block) && block.type === blockType && typeof block.text === "string" && block.text.length > 0
		? block.text : undefined;
}

function validSuffix(item: unknown, api: Api): boolean {
	if (!isRecord(item) || item.role !== "user") return false;
	if (api === "openai-responses" || api === "openai-codex-responses" || api === "azure-openai-responses") {
		return itemText(item, "input_text") !== undefined;
	}
	if (api === "anthropic-messages") return itemText(item, "text") !== undefined;
	if (api === "openai-completions") {
		if (typeof item.content === "string") return item.content.length > 0;
		return itemText(item, "text") !== undefined;
	}
	return false;
}

function countKey(value: unknown, key: string): number {
	if (Array.isArray(value)) return value.reduce((count, item) => count + countKey(item, key), 0);
	if (!isRecord(value)) return 0;
	return (Object.hasOwn(value, key) ? 1 : 0)
		+ Object.entries(value).reduce((count, [childKey, item]) => count + (childKey === key ? 0 : countKey(item, key)), 0);
}

function removeSuffixMarker(suffix: unknown, key: "cache_control" | "prompt_cache_breakpoint"): void {
	if (!isRecord(suffix) || !Array.isArray(suffix.content) || suffix.content.length !== 1) return;
	const block = suffix.content[0];
	if (isRecord(block)) delete block[key];
}

function hasAmbiguousSequence(payload: JsonRecord, key: SequenceKey): boolean {
	const other = key === "input" ? "messages" : "input";
	return Array.isArray(payload[other]);
}

/** Restore a complete provider request from captured wire data plus one proven suffix. */
export function restoreCapturedProviderPrefix(
	candidate: unknown,
	prefix: CompactionRequestPrefix,
	model: Model<Api>,
): CapturedPrefixRestoration {
	const key = sequenceKey(model.api);
	if (!key) return { ok: false, reason: "unsupported provider payload family" };
	let priorValue: unknown;
	let nextValue: unknown;
	try {
		priorValue = cloneJsonWire(prefix.finalPayload);
		nextValue = cloneJsonWire(candidate);
	} catch (error) {
		return { ok: false, reason: error instanceof Error ? error.message : "provider payload is not JSON wire data" };
	}
	if (!isRecord(priorValue) || !isRecord(nextValue)) return { ok: false, reason: "provider payload is not a JSON object" };
	const prior = priorValue;
	const next = nextValue;
	if (hasAmbiguousSequence(prior, key) || hasAmbiguousSequence(next, key)) return { ok: false, reason: "provider payload has an ambiguous sequence key" };
	const priorItems = prior[key];
	const nextItems = next[key];
	if (!Array.isArray(priorItems) || !Array.isArray(nextItems)) return { ok: false, reason: `provider payload is missing ${key}` };
	if (nextItems.length !== priorItems.length + 1) return { ok: false, reason: "provider payload historical length does not isolate one suffix" };
	if (!priorItems.every((item, index) => equalIgnoringCacheMarkers(item, nextItems[index]))) {
		return { ok: false, reason: "provider payload historical items changed" };
	}
	const suffix = cloneJsonWire(nextItems[nextItems.length - 1]);
	if (!validSuffix(suffix, model.api)) return { ok: false, reason: "provider payload suffix is not one supported user text item" };
	if (projectProviderVisibleInput(prior, model.api).mediaUnbounded || projectProviderVisibleInput(suffix, model.api).mediaUnbounded) {
		return { ok: false, reason: "provider payload contains unsupported media" };
	}

	if (model.api === "anthropic-messages") {
		const historicalBreakpoints = countKey(prior, "cache_control");
		if (historicalBreakpoints > 4) return { ok: false, reason: "captured Anthropic payload exceeds four cache breakpoints" };
		if (historicalBreakpoints + countKey(suffix, "cache_control") > 4) removeSuffixMarker(suffix, "cache_control");
		if (historicalBreakpoints + countKey(suffix, "cache_control") > 4) return { ok: false, reason: "Anthropic suffix cannot fit the cache breakpoint limit" };
	} else {
		removeSuffixMarker(suffix, "prompt_cache_breakpoint");
		if ((model.api === "openai-codex-responses" || model.api === "azure-openai-responses")
			&& countKey(prior, "prompt_cache_breakpoint") > 0) {
			return { ok: false, reason: "captured provider payload has an unsupported explicit cache breakpoint" };
		}
	}

	prior[key] = [...priorItems, suffix];
	for (const outputKey of ["max_tokens", "max_output_tokens", "max_completion_tokens"] as const) {
		if (typeof next[outputKey] === "number") prior[outputKey] = next[outputKey];
	}
	return { ok: true, payload: prior };
}

function leadingSystemText(item: unknown): string | undefined {
	if (!isRecord(item) || (item.role !== "system" && item.role !== "developer")) return undefined;
	if (typeof item.content === "string") return item.content;
	if (!Array.isArray(item.content) || item.content.length !== 1 || !isRecord(item.content[0])) return undefined;
	const block = item.content[0];
	return (block.type === "input_text" || block.type === "text") && typeof block.text === "string" ? block.text : undefined;
}

/** Number of known provider-leading items before host semantic messages, or undefined on ambiguity. */
export function capturedProviderMessageOffset(prefix: CompactionRequestPrefix, model: Model<Api>): number | undefined {
	if (!isRecord(prefix.finalPayload)) return undefined;
	const key = sequenceKey(model.api);
	if (!key) return undefined;
	const items = prefix.finalPayload[key];
	if (!Array.isArray(items)) return undefined;
	if (items.length === prefix.messages.length) return 0;
	const supportsLeadingSystem = model.api === "openai-responses" || model.api === "azure-openai-responses" || model.api === "openai-completions";
	if (!supportsLeadingSystem || items.length !== prefix.messages.length + 1 || !prefix.systemPrompt) return undefined;
	return leadingSystemText(items[0]) === prefix.systemPrompt ? 1 : undefined;
}
