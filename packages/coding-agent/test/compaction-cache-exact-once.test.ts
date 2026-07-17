import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, AssistantMessageEventStream, Context, Message, Model, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/core/compaction/compaction.js";
import type { CompactionRequestPrefix, FullCollapsePreparation } from "../src/core/compaction/compaction-types.js";
import { runFullCollapseCompaction } from "../src/core/compaction/compaction-runner.js";
import { prepareFullCollapseBoundary } from "../src/core/compaction/full-collapse-boundary.js";
import { convertToLlm } from "../src/core/messages.js";
import { SessionManager } from "../src/core/session-manager.js";

const codexModel: Model<Api> = {
	id: "gpt-5.6-sol", name: "Codex exact-once", api: "openai-codex-responses", provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api", reasoning: false, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8_192,
};

function assistant(text: string, timestamp: number): AgentMessage {
	return {
		role: "assistant", content: [{ type: "text", text }], api: codexModel.api, provider: codexModel.provider, model: codexModel.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop", timestamp,
	};
}

function seedSession(firstMarker: string, latestMarker: string): SessionManager {
	const manager = SessionManager.inMemory();
	for (let index = 0; index < 12; index++) {
		manager.appendMessage({
			role: "user", content: [{ type: "text", text: index === 0 ? firstMarker : `historical user ${index}` }], timestamp: index * 2 + 1,
		});
		manager.appendMessage(assistant(`historical assistant ${index}`, index * 2 + 2));
	}
	manager.appendMessage({ role: "user", content: [{ type: "text", text: latestMarker }], timestamp: 100 });
	return manager;
}

function nativePayload(messages: readonly Message[], sessionId: string): Record<string, unknown> {
	return {
		input: messages.map((message) => ({
			role: message.role,
			content: [{
				type: message.role === "user" ? "input_text" : "output_text",
				text: Array.isArray(message.content) && message.content[0]?.type === "text" ? message.content[0].text : "",
			}],
		})),
		prompt_cache_key: sessionId,
	};
}

function prefixFor(messages: Message[], sessionId = "exact-once-session"): CompactionRequestPrefix {
	return {
		identity: {
			api: codexModel.api, provider: codexModel.provider, model: codexModel.id, baseUrl: codexModel.baseUrl,
			sessionId, transport: "auto",
		},
		messages,
		finalPayload: nativePayload(messages, sessionId),
		sessionId,
		transport: "auto",
	};
}

function keepRecord(preparation: FullCollapsePreparation): string {
	return `KEEP ${[1, ...(preparation.region.protectedLineNumbers ?? [])].sort((left, right) => left - right).join(",")}`;
}

async function finalPayload(preparation: FullCollapsePreparation, prefix: CompactionRequestPrefix): Promise<Record<string, unknown>> {
	let captured: Record<string, unknown> | undefined;
	const streamFn = async (model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessageEventStream> => {
		const candidate = nativePayload(context.messages, options?.sessionId ?? "");
		captured = await options?.onPayload?.(candidate, model) as Record<string, unknown> ?? candidate;
		const stream = createAssistantMessageEventStream();
		const message: AssistantMessage = {
			role: "assistant", content: [{ type: "text", text: keepRecord(preparation) }], api: model.api,
			provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
			usage: { input: 0, output: 0, cacheRead: 500, cacheWrite: 0, totalTokens: 500, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		queueMicrotask(() => {
			stream.push({ type: "start", partial: { ...message, content: [] } });
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
	await runFullCollapseCompaction(preparation, codexModel, "key", undefined, undefined, "off", { streamFn, prefix });
	if (!captured) throw new Error("expected a final provider payload");
	return captured;
}

function occurrences(payload: unknown, marker: string): number {
	return JSON.stringify(payload).split(marker).length - 1;
}

function suffixText(payload: Record<string, unknown>): string {
	const input = payload.input as Array<{ content: Array<{ text: string }> }>;
	return input.at(-1)?.content[0]?.text ?? "";
}

describe("warm compaction exact-once query provenance", () => {
	it("keeps an auto-derived latest user marker once with an empty delta", async () => {
		const latestMarker = "LATEST_USER_EMPTY_DELTA_93bfe9";
		const manager = seedSession("OLD_EMPTY_DELTA_e69489", latestMarker);
		const preparation = prepareFullCollapseBoundary(manager.getBranch(), DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 2 })!;
		const messages = convertToLlm(manager.buildSessionContext().messages);
		const payload = await finalPayload(preparation, prefixFor(messages));

		expect(preparation.parameters.query).toBe(latestMarker);
		expect(occurrences(payload, latestMarker)).toBe(1);
		expect(suffixText(payload)).not.toContain("Relevance focus:");
	});

	it("keeps the old prefix and non-empty delta exactly once each", async () => {
		const oldMarker = "OLD_PREFIX_NONEMPTY_f64002";
		const deltaMarker = "LATEST_USER_DELTA_7794aa";
		const manager = seedSession(oldMarker, deltaMarker);
		const preparation = prepareFullCollapseBoundary(manager.getBranch(), DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 2 })!;
		const messages = convertToLlm(manager.buildSessionContext().messages);
		const payload = await finalPayload(preparation, prefixFor(messages.slice(0, -1)));

		expect(occurrences(payload, oldMarker)).toBe(1);
		expect(occurrences(payload, deltaMarker)).toBe(1);
		expect(suffixText(payload)).not.toContain("Relevance focus:");
	});

	it("honors an explicit query override exactly once in the suffix", async () => {
		const explicitMarker = "EXPLICIT_QUERY_FOCUS_18f3dc";
		const manager = seedSession("OLD_EXPLICIT_2d45d6", "LATEST_USER_EXPLICIT_7219b1");
		const preparation = prepareFullCollapseBoundary(manager.getBranch(), DEFAULT_COMPACTION_SETTINGS, {
			preserve_recent: 2,
			query: explicitMarker,
		})!;
		const messages = convertToLlm(manager.buildSessionContext().messages);
		const payload = await finalPayload(preparation, prefixFor(messages));
		const suffix = suffixText(payload);

		expect(preparation.parameters.query).toBe(explicitMarker);
		expect(occurrences(payload, explicitMarker)).toBe(1);
		expect(suffix).toContain(`Relevance focus: ${explicitMarker}`);
	});
});
