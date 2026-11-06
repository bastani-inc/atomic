import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import {
	createStageReplayKeyGenerator,
	type DurableStageDeps,
	recordStageCheckpoint,
	recordStageSessionCheckpoint,
} from "../../packages/workflows/src/durable/stage-primitive.js";
import { createCheckpointIdGenerator } from "../../packages/workflows/src/durable/tool-primitive.js";
import { run as sdkRun } from "../../packages/workflows/src/runs/foreground/sdk-run.js";
import type { StageAdapters } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import type { StageWaitKind } from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import {
	isRunEvictionConfigError,
	RunEvictionConfigError,
} from "../../packages/workflows/src/shared/run-eviction-errors.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import { assert, createStore, run, test, workflow } from "./executor-shared.js";
import { counters, detachingAdapters, FakeCiService } from "./waiting-stage-helpers.js";

useTemporaryAgentDir();

const WORKFLOW_NAME = "evict-replay";

/**
 * The journal and store a process leaves when it stops while a stage waits: its first prompt answered and recorded,
 * then a wait of `kind` recorded after `promptsCompleted` calls.
 */
async function seedWaitingStage(kind: StageWaitKind, promptsCompleted: number) {
	const runId = crypto.randomUUID();
	const backend = await JournalDurableBackend.open(new MemoryRunJournal());
	await backend.commitWorkflowRegistration({
		workflowId: runId,
		name: WORKFLOW_NAME,
		inputs: {},
		createdAt: 1_000,
		status: "running",
	});
	const sessionStore = new MemorySessionStore();
	const manager = await SessionManager.create(sessionStore, "/");
	await manager.appendMessage({ role: "user", content: "plan agent", timestamp: 1 });
	await manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "planned agent" }],
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	});
	const sessionId = manager.getSessionId();
	const deps = (now: number): DurableStageDeps => ({
		workflowId: runId,
		backend,
		nextCheckpointId: createCheckpointIdGenerator(),
		nextReplayKey: createStageReplayKeyGenerator(runId),
		now: () => now,
	});
	const stage: StageSnapshot = {
		id: "stage-agent",
		name: "agent",
		replayKey: "stage:agent:1",
		status: "completed",
		parentIds: [],
		toolEvents: [],
		startedAt: 1_000,
		endedAt: 2_000,
		durationMs: 1_000,
		result: "planned agent",
		sessionId,
	};
	await recordStageCheckpoint(deps(2_000), stage);
	await recordStageSessionCheckpoint(
		deps(3_000),
		{ ...stage, status: "waiting", wait: { kind, since: 3_000, promptsCompleted } },
		{ force: true },
	);
	return { runId, backend, sessionStore };
}

describe("resuming a stage that waited after earlier calls finished (#4373)", () => {
	test("a tool wait answers the finished calls from the record, and its next call continues the turn instead of sending its text (#4373)", async () => {
		const seeded = await seedWaitingStage("tool", 1);
		const service = new FakeCiService();
		const seen = counters();
		const answers: string[] = [];
		const definition = workflow({
			name: WORKFLOW_NAME,
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const stage = ctx.stage("agent");
				answers.push(await stage.prompt("plan agent"));
				await stage.sendUserMessage("watch ci");
				await stage.sendUserMessage("summarize");
				return {};
			},
		});
		const result = await run(
			definition,
			{},
			{
				runId: seeded.runId,
				store: createStore(),
				durableBackend: seeded.backend,
				adapters: { ...detachingAdapters(service, seen, { detach: false }), sessionStore: seeded.sessionStore },
			},
		);

		assert.equal(result.status, "completed", result.error);
		assert.deepEqual(answers, ["planned agent"]);
		assert.equal(seen.userPrompts.get("agent"), 2, "the continuation and the call after it reached the model");
		const transcript = await seeded.sessionStore.load(result.stages[0]!.sessionId!);
		const texts = transcript.entries.flatMap((entry) =>
			entry.type === "message" && entry.message.role === "user" ? [entry.message.content] : [],
		);
		assert.equal(texts.includes("watch ci"), false, "the waiting call's own text was not sent");
		assert.equal(texts.includes("summarize"), true, "the next call sent its own text");
		assert.equal(result.stages[0]!.wait, undefined, "the stage no longer shows the wait its record held");
	});

	test("a stage that stopped waiting on a person is replayed from its record, not started released (#4373)", async () => {
		const seeded = await seedWaitingStage("prompt", 1);
		const seen = counters();
		let sessionId: string | undefined;
		const definition = workflow({
			name: WORKFLOW_NAME,
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const stage = ctx.stage("agent");
				await stage.prompt("plan agent");
				sessionId = stage.sessionId;
				return {};
			},
		});
		const result = await run(
			definition,
			{},
			{
				runId: seeded.runId,
				store: createStore(),
				durableBackend: seeded.backend,
				adapters: {
					...detachingAdapters(new FakeCiService(), seen, { detach: false }),
					sessionStore: seeded.sessionStore,
				},
			},
		);
		assert.equal(result.status, "completed", result.error);
		assert.equal(sessionId, "durable-replay:agent");
		assert.equal(seen.created, 0);
	});
});

describe("a stage's first prompt (#4373)", () => {
	test("opens its session and records it durably before the prompt reaches the session (#4373)", async () => {
		const backend = await JournalDurableBackend.open(new MemoryRunJournal());
		const runId = crypto.randomUUID();
		const seen = counters();
		const adapters = detachingAdapters(new FakeCiService(), seen, { detach: false });
		const recordedBeforePrompt: (string | undefined)[] = [];
		const watched: StageAdapters = {
			...adapters,
			agentSession: {
				async create(options, meta) {
					const created = await adapters.agentSession!.create(options, meta);
					if ("session" in created) return created;
					const prompt = created.prompt.bind(created);
					return Object.assign(created, {
						prompt: async (text: string) => {
							recordedBeforePrompt.push(backend.getStageSession(runId, "stage:agent:1")?.sessionId);
							return prompt(text);
						},
					});
				},
			},
		};
		const result = await run(
			workflow({
				name: "eager-session",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					await ctx.stage("agent").prompt("plan");
					return {};
				},
			}),
			{},
			{ runId, store: createStore(), durableBackend: backend, adapters: watched },
		);
		assert.equal(result.status, "completed", result.error);
		assert.equal(recordedBeforePrompt.length, 1);
		assert.equal(recordedBeforePrompt[0], result.stages[0]!.sessionId);
	});
});

describe("evictWhenWaiting at the SDK boundary (#4373)", () => {
	test("an invalid value is refused before the run's journal is opened (#4373)", async () => {
		const directory = makeTempDirectory("evict-sdk-boundary-");
		const path = join(directory, "journal.sqlite");
		try {
			await assert.rejects(
				sdkRun(
					workflow({
						name: "evict-sdk-boundary",
						description: "",
						inputs: {},
						outputs: {},
						run: async () => ({}),
					}),
					{},
					{ journal: { path }, evictWhenWaiting: { afterMs: -1 } },
				),
				(error: unknown) => error instanceof RunEvictionConfigError,
			);
			assert.equal(existsSync(path), false, "the journal was opened");
		} finally {
			removeTempDirectory(directory);
		}
	});

	test("a child run ignores evictWhenWaiting: only a root run is evicted (#4373)", async () => {
		const backend = await JournalDurableBackend.open(new MemoryRunJournal());
		const parentId = crypto.randomUUID();
		const outcome = await run(
			workflow({
				name: "evict-child-run",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					await ctx.tool("noop", {}, async () => "done");
					return {};
				},
			}),
			{},
			{
				durableBackend: backend,
				store: createStore(),
				parentRun: { runId: parentId, stageId: "stage-parent", rootRunId: parentId },
				evictWhenWaiting: "soon" as never,
			},
		).then(
			(result) => result,
			(error: unknown) => error,
		);
		assert.equal(isRunEvictionConfigError(outcome), false);
	});
});
