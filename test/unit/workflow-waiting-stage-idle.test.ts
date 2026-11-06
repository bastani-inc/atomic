import type { SessionManager } from "@bastani/atomic";
import { afterEach, describe, vi } from "vitest";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { READINESS_GATE_ADVANCE_LABEL } from "../../packages/workflows/src/runs/foreground/executor.js";
import { type IdleStage, StageIdleReleaser } from "../../packages/workflows/src/runs/foreground/stage-idle-release.js";
import type { StageLifecycleEvent } from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import { store as defaultStore } from "../../packages/workflows/src/shared/store.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import {
	assert,
	createStore,
	mockSession,
	run,
	type StageSessionRuntime,
	stageUiBroker,
	test,
	workflow,
} from "./executor-shared.js";
import { counters, detachingAdapters, FakeCiService } from "./waiting-stage-helpers.js";

/** Long enough that a stage's own prompt and finalization finish well inside it, even on a loaded machine. */
const IDLE_THRESHOLD_MS = 300;

async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, "condition never held");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function stageNamed(stages: readonly StageSnapshot[] | undefined, name: string): StageSnapshot | undefined {
	return stages?.find((stage) => stage.name === name);
}

describe("the run's idle scan (#4309)", () => {
	test("watching many stages arms one timer for the run, and releases each once it has been idle past its threshold (#4309)", async () => {
		const STAGES = 500;
		const released: string[] = [];
		const timers = vi.spyOn(globalThis, "setTimeout");
		const releaser = new StageIdleReleaser(() => {});
		const idleFrom = Date.now();
		try {
			for (let index = 0; index < STAGES; index++) {
				const stage: IdleStage = {
					afterMs: 20,
					idleSince: () => idleFrom,
					release: async () => {
						released.push(`stage-${index}`);
					},
				};
				releaser.watch(`stage-${index}`, stage);
			}
			// Every stage is due no earlier than the first: the scan's one timer covers them all.
			assert.equal(timers.mock.calls.length, 1);
			while (released.length < STAGES) await new Promise((resolve) => setImmediate(resolve));
			assert.equal(releaser.size, 0);
			// One scan per distinct deadline at most, however many stages: never a timer per stage.
			assert.ok(timers.mock.calls.length < STAGES / 10, `${timers.mock.calls.length} timers for ${STAGES} stages`);
		} finally {
			timers.mockRestore();
			releaser.dispose();
		}
	});

	test("a busy stage is not released, and one that went idle is released only a full threshold after (#4309)", async () => {
		const releaser = new StageIdleReleaser(() => {});
		let idleSince: number | undefined;
		let releasedAt: number | undefined;
		const stage: IdleStage = {
			afterMs: 30,
			idleSince: () => idleSince,
			release: async () => {
				releasedAt = Date.now();
			},
		};
		releaser.watch("stage", stage);
		await new Promise((resolve) => setTimeout(resolve, 60));
		assert.equal(releasedAt, undefined);
		idleSince = Date.now();
		// The stage's own call ended: it is watched afresh from now.
		releaser.watch("stage", stage);
		await until(() => releasedAt !== undefined);
		assert.ok(releasedAt! - idleSince >= 30);
		releaser.dispose();
	});
});

describe("stages held idle by the workflow release their session (#4309)", () => {
	test("a stage the workflow holds unused past its threshold waits released, and its next message reopens the saved session (#4309)", async () => {
		const service = new FakeCiService();
		const seen = counters();
		const store = createStore();
		const events: StageLifecycleEvent[] = [];
		const allIdle = Promise.withResolvers<void>();
		let beforeThreshold: number | undefined;
		let whileIdle: { statuses: (string | undefined)[]; kinds: (string | undefined)[]; live: number } | undefined;
		let afterMessage: string | undefined;
		const NAMES = ["a", "b", "c"];
		const definition = workflow({
			name: "idle-held-stages",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const stages = NAMES.map((name) => ctx.stage(name));
				for (const stage of stages) await stage.prompt("plan");
				// Right after their prompts the stages are idle, but not for long enough yet.
				beforeThreshold = events.length;
				// The workflow now waits on something else (a child workflow, a person) while it holds the stages.
				await allIdle.promise;
				const stagesNow = store.runs()[0]?.stages;
				whileIdle = {
					statuses: NAMES.map((name) => stageNamed(stagesNow, name)?.status),
					kinds: NAMES.map((name) => stageNamed(stagesNow, name)?.wait?.kind),
					live: seen.created - seen.disposed,
				};
				await stages[0]!.sendUserMessage("report");
				afterMessage = stageNamed(store.runs()[0]?.stages, "a")?.status;
				return {};
			},
		});

		const result = await run(
			definition,
			{},
			{
				store,
				adapters: detachingAdapters(service, seen, { detach: false }),
				releaseWhenWaiting: { afterMs: IDLE_THRESHOLD_MS },
				onStageLifecycleEvent: (_runId, event) => {
					events.push(event);
					if (events.filter((candidate) => candidate.type === "stage_waiting").length === NAMES.length)
						allIdle.resolve();
				},
			},
		);

		assert.equal(result.status, "completed", result.error);
		assert.equal(beforeThreshold, 0);
		assert.deepEqual(whileIdle, {
			statuses: ["waiting", "waiting", "waiting"],
			kinds: ["idle", "idle", "idle"],
			live: 0,
		});
		assert.deepEqual(
			events.map((event) => [event.type, event.stageName, event.wait.kind, event.wait.promptsCompleted]),
			[
				["stage_waiting", "a", "idle", 1],
				["stage_waiting", "b", "idle", 1],
				["stage_waiting", "c", "idle", 1],
				["stage_rehydrated", "a", "idle", 1],
			],
		);
		// Only the stage that was sent a message reopened its session; each was prompted for its own work only.
		assert.equal(seen.created, NAMES.length + 1);
		assert.deepEqual(Object.fromEntries(seen.userPrompts), { a: 2, b: 1, c: 1 });
		assert.equal(afterMessage, "completed");
		// Stages still released when the workflow returned show their own status, not `waiting`.
		assert.deepEqual(
			result.stages.map((stage) => [stage.name, stage.status, stage.wait]),
			NAMES.map((name) => [name, "completed", undefined]),
		);
	});

	test("a stage that opts out of releasing stays resident however long the workflow holds it (#4309)", async () => {
		const service = new FakeCiService();
		const seen = counters();
		const events: StageLifecycleEvent[] = [];
		let live: number | undefined;
		const definition = workflow({
			name: "idle-resident",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const stage = ctx.stage("kept", { releaseWhenWaiting: false });
				await stage.prompt("plan");
				await new Promise((resolve) => setTimeout(resolve, 60));
				live = seen.created - seen.disposed;
				return {};
			},
		});

		const result = await run(
			definition,
			{},
			{
				store: createStore(),
				adapters: detachingAdapters(service, seen, { detach: false }),
				releaseWhenWaiting: { afterMs: 0 },
				onStageLifecycleEvent: (_runId, event) => events.push(event),
			},
		);

		assert.equal(result.status, "completed", result.error);
		assert.equal(live, 1);
		assert.deepEqual(events, []);
	});
});

/** A stage session whose first turn asks the user a question, so the stage asks whether it is ready to advance. */
function askingAdapters(created: { count: number }) {
	const sessionStore = new MemorySessionStore();
	return {
		sessionStore,
		agentSession: {
			async create(options: { readonly sessionManager?: unknown }) {
				created.count += 1;
				const manager = options.sessionManager as SessionManager;
				const listeners = new Set<(event: { type: string; [key: string]: unknown }) => void>();
				const session: StageSessionRuntime = {
					...mockSession(manager),
					async prompt(text: string) {
						await manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
						for (const listener of [...listeners]) {
							listener({ type: "tool_execution_start", toolCallId: "ask", toolName: "ask_user_question" });
							listener({
								type: "tool_execution_end",
								toolCallId: "ask",
								toolName: "ask_user_question",
								result: { details: { answers: [{ questionIndex: 0, answer: "yes" }], cancelled: false } },
							});
						}
					},
					subscribe(listener) {
						const typed = listener as (event: { type: string; [key: string]: unknown }) => void;
						listeners.add(typed);
						return () => listeners.delete(typed);
					},
				};
				return session;
			},
		},
	};
}

describe("a readiness question that outlasts the threshold (#4309)", () => {
	afterEach(() => defaultStore.clear());

	test("waits with the session released and the stage still awaiting input; the answer reopens the session (#4309)", async () => {
		defaultStore.clear();
		const created = { count: 0 };
		const events: StageLifecycleEvent[] = [];
		const released = Promise.withResolvers<void>();
		const definition = workflow({
			name: "readiness-release",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.stage("interview").prompt("ask the user");
				return {};
			},
		});

		const execution = run(
			definition,
			{},
			{
				store: defaultStore,
				usePromptNodesForUi: true,
				releaseWhenWaiting: { afterMs: 0 },
				adapters: askingAdapters(created),
				onStageLifecycleEvent: (_runId, event) => {
					events.push(event);
					if (event.type === "stage_waiting") released.resolve();
				},
			},
		);
		await released.promise;
		const runSnapshot = defaultStore.runs()[0]!;
		const stage = stageNamed(runSnapshot.stages, "interview")!;
		assert.equal(stage.status, "awaiting_input");
		assert.equal(stage.wait?.kind, "prompt");
		assert.equal(stage.inputRequest?.kind, "readiness_gate");
		assert.equal(created.count, 1);

		assert.equal(
			stageUiBroker.answerStagePrompt(runSnapshot.id, stage.id, { optionLabels: [READINESS_GATE_ADVANCE_LABEL] }),
			true,
		);
		const result = await execution;

		assert.equal(result.status, "completed", result.error);
		assert.deepEqual(
			events.map((event) => [event.type, event.wait.kind]),
			[
				["stage_waiting", "prompt"],
				["stage_rehydrated", "prompt"],
			],
		);
		// The answer reopened the stage's own session before the stage went on.
		assert.equal(created.count, 2);
		assert.equal(stageNamed(result.stages, "interview")?.status, "completed");
	});
});
