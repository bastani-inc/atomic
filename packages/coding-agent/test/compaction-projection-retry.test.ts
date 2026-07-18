import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function streamHarness(region: NumberedRegion, outcomes: Array<"success" | "overflow" | "length">): { streamFn: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => Promise<ReturnType<typeof createAssistantMessageEventStream>>; capture: TransportCapture } {
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
			const message = outcome === "overflow" ? response("", "error", "context_length_exceeded")
				: outcome === "length" ? response("incomplete final fragment", "length") : response(validOutput(region));
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => { stream.push({ type: "start", partial: { ...message, content: [] } }); stream.push({ type: "done", reason: message.stopReason, message }); });
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
	it("advances an async adapter-caught warm fit failure without provider misclassification", async () => {
		const { manager, region } = session();
		const prep = prepareFullCollapseBoundary(manager.getBranch(), DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 1 })!;
		const attempts: string[] = [];
		const transported: string[] = [];
		const streamFn = async (_requestModel: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
			const stream = createAssistantMessageEventStream();
			attempts.push(JSON.stringify(context));
			queueMicrotask(async () => {
				const native = { messages: context.messages.map((message) => ({ role: message.role, content: message.content })), max_tokens: options?.maxTokens };
				let result: AssistantMessage;
				try {
					const payload = await options?.onPayload?.(native, model) ?? native;
					transported.push(JSON.stringify(payload));
					result = response(validOutput(region));
				} catch {
					// Production adapters resolve their EventStream with an assistant error.
					result = response("", "error", "adapter converted onPayload failure");
				}
				stream.push({ type: "start", partial: { ...result, content: [] } });
				stream.push(result.stopReason === "error"
					? { type: "error", reason: "error", error: result }
					: { type: "done", reason: "stop", message: result });
			});
			return stream;
		};
		const counter: ProviderPayloadTokenCounter = async (payload) => ({
			tokens: JSON.stringify(payload).includes("SYSTEM TASK OVERRIDE") ? 9_500 : 2_000,
			confidence: "exact", source: "test-provider",
		});

		const warmPrefix = prefix(manager);
		warmPrefix.finalPayload = { ...(warmPrefix.finalPayload as Record<string, unknown>), system: [{ type: "text", text: "z".repeat(20_000) }] };
		await expect(runFullCollapseCompaction(prep, model, "key", undefined, undefined, "off", {
			streamFn, prefix: warmPrefix, providerTokenCounter: counter,
		})).resolves.toBeDefined();
		expect(attempts).toHaveLength(2);
		expect(transported).toHaveLength(1);
		expect(transported[0]).not.toContain("SYSTEM TASK OVERRIDE");
	});

	it.each([
		{ source: "signal and assistant", abortSignal: true },
		{ source: "assistant stop reason only", abortSignal: false },
	])("prioritizes cancellation from $source over an async adapter-caught fit failure", async ({ abortSignal }) => {
		const { manager, region } = session();
		const prep = prepareFullCollapseBoundary(manager.getBranch(), DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 1 })!;
		const entriesBefore = manager.getEntries().map((entry) => entry.id);
		const controller = new AbortController();
		const diagnosticsDir = mkdtempSync(join(tmpdir(), "atomic-compaction-cancel-"));
		let calls = 0;
		let fitFailures = 0;
		const streamFn = async (_requestModel: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
			calls++;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(async () => {
				const native = { messages: context.messages.map((message) => ({ role: message.role, content: message.content })), max_tokens: options?.maxTokens };
				try {
					await options?.onPayload?.(native, model);
				} catch {
					fitFailures++;
					if (abortSignal) controller.abort();
				}
				const aborted = response("", "aborted");
				stream.push({ type: "start", partial: { ...aborted, content: [] } });
				stream.push({ type: "done", reason: "aborted", message: aborted });
			});
			return stream;
		};

		try {
			let caught: unknown;
			try {
				await runFullCollapseCompaction(prep, model, "key", undefined, abortSignal ? controller.signal : undefined, "off", {
					streamFn, sessionFilePath: join(diagnosticsDir, "session.jsonl"),
					providerTokenCounter: async () => ({ tokens: 9_500, confidence: "exact", source: "test-provider" }),
				});
			} catch (error) { caught = error; }
			expect(caught).toBeInstanceOf(Error);
			expect((caught as Error).message).toBe("Compaction cancelled");
			expect(caught).not.toBeInstanceOf(RangePlanError);
			expect(calls).toBe(1);
			expect(fitFailures).toBe(1);
			expect(readdirSync(diagnosticsDir)).toEqual([]);
			expect(manager.getEntries().map((entry) => entry.id)).toEqual(entriesBefore);
			expect(manager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
		} finally {
			rmSync(diagnosticsDir, { recursive: true, force: true });
		}
	});

	it("fails closed before warm transport when historical restoration is ambiguous", async () => {
		const { manager, region } = session();
		const prep = prepareFullCollapseBoundary(manager.getBranch(), DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 1 })!;
		const attempts: string[] = [];
		const transported: string[] = [];
		const streamFn = async (_requestModel: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(async () => {
				const warm = JSON.stringify(context).includes("SYSTEM TASK OVERRIDE");
				attempts.push(warm ? "warm" : "isolated");
				const native = { messages: context.messages.map((message) => ({ role: message.role, content: structuredClone(message.content) })), max_tokens: options?.maxTokens };
				if (warm) ((native.messages[0].content as Array<{ type: string; text: string }>)[0]).text = "changed historical text";
				let result: AssistantMessage;
				try {
					const payload = await options?.onPayload?.(native, model) ?? native;
					transported.push(JSON.stringify(payload));
					result = response(validOutput(region));
					result.usage = usage(9_999);
				} catch {
					result = response("", "error", "adapter hid restoration decline");
				}
				stream.push({ type: "start", partial: { ...result, content: [] } });
				stream.push(result.stopReason === "error"
					? { type: "error", reason: "error", error: result }
					: { type: "done", reason: "stop", message: result });
			});
			return stream;
		};

		const result = await runFullCollapseCompaction(prep, model, "key", undefined, undefined, "off", { streamFn, prefix: prefix(manager) });
		expect(attempts).toEqual(["warm", "isolated"]);
		expect(transported).toHaveLength(1);
		expect(transported[0]).not.toContain("SYSTEM TASK OVERRIDE");
		expect(result.cache).toBeUndefined();
	});

	it("advances an async adapter-caught isolated-full fit failure to one elided transport", async () => {
		const { manager, region } = session();
		const prep = prepareFullCollapseBoundary(manager.getBranch(), DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 1 })!;
		const attempts: string[] = [];
		const transported: string[] = [];
		const streamFn = async (_requestModel: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(async () => {
				attempts.push(JSON.stringify(context));
				const native = { messages: context.messages.map((message) => ({ role: message.role, content: message.content })), max_tokens: options?.maxTokens };
				let result: AssistantMessage;
				try {
					const payload = await options?.onPayload?.(native, model) ?? native;
					transported.push(JSON.stringify(payload));
					result = response(validOutput(region));
				} catch {
					result = response("", "error", "adapter hid isolated fit failure");
				}
				stream.push({ type: "start", partial: { ...result, content: [] } });
				stream.push(result.stopReason === "error"
					? { type: "error", reason: "error", error: result }
					: { type: "done", reason: "stop", message: result });
			});
			return stream;
		};
		await expect(runFullCollapseCompaction(prep, model, "key", undefined, undefined, "off", {
			streamFn, providerTokenCounter: countByShape,
		})).resolves.toBeDefined();
		expect(attempts).toHaveLength(2);
		expect(transported).toHaveLength(1);
		expect(transported[0]).toContain("omitted-unprotected-lines");
	});

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

	it("advances invalid length output only when total-context headroom reduced the transported cap", async () => {
		const { manager, region } = session();
		const prep = prepareFullCollapseBoundary(manager.getBranch(), DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 1 })!;
		const harness = streamHarness(region, ["length", "success"]);
		const counter: ProviderPayloadTokenCounter = async (payload) => ({
			tokens: JSON.stringify(payload).includes("omitted-unprotected-lines") ? 2_000 : 9_500,
			confidence: "exact", source: "test-provider",
		});

		await expect(runFullCollapseCompaction(prep, { ...model, maxInputTokens: 10_000 }, "key", undefined, undefined, "off", {
			streamFn: harness.streamFn, providerTokenCounter: counter,
		})).resolves.toBeDefined();
		expect(harness.capture.payloads.map((payload) => (JSON.parse(payload) as { max_tokens: number }).max_tokens)).toEqual([500, 1_000]);
	});

	it("preserves the provider-observed length response and cap when the smaller projection is locally blocked", async () => {
		const { manager, region } = session();
		const prep = prepareFullCollapseBoundary(manager.getBranch(), DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 1 })!;
		let call = 0;
		const raw = "complete-but-invalid-line\nunterminated provider tail";
		const streamFn = async (_requestModel: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(async () => {
				const native = { messages: context.messages.map((message) => ({ role: message.role, content: structuredClone(message.content) })), max_tokens: options?.maxTokens };
				if (call > 0) {
					const content = native.messages[0]?.content;
					if (Array.isArray(content) && content[0]?.type === "text") content[0].text += "x".repeat(30_000);
				}
				let result: AssistantMessage;
				try {
					await options?.onPayload?.(native, model);
					result = response(raw, "length");
				} catch {
					result = response("", "error", "adapter hid retry guard");
				}
				call++;
				stream.push({ type: "start", partial: { ...result, content: [] } });
				stream.push(result.stopReason === "error"
					? { type: "error", reason: "error", error: result }
					: { type: "done", reason: "length", message: result });
			});
			return stream;
		};
		const counter: ProviderPayloadTokenCounter = async (payload) => ({
			tokens: JSON.stringify(payload).includes("omitted-unprotected-lines") ? 2_000 : 9_500,
			confidence: "exact", source: "test-provider",
		});
		let error: RangePlanError | undefined;
		try {
			await runFullCollapseCompaction(prep, { ...model, maxInputTokens: 10_000 }, "key", undefined, undefined, "off", { streamFn, providerTokenCounter: counter });
		} catch (caught) { if (caught instanceof RangePlanError) error = caught; else throw caught; }
		expect(call).toBe(2);
		expect(error?.providerOverflow).toBe(false);
		expect(error?.message).toContain("500-token limit");
		expect(error?.lastResponseExcerpt).toBe(raw);
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
	])("requires the elided projection to be smaller than the 10k rejected input: $elidedSize", async ({ elidedSize, proceeds }) => {
		const { manager, region } = session();
		const prep = prepareFullCollapseBoundary(manager.getBranch(), DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 1 })!;
		const transportedInputSizes: number[] = [];
		const streamFn = async (_requestModel: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
			const instruction = JSON.stringify(context.messages);
			const inputSize = instruction.includes("omitted-unprotected-lines") ? elidedSize : 10_000;
			const messages = context.messages.map((message) => ({ role: message.role, content: message.content }));
			const suffix = messages.at(-1);
			if (suffix && Array.isArray(suffix.content) && suffix.content[0]?.type === "text") suffix.content[0].text = "x".repeat(inputSize);
			const native = { messages, max_tokens: options?.maxTokens };
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
			streamFn, providerTokenCounter: async () => ({ tokens: 100, confidence: "exact", source: "test-provider" }),
		});
		if (proceeds) {
			await expect(planned).resolves.toBeDefined();
			expect(transportedInputSizes).toEqual([10_000, 9_000]);
		} else {
			let error: RangePlanError | undefined;
			try { await planned; } catch (caught) { if (caught instanceof RangePlanError) error = caught; else throw caught; }
			expect(error?.providerOverflow).toBe(true);
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
