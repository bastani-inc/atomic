import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Api,
	Context,
	Model,
	SimpleStreamOptions,
	Usage,
} from "@earendil-works/pi-ai/compat";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import type { VerbatimCompactionApplyOptions } from "../src/core/agent-session-methods.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/core/compaction/compaction.ts";
import { reconstructCompactedTranscript, validateDeletedRanges } from "../src/core/compaction/deleted-ranges.ts";
import { runFullCollapseCompaction } from "../src/core/compaction/compaction-runner.ts";
import { prepareFullCollapseBoundary } from "../src/core/compaction/full-collapse-boundary.ts";
import type { NumberedRegion, VerbatimCompactionDetails } from "../src/core/compaction/compaction-types.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import type { CompactionEntry } from "../src/core/session-manager.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

const model: Model<"anthropic-messages"> = {
	id: "collapse-test", name: "Collapse Test", api: "anthropic-messages", provider: "anthropic", baseUrl: "https://example.com",
	reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 372_000, maxTokens: 13_107,
};

function assistant(text: string, timestamp: number): AgentMessage {
	return {
		role: "assistant", content: [{ type: "text", text }], api: "anthropic-messages", provider: "anthropic", model: "collapse-test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop", timestamp,
	};
}

function toolResult(text: string, timestamp: number): AgentMessage {
	return { role: "toolResult", toolCallId: `tc-${timestamp}`, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp };
}

function assistantToolCall(id: string, timestamp: number): AgentMessage {
	return {
		...assistant("running deterministic tool", timestamp),
		content: [{ type: "toolCall", id, name: "read", arguments: { path: "large.txt", alias: "large.txt" } }],
	};
}

/** A valid subsequence: keep line 1 plus every protected line, delete the rest. */
function validCollapseOutput(region: NumberedRegion): string {
	const keep = new Set<number>([1, ...(region.protectedLineNumbers ?? [])]);
	return region.lines.filter((_, index) => keep.has(index + 1)).join("\n");
}

function validKeepRecord(region: NumberedRegion): string {
	return `KEEP ${[1, ...(region.protectedLineNumbers ?? [])].sort((left, right) => left - right).join(",")}`;
}

interface Capture {
	context: Context;
	options?: SimpleStreamOptions;
	transportPayload?: unknown;
}

/**
 * A stream function that returns a caller-staged compacted string with staged
 * cache usage, mimicking the provider serving the cached old-conversation prefix.
 */
function stagedStreamFn(getResponse: () => { text: string; usage: Partial<Usage> }, calls: Capture[]) {
	return async (requestModel: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessageEventStream> => {
		const capture: Capture = { context, options };
		const payload = requestModel.api === "openai-responses" || requestModel.api === "openai-codex-responses"
			? {
				input: context.messages.map((message) => ({ role: message.role, content: [{
					type: message.role === "user" ? "input_text" : "output_text",
					text: Array.isArray(message.content) && message.content[0]?.type === "text" ? message.content[0].text : "",
				}] })),
				max_output_tokens: options?.maxTokens ?? requestModel.maxTokens,
				prompt_cache_retention: undefined,
			}
			: JSON.parse(JSON.stringify({
				system: context.systemPrompt ? [{ type: "text", text: context.systemPrompt }] : [],
				tools: context.tools?.map((tool) => ({ name: tool.name, description: tool.description, input_schema: JSON.parse(JSON.stringify(tool.parameters)) as object })) ?? [],
				messages: context.messages.map((message) => ({ role: message.role, content: Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }] })),
				max_tokens: options?.maxTokens ?? requestModel.maxTokens,
			})) as Record<string, unknown>;
		capture.transportPayload = await options?.onPayload?.(payload, requestModel) ?? payload;
		calls.push(capture);
		const { text, usage } = getResponse();
		const stream = createAssistantMessageEventStream();
		const message: AssistantMessage = {
			role: "assistant", content: [{ type: "text", text }], api: "anthropic-messages", provider: "anthropic", model: "collapse-test",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, ...usage },
			stopReason: "stop", timestamp: Date.now(),
		};
		queueMicrotask(() => {
			stream.push({ type: "start", partial: { ...message, content: [] } });
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
}

describe("repeated overflow full-collapse in one logical turn", () => {
	let session: AgentSession;
	let authStorage: AuthStorage;
	let sessionManager: SessionManager;
	let tempDir: string;
	let pending: { text: string; usage: Partial<Usage> };
	let calls: Capture[];

	beforeEach(() => {
		tempDir = join(tmpdir(), `atomic-overflow-repro-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		calls = [];
		pending = { text: "", usage: {} };

		const agent = new Agent({
			getApiKey: () => "faux-key",
			initialState: { model, systemPrompt: "You are the ACTIVE coding agent system prompt.", tools: [] },
			streamFn: stagedStreamFn(() => pending, calls),
		});

		// One logical turn: a single user message followed by hundreds of
		// assistant/tool entries (the incident shape) with NO later user turn.
		sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "kick off the long task\nwith much detail" }], timestamp: 1 });
		for (let i = 0; i < 300; i++) {
			sessionManager.appendMessage(i % 2 === 0 ? assistant(`step ${i}\nwork line ${i}`, i + 2) : toolResult(`result ${i}\noutput line ${i}`, i + 2));
		}
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "faux-key");
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		session = new AgentSession({ agent, sessionManager, settingsManager, cwd: tempDir, modelRegistry, resourceLoader: createTestResourceLoader() });
	});

	afterEach(() => {
		session.dispose();
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	function overflowOptions(): VerbatimCompactionApplyOptions {
		return {
			resolvePlannerAuth: async () => ({ apiKey: "faux-key" }),
			abortController: new AbortController(),
			backupLabel: "overflow",
			reason: "overflow",
			preserve_recent: 2,
		};
	}

	async function capturePrecedingActiveRequest(): Promise<Context> {
		const messages = convertToLlm(sessionManager.buildSessionContext().messages).slice(0, -1);
		const context: Context = { systemPrompt: session.agent.state.systemPrompt, tools: session.agent.state.tools, messages };
		await session.agent.streamFn(model, context, { sessionId: session.sessionId, transport: "auto" });
		calls.length = 0;
		return context;
	}

	it("recovers from repeated same-turn overflow with bounded isolated fallback for complex tool history", async () => {
		// ---- Round 1: overflow inside one huge logical turn no longer dead-ends.
		const prep1 = prepareFullCollapseBoundary(sessionManager.getBranch(), DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 2 })!;
		expect(prep1).toBeDefined();
		await capturePrecedingActiveRequest();
		pending = { text: validCollapseOutput(prep1.region), usage: { cacheRead: 4096, cacheWrite: 128 } };

		const result1 = await session._applyVerbatimCompaction(overflowOptions());
		expect(result1).toBeDefined();
		expect(result1?.format).toBe("full-collapse");
		expect(result1?.cache).toBeUndefined();

		const boundary1 = sessionManager.getEntries().filter((entry) => entry.type === "compaction").at(-1) as CompactionEntry<VerbatimCompactionDetails>;
		expect(boundary1.details?.format).toBe("full-collapse");
		expect(boundary1.details?.cache).toBeUndefined();

		// Tool results are intentionally ineligible for mechanical KEEP mapping.
		const call1 = calls[0];
		expect(call1.context.messages).toHaveLength(1);
		expect(typeof call1.options?.onPayload).toBe("function");

		// ---- Same logical turn: append more assistant/tool work, NO new user turn.
		for (let i = 0; i < 40; i++) {
			sessionManager.appendMessage(i % 2 === 0 ? assistant(`more ${i}\ntail ${i}`, 10_000 + i) : toolResult(`out ${i}\ntail ${i}`, 10_000 + i));
		}

		// ---- Round 2: overflow recovery repeats (collapses prior string + new work).
		const prep2 = prepareFullCollapseBoundary(sessionManager.getBranch(), DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 2 })!;
		expect(prep2).toBeDefined();
		const active2 = await capturePrecedingActiveRequest();
		pending = { text: validCollapseOutput(prep2.region), usage: { cacheRead: 8192, cacheWrite: 64 } };

		const result2 = await session._applyVerbatimCompaction(overflowOptions());
		expect(result2).toBeDefined();
		// A prior full-collapse summary is provider-visible as a synthetic user
		// message but persisted without a role header. It is not byte-alignable, so
		// round two correctly uses the isolated no-duplication fallback.
		expect(result2?.cache).toBeUndefined();
		expect(calls).toHaveLength(1);
		expect(calls[0].context.messages).toHaveLength(1);
		expect(active2.messages.length).toBeGreaterThan(0);

		// Two boundaries were written in one logical turn; the latest is v2.
		const boundaries = sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(boundaries).toHaveLength(2);
	});

	it("projects a synthetic 108% tool result only for compaction and leaves durable bytes intact", async () => {
		// 1,607,040 chars / 4 = 401,760 heuristic tokens: exactly 108% of 372k.
		const raw = `BEGIN-${"x".repeat(1_607_028)}-END`;
		const prefixMessages = convertToLlm(sessionManager.buildSessionContext().messages);
		const active: Context = { systemPrompt: session.agent.state.systemPrompt, tools: session.agent.state.tools, messages: prefixMessages };
		await session.agent.streamFn(model, active, { sessionId: session.sessionId, transport: "auto" });
		calls.length = 0;

		const id = "large-tool-call";
		sessionManager.appendMessage(assistantToolCall(id, 20_000));
		sessionManager.appendMessage({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: raw }], isError: false, timestamp: 20_001 });
		const prep = prepareFullCollapseBoundary(sessionManager.getBranch(), DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 0 })!;
		pending = { text: validCollapseOutput(prep.region), usage: { cacheRead: 16_384 } };

		const result = await session._applyVerbatimCompaction({ ...overflowOptions(), preserve_recent: 0 });
		expect(result).toBeDefined();
		expect(calls).toHaveLength(1);

		const instruction = calls[0].context.messages.at(-1)!;
		const instructionText = Array.isArray(instruction.content) && instruction.content[0].type === "text" ? instruction.content[0].text : "";
		expect(instructionText).toContain("more characters truncated");
		expect(instructionText).not.toContain(raw.slice(-20_000));
		const durable = sessionManager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === id);
		expect(durable?.type === "message" && durable.message.role === "toolResult" ? durable.message.content[0] : undefined).toEqual({ type: "text", text: raw });
		expect(calls[0].context.messages).toHaveLength(1);
	});

	it("keeps the immutable normal-request payload snapshot across public compaction calls", async () => {
		let hookCalls = 0;
		const context: Context = {
			systemPrompt: session.agent.state.systemPrompt,
			tools: session.agent.state.tools,
			messages: convertToLlm(sessionManager.buildSessionContext().messages).slice(0, -1),
		};
		await session.agent.streamFn(model, context, {
			sessionId: session.sessionId,
			transport: "auto",
			onPayload: (payload) => {
				hookCalls++;
				const system = (payload as { system: Array<Record<string, unknown>> }).system;
				system[0].nestedMutation = { invocation: hookCalls };
				return undefined;
			},
		});
		calls.length = 0;
		const capturedBefore = (session as unknown as { _activeRequestPrefix: { finalPayload: unknown } })._activeRequestPrefix;
		const prep = prepareFullCollapseBoundary(sessionManager.getBranch(), DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 2 })!;
		pending = { text: validCollapseOutput(prep.region), usage: { cacheRead: 100 } };
		await session.compact({ preserve_recent: 2 });
		expect(hookCalls).toBe(1);
		expect((session as unknown as { _activeRequestPrefix: object })._activeRequestPrefix).toBe(capturedBefore);
		expect(Object.isFrozen(capturedBefore.finalPayload)).toBe(true);

		const afterSuccess = (session as unknown as { _activeRequestPrefix: object })._activeRequestPrefix;
		for (let index = 0; index < 20; index++) sessionManager.appendMessage(index % 2 === 0
			? { role: "user", content: [{ type: "text", text: `fresh ${index}` }], timestamp: 30_000 + index }
			: assistant(`fresh answer ${index}`, 30_000 + index));
		const failedPrep = prepareFullCollapseBoundary(sessionManager.getBranch(), DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 2 });
		expect(failedPrep).toBeDefined();
		pending = { text: "not a valid subsequence", usage: {} };
		await expect(session.compact({ preserve_recent: 2 })).rejects.toThrow();
		expect((session as unknown as { _activeRequestPrefix: object })._activeRequestPrefix).toBe(afterSuccess);
	});
	it("captures an adapter-realistic Codex Responses payload without unsupported explicit cache fields", async () => {
		const openAI = {
			...model, api: "openai-codex-responses", provider: "openai-codex", id: "gpt-5.6-sol", baseUrl: "https://chatgpt.com/backend-api",
		} as Model<Api>;
		const context: Context = { messages: [
			{ role: "user", content: [{ type: "text", text: "duplicate" }], timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "duplicate" }], timestamp: 2 },
			{ role: "user", content: [{ type: "text", text: "duplicate" }], timestamp: 3 },
		] };
		let hookCalls = 0;
		await session.agent.streamFn(openAI, context, { sessionId: "codex-session", onPayload: (payload) => {
			hookCalls++;
			return { ...(payload as Record<string, unknown>), jsonArray: ["duplicate", undefined, "duplicate"] };
		} });
		expect(hookCalls).toBe(1);
		const transported = calls.at(-1)!.transportPayload as Record<string, unknown>;
		expect(transported.prompt_cache_retention).toBeUndefined();
		expect(transported.jsonArray).toEqual(["duplicate", undefined, "duplicate"]);
		const prefix = (session as unknown as { _activeRequestPrefix?: { finalPayload: Record<string, unknown> } })._activeRequestPrefix;
		expect(prefix).toBeDefined();
		expect(Object.hasOwn(prefix!.finalPayload, "prompt_cache_retention")).toBe(false);
		expect(prefix!.finalPayload.jsonArray).toEqual(["duplicate", null, "duplicate"]);
		expect(JSON.stringify(transported)).not.toContain("prompt_cache_breakpoint");
		expect(JSON.stringify(prefix!.finalPayload)).not.toContain("prompt_cache_breakpoint");
	});
	it("runs one warm KEEP compaction through the captured final transport payload", async () => {
		const localManager = SessionManager.inMemory();
		for (let index = 0; index < 12; index++) {
			localManager.appendMessage({ role: "user", content: [{ type: "text", text: `duplicate\nordered-${index}` }], timestamp: index * 2 + 1 });
			localManager.appendMessage(assistant(`duplicate\nanswer-${index}`, index * 2 + 2));
		}
		let localPending = { text: "", usage: {} as Partial<Usage> };
		const localCalls: Capture[] = [];
		const localTransport = stagedStreamFn(() => localPending, localCalls);
		const localAgent = new Agent({
			getApiKey: () => "faux-key",
			initialState: { model, systemPrompt: "warm system", tools: [] },
			streamFn: localTransport,
		});
		const localAuth = AuthStorage.create(join(tempDir, "warm-auth.json"));
		localAuth.setRuntimeApiKey("anthropic", "faux-key");
		const localSession = new AgentSession({
			agent: localAgent, sessionManager: localManager, settingsManager: SettingsManager.create(tempDir, tempDir), cwd: tempDir,
			modelRegistry: ModelRegistry.create(localAuth, tempDir), resourceLoader: createTestResourceLoader(),
		});
		try {
			const messages = convertToLlm(localManager.buildSessionContext().messages);
			let originatingHookCalls = 0;
			await localAgent.streamFn(model, { systemPrompt: "warm system", tools: [], messages }, {
				sessionId: localSession.sessionId,
				onPayload: (payload) => {
					originatingHookCalls++;
					return { ...(payload as Record<string, unknown>), optional: undefined };
				},
			});
			const prefix = (localSession as unknown as { _activeRequestPrefix: { finalPayload: Record<string, unknown> } })._activeRequestPrefix;
			expect(Object.hasOwn(prefix.finalPayload, "optional")).toBe(false);
			const historical = prefix.finalPayload.messages as unknown[];
			expect((prefix as unknown as { warmEligible: boolean }).warmEligible).toBe(true);
			expect(historical).toHaveLength(messages.length);
			expect((historical.at(-1) as { content: Array<Record<string, unknown>> }).content[0].cache_control).toEqual({ type: "ephemeral" });
			localCalls.length = 0;
			const preparation = prepareFullCollapseBoundary(localManager.getBranch(), DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 2 })!;
			localPending = { text: validKeepRecord(preparation.region), usage: { cacheRead: 2_048 } };
			expect((prefix as unknown as { identity: { sessionId?: string } }).identity.sessionId).toBe(localManager.getSessionId());
			const result = await runFullCollapseCompaction(preparation, model, "faux-key", undefined, undefined, "off", {
				streamFn: localTransport, prefix: prefix as never,
			});
			expect(originatingHookCalls).toBe(1);
			const payload = localCalls[0].transportPayload as { messages: unknown[] };
			expect(payload.messages.slice(0, historical.length)).toEqual(historical);
			expect(payload.messages).toHaveLength(historical.length + 1);
			const suffix = JSON.stringify(payload.messages.at(-1));
			expect(suffix.match(/SYSTEM TASK OVERRIDE/g)).toHaveLength(1);
			expect(suffix).not.toContain("1→");
			expect(suffix).not.toContain("[User]: duplicate");
			expect(JSON.stringify(payload.messages).match(/ordered-0/g)).toHaveLength(1);
			const kept = new Set([1, ...(preparation.region.protectedLineNumbers ?? [])]);
			const rawDeleted = preparation.region.lines.flatMap((_, index) => kept.has(index + 1) ? [] : [{ start: index + 1, end: index + 1 }]);
			const cold = reconstructCompactedTranscript(preparation.region, validateDeletedRanges(rawDeleted, preparation.region));
			expect(Buffer.from(result.text)).toEqual(Buffer.from(cold.text));
		} finally {
			localSession.dispose();
		}
	});
	it("isolates public compaction after switching provider, model, API, and base URL", async () => {
		let hookCalls = 0;
		const active: Context = {
			systemPrompt: session.agent.state.systemPrompt,
			tools: session.agent.state.tools,
			messages: convertToLlm(sessionManager.buildSessionContext().messages),
		};
		await session.agent.streamFn(model, active, { sessionId: session.sessionId, onPayload: (payload) => {
			hookCalls++;
			return payload;
		} });
		calls.length = 0;
		const messagesBefore = sessionManager.getEntries().filter((entry) => entry.type === "message");
		const switched = {
			...model, api: "openai-responses", provider: "openai", id: "gpt-5.6", baseUrl: "https://other.example/v1",
		} as Model<Api>;
		authStorage.setRuntimeApiKey("openai", "faux-openai-key");
		await session.setModel(switched);
		const preparation = prepareFullCollapseBoundary(sessionManager.getBranch(), DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 2 })!;
		pending = { text: validCollapseOutput(preparation.region), usage: { cacheRead: 9_999 } };
		const result = await session.compact({ preserve_recent: 2 });
		expect(result.cache).toBeUndefined();
		expect(hookCalls).toBe(1);
		expect(calls).toHaveLength(1);
		expect(calls[0].context.messages).toHaveLength(1);
		expect(sessionManager.getEntries().filter((entry) => entry.type === "message")).toEqual(messagesBefore);
	});
	it("falls back without validation errors for non-JSON provider payload snapshots", async () => {
		class CustomPayload { value = "custom"; }
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		const unsupported: unknown[] = [
			new Map([["k", "v"]]), new Set(["v"]), new Date(0), new CustomPayload(), { value: 1n }, cycle,
			{ value: () => "function" }, { value: Symbol("symbol") },
		];
		const context: Context = { messages: [{ role: "user", content: [{ type: "text", text: "simple" }], timestamp: 1 }] };
		for (const value of unsupported) {
			calls.length = 0;
			await expect(session.agent.streamFn(model, context, { onPayload: () => value })).resolves.toBeDefined();
			expect(calls[0].transportPayload).toBe(value);
			expect((session as unknown as { _activeRequestPrefix?: unknown })._activeRequestPrefix).toBeUndefined();
		}
	});
});
