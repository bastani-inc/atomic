import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
	type Usage,
} from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { Type } from "typebox";
import { AgentSession, type AgentSessionEvent } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { CACHE_REUSE_COLLAPSE_DIRECTIVE, COLLAPSE_PLANNER_SYSTEM_PROMPT } from "../src/core/compaction/collapse-planner.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { buildSessionContext, SessionManager, type CompactionEntry } from "../src/core/session-manager.ts";
import { convertToLlm } from "../src/core/messages.ts";
import type { VerbatimCompactionDetails } from "../src/core/compaction/compaction-types.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

const model: Model<"anthropic-messages"> = {
	id: "public-lifecycle", name: "Public lifecycle", api: "anthropic-messages", provider: "anthropic",
	baseUrl: "https://example.test", reasoning: false, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 16_384,
};

interface NormalStage { text?: string; toolCall?: { id: string; name: string }; error?: string; usage?: Partial<Usage> }
interface TransportCapture { context: Context; payload: Record<string, unknown>; planner: boolean }

function usage(partial: Partial<Usage> = {}): Usage {
	const input = partial.input ?? 100;
	const output = partial.output ?? 20;
	return { input, output, cacheRead: partial.cacheRead ?? 0, cacheWrite: partial.cacheWrite ?? 0,
		totalTokens: partial.totalTokens ?? input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function message(stage: NormalStage, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: stage.toolCall
			? [{ type: "toolCall", id: stage.toolCall.id, name: stage.toolCall.name, arguments: {} }]
			: stage.error ? [] : [{ type: "text", text: stage.text ?? "ok" }],
		api: model.api, provider: model.provider, model: model.id, usage: usage(stage.usage),
		stopReason: stage.error ? "error" : stage.toolCall ? "toolUse" : "stop",
		...(stage.error ? { errorMessage: stage.error } : {}), timestamp,
	};
}

function textFromMessages(messages: readonly object[]): string {
	const text: string[] = [];
	for (const message of messages) {
		const content = (message as { content?: string | Array<{ type?: string; text?: string }> }).content;
		if (typeof content === "string") text.push(content);
		else if (Array.isArray(content)) for (const block of content) if (block.type === "text" && typeof block.text === "string") text.push(block.text);
	}
	return text.join("\n");
}

function textOfLast(context: Context): string {
	const content = context.messages.at(-1)?.content;
	return Array.isArray(content) && content[0]?.type === "text" ? content[0].text : "";
}

function protectedKeep(prompt: string): string {
	const match = /(?:Protected original line ranges \(all mandatory\)|You MUST reproduce these protected lines exactly \(1-based inclusive\)):\s*([^\n]+)/.exec(prompt);
	const protectedParts = match?.[1] === "none" ? [] : (match?.[1] ?? "").split(",").map((part) => part.trim().replace(/-(\d+)$/, "-$1"));
	return `KEEP ${["1", ...protectedParts].join(",")}`;
}

function isolatedPlannerText(prompt: string): string {
	const numbered = /<compaction-transcript>\n([\s\S]*?)\n<\/compaction-transcript>/.exec(prompt)?.[1] ?? "";
	const lines = numbered.split("\n").map((line) => ({ number: Number(/^([0-9]+)→/.exec(line)?.[1]), text: line.replace(/^[0-9]+→/, "") }));
	const ranges = /You MUST reproduce these protected lines exactly \(1-based inclusive\):\s*([^\n]+)/.exec(prompt)?.[1] ?? "none";
	const kept = new Set<number>([1]);
	if (ranges !== "none") for (const part of ranges.split(",")) {
		const [start, end = start] = part.trim().split("-").map(Number);
		for (let line = start; line <= end; line++) kept.add(line);
	}
	return lines.filter((line) => kept.has(line.number)).map((line) => line.text).join("\n");
}

function stagedStream(stages: NormalStage[], captures: TransportCapture[], plannerGate?: Promise<void>) {
	let normalIndex = 0;
	let responseSequence = 0;
	return async (_model: Model<"anthropic-messages">, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessageEventStream> => {
		const lastText = textOfLast(context);
		const warmPlanner = lastText.includes(CACHE_REUSE_COLLAPSE_DIRECTIVE);
		const isolatedPlanner = context.systemPrompt === COLLAPSE_PLANNER_SYSTEM_PROMPT;
		const planner = warmPlanner || isolatedPlanner;
		const stage = planner
			? { text: warmPlanner ? protectedKeep(lastText) : isolatedPlannerText(lastText), usage: { input: 100, output: 20 } }
			: stages[normalIndex++] ?? { text: "settled" };
		const payload: Record<string, unknown> = {
			messages: context.messages.map((item) => ({ role: item.role, content: Array.isArray(item.content) ? item.content : [{ type: "text", text: item.content }] })),
			max_tokens: options?.maxTokens ?? model.maxTokens,
		};
		const finalPayload = await options?.onPayload?.(payload, model) ?? payload;
		captures.push({ context, payload: finalPayload as Record<string, unknown>, planner });
		const response = message(stage, Date.now() + ++responseSequence * 1_000);
		const stream = createAssistantMessageEventStream();
		const emit = () => {
			stream.push({ type: "start", partial: { ...response, content: [] } });
			if (response.stopReason === "error") stream.push({ type: "error", reason: "error", error: response });
			else stream.push({ type: "done", reason: response.stopReason, message: response });
		};
		if (planner && plannerGate) void plannerGate.then(emit);
		else queueMicrotask(emit);
		return stream;
	};
}

interface LifecycleHarness {
	session: AgentSession; manager: SessionManager; events: AgentSessionEvent[]; captures: TransportCapture[];
	file?: string; cleanup(): void;
}

function createLifecycleHarness(stages: NormalStage[], options: { disk?: boolean; tool?: AgentTool; plannerGate?: Promise<void>; requestModel?: Model<"anthropic-messages">; preserveRecent?: number } = {}): LifecycleHarness {
	const dir = join(tmpdir(), `atomic-public-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	const captures: TransportCapture[] = [];
	const streamFn = stagedStream(stages, captures, options.plannerGate);
	const tools = options.tool ? [options.tool] : [];
	const requestModel = options.requestModel ?? model;
	const agent = new Agent({ getApiKey: () => "key", initialState: { model: requestModel, systemPrompt: "system", tools }, streamFn });
	const manager = options.disk ? SessionManager.create(dir, dir) : SessionManager.inMemory();
	const settings = SettingsManager.create(dir, dir);
	settings.applyOverrides({ retry: { enabled: false }, compaction: { enabled: true, reserveTokens: 16_384, compression_ratio: 0.5, preserve_recent: options.preserveRecent ?? 0 } });
	const auth = AuthStorage.create(join(dir, "auth.json"));
	auth.setRuntimeApiKey(model.provider, "key");
	const session = new AgentSession({ agent, sessionManager: manager, settingsManager: settings, cwd: dir,
		modelRegistry: ModelRegistry.create(auth, dir), resourceLoader: createTestResourceLoader(), customTools: tools });
	const events: AgentSessionEvent[] = [];
	session.subscribe((event) => events.push(event));
	return { session, manager, events, captures, file: manager.getSessionFile(), cleanup() { session.dispose(); if (existsSync(dir)) rmSync(dir, { recursive: true }); } };
}

const active: LifecycleHarness[] = [];
afterEach(() => { while (active.length) active.pop()!.cleanup(); });

describe("public auto-compaction lifecycle", () => {
	it("completes two real threshold boundaries during one public prompt with queued same-turn work", async () => {
		const large = Array.from({ length: 80 }, (_, index) => `tool-line-${index}-${"x".repeat(200)}`).join("\n");
		const tool: AgentTool = { name: "large_result", label: "large_result", description: "large", parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: large }], details: {} }) };
		let releasePlanner!: () => void;
		const plannerGate = new Promise<void>((resolve) => { releasePlanner = resolve; });
		const harness = createLifecycleHarness([
			{ toolCall: { id: "large-1", name: "large_result" } },
			{ text: "first completion", usage: { input: 112_000, output: 1 } },
			{ text: "second completion", usage: { input: 112_000, output: 1 } },
			{ text: Array.from({ length: 30 }, (_, index) => `second-final-${index}`).join("\n"), usage: { input: 112_000, output: 1 } },
		], { tool, plannerGate, preserveRecent: 2 });
		active.push(harness);
		let resolveFirstStart!: () => void;
		const firstCompactionStarted = new Promise<void>((resolve) => { resolveFirstStart = resolve; });
		let resolveSecond!: () => void;
		const secondBoundary = new Promise<void>((resolve) => { resolveSecond = resolve; });
		let completedBoundaries = 0;
		let observedFirstStart = false;
		harness.session.subscribe((event) => {
			if (!observedFirstStart && event.type === "compaction_start" && event.reason === "threshold") {
				observedFirstStart = true;
				resolveFirstStart();
			}
			if (event.type === "compaction_end" && event.reason === "threshold" && event.result) {
				completedBoundaries++;
				if (completedBoundaries === 2) resolveSecond();
			}
		});
		const prompting = harness.session.prompt(Array.from({ length: 30 }, (_, index) => `initial-${index}`).join("\n"));
		await firstCompactionStarted;
		await harness.session.followUp("continue the same public task");
		releasePlanner();
		await prompting;
		await secondBoundary;
		const boundaries = harness.manager.getEntries().filter((entry) => entry.type === "compaction");
		expect(boundaries).toHaveLength(2);
		expect(harness.events.filter((event) => event.type === "compaction_end" && event.reason === "threshold")).toHaveLength(2);
		const toolEvents = harness.events.filter((event) => event.type === "message_end" && event.message.role === "toolResult");
		expect(toolEvents).toHaveLength(1);
		const publicToolText = toolEvents[0].type === "message_end" && toolEvents[0].message.role === "toolResult" && toolEvents[0].message.content[0]?.type === "text"
			? toolEvents[0].message.content[0].text : "";
		expect(publicToolText).toBe(large);
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
	});

	it("publicly compacts a 108%-reported protected tool result while keeping raw disk bytes append-only and active context bounded", async () => {
		const prefixLines = Array.from({ length: 200 }, (_, index) => `raw-line-${index}-${"r".repeat(90)}`).join("\n");
		const raw = prefixLines + "z".repeat(503_999 - prefixLines.length);
		expect(raw).toHaveLength(503_999);
		const rawHash = createHash("sha256").update(raw).digest("hex");
		const expectedCanonical = `${raw.slice(0, 16_000)}\n\n[... ${raw.length - 16_000} more characters truncated]`;
		const largeModel = { ...model, contextWindow: 372_000, maxInputTokens: 372_000 } as Model<"anthropic-messages">;
		const tool: AgentTool = {
			name: "oversized_result", label: "oversized_result", description: "returns the protected oversized result", parameters: Type.Object({}),
			maxResultSizeChars: Infinity,
			execute: async () => ({ content: [{ type: "text", text: raw }], details: { hash: rawHash } }),
		};
		const overflow = "prompt is too long: public 401760/372000 staged overflow";
		const harness = createLifecycleHarness([
			{ toolCall: { id: "public-large-call", name: "oversized_result" } },
			{ error: overflow, usage: { input: 401_760, output: 0, totalTokens: 401_760 } },
			{ text: "continuation after automatic overflow", usage: { input: 1_000, output: 20 } },
		], { disk: true, tool, requestModel: largeModel, preserveRecent: 2 });
		active.push(harness);

		await harness.session.prompt(Array.from({ length: 30 }, (_, index) => `public-overflow-source-${index}`).join("\n"));
		const boundaries = harness.manager.getEntries().filter((entry) => entry.type === "compaction") as Array<CompactionEntry<VerbatimCompactionDetails>>;
		expect(boundaries).toHaveLength(1);
		const boundary = boundaries[0];
		expect(boundary.details).toMatchObject({ format: "full-collapse", promptVersion: 4 });
		expect(boundary.summary).toContain(expectedCanonical);
		expect(boundary.summary.split("more characters truncated")).toHaveLength(2);
		expect(boundary.summary).not.toContain(raw);

		const durableTool = harness.manager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "toolResult");
		expect(durableTool?.type).toBe("message");
		if (!durableTool || durableTool.type !== "message" || durableTool.message.role !== "toolResult") throw new Error("missing durable tool result");
		const durableText = durableTool.message.content[0]?.type === "text" ? durableTool.message.content[0].text : "";
		expect(durableText).toHaveLength(raw.length);
		expect(createHash("sha256").update(durableText).digest("hex")).toBe(rawHash);
		const rawToolTextOnDisk = (file: string): string => {
			for (const line of readFileSync(file, "utf8").trim().split("\n")) {
				const entry = JSON.parse(line) as { type?: string; message?: { role?: string; content?: Array<{ type?: string; text?: string }> } };
				if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.content?.[0]?.type === "text") return entry.message.content[0].text ?? "";
			}
			return "";
		};
		const activeDiskRaw = rawToolTextOnDisk(harness.file!);
		expect(activeDiskRaw).toHaveLength(503_999);
		expect(createHash("sha256").update(activeDiskRaw).digest("hex")).toBe(rawHash);
		const backupPath = boundary.details?.backupPath;
		expect(backupPath && existsSync(backupPath)).toBe(true);
		const backupRaw = rawToolTextOnDisk(backupPath!);
		expect(backupRaw).toHaveLength(503_999);
		expect(createHash("sha256").update(backupRaw).digest("hex")).toBe(rawHash);

		const activeText = textFromMessages(harness.session.agent.state.messages);
		expect(activeText).toContain(raw.slice(0, 16_000));
		expect(activeText).toContain("more characters truncated");
		expect(activeText).not.toContain(raw);
		const reopened = SessionManager.open(harness.file!);
		expect(convertToLlm(reopened.buildSessionContext().messages)).toEqual(convertToLlm(harness.manager.buildSessionContext().messages));
		expect(textFromMessages(reopened.buildSessionContext().messages)).not.toContain(raw);
		const rawBranch = convertToLlm(buildSessionContext(harness.manager.getEntries(), durableTool.id).messages);
		expect(textFromMessages(rawBranch)).toContain(raw);
		expect(harness.events.filter((event) => event.type === "compaction_end" && event.reason === "overflow")).toHaveLength(1);
		const overflowEvent = harness.events.find((event) => event.type === "message_end" && event.message.role === "assistant" && event.message.errorMessage === overflow);
		expect(overflowEvent?.type === "message_end" && overflowEvent.message.role === "assistant" ? overflowEvent.message.usage.input : 0).toBe(401_760);
		expect(401_760 / 372_000).toBeCloseTo(1.08, 5);
		expect(harness.events.some((event) => event.type === "message_end" && event.message.role === "assistant" && textFromMessages([event.message]).includes("continuation after automatic overflow"))).toBe(true);
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		await harness.session.prompt("continuation remains publicly usable");
		const repeated = await harness.session.compact({ preserve_recent: 1 });
		expect(repeated.format).toBe("full-collapse");
		const repeatedBoundaries = harness.manager.getEntries().filter((entry) => entry.type === "compaction");
		expect(repeatedBoundaries).toHaveLength(2);
		const repeatedPlannerText = textFromMessages(harness.captures.filter((capture) => capture.planner).at(-1)!.context.messages);
		expect(repeatedPlannerText).not.toContain(raw);
		expect(repeatedPlannerText.split("more characters truncated").length - 1).toBeLessThanOrEqual(1);
		expect(textFromMessages(harness.session.agent.state.messages)).not.toContain(raw);
		expect(createHash("sha256").update(rawToolTextOnDisk(harness.file!)).digest("hex")).toBe(rawHash);
		expect(textFromMessages(SessionManager.open(harness.file!).buildSessionContext().messages)).not.toContain(raw);
		expect(harness.session.isStreaming).toBe(false);
	});

	it("allows only one compact-and-retry for two consecutive provider overflows", async () => {
		const overflow = "prompt is too long: staged-overflow";
		const harness = createLifecycleHarness([{ error: overflow }, { error: overflow }]);
		active.push(harness);
		await harness.session.prompt(Array.from({ length: 40 }, (_, index) => `overflow-source-${index}`).join("\n"));
		const ends = harness.events.filter((event) => event.type === "compaction_end" && event.reason === "overflow");
		expect(harness.manager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(ends).toHaveLength(2);
		expect(ends[0]).toMatchObject({ willRetry: true });
		expect(ends[1]).toMatchObject({ willRetry: false, errorMessage: expect.stringContaining("after one compact-and-retry") });
		expect(harness.captures.filter((capture) => !capture.planner)).toHaveLength(2);
		expect(harness.captures.filter((capture) => capture.planner)).toHaveLength(1);
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		expect(harness.session.isStreaming).toBe(false);
	});

	it("archives one overflow error while excluding it from compaction and retry transport", async () => {
		const overflow = "prompt is too long: UNIQUE_ARCHIVED_OVERFLOW_TEXT";
		const harness = createLifecycleHarness([{ error: overflow }, { text: "retry succeeded" }], { disk: true });
		active.push(harness);
		await harness.session.prompt(Array.from({ length: 40 }, (_, index) => `durable-source-${index}`).join("\n"));
		const plannerCapture = harness.captures.find((capture) => capture.planner)!;
		const normalCaptures = harness.captures.filter((capture) => !capture.planner);
		expect(JSON.stringify(plannerCapture.context)).not.toContain(overflow);
		expect(JSON.stringify(plannerCapture.payload)).not.toContain(overflow);
		expect(JSON.stringify(normalCaptures[1].context)).not.toContain(overflow);
		expect(JSON.stringify(normalCaptures[1].payload)).not.toContain(overflow);
		const file = harness.file!;
		const diskText = readFileSync(file, "utf8");
		expect(diskText.split(overflow)).toHaveLength(2);
		const reopened = SessionManager.open(file);
		expect(JSON.stringify(reopened.getEntries()).split(overflow)).toHaveLength(2);
		expect(harness.events.some((event) => event.type === "message_end" && event.message.role === "assistant" && event.message.errorMessage === overflow)).toBe(true);
		expect(harness.events.some((event) => event.type === "agent_end")).toBe(true);
		expect(harness.events.filter((event) => event.type === "compaction_end" && event.reason === "overflow")).toHaveLength(1);
		const archivedMessageIndex = harness.events.findIndex((event) => event.type === "message_end" && event.message.role === "assistant" && event.message.errorMessage === overflow);
		const agentEndIndex = harness.events.findIndex((event, index) => index > archivedMessageIndex && event.type === "agent_end");
		expect(archivedMessageIndex).toBeGreaterThanOrEqual(0);
		expect(agentEndIndex).toBeGreaterThan(archivedMessageIndex);
		await harness.session.prompt("public continuation after recovered overflow");
		expect(harness.session.isStreaming).toBe(false);
	});
});
