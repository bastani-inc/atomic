import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import {
	createStageReplayKeyGenerator,
	type DurableStageDeps,
	recordStageCheckpoint,
	recordStageSessionCheckpoint,
} from "../../packages/workflows/src/durable/stage-primitive.js";
import { createCheckpointIdGenerator } from "../../packages/workflows/src/durable/tool-primitive.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import type { StageAdapters } from "../../packages/workflows/src/runs/foreground/stage-runner-types.js";
import { isStageReleasedError, StageReleasedError } from "../../packages/workflows/src/shared/stage-wait-errors.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { StageNotice, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { counters, detachingAdapters, FakeCiService } from "./waiting-stage-helpers.js";

const WORKFLOW_NAME = "released-thinking-level";

/**
 * The journal and session store a process leaves when it stops while stage `alpha` waits released after its first
 * prompt: the record has the prompt's answer and the session, but not the session's thinking level.
 */
async function seedStoppedRun(): Promise<{
	readonly runId: string;
	readonly backend: JournalDurableBackend;
	readonly sessionStore: MemorySessionStore;
}> {
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
	await manager.appendMessage({ role: "user", content: "plan alpha", timestamp: 1 });
	const deps = (now: number): DurableStageDeps => ({
		workflowId: runId,
		backend,
		nextCheckpointId: createCheckpointIdGenerator(),
		nextReplayKey: createStageReplayKeyGenerator(runId),
		now: () => now,
	});
	const stage: StageSnapshot = {
		id: "stage-alpha",
		name: "alpha",
		replayKey: "stage:alpha:1",
		status: "completed",
		parentIds: [],
		toolEvents: [],
		startedAt: 1_000,
		endedAt: 2_000,
		durationMs: 1_000,
		result: "planned alpha",
		sessionId: manager.getSessionId(),
	};
	await recordStageCheckpoint(deps(2_000), stage);
	await recordStageSessionCheckpoint(
		deps(3_000),
		{ ...stage, status: "suspended", wait: { kind: "release", since: 3_000, promptsCompleted: 1 } },
		{ force: true },
	);
	return { runId, backend, sessionStore };
}

function observedAdapters(
	seen: ReturnType<typeof counters>,
	sessionStore: MemorySessionStore,
	applied: unknown[],
	failure: () => unknown = () => undefined,
): StageAdapters {
	const adapters = detachingAdapters(new FakeCiService(), seen, { detach: false });
	const create = adapters.agentSession!.create.bind(adapters.agentSession);
	return {
		...adapters,
		sessionStore,
		agentSession: {
			async create(options, meta) {
				if (options.thinkingLevel !== undefined) applied.push(options.thinkingLevel);
				const session = (await create(options, meta)) as StageSessionRuntime;
				let level: unknown = "medium";
				Object.defineProperty(session, "thinkingLevel", {
					get() {
						const error = failure();
						if (error !== undefined) throw error;
						return level;
					},
					configurable: true,
				});
				session.setThinkingLevel = async (next: unknown) => {
					applied.push(next);
					level = next;
				};
				return session;
			},
		},
	};
}

describe("setting the thinking level of a stage a resumed run starts released (#4309)", () => {
	test("setThinkingLevel() keeps the level without reopening the session, and records it as a notice without a previous level", async () => {
		const seeded = await seedStoppedRun();
		const seen = counters();
		const store = createStore();
		let before: unknown;
		let after: unknown;
		let createdWhileReleased = -1;
		let noticesWhileReleased: readonly StageNotice[] = [];
		const definition = workflow({
			name: WORKFLOW_NAME,
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const stage = ctx.stage("alpha");
				await stage.prompt("plan alpha");
				try {
					before = stage.thinkingLevel;
				} catch (error) {
					before = error;
				}
				await stage.setThinkingLevel("low");
				after = stage.thinkingLevel;
				createdWhileReleased = seen.created;
				noticesWhileReleased = [
					...(store.runs()[0]?.stages.find((snapshot) => snapshot.name === "alpha")?.notices ?? []),
				];
				await stage.sendUserMessage("report alpha");
				return {};
			},
		});

		const applied: unknown[] = [];
		const result = await run(
			definition,
			{},
			{
				runId: seeded.runId,
				store,
				durableBackend: seeded.backend,
				adapters: observedAdapters(seen, seeded.sessionStore, applied),
				releaseWhenWaiting: { afterMs: 600_000 },
			},
		);

		assert.equal(result.status, "completed", result.error);
		assert.ok(isStageReleasedError(before) && before.fields.property === "thinkingLevel");
		assert.equal(after, "low");
		assert.equal(createdWhileReleased, 0, "setting the level reopened no session");
		assert.deepEqual(
			noticesWhileReleased.map((notice) => [notice.kind, notice.from, notice.to]),
			[["thinking", undefined, "low"]],
		);
		assert.equal(Object.hasOwn(noticesWhileReleased[0] ?? {}, "from"), false);
		assert.equal(seen.created, 1, "the next message reopened the session once");
		assert.deepEqual(applied, ["low"], "the reopened session received the saved level");
	});

	test("setThinkingLevel() rethrows any other failure to read the current level, and leaves the level unchanged", async () => {
		const failures: unknown[] = [
			new Error("thinking level unavailable"),
			Object.assign(new Error("unrelated thinking level failure"), { fields: { property: "thinkingLevel" } }),
			new StageReleasedError({ stageName: "alpha", property: "model" }),
			{ name: "StageReleasedError", code: "stage-released" },
		];
		let failing: unknown;
		const caught: unknown[] = [];
		const applied: unknown[] = [];
		const store = createStore();
		const definition = workflow({
			name: WORKFLOW_NAME,
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const stage = ctx.stage("alpha");
				await stage.prompt("plan alpha");
				for (const failure of failures) {
					failing = failure;
					try {
						await stage.setThinkingLevel("low");
					} catch (error) {
						caught.push(error);
					} finally {
						failing = undefined;
					}
				}
				return {};
			},
		});

		const result = await run(
			definition,
			{},
			{
				store,
				adapters: observedAdapters(counters(), new MemorySessionStore(), applied, () => failing),
			},
		);

		assert.equal(result.status, "completed", result.error);
		assert.equal(caught.length, failures.length);
		for (const [index, failure] of failures.entries()) assert.equal(caught[index], failure);
		assert.deepEqual(applied, [], "no level was applied");
		assert.deepEqual(store.runs()[0]?.stages[0]?.notices ?? [], []);
	});

	test("setThinkingLevel() records the previous known level in its notice", async () => {
		const applied: unknown[] = [];
		const store = createStore();
		const definition = workflow({
			name: WORKFLOW_NAME,
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const stage = ctx.stage("alpha");
				await stage.prompt("plan alpha");
				await stage.setThinkingLevel("low");
				return {};
			},
		});
		const result = await run(
			definition,
			{},
			{
				store,
				adapters: observedAdapters(counters(), new MemorySessionStore(), applied),
			},
		);
		assert.equal(result.status, "completed", result.error);
		assert.deepEqual(applied, ["low"]);
		assert.deepEqual(
			store.runs()[0]?.stages[0]?.notices?.map(({ kind, from, to }) => ({ kind, from, to })),
			[{ kind: "thinking", from: "medium", to: "low" }],
		);
	});
});
