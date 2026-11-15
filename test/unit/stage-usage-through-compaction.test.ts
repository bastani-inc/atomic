import assert from "node:assert/strict";
import { type AssistantMessage, createAssistantMessageEventStream } from "@bastani/pi-ai/compat";
import { afterEach, describe, test } from "vitest";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import type { FileEntry } from "../../packages/coding-agent/src/core/session-manager.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { createTestResourceLoader } from "../../packages/coding-agent/test/utilities.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner-types.js";
import type { WorkflowModelAttempt } from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import {
	type AgentSessionAdapter,
	createStageContext,
	type InternalStageContext,
	makeOpts,
} from "./stage-runner-helpers.js";

type ModelRef = { api: AssistantMessage["api"]; provider: string; id: string };

/** What the fake provider answers for one request, and what that request cost. */
type Reply = { text: string; cost: number; input?: number; stopReason?: "stop" | "error"; errorMessage?: string };

/** Everything the fake provider knows about a request. */
type Request = { kind: "turn" | "planner" | "compaction"; turn: number };

const spec = {
	id: "m",
	name: "m",
	reasoning: false,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 20_000,
	maxTokens: 1000,
};

const longText = "lorem ipsum dolor ".repeat(1500);

function stream(model: ModelRef, reply: Reply) {
	const events = createAssistantMessageEventStream();
	const input = reply.input ?? 100;
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: reply.text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: input + 10,
			cost: { input: reply.cost, output: 0, cacheRead: 0, cacheWrite: 0, total: reply.cost },
		},
		stopReason: reply.stopReason ?? "stop",
		...(reply.errorMessage === undefined ? {} : { errorMessage: reply.errorMessage }),
		timestamp: Date.now(),
	};
	events.push({ type: "start", partial: message });
	if (message.stopReason === "error") events.push({ type: "error", reason: "error", error: message });
	else events.push({ type: "done", reason: "stop", message });
	events.end(message);
	return events;
}

/** Keep every numbered line but the last two messages, so the planner deletes most of the region. */
function plannerRanges(lastText: string): string {
	const body = lastText.slice("<compaction_request>\n".length, lastText.indexOf("\n</compaction_request>"));
	const request = JSON.parse(body) as { messages: Array<{ id: number; lines: string[] }> };
	return request.messages
		.slice(0, -2)
		.map((message) => `${message.id}:1,${message.lines.length}`)
		.join("\n");
}

interface Harness {
	readonly ctx: InternalStageContext;
	/** Cost of every request the fake provider answered, in order. */
	readonly spent: number[];
	readonly sessions: StageSessionRuntime[];
	readonly compactions: Array<{ reason: string; backend?: string; errorMessage?: string }>;
	attempts(): readonly WorkflowModelAttempt[];
	charged(): number;
}

const harnesses: Harness[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.ctx.abort();
		for (const session of harness.sessions) await session.dispose();
	}
});

/**
 * A stage over a real AgentSession whose provider is scripted per request. A
 * request is a planner request when its last message is a compaction request,
 * a compaction request of another kind (summary fallback) while compaction runs,
 * and a main turn otherwise.
 */
function stageHarness(
	answer: (request: Request, lastText: string) => Reply,
	options: { retry?: boolean; history?: FileEntry[] } = {},
): Harness {
	const spent: number[] = [];
	const sessions: StageSessionRuntime[] = [];
	const compactions: Harness["compactions"] = [];
	let compacting = false;
	let turn = 0;
	const agentSession: AgentSessionAdapter = {
		async create(createOptions) {
			const modelRuntime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory({ p: { type: "api_key", key: "x" } }),
				modelsPath: null,
				refreshOnCreate: false,
			});
			modelRuntime.registerProvider("p", {
				api: "openai-completions",
				baseUrl: "https://example.invalid",
				apiKey: "x",
				models: [spec],
				streamSimple: (model, context) => {
					const last = context.messages.at(-1);
					const lastText =
						last !== undefined && Array.isArray(last.content) && last.content[0]?.type === "text"
							? last.content[0].text
							: typeof last?.content === "string"
								? last.content
								: "";
					const kind: Request["kind"] = lastText.startsWith("<compaction_request>")
						? "planner"
						: compacting
							? "compaction"
							: "turn";
					if (kind === "turn") turn += 1;
					const reply = answer({ kind, turn }, lastText);
					spent.push(reply.cost);
					return stream(model, reply);
				},
			});
			const { session } = await createAgentSession({
				cwd: process.cwd(),
				agentDir: process.cwd(),
				builtins: { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false },
				modelRuntime,
				model: modelRuntime.getModel("p", "m")!,
				fallbackModels: createOptions.fallbackModels,
				settingsManager: SettingsManager.inMemory({
					retry: options.retry ? { enabled: true, maxRetries: 2, baseDelayMs: 1 } : { enabled: false },
					compaction: { enabled: true, reserveTokens: 2000, background: false },
				}),
				sessionManager: SessionManager.inMemory(process.cwd(), undefined, options.history),
				resourceLoader: createTestResourceLoader(),
			});
			session.subscribe((event) => {
				if (event.type === "compaction_start") compacting = true;
				if (event.type !== "compaction_end") return;
				compacting = false;
				if (event.result === undefined && event.errorMessage === undefined) return;
				compactions.push({
					reason: event.reason,
					...(event.result?.backend === undefined ? {} : { backend: event.result.backend }),
					...(event.errorMessage === undefined ? {} : { errorMessage: event.errorMessage }),
				});
			});
			sessions.push(session as unknown as StageSessionRuntime);
			return session as unknown as StageSessionRuntime;
		},
	};
	const ctx = createStageContext(
		makeOpts({ adapters: { agentSession }, stageOptions: { model: "p/m" } }),
	) as InternalStageContext;
	const attempts = () => ctx.__modelFallbackMeta().modelAttempts ?? [];
	const harness: Harness = {
		ctx,
		spent,
		sessions,
		compactions,
		attempts,
		charged: () => attempts().reduce((sum, attempt) => sum + (attempt.usage?.cost ?? 0), 0),
	};
	harnesses.push(harness);
	return harness;
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

/** Each main turn reports 19k input tokens, past the 18k threshold, so compaction runs inside a later prompt. */
const thresholdAnswer = (request: Request, lastText: string): Reply =>
	request.kind === "planner"
		? { text: plannerRanges(lastText), cost: 0.5, input: 5000 }
		: { text: longText, cost: 1, input: 19_000 };

describe("stage usage through compaction (#5053)", () => {
	test("a threshold compaction inside a stage prompt charges every main turn and the planner once (#5053)", async () => {
		const harness = stageHarness(thresholdAnswer);

		for (let index = 0; index < 8; index += 1) await harness.ctx.prompt(`prompt ${index}`);

		assert.ok(
			harness.compactions.some((compaction) => compaction.reason === "threshold"),
			"a threshold compaction ran inside a stage prompt",
		);
		assert.deepEqual(harness.spent.filter((cost) => cost === 0.5).length, 1, "the planner ran once");
		assert.equal(harness.attempts().length, 8);
		assert.ok(
			harness.attempts().every((attempt) => attempt.usage !== undefined),
			"every prompt made a priced call, so every attempt carries usage",
		);
		assert.equal(harness.charged(), 8.5);
		assert.equal(harness.charged(), sum(harness.spent));
		assert.deepEqual(
			harness.attempts().map((attempt) => attempt.usage?.turns),
			[1, 1, 1, 1, 1, 1, 1, 1],
			"a compaction request is charged but is not a turn",
		);
	});

	test("overflow recovery charges the overflowed request, the planner and the retried turn (#5053)", async () => {
		const harness = stageHarness((request, lastText) => {
			if (request.kind === "planner") return { text: plannerRanges(lastText), cost: 0.5, input: 5000 };
			if (request.turn === 5)
				return {
					text: "",
					cost: 0.25,
					stopReason: "error",
					errorMessage: "prompt is too long: 213462 tokens > 200000 maximum",
				};
			return { text: "lorem ipsum dolor\n".repeat(40), cost: 1 };
		});

		for (let index = 0; index < 5; index += 1) await harness.ctx.prompt(`prompt ${index}`);

		assert.ok(
			harness.compactions.some((compaction) => compaction.reason === "overflow" && !compaction.errorMessage),
			"overflow recovery compacted the transcript",
		);
		assert.equal(harness.attempts().length, 5);
		assert.equal(harness.attempts()[4]?.success, true, "the turn retried after compaction succeeded");
		assert.equal(harness.attempts()[4]?.usage?.cost, 0.25 + 0.5 + 1);
		assert.equal(harness.charged(), sum(harness.spent));
	});

	test("a planner refusal that falls back to a summary charges the refusal and the summary (#5053)", async () => {
		const harness = stageHarness((request, lastText) => {
			if (request.kind === "planner")
				return {
					text: "",
					cost: 0.5,
					input: 5000,
					stopReason: "error",
					errorMessage: "The model refused to complete the request.",
				};
			if (request.kind === "compaction") return { text: "## Goal\nSummarized.", cost: 0.25, input: 5000 };
			return thresholdAnswer(request, lastText);
		});

		for (let index = 0; index < 8; index += 1) await harness.ctx.prompt(`prompt ${index}`);

		assert.ok(
			harness.compactions.some((compaction) => compaction.backend === "summary"),
			"the compaction fell back to a summary",
		);
		assert.ok(harness.spent.includes(0.25), "the summary request ran");
		assert.equal(harness.attempts().length, 8);
		assert.equal(harness.charged(), sum(harness.spent));
	});

	test("a stage resumed on a compacted session charges only its new requests, once (#5053)", async () => {
		const first = stageHarness(thresholdAnswer);
		for (let index = 0; index < 8; index += 1) await first.ctx.prompt(`prompt ${index}`);
		const sessionManager = (first.sessions[0] as unknown as { sessionManager: SessionManager }).sessionManager;
		const history = [sessionManager.getHeader()!, ...sessionManager.getEntries()] as FileEntry[];
		assert.ok(
			history.some((entry) => entry.type === "compaction"),
			"the resumed history holds a compaction",
		);

		const resumed = stageHarness(thresholdAnswer, { history });
		for (let index = 0; index < 2; index += 1) await resumed.ctx.prompt(`resumed ${index}`);

		assert.equal(first.charged(), 8.5);
		assert.equal(resumed.charged(), sum(resumed.spent), "history is never charged again");
		assert.equal(first.charged() + resumed.charged(), sum([...first.spent, ...resumed.spent]));
	});

	test("a session auto-retry inside a stage prompt charges the failed request too (#5053)", async () => {
		const harness = stageHarness(
			(request) =>
				request.turn === 1
					? { text: "partial", cost: 1, stopReason: "error", errorMessage: "503 service unavailable" }
					: { text: "done", cost: 1 },
			{ retry: true },
		);

		await harness.ctx.prompt("prompt");

		assert.equal(harness.spent.length, 2, "the session retried the failed request");
		assert.equal(harness.attempts().length, 1);
		assert.equal(harness.charged(), 2);
	});
});
