import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Context, type Model, type SimpleStreamOptions, type Usage } from "@earendil-works/pi-ai/compat";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/core/compaction/compaction.js";
import type { CompactionRequestPrefix, NumberedRegion } from "../src/core/compaction/compaction-types.js";
import { prepareFullCollapseBoundary } from "../src/core/compaction/full-collapse-boundary.js";
import { runFullCollapseCompaction } from "../src/core/compaction/compaction-runner.js";
import { RangePlanError } from "../src/core/compaction/range-planner.js";
import type { ProviderPayloadTokenCounter } from "../src/core/compaction/provider-payload-fit.js";
import { SessionManager } from "../src/core/session-manager.js";
import { convertToLlm } from "../src/core/messages.js";

const model: Model<Api> = {
	id: "projection-test", name: "Projection Test", api: "anthropic-messages", provider: "anthropic", baseUrl: "https://example.com",
	reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10_000, maxInputTokens: 9_000, maxTokens: 1_000,
};

function usage(cacheRead = 0): Usage {
	return { input: 100, output: 10, cacheRead, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function response(text: string, stopReason: AssistantMessage["stopReason"] = "stop", errorMessage?: string): AssistantMessage {
	return { role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id, usage: usage(), stopReason, errorMessage, timestamp: Date.now() };
}

function session(): { manager: SessionManager; region: NumberedRegion } {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: [{ type: "text", text: Array.from({ length: 80 }, (_, index) => `bulk-${index + 1}-${"x".repeat(80)}`).join("\n") }], timestamp: 1 });
	manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "protected-final-a\nprotected-final-b" }], api: model.api, provider: model.provider, model: model.id, usage: usage(), stopReason: "stop", timestamp: 2 } as AgentMessage);
	const prep = prepareFullCollapseBoundary(manager.getBranch(), DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 1 })!;
	return { manager, region: prep.region };
}

function validOutput(region: NumberedRegion): string {
	const keep = new Set([1, ...(region.protectedLineNumbers ?? [])]);
	return region.lines.filter((_, index) => keep.has(index + 1)).join("\n");
}

function prefix(manager: SessionManager): CompactionRequestPrefix {
	const messages = convertToLlm(manager.buildSessionContext().messages);
	const finalPayload = { messages: messages.map((message, index) => ({
		role: message.role,
		content: [{
			type: "text",
			text: Array.isArray(message.content) && message.content[0]?.type === "text" ? message.content[0].text : "",
			...(index === messages.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
		}],
	})) };
	return {
		identity: { api: model.api, provider: model.provider, model: model.id, baseUrl: model.baseUrl, sessionId: "s" },
		messages, systemPrompt: "active", sessionId: "s", finalPayload,
	};
}

interface TransportCapture { contexts: Context[]; payloads: string[] }

function streamHarness(region: NumberedRegion, outcomes: Array<"success" | "overflow">): { streamFn: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => Promise<ReturnType<typeof createAssistantMessageEventStream>>; capture: TransportCapture } {
	const capture: TransportCapture = { contexts: [], payloads: [] };
	let index = 0;
	return {
		capture,
		streamFn: async (_model, context, options) => {
			const native = { messages: context.messages.map((message) => ({ role: message.role, content: message.content })), max_tokens: options?.maxTokens };
			const payload = await options?.onPayload?.(native, model) ?? native;
			capture.contexts.push(context);
			capture.payloads.push(JSON.stringify(payload));
			const outcome = outcomes[index++] ?? "success";
			const message = outcome === "overflow" ? response("", "error", "context_length_exceeded") : response(validOutput(region));
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => { stream.push({ type: "start", partial: { ...message, content: [] } }); stream.push({ type: "done", reason: message.stopReason === "error" ? "error" : "stop", message }); });
			return stream;
		},
	};
}

const countByShape: ProviderPayloadTokenCounter = async (payload) => {
	const text = JSON.stringify(payload);
	const tokens = text.includes("SYSTEM TASK OVERRIDE") ? 9_500 : text.includes("omitted-unprotected-lines") ? 2_000 : 9_500;
	return { tokens, confidence: "exact", source: "test-provider" };
};

describe("bounded full-collapse projection retries", () => {
	it("advances warm final-fit failure to isolated-full with one transport", async () => {
		const { manager, region } = session();
		const prep = prepareFullCollapseBoundary(manager.getBranch(), DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 1 })!;
		const harness = streamHarness(region, ["success"]);
		const result = await runFullCollapseCompaction(prep, model, "key", undefined, undefined, "off", { streamFn: harness.streamFn, prefix: prefix(manager), providerTokenCounter: async (payload) => ({ tokens: JSON.stringify(payload).includes("SYSTEM TASK OVERRIDE") ? 9_500 : 2_000, confidence: "exact", source: "test-provider" }) });
		expect(result.text).toContain("protected-final-a");
		expect(harness.capture.payloads).toHaveLength(1);
		expect(harness.capture.payloads[0]).not.toContain("SYSTEM TASK OVERRIDE");
	});

	it("advances warm and isolated-full fit failures to one request-local elided transport", async () => {
		const { manager, region } = session();
		const prep = prepareFullCollapseBoundary(manager.getBranch(), DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 1 })!;
		const harness = streamHarness(region, ["success"]);
		await runFullCollapseCompaction(prep, model, "key", undefined, undefined, "off", { streamFn: harness.streamFn, prefix: prefix(manager), providerTokenCounter: countByShape });
		expect(harness.capture.payloads).toHaveLength(1);
		const payload = harness.capture.payloads[0];
		expect(payload).toContain("omitted-unprotected-lines");
		expect(payload).toContain("protected-final-a");
		expect(payload).not.toContain("bulk-40-");
		expect(payload).toContain("82→[Assistant]: protected-final-a");
	});

	it("retries a provider context rejection only with a changed smaller elided payload", async () => {
		const { manager, region } = session();
		const prep = prepareFullCollapseBoundary(manager.getBranch(), DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 1 })!;
		const harness = streamHarness(region, ["overflow", "success"]);
		const counter: ProviderPayloadTokenCounter = async (payload) => ({ tokens: JSON.stringify(payload).includes("omitted-unprotected-lines") ? 2_000 : 4_000, confidence: "exact", source: "test-provider" });
		await runFullCollapseCompaction(prep, model, "key", undefined, undefined, "off", { streamFn: harness.streamFn, providerTokenCounter: counter });
		expect(harness.capture.payloads).toHaveLength(2);
		expect(harness.capture.payloads[1]).not.toBe(harness.capture.payloads[0]);
		expect(harness.capture.payloads[1].length).toBeLessThan(harness.capture.payloads[0].length);
	});

	it("terminates after the elided provider rejection with three projections and at most two transports", async () => {
		const { manager, region } = session();
		const prep = prepareFullCollapseBoundary(manager.getBranch(), DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 1 })!;
		const harness = streamHarness(region, ["overflow", "overflow"]);
		let error: RangePlanError | undefined;
		try { await runFullCollapseCompaction(prep, model, "key", undefined, undefined, "off", { streamFn: harness.streamFn, prefix: prefix(manager), providerTokenCounter: countByShape }); }
		catch (caught) { if (caught instanceof RangePlanError) error = caught; else throw caught; }
		expect(error?.providerOverflow).toBe(true);
		expect(error?.attempts).toBe(3);
		expect(harness.capture.payloads.length).toBeLessThanOrEqual(2);
	});

	it.each([
		{ elidedSize: 11_000, proceeds: false },
		{ elidedSize: 9_000, proceeds: true },
	])("keeps the 10k rejected ceiling through a 12k blocked projection: elided $elidedSize", async ({ elidedSize, proceeds }) => {
		const { manager, region } = session();
		const prep = prepareFullCollapseBoundary(manager.getBranch(), DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 1 })!;
		const transportedInputSizes: number[] = [];
		const streamFn = async (_requestModel: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
			const instruction = JSON.stringify(context.messages);
			const inputSize = instruction.includes("SYSTEM TASK OVERRIDE") ? 10_000
				: instruction.includes("omitted-unprotected-lines") ? elidedSize : 12_000;
			const native = { messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(inputSize) }] }], max_tokens: options?.maxTokens };
			await options?.onPayload?.(native, model);
			transportedInputSizes.push(inputSize);
			const message = transportedInputSizes.length === 1
				? response("", "error", "context_length_exceeded") : response(validOutput(region));
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: { ...message, content: [] } });
				stream.push({ type: "done", reason: message.stopReason === "error" ? "error" : "stop", message });
			});
			return stream;
		};

		const planned = runFullCollapseCompaction(prep, model, "key", undefined, undefined, "off", {
			streamFn, prefix: prefix(manager), providerTokenCounter: async () => ({ tokens: 100, confidence: "exact", source: "test-provider" }),
		});
		if (proceeds) {
			await expect(planned).resolves.toBeDefined();
			expect(transportedInputSizes).toEqual([10_000, 9_000]);
		} else {
			await expect(planned).rejects.toThrow("not strictly smaller");
			expect(transportedInputSizes).toEqual([10_000]);
		}
	});

});
	it("never dispatches or reports provider overflow for a negative local output budget", async () => {
		const { manager } = session();
		const prep = prepareFullCollapseBoundary(manager.getBranch(), DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 1 })!;
		let dispatched = false;
		let error: RangePlanError | undefined;
		try {
			await runFullCollapseCompaction(prep, { ...model, maxTokens: -34 }, "key", undefined, undefined, "off", {
				streamFn: (() => { dispatched = true; throw new Error("unexpected dispatch"); }) as never,
			});
		} catch (caught) { if (caught instanceof RangePlanError) error = caught; else throw caught; }
		expect(dispatched).toBe(false);
		expect(error?.providerOverflow).toBe(false);
		expect(error?.message).toContain("output budget");
	});
