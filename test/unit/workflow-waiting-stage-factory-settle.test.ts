import { afterEach, describe, vi } from "vitest";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { READINESS_GATE_ADVANCE_LABEL } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type {
	StageAdapters,
	StageSessionEvent,
} from "../../packages/workflows/src/runs/foreground/stage-runner-types.js";
import type { StageLifecycleEvent } from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import type { Store } from "../../packages/workflows/src/shared/store.js";
import { store as defaultStore } from "../../packages/workflows/src/shared/store.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import type { StageContext } from "../../packages/workflows/src/shared/types.js";
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

/** Each state of one stage the store is told of, as `status/wait`. */
function observeStage(store: Store, stageName: string): string[] {
	const told: string[] = [];
	const original = store.recordStageStart.bind(store);
	vi.spyOn(store, "recordStageStart").mockImplementation((runId: string, stage: StageSnapshot) => {
		if (stage.name === stageName) told.push(`${stage.status}/${stage.wait?.kind ?? "-"}`);
		original(runId, stage);
	});
	return told;
}

describe("what the run settles when the workflow finishes around waiting stages (#4309)", () => {
	afterEach(() => vi.restoreAllMocks());

	test("a stage paused while it waits released between turns stays paused when the workflow finishes (#4309)", async () => {
		const registry = createStageControlRegistry();
		const store = createStore();
		const definition = workflow({
			name: "paused-released",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const alpha = ctx.stage("alpha");
				await alpha.prompt("plan");
				await alpha.release();
				const run = store.runs()[0]!;
				await registry.get(run.id, run.stages[0]!.id)!.pause();
				return {};
			},
		});

		const result = await run(
			definition,
			{},
			{
				store,
				stageControlRegistry: registry,
				adapters: detachingAdapters(new FakeCiService(), counters(), { detach: false }),
			},
		);
		await registry.clear();

		assert.deepEqual(
			result.stages.map((stage) => [stage.name, stage.status]),
			[["alpha", "paused"]],
			result.error,
		);
	});

	test("a stage paused while it gives its session up for a tool wait shows paused, and runs again once resumed and woken (#4309)", async () => {
		const service = new FakeCiService();
		const registry = createStageControlRegistry();
		const store = createStore();
		const disposing = Promise.withResolvers<void>();
		const disposeGate = Promise.withResolvers<void>();
		let disposals = 0;
		const seen: { atWait?: string; afterWake?: string } = {};
		const told = observeStage(store, "implement");
		const definition = workflow({
			name: "paused-into-tool-wait",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const task = ctx.task("implement", { prompt: "watch ci" });
				await disposing.promise;
				const run = store.runs()[0]!;
				const handle = registry.get(run.id, run.stages[0]!.id)!;
				await handle.pause();
				disposeGate.resolve();
				const stage = (): StageSnapshot => store.runs()[0]!.stages[0]!;
				while (stage().wait === undefined) await new Promise((resolve) => setImmediate(resolve));
				seen.atWait = stage().status;
				await handle.resume();
				const resumedAt = told.length;
				service.finishAll();
				await task;
				seen.afterWake = told.slice(resumedAt).find((state) => state.endsWith("/-"));
				return {};
			},
		});

		const result = await run(
			definition,
			{},
			{
				store,
				stageControlRegistry: registry,
				releaseWhenWaiting: { afterMs: 0 },
				adapters: detachingAdapters(service, counters(), {
					beforeDispose: () => {
						disposals += 1;
						if (disposals !== 1) return Promise.resolve();
						disposing.resolve();
						return disposeGate.promise;
					},
				}),
			},
		);
		await registry.clear();

		assert.equal(result.status, "completed", result.error);
		// Woken, the stage is shown running again, not paused as it was when its wait began.
		assert.deepEqual(seen, { atWait: "paused", afterWake: "running/-" });
	});

	test("a stage still waiting on its tool when the workflow returns is not shown settled as if released between turns (#4309)", async () => {
		const service = new FakeCiService();
		const store = createStore();
		const told = observeStage(store, "implement");
		let atReturn = -1;
		const definition = workflow({
			name: "tool-wait-at-return",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const waiting = Promise.withResolvers<void>();
				void ctx.task("implement", { prompt: "watch ci" }).catch(() => {});
				const unsubscribe = store.subscribe(() => {
					if (store.runs()[0]?.stages[0]?.status === "suspended") waiting.resolve();
				});
				await waiting.promise;
				unsubscribe();
				atReturn = told.length;
				return {};
			},
		});

		await run(
			definition,
			{},
			{
				store,
				releaseWhenWaiting: { afterMs: 0 },
				adapters: detachingAdapters(service, counters()),
				onStageLifecycleEvent: (_runId: string, event: StageLifecycleEvent) => {
					void event;
				},
			},
		);
		service.finishAll();

		assert.ok(atReturn > 0);
		assert.equal(told.slice(atReturn).includes("completed/-"), false, told.slice(atReturn).join(" | "));
	});

	test("a stage reopened before its readiness question is answered stays awaiting_input (#4589)", async () => {
		defaultStore.clear();
		const released = Promise.withResolvers<void>();
		let interview: StageContext | undefined;
		const told = observeStage(defaultStore, "interview");
		const definition = workflow({
			name: "readiness-reopened",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				interview = ctx.stage("interview");
				await interview.prompt("ask the user");
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
				adapters: askingAdapters(),
				onStageLifecycleEvent: (_runId: string, event: StageLifecycleEvent) => {
					if (event.type === "stage_waiting") released.resolve();
				},
			},
		);
		await released.promise;
		const runSnapshot = defaultStore.runs()[0]!;
		const stage = runSnapshot.stages.find((candidate) => candidate.name === "interview")!;
		assert.equal(stage.status, "awaiting_input");
		const reopenedFrom = told.length;

		await interview!.rehydrate();

		assert.equal(stage.wait, undefined);
		assert.equal(stage.status, "awaiting_input");
		assert.equal(told.slice(reopenedFrom).includes("running/-"), false, told.slice(reopenedFrom).join(" | "));

		assert.equal(
			stageUiBroker.answerStagePrompt(runSnapshot.id, stage.id, { optionLabels: [READINESS_GATE_ADVANCE_LABEL] }),
			true,
		);
		const result = await execution;
		assert.equal(result.status, "completed", result.error);
	});
});

function askingAdapters(): StageAdapters {
	return {
		sessionStore: new MemorySessionStore(),
		agentSession: {
			async create(options) {
				const manager = options.sessionManager;
				assert.ok(manager);
				const listeners = new Set<(event: StageSessionEvent) => void>();
				const session: StageSessionRuntime = {
					...mockSession(manager),
					async prompt(text: string) {
						await manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
						for (const listener of [...listeners]) {
							listener({
								type: "tool_execution_start",
								toolCallId: "ask",
								toolName: "ask_user_question",
								args: {},
							});
							listener({
								type: "tool_execution_end",
								toolCallId: "ask",
								toolName: "ask_user_question",
								isError: false,
								result: { details: { answers: [{ questionIndex: 0, answer: "yes" }], cancelled: false } },
							});
						}
					},
					subscribe(listener) {
						listeners.add(listener);
						return () => listeners.delete(listener);
					},
				};
				return session;
			},
		},
	};
}
