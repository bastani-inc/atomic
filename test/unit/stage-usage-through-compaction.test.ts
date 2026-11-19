import assert from "node:assert/strict";
import { type AssistantMessage, createAssistantMessageEventStream } from "@bastani/atomic-ai/compat";
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

/** Everything the fake provider knows about a request. Compaction makes none, so every request is a turn. */
type Request = { kind: "turn" | "compaction"; turn: number; roles: string[]; lastText: string };

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

interface Harness {
	readonly ctx: InternalStageContext;
	/** Cost of every request the fake provider answered, in order. */
	readonly spent: number[];
	readonly sessions: StageSessionRuntime[];
	readonly compactions: Array<{ reason: string; form?: string; errorMessage?: string }>;
	readonly requests: Request[];
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
 * A stage over a real AgentSession whose provider is scripted per request. A request made while compaction runs is a
 * compaction request; there must be none.
 */
function stageHarness(
	answer: (request: Request) => Reply,
	options: { retry?: boolean; history?: FileEntry[] } = {},
): Harness {
	const spent: number[] = [];
	const sessions: StageSessionRuntime[] = [];
	const compactions: Harness["compactions"] = [];
	const requests: Request[] = [];
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
					const kind: Request["kind"] = compacting ? "compaction" : "turn";
					if (kind === "turn") turn += 1;
					const request: Request = {
						kind,
						turn,
						roles: context.messages.map((message) => message.role),
						lastText,
					};
					requests.push(request);
					const reply = answer(request);
					spent.push(reply.cost);
					return stream(model, reply);
				},
			});
			const { session } = await createAgentSession({
				cwd: process.cwd(),
				agentDir: process.cwd(),
				builtins: { subagents: false, intercom: false, mcp: false, "web-access": false },
				modelRuntime,
				model: modelRuntime.getModel("p", "m")!,
				fallbackModels: createOptions.fallbackModels,
				settingsManager: SettingsManager.inMemory({
					retry: options.retry ? { enabled: true, maxRetries: 2, baseDelayMs: 1 } : { enabled: false },
					compaction: { enabled: true, reserveTokens: 2000 },
				}),
				sessionManager: options.history
					? await SessionManager.inMemory(process.cwd(), undefined, options.history)
					: SessionManager.inMemory(process.cwd()),
				resourceLoader: createTestResourceLoader(),
			});
			session.subscribe((event) => {
				if (event.type === "compaction_start") compacting = true;
				if (event.type !== "compaction_end") return;
				compacting = false;
				if (event.result === undefined && event.errorMessage === undefined) return;
				compactions.push({
					reason: event.reason,
					...(event.result?.form === undefined ? {} : { form: event.result.form }),
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
		requests,
		attempts,
		charged: () => attempts().reduce((sum, attempt) => sum + (attempt.usage?.cost ?? 0), 0),
	};
	harnesses.push(harness);
	return harness;
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

/** Each main turn reports 19k input tokens, past the 18k threshold, so compaction runs inside a later prompt. */
const thresholdAnswer = (): Reply => ({ text: longText, cost: 1, input: 19_000 });

describe("stage usage through compaction (#5053)", () => {
	test("a threshold compaction inside a stage prompt clears the context with no model call and charges every turn (#5053)", async () => {
		const harness = stageHarness(thresholdAnswer);

		for (let index = 0; index < 8; index += 1) await harness.ctx.prompt(`prompt ${index}`);

		assert.ok(
			harness.compactions.some((compaction) => compaction.reason === "threshold" && compaction.form === "cleared"),
			"a threshold compaction cleared the stage context",
		);
		assert.ok(
			harness.requests.every((request) => request.kind === "turn"),
			"compaction made no request of its own",
		);
		assert.equal(harness.attempts().length, 8);
		assert.equal(harness.charged(), 8);
		assert.equal(harness.charged(), sum(harness.spent));
		assert.deepEqual(
			harness.attempts().map((attempt) => attempt.usage?.turns),
			[1, 1, 1, 1, 1, 1, 1, 1],
		);
		const afterClear = harness.requests.find((request) => request.lastText.startsWith("Context cleared."));
		assert.equal(afterClear, undefined, "the next prompt follows the Context cleared message");
		const cleared = harness.requests.find(
			(request) => request.roles.filter((role) => role !== "system").length === 2,
		);
		assert.ok(cleared, "a turn after the clear saw only the Context cleared message and its own prompt");
	});

	test("overflow recovery inside a stage clears the context and retries with exactly system + Context cleared (#5053)", async () => {
		const harness = stageHarness((request) => {
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
			harness.compactions.some(
				(compaction) =>
					compaction.reason === "overflow" && compaction.form === "cleared" && !compaction.errorMessage,
			),
			"overflow recovery cleared the stage context",
		);
		assert.equal(harness.attempts().length, 5);
		assert.equal(harness.attempts()[4]?.success, true, "the turn retried after the clear");
		assert.equal(harness.attempts()[4]?.usage?.cost, 0.25 + 1);
		assert.equal(harness.charged(), sum(harness.spent));
		const retry = harness.requests.at(-1);
		assert.deepEqual(retry?.roles, ["system", "user"]);
		assert.ok(retry?.lastText.startsWith("Context cleared."), retry?.lastText);
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

		assert.equal(first.charged(), 8);
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
