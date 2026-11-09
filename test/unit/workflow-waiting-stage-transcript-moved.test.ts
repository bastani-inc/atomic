import assert from "node:assert/strict";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@bastani/pi-ai/compat";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, test } from "vitest";
import { InMemoryCodingAgentModelsStore } from "../../packages/coding-agent/src/core/models-store.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import {
	AuthStorage,
	ModelRuntime,
	SettingsManager,
	type ToolDefinition,
} from "../../packages/coding-agent/src/index.js";
import type { RunResult } from "../../packages/workflows/src/runs/foreground/executor-types.js";
import type { StageAdapters, StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { EMPTY_COMPLETION_FAILURE_MESSAGE } from "../../packages/workflows/src/runs/foreground/stage-runner-messages.js";
import { createAgentSessionAdapter, run, workflow } from "../../packages/workflows/src/sdk-surface.js";
import { RESUME_CONTINUATION_PROMPT } from "../../packages/workflows/src/shared/resume-continuation.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

const BUILTINS = { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false } as const;
const NOTIFICATION = { customType: "subagent-notify", content: "child finished", display: true } as const;
const NOTIFICATION_OPTIONS = { triggerTurn: true, stageAdmissionKey: "subagent:child-1" } as const;

type Messages = readonly {
	readonly role: string;
	readonly content?: unknown;
}[];

interface ModelRequest {
	readonly messages: Messages;
}

/** Whether this is the request a `structured_output` call makes to infer its result, not a turn of the stage. */
function isInference(messages: Messages): boolean {
	return JSON.stringify(messages[0]?.content ?? "").includes("Do not use prose or other tools");
}

function lastText(messages: Messages): string {
	const last = messages.at(-1);
	return typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
}

type Session = StageSessionRuntime & {
	sendCustomMessages(messages: (typeof NOTIFICATION)[], options: typeof NOTIFICATION_OPTIONS): Promise<void>;
};

interface Harness {
	readonly sessionStore: MemorySessionStore;
	/** How many times the detachable tool's work started. */
	toolRuns(): number;
	/** The faux model's requests, as the roles of the messages each one carried. */
	requests: string[][];
	/** The text of the last message of each of those requests. */
	lastTexts: string[];
	run(definition: ReturnType<typeof workflow>, hook: (session: Session) => void): Promise<RunResult>;
	/** The stage's stored conversation: each message as `role` or `role/stopReason`, the system prompt left out. */
	transcript(sessionId: string | undefined): Promise<string[]>;
	readonly waitForCi: ToolDefinition;
}

let cwd: string;
let faux: ReturnType<typeof registerFauxProvider>;

beforeEach(() => {
	cwd = makeTempDirectory("atomic-waiting-stage-transcript-moved-");
	faux = registerFauxProvider();
});

afterEach(() => {
	faux.unregister();
	removeTempDirectory(cwd);
});

/**
 * The real SDK session with a detachable tool that finishes after a moment. `respond` answers the model's requests;
 * `hook` runs on each session the stage opens, to move its transcript the way a late delivery or a host would.
 */
async function harness(
	respond: (request: ModelRequest) => ReturnType<typeof fauxAssistantMessage>,
	options: { readonly retries?: boolean } = {},
): Promise<Harness> {
	const model = faux.getModel();
	const requests: string[][] = [];
	const lastTexts: string[] = [];
	faux.setResponses(
		Array.from({ length: 12 }, () => (context: ModelRequest) => {
			requests.push(context.messages.map((message) => message.role));
			lastTexts.push(lastText(context.messages));
			return respond(context);
		}),
	);
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials: authStorage,
		modelsPath: null,
		modelsStore: new InMemoryCodingAgentModelsStore(),
	});
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		api: faux.api,
		models: faux.models.map((registered) => ({
			id: registered.id,
			name: registered.name,
			api: registered.api,
			reasoning: registered.reasoning,
			input: registered.input,
			contextWindow: registered.contextWindow,
			maxTokens: registered.maxTokens,
			cost: registered.cost,
		})),
	});
	let toolRuns = 0;
	const waitForCi: ToolDefinition = {
		name: "wait_for_ci",
		label: "Wait for CI",
		description: "Waits for the CI run of the change",
		parameters: Type.Object({}),
		detachable: true,
		execute: async (): Promise<AgentToolResult> => {
			toolRuns += 1;
			await new Promise((resolve) => setTimeout(resolve, 5));
			return { content: [{ type: "text", text: "ci passed" }], details: undefined };
		},
	};
	const sdkAdapter = createAgentSessionAdapter({
		cwd,
		agentDir: join(cwd, "agent"),
		model,
		modelRuntime,
		settingsManager: SettingsManager.inMemory({
			retry: options.retries === true ? { enabled: true, maxRetries: 2, baseDelayMs: 1 } : { enabled: false },
		}),
		builtins: BUILTINS,
		tools: ["wait_for_ci", "structured_output"],
	});
	const sessionStore = new MemorySessionStore();
	return {
		sessionStore,
		toolRuns: () => toolRuns,
		requests,
		lastTexts,
		waitForCi,
		async run(definition, hook) {
			const agentSession: NonNullable<StageAdapters["agentSession"]> = {
				async create(...args) {
					const created = await sdkAdapter.create(...args);
					hook(("session" in created ? created.session : created) as unknown as Session);
					return created;
				},
			};
			return run(
				definition,
				{},
				{
					store: createStore(),
					durableBackend: await createMemoryTestBackend(),
					releaseWhenWaiting: { afterMs: 0 },
					adapters: { sessionStore, agentSession },
				},
			);
		},
		async transcript(sessionId) {
			assert.ok(sessionId !== undefined, "the stage has a session");
			const saved = await sessionStore.load(sessionId);
			return saved.entries.flatMap((entry) => {
				if (entry.type === "custom_message") return ["custom"];
				if (entry.type !== "message" || entry.message.role === "system") return [];
				const { message } = entry;
				return [message.role === "assistant" ? `assistant/${message.stopReason}` : message.role];
			});
		},
	};
}

function callsCi(): ReturnType<typeof fauxAssistantMessage> {
	return fauxAssistantMessage([fauxToolCall("wait_for_ci", {})], { stopReason: "toolUse" });
}

describe("a stage whose transcript would move past the call it waits on (#4580)", () => {
	test("a notification delivered as the reopened session is handed the result joins the turn that continues, and the stage completes (#4580)", async () => {
		const rig = await harness(({ messages }) => {
			if (messages.at(-1)?.role === "user" && lastText(messages).includes("child finished"))
				return fauxAssistantMessage("ci passed; child finished");
			return messages.some((message) => message.role === "toolResult")
				? fauxAssistantMessage("ci passed")
				: callsCi();
		});
		const definition = workflow({
			name: "notified-stage",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.task("implement", { prompt: "ship the change", customTools: [rig.waitForCi] });
				return {};
			},
		});

		const result = await rig.run(definition, (session) => {
			const resume = session.resumeDetachedTurn?.bind(session);
			session.resumeDetachedTurn = async (results) => {
				// Delivered the way a finished subagent's notice is, with its turn requested, right before the hand-back.
				await session.sendCustomMessages([NOTIFICATION], NOTIFICATION_OPTIONS);
				await resume?.(results);
			};
		});

		assert.equal(result.status, "completed", result.error);
		const stage = result.stages.find((candidate) => candidate.name === "implement");
		assert.equal(stage?.status, "completed");
		assert.equal(stage?.result, "ci passed; child finished");
		assert.deepEqual(await rig.transcript(stage?.sessionId), [
			"user",
			"assistant/toolUse",
			"custom",
			"toolResult",
			"custom",
			"assistant/stop",
		]);
		assert.equal(rig.toolRuns(), 1);
		assert.equal(rig.requests.length, 2, "the notification started no turn of its own");
	});

	test("a notification delivered right after the detaching prompt survives the stage releasing its session and reaches the model after the result (#4580)", async () => {
		const rig = await harness(({ messages }) => {
			if (lastText(messages).includes("child finished")) return fauxAssistantMessage("ci passed; child finished");
			return messages.some((message) => message.role === "toolResult")
				? fauxAssistantMessage("ci passed")
				: callsCi();
		});
		const definition = workflow({
			name: "notified-before-release",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.task("implement", { prompt: "ship the change", customTools: [rig.waitForCi] });
				return {};
			},
		});

		const result = await rig.run(definition, (session) => {
			const prompt = session.prompt.bind(session);
			let sent = false;
			session.prompt = async (text, options) => {
				await prompt(text, options);
				if (sent) return;
				sent = true;
				await session.sendCustomMessages([NOTIFICATION], NOTIFICATION_OPTIONS);
			};
		});

		assert.equal(result.status, "completed", result.error);
		const stage = result.stages.find((candidate) => candidate.name === "implement");
		assert.equal(stage?.result, "ci passed; child finished");
		assert.equal(rig.requests.length, 2, "the notification started no turn of its own");
		assert.deepEqual(rig.requests[1]?.slice(-2), ["toolResult", "user"], "it reached the model after the result");
		assert.match(rig.lastTexts[1] ?? "", /child finished/);
	});

	test("a stage that finished with its structured_output keeps that result when the call it left detached is handed back late, and the run goes on (#4580)", async () => {
		const rig = await harness(({ messages }) => {
			if (isInference(messages))
				return fauxAssistantMessage([fauxToolCall("structured_output", { verdict: "shipped" })], {
					stopReason: "toolUse",
				});
			const last = lastText(messages);
			if (last.includes("wrap up now"))
				return fauxAssistantMessage(
					[fauxToolCall("structured_output", { instructions: "State the verdict", state: { note: "done" } })],
					{ stopReason: "toolUse" },
				);
			if (last.includes("report")) return fauxAssistantMessage("reported");
			return callsCi();
		});
		const definition = workflow({
			name: "late-hand-back",
			description: "",
			inputs: {},
			outputs: { verdict: Type.String(), report: Type.String() },
			run: async (ctx) => {
				const review = await ctx.task("review", {
					prompt: "ship the change",
					customTools: [rig.waitForCi],
					schema: Type.Object({ verdict: Type.String() }),
				});
				const report = await ctx.task("report", { prompt: "report" });
				return { verdict: (review.structured as { verdict: string }).verdict, report: report.text };
			},
		});

		const result = await rig.run(definition, (session) => {
			const prompt = session.prompt.bind(session);
			let moved = false;
			// The host runs another turn on the live session before it takes the calls the first one detached.
			session.prompt = async (text, options) => {
				await prompt(text, options);
				if (moved) return;
				moved = true;
				await prompt("wrap up now", options);
			};
		});

		assert.equal(result.status, "completed", result.error);
		assert.deepEqual(result.result, { verdict: "shipped", report: "reported" });
		const review = result.stages.find((candidate) => candidate.name === "review");
		assert.equal(review?.status, "completed");
		assert.deepEqual(await rig.transcript(review?.sessionId), [
			"user",
			"assistant/toolUse",
			"user",
			"assistant/toolUse",
			"toolResult",
		]);
		assert.equal(result.stages.find((candidate) => candidate.name === "report")?.status, "completed");
	});

	test("a hand-back that finds the session running waits for the run to settle, then goes on (#4580)", async () => {
		const rig = await harness(({ messages }) => {
			if (lastText(messages).includes("meanwhile")) return fauxAssistantMessage("wrapped up");
			return messages.some((message) => message.role === "toolResult")
				? fauxAssistantMessage("ci passed")
				: callsCi();
		});
		const definition = workflow({
			name: "busy-hand-back",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.task("implement", { prompt: "ship the change", customTools: [rig.waitForCi] });
				return {};
			},
		});

		const result = await rig.run(definition, (session) => {
			const resume = session.resumeDetachedTurn?.bind(session);
			let ran = false;
			session.resumeDetachedTurn = async (results) => {
				if (ran) return resume?.(results);
				ran = true;
				const started = Promise.withResolvers<void>();
				const unsubscribe = session.subscribe((event) => {
					if (event.type === "agent_start") started.resolve();
				});
				const running = session.prompt("meanwhile, wrap up");
				await started.promise;
				unsubscribe();
				try {
					await resume?.(results);
				} finally {
					await running;
				}
			};
		});

		assert.equal(result.status, "completed", result.error);
		const stage = result.stages.find((candidate) => candidate.name === "implement");
		assert.equal(stage?.status, "completed");
		assert.equal(stage?.result, "wrapped up");
	});

	test("a compaction during the prompt that detached a call is not an empty completion, so the stage is not prompted again (#4580)", async () => {
		const rig = await harness(({ messages }) => {
			if (isInference(messages))
				return fauxAssistantMessage([fauxToolCall("structured_output", { verdict: "shipped" })], {
					stopReason: "toolUse",
				});
			return messages.some((message) => message.role === "toolResult")
				? fauxAssistantMessage(
						[fauxToolCall("structured_output", { instructions: "State the verdict", state: { note: "done" } })],
						{ stopReason: "toolUse" },
					)
				: callsCi();
		});
		const definition = workflow({
			name: "compacted-prompt",
			description: "",
			inputs: {},
			outputs: { verdict: Type.String() },
			run: async (ctx) => {
				const review = await ctx.task("review", {
					prompt: "review the change",
					customTools: [rig.waitForCi],
					schema: Type.Object({ verdict: Type.String() }),
				});
				return { verdict: (review.structured as { verdict: string }).verdict };
			},
		});

		const result = await rig.run(definition, (session) => {
			const prompt = session.prompt.bind(session);
			session.prompt = async (text, options) => {
				await prompt(text, options);
				// What a compaction leaves of the context the model sees: its summary instead of the messages.
				session.messages.splice(0, session.messages.length, {
					role: "custom",
					customType: "compaction-summary",
					content: [{ type: "text", text: "[User]: retained" }],
					display: false,
					timestamp: Date.now(),
				});
			};
		});

		assert.equal(result.status, "completed", result.error);
		assert.deepEqual(result.result, { verdict: "shipped" });
		assert.equal(
			rig.requests.length,
			3,
			"the call, the structured_output turn and its inference: no repeated prompt",
		);
	});

	test("a continuation that compacts and detaches another call is not prompted with the continuation text while that call waits (#4580)", async () => {
		const rig = await harness(
			({ messages }) => {
				if (isInference(messages))
					return fauxAssistantMessage([fauxToolCall("structured_output", { verdict: "shipped" })], {
						stopReason: "toolUse",
					});
				const results = messages.filter((message) => message.role === "toolResult").length;
				if (results < 2) return callsCi();
				return fauxAssistantMessage(
					[fauxToolCall("structured_output", { instructions: "State the verdict", state: { note: "done" } })],
					{ stopReason: "toolUse" },
				);
			},
			{ retries: true },
		);
		const definition = workflow({
			name: "compacting-continuation",
			description: "",
			inputs: {},
			outputs: { verdict: Type.String() },
			run: async (ctx) => {
				const review = await ctx.task("review", {
					prompt: "review the change",
					customTools: [rig.waitForCi],
					schema: Type.Object({ verdict: Type.String() }),
				});
				return { verdict: (review.structured as { verdict: string }).verdict };
			},
		});

		const result = await rig.run(definition, (session) => {
			const resume = session.resumeDetachedTurn?.bind(session);
			session.resumeDetachedTurn = async (results) => {
				await resume?.(results);
				// What a compaction during the continuation leaves of the context the model sees: its summary.
				session.messages.splice(0, session.messages.length, {
					role: "custom",
					customType: "compaction-summary",
					content: [{ type: "text", text: "[User]: retained" }],
					display: false,
					timestamp: Date.now(),
				});
			};
		});

		assert.equal(result.status, "completed", result.error);
		assert.deepEqual(result.result, { verdict: "shipped" });
		assert.deepEqual(
			rig.lastTexts.filter((text) => text.includes(RESUME_CONTINUATION_PROMPT)),
			[],
			"no request carried the continuation prompt",
		);
		assert.equal(rig.toolRuns(), 2);
	});

	test("a prompt that appends no assistant message to the store is still an empty completion (#4580)", async () => {
		const rig = await harness(() => fauxAssistantMessage("never asked"));
		const definition = workflow({
			name: "empty-prompt",
			description: "",
			inputs: {},
			outputs: { verdict: Type.String() },
			run: async (ctx) => {
				const review = await ctx.task("review", {
					prompt: "review the change",
					schema: Type.Object({ verdict: Type.String() }),
				});
				return { verdict: (review.structured as { verdict: string }).verdict };
			},
		});

		const result = await rig.run(definition, (session) => {
			// A prompt that resolves with nothing done, as one whose provider request was dropped does.
			session.prompt = async () => {};
		});

		assert.notEqual(result.status, "completed");
		assert.equal(result.error, EMPTY_COMPLETION_FAILURE_MESSAGE);
		assert.equal(rig.requests.length, 0);
	});
});
