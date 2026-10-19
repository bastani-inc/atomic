import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe } from "vitest";
import { JsonlSessionStore } from "../../packages/coding-agent/src/core/storage/session/jsonl-session-store.js";
import { ensurePostMortemStageHandle } from "../../packages/workflows/src/runs/foreground/postmortem-stage-chat.js";
import type {
	StageControlHandle,
	StageControlRegistry,
} from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { WorkflowAttachPane } from "../../packages/workflows/src/tui/workflow-attach-pane.js";
import {
	assert,
	createStageControlRegistry,
	deferred,
	mockSession,
	pauseRun,
	resumeRun,
	run,
	test,
	waitForMicrotasks,
	workflow,
} from "./executor-shared.js";
import {
	createPersistedStageFixture,
	type PersistedStageFixture,
	type PersistedStageFixtureOptions,
	type PersistedStageSession,
} from "./persisted-stage-fixture.js";

interface CompletedStage {
	readonly registry: StageControlRegistry;
	readonly store: ReturnType<typeof createStore>;
	readonly fixture: PersistedStageFixture;
	readonly runId: string;
	readonly stageId: string;
	readonly handle: StageControlHandle;
	readonly record: PersistedStageSession;
	/** What the test set up to keep the session in use, undone by `lift()`. */
	lift(): Promise<void>;
}

/**
 * Runs a one-stage workflow whose body reaches the completed stage's handle
 * through the registry, as a consumer would, and leaves `hold` in place when
 * the run ends.
 */
async function completeStageHeldBy(
	hold: (stage: Omit<CompletedStage, "lift">) => (() => void | Promise<void>) | undefined,
	fixtureOptions: PersistedStageFixtureOptions = {},
): Promise<CompletedStage> {
	const registry = createStageControlRegistry();
	const store = createStore();
	const fixture = createPersistedStageFixture(fixtureOptions);
	let ids: { runId: string; stageId: string } | undefined;
	let handle: StageControlHandle | undefined;
	let lift: (() => void | Promise<void>) | undefined;
	const def = workflow({
		name: "held-completed-stage",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("only").prompt("workflow prompt");
			const { runId, stageId } = ids!;
			handle = registry.get(runId, stageId)!;
			lift = hold({ registry, store, fixture, runId, stageId, handle, record: fixture.sessions[0]! });
			return {};
		},
	});
	await run(
		def,
		{},
		{
			store,
			stageControlRegistry: registry,
			adapters: fixture.adapters,
			onStageStart: (runId, stage) => {
				ids ??= { runId, stageId: stage.id };
			},
		},
	);
	const { runId, stageId } = ids!;
	return {
		registry,
		store,
		fixture,
		runId,
		stageId,
		handle: handle!,
		record: fixture.sessions[0]!,
		async lift() {
			await lift?.();
		},
	};
}

async function assertKeptThenReleasedWhenLifted(stage: CompletedStage): Promise<void> {
	assert.equal(stage.registry.get(stage.runId, stage.stageId), stage.handle, "the stage stays registered");
	assert.equal(stage.fixture.disposals(), 0, "the live session is not disposed");
	await stage.lift();
	await stage.registry.releaseIdle(stage.runId);
	assert.equal(
		stage.registry.get(stage.runId, stage.stageId),
		undefined,
		"the stage is released once nothing needs it",
	);
	assert.equal(stage.fixture.disposals(), 1);
}

describe("completed stage session release", () => {
	test("releases every completed stage session once the run ends, without clearDetached (#3622)", async () => {
		const registry = createStageControlRegistry();
		const store = createStore();
		const fixture = createPersistedStageFixture();
		const def = workflow({
			name: "completed-session-release",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				for (let i = 0; i < 120; i++) await ctx.stage(`stage-${i}`).prompt("synthetic");
				return {};
			},
		});

		const result = await run(def, {}, { store, stageControlRegistry: registry, adapters: fixture.adapters });

		assert.equal(result.status, "completed");
		const snapshot = store.runs()[0]!;
		assert.equal(snapshot.stages.length, 120);
		assert.ok(snapshot.stages.every((stage) => stage.status === "completed" && stage.attached !== true));
		assert.equal(fixture.sessions.length, 120);
		assert.equal(fixture.disposals(), 120);
		assert.equal(registry.forRun(snapshot.id).length, 0);
		assert.equal(registry.run(snapshot.id).stages().length, 0);
	});

	describe("a failed run, which can be resumed, releases its completed stages too", () => {
		function failingWorkflow(failAt: { stage: string | undefined }) {
			return workflow({
				name: "failed-run-release",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					for (const name of ["one", "two", "three"]) await ctx.stage(name).prompt(`prompt ${name}`);
					await ctx.stage("last").prompt(failAt.stage === "last" ? "fail now" : "prompt last");
					return {};
				},
			});
		}

		test("a run that fails after saved stages completed disposes and unregisters them (#3622)", async () => {
			const registry = createStageControlRegistry();
			const store = createStore();
			const fixture = createPersistedStageFixture({
				onPrompt(text) {
					if (text === "fail now") throw new Error("stage exploded");
				},
			});

			const result = await run(
				failingWorkflow({ stage: "last" }),
				{},
				{ store, stageControlRegistry: registry, adapters: fixture.adapters },
			);

			assert.equal(result.status, "failed");
			const snapshot = store.runs()[0]!;
			assert.equal(snapshot.resumable, true, "an ordinary failed run is resumable");
			const completed = snapshot.stages.filter((stage) => stage.status === "completed");
			assert.equal(completed.length, 3);
			for (const stage of completed) {
				assert.equal(registry.get(snapshot.id, stage.id), undefined, `${stage.name} leaves the registry`);
			}
			assert.deepEqual(
				registry.forRun(snapshot.id).map((handle) => handle.stageName),
				["last"],
				"only the stage that did not complete stays registered",
			);
			assert.equal(fixture.sessions.length, 4);
			assert.equal(fixture.disposals(), 3, "every completed session was disposed");
			await registry.clear();
		});

		test("a failed run whose completed stages were released resumes by replaying them (#3622)", async () => {
			const registry = createStageControlRegistry();
			const store = createStore();
			const fixture = createPersistedStageFixture({
				onPrompt(text) {
					if (text === "fail now") throw new Error("stage exploded");
				},
			});
			let bodyRuns = 0;
			const failAt: { stage: string | undefined } = { stage: "last" };
			const def = failingWorkflow(failAt);
			const counted = workflow({
				name: "failed-run-release",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx, ...rest) => {
					bodyRuns += 1;
					return def.run(ctx, ...rest);
				},
			});

			const failed = await run(counted, {}, { store, stageControlRegistry: registry, adapters: fixture.adapters });
			assert.equal(failed.status, "failed");
			const source = store.runs().find((candidate) => candidate.id === failed.runId)!;
			assert.equal(fixture.disposals(), 3);
			const createdBeforeResume = fixture.sessions.length;

			failAt.stage = undefined;
			const resumed = await run(
				counted,
				{},
				{
					store,
					stageControlRegistry: registry,
					adapters: fixture.adapters,
					continuation: { source, resumeFromStageId: source.failedStageId! },
				},
			);

			assert.equal(resumed.status, "completed", resumed.error);
			assert.equal(bodyRuns, 2);
			assert.deepEqual(
				resumed.stages.map((stage) => [stage.name, stage.replayed === true]),
				[
					["one", true],
					["two", true],
					["three", true],
					["last", false],
				],
			);
			assert.equal(
				fixture.sessions.length,
				createdBeforeResume + 1,
				"only the stage that had not completed created a session",
			);
			assert.deepEqual(fixture.sessions.at(-1)!.prompts, ["prompt last"]);

			const releasedStage = source.stages.find((stage) => stage.name === "one")!;
			const reopened = await ensurePostMortemStageHandle(source.id, releasedStage, {
				registry,
				adapters: fixture.adapters,
			});
			assert.equal(
				reopened.ok,
				true,
				"a released stage of the failed run still reopens from its saved conversation",
			);
			await registry.clear();
		});
	});

	test("a stage context keeps its session while the workflow body can still reuse it (#3622)", async () => {
		const registry = createStageControlRegistry();
		const store = createStore();
		const fixture = createPersistedStageFixture();
		const def = workflow({
			name: "reused-stage-context",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const stage = ctx.stage("only");
				await stage.prompt("first");
				assert.equal(fixture.disposals(), 0, "the completed stage is not released while the body runs");
				await stage.sendUserMessage("follow-on turn");
				return {};
			},
		});

		await run(def, {}, { store, stageControlRegistry: registry, adapters: fixture.adapters });

		assert.deepEqual(fixture.sessions[0]!.prompts, ["first", "follow-on turn"]);
		assert.equal(fixture.sessions.length, 1);
		assert.equal(fixture.disposals(), 1);
	});

	test("a released stage keeps its transcript and reopens it for follow-up chat without rerunning the workflow (#3622)", async () => {
		const registry = createStageControlRegistry();
		const store = createStore();
		const fixture = createPersistedStageFixture();
		let workflowRuns = 0;
		const def = workflow({
			name: "completed-session-reopen",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				workflowRuns += 1;
				await ctx.stage("only").prompt("workflow prompt");
				return {};
			},
		});

		await run(def, {}, { store, stageControlRegistry: registry, adapters: fixture.adapters });

		const runSnapshot = store.runs()[0]!;
		const stage = runSnapshot.stages[0]!;
		assert.equal(fixture.disposals(), 1);
		assert.equal(registry.get(runSnapshot.id, stage.id), undefined);
		assert.equal(registry.getSessionStore(runSnapshot.id, stage.id), fixture.store);
		const savedBefore = await fixture.store.load(stage.sessionId!);

		const reopened = await ensurePostMortemStageHandle(runSnapshot.id, stage, {
			registry,
			adapters: fixture.adapters,
		});
		assert.equal(reopened.ok, true);
		if (!reopened.ok) return;
		await reopened.handle.ensureAttached();
		assert.deepEqual(
			fixture.sessions[1]!.session.messages.map((message) => message.role),
			["user"],
			"the reopened session starts from the saved conversation",
		);
		await reopened.handle.prompt("follow-up question");

		assert.equal(workflowRuns, 1);
		assert.equal(fixture.sessions.length, 2);
		assert.deepEqual(fixture.sessions[1]!.prompts, ["follow-up question"]);
		assert.equal(store.runs()[0]!.stages[0]!.status, "completed");
		const savedAfter = await fixture.store.load(stage.sessionId!);
		assert.deepEqual(savedAfter.entries.slice(0, savedBefore.entries.length), savedBefore.entries);
		assert.ok(savedAfter.entries.length > savedBefore.entries.length);
		await registry.clear();
	});

	test("a stage saved in an on-disk session store reopens from the file it was released with (#3622)", async () => {
		const directory = mkdtempSync(join(tmpdir(), "atomic-released-stage-"));
		const diskStore = await JsonlSessionStore.open(directory, { exactDirectory: true });
		const registry = createStageControlRegistry();
		try {
			const store = createStore();
			const fixture = createPersistedStageFixture({ store: diskStore });
			const def = workflow({
				name: "released-stage-on-disk",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					await ctx.stage("only").prompt("workflow prompt");
					return {};
				},
			});

			await run(def, {}, { store, stageControlRegistry: registry, adapters: fixture.adapters });

			const runSnapshot = store.runs()[0]!;
			const stage = runSnapshot.stages[0]!;
			assert.equal(fixture.disposals(), 1);
			assert.equal(registry.get(runSnapshot.id, stage.id), undefined);
			const savedFile = readFileSync(stage.sessionFile!, "utf8");

			const reopened = await ensurePostMortemStageHandle(runSnapshot.id, stage, {
				registry,
				adapters: fixture.adapters,
			});
			assert.equal(reopened.ok, true);
			if (!reopened.ok) return;
			await reopened.handle.prompt("follow-up question");

			assert.deepEqual(fixture.sessions[1]!.prompts, ["follow-up question"]);
			assert.ok(
				readFileSync(stage.sessionFile!, "utf8").startsWith(savedFile),
				"the saved file is only appended to",
			);
		} finally {
			await registry.clear();
			await diskStore.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("attaching to a released stage reopens its saved conversation in the chat pane (#3622)", async () => {
		const stage = await completeStageHeldBy(() => undefined);
		const { createPostMortemHandleResolver } = await import(
			"../../packages/workflows/src/extension/postmortem-deps.js"
		);
		const pane = new WorkflowAttachPane({
			store: stage.store,
			graphTheme: deriveGraphTheme({}),
			runId: stage.runId,
			stageControlRegistry: stage.registry,
			resolvePostMortemHandle: createPostMortemHandleResolver({
				adapters: stage.fixture.adapters,
				resolveDefaultStageSessionDir: () => undefined,
				store: stage.store,
				stageControlRegistry: stage.registry,
			}),
			initialAttachStageId: stage.stageId,
			onClose: () => {},
		});
		try {
			assert.equal(stage.fixture.disposals(), 1, "the stage was released before it was attached");
			await waitForMicrotasks();
			await waitForMicrotasks();
			assert.equal(pane._hasChatView, true);
			const reopened = stage.registry.get(stage.runId, stage.stageId);
			assert.ok(reopened && reopened !== stage.handle, "a fresh post-mortem handle serves the pane");
			await reopened.ensureAttached();
			assert.equal(stage.fixture.sessions.length, 2);
			assert.equal(stage.fixture.sessions[1]!.session.messages.length, 1);
		} finally {
			pane.dispose();
			await stage.registry.clear();
		}
	});

	test("a completed stage whose session is not saved stays resumable (#3622)", async () => {
		const registry = createStageControlRegistry();
		const store = createStore();
		let disposals = 0;
		const def = workflow({
			name: "unsaved-session-retained",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.stage("only").prompt("workflow prompt");
				return {};
			},
		});

		await run(
			def,
			{},
			{
				store,
				stageControlRegistry: registry,
				adapters: {
					agentSession: {
						async create() {
							return {
								...mockSession(),
								async dispose() {
									disposals += 1;
								},
							};
						},
					},
				},
			},
		);

		const runSnapshot = store.runs()[0]!;
		const retained: StageControlHandle | undefined = registry.get(runSnapshot.id, runSnapshot.stages[0]!.id);
		assert.ok(retained, "a session without a saved transcript cannot be reopened, so it stays live");
		assert.equal(disposals, 0);
		await registry.clear();
		assert.equal(disposals, 1);
	});

	describe("a session that is still needed is kept until the need ends", () => {
		test("a mounted chat subscription keeps the session (#3622)", async () => {
			const stage = await completeStageHeldBy(({ handle }) => handle.subscribe(() => {}));
			await assertKeptThenReleasedWhenLifted(stage);
		});

		test("a delivery activity subscription keeps the session (#3622)", async () => {
			const stage = await completeStageHeldBy(({ handle }) => handle.subscribeDeliveryActivity?.(() => {}));
			await assertKeptThenReleasedWhenLifted(stage);
		});

		test("a chat pane that is mounted but hidden keeps the session (#3622)", async () => {
			let pane: WorkflowAttachPane | undefined;
			const stage = await completeStageHeldBy(({ registry, store, runId, stageId }) => {
				pane = new WorkflowAttachPane({
					store,
					graphTheme: deriveGraphTheme({}),
					runId,
					stageControlRegistry: registry,
					initialAttachStageId: stageId,
					onClose: () => {},
				});
				pane.setVisible(false);
				return () => pane?.dispose();
			});
			try {
				assert.equal(pane?._hasChatView, true, "the hidden pane still has its chat mounted");
				assert.notEqual(stage.store.runs()[0]!.stages[0]!.attached, true, "hidden means not attached in the graph");
				await assertKeptThenReleasedWhenLifted(stage);
			} finally {
				pane?.dispose();
			}
		});

		test("a detached delivery lease keeps the session (#3622)", async () => {
			const stage = await completeStageHeldBy(({ registry, runId, stageId, handle }) => {
				const lease = registry.acquireDetached(runId, stageId, () => handle);
				return () => lease.release();
			});
			await assertKeptThenReleasedWhenLifted(stage);
		});

		test("a queued steering message keeps the session (#3622)", async () => {
			const stage = await completeStageHeldBy(({ record }) => {
				record.emit({ type: "queue_update", steering: ["queued guidance"], followUp: [] });
				return () => record.emit({ type: "queue_update", steering: [], followUp: [] });
			});
			await assertKeptThenReleasedWhenLifted(stage);
		});

		test("a message queued inside the session keeps it even when nothing was published (#3622)", async () => {
			const stage = await completeStageHeldBy(({ record }) => {
				record.activity.pendingMessages = 1;
				return () => {
					record.activity.pendingMessages = 0;
				};
			});
			await assertKeptThenReleasedWhenLifted(stage);
		});

		test("an active turn keeps the session (#3622)", async () => {
			const stage = await completeStageHeldBy(({ record }) => {
				record.activity.streaming = true;
				return () => {
					record.activity.streaming = false;
				};
			});
			await assertKeptThenReleasedWhenLifted(stage);
		});

		test("a follow-up turn still running when the run ends keeps the session (#3622)", async () => {
			const turn = deferred();
			let holdTurns = false;
			let followUp: ReturnType<NonNullable<StageControlHandle["sendUserMessage"]>> | undefined;
			const stage = await completeStageHeldBy(
				({ handle }) => {
					holdTurns = true;
					followUp = handle.sendUserMessage?.("late follow-up");
					return async () => {
						turn.resolve();
						await followUp;
					};
				},
				{
					onPrompt: async () => {
						if (holdTurns) await turn.promise;
					},
				},
			);
			assert.equal(stage.fixture.disposals(), 0);
			await assertKeptThenReleasedWhenLifted(stage);
			assert.deepEqual(stage.record.prompts, ["workflow prompt", "late follow-up"]);
		});

		test("an operation still running on the handle keeps the session (#3622)", async () => {
			const steering = deferred();
			let holdSteering = false;
			let nudge: Promise<void> | undefined;
			const stage = await completeStageHeldBy(
				({ handle }) => {
					holdSteering = true;
					nudge = handle.steer("nudge");
					return async () => {
						steering.resolve();
						await nudge;
					};
				},
				{
					onSteer: async () => {
						if (holdSteering) await steering.promise;
					},
				},
			);
			await assertKeptThenReleasedWhenLifted(stage);
		});

		test("a stage whose latest session checkpoint failed is kept (#3622)", async () => {
			const registry = createStageControlRegistry();
			const store = createStore();
			const fixture = createPersistedStageFixture();
			let checkpointsFail = false;
			const def = workflow({
				name: "failed-final-checkpoint",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					const stage = ctx.stage("only");
					await stage.prompt("first");
					checkpointsFail = true;
					await assert.rejects(stage.sendUserMessage("second"), /journal unavailable/);
					return {};
				},
			});

			await run(
				def,
				{},
				{
					store,
					stageControlRegistry: registry,
					adapters: fixture.adapters,
					onStageSession: async () => {
						if (checkpointsFail) throw new Error("journal unavailable");
					},
				},
			);

			const runSnapshot = store.runs()[0]!;
			assert.ok(
				registry.get(runSnapshot.id, runSnapshot.stages[0]!.id),
				"its saved state is not proven, so it stays live",
			);
			assert.equal(fixture.disposals(), 0);
			await registry.clear();
		});

		test("compaction keeps the session (#3622)", async () => {
			const stage = await completeStageHeldBy(({ record }) => {
				record.activity.compacting = true;
				return () => {
					record.activity.compacting = false;
				};
			});
			await assertKeptThenReleasedWhenLifted(stage);
		});

		test("a retry in progress keeps the session (#3622)", async () => {
			const stage = await completeStageHeldBy(({ record }) => {
				record.activity.retrying = true;
				return () => {
					record.activity.retrying = false;
				};
			});
			await assertKeptThenReleasedWhenLifted(stage);
		});

		test("a held queue keeps the session (#3622)", async () => {
			const stage = await completeStageHeldBy(({ record }) => {
				record.activity.queuedMessagesPaused = true;
				return () => {
					record.activity.queuedMessagesPaused = false;
				};
			});
			await assertKeptThenReleasedWhenLifted(stage);
		});

		test("a stage waiting at its readiness gate is never released (#3622)", async () => {
			const registry = createStageControlRegistry();
			const store = createStore();
			const fixture = createPersistedStageFixture({
				onPrompt(_text, record) {
					record.emit({
						type: "tool_execution_start",
						toolCallId: "question",
						toolName: "ask_user_question",
						args: {},
					});
					record.emit({
						type: "tool_execution_end",
						toolCallId: "question",
						toolName: "ask_user_question",
						result: {},
						isError: false,
					});
				},
			});
			const gate = deferred<boolean>();
			const reached = deferred<{ runId: string; stageId: string }>();
			const def = workflow({
				name: "readiness-gated-stage",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					await ctx.stage("only").prompt("ask the user");
					return {};
				},
			});
			const running = run(
				def,
				{},
				{
					store,
					stageControlRegistry: registry,
					adapters: fixture.adapters,
					confirmStageReadiness: ({ runId, stageId }) => {
						reached.resolve({ runId, stageId });
						return gate.promise;
					},
				},
			);
			const { runId, stageId } = await reached.promise;

			await registry.releaseIdle(runId);
			assert.ok(registry.get(runId, stageId), "the stage still waits on its readiness gate");
			assert.equal(fixture.disposals(), 0);

			gate.resolve(true);
			await running;
			assert.equal(fixture.disposals(), 1, "once the gate advances the stage completes and is released");
		});

		test("a stage that is running or paused is never released (#3622)", async () => {
			const registry = createStageControlRegistry();
			const store = createStore();
			const fixture = createPersistedStageFixture();
			const finish = deferred();
			let ids: { runId: string; stageId: string } | undefined;
			const def = workflow({
				name: "running-stage-not-released",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					await ctx.stage("only").prompt("held");
					return {};
				},
			});
			const running = run(
				def,
				{},
				{
					store,
					stageControlRegistry: registry,
					adapters: createHeldPromptAdapters(fixture, finish.promise),
					onStageStart: (runId, stage) => {
						ids ??= { runId, stageId: stage.id };
					},
				},
			);
			await waitForPrompt(fixture, "held");
			const { runId, stageId } = ids!;

			await registry.releaseIdle(runId);
			assert.equal(registry.get(runId, stageId)?.status, "running");
			assert.equal(fixture.disposals(), 0);

			await pauseRun(runId, { store, stageControlRegistry: registry });
			await registry.releaseIdle(runId);
			assert.equal(registry.get(runId, stageId)?.status, "paused");
			assert.equal(fixture.disposals(), 0);

			await resumeRun(runId, { store, stageControlRegistry: registry });
			finish.resolve();
			await running;
			assert.equal(fixture.disposals(), 1, "the stage is released once it completes and the run ends");
		});
	});

	describe("a message cannot race release", () => {
		test("a message admitted while the transcript is being checked keeps the session and is delivered (#3622)", async () => {
			const registry = createStageControlRegistry();
			const store = createStore();
			const check = delayedTranscriptCheck();
			const fixture = createPersistedStageFixture({ store: check.store });
			let ids: { runId: string; stageId: string } | undefined;
			const def = workflow({
				name: "message-during-release-check",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					await ctx.stage("only").prompt("workflow prompt");
					check.arm();
					return {};
				},
			});
			const running = run(
				def,
				{},
				{
					store,
					stageControlRegistry: registry,
					adapters: fixture.adapters,
					onStageStart: (runId, stage) => {
						ids ??= { runId, stageId: stage.id };
					},
				},
			);
			await check.started;
			const { runId, stageId } = ids!;
			const handle = registry.get(runId, stageId)!;

			const delivery = handle.sendUserMessage?.("racing message");
			check.proceed();
			await running;
			await delivery;

			assert.equal(registry.get(runId, stageId), handle, "the release backed off");
			assert.equal(fixture.disposals(), 0);
			assert.deepEqual(fixture.sessions[0]!.prompts, ["workflow prompt", "racing message"]);
			await registry.releaseIdle(runId);
			assert.equal(fixture.disposals(), 1, "once the message settled the session is released");
		});

		test("a consumer that claims the handle while the transcript is being checked keeps it (#3622)", async () => {
			const registry = createStageControlRegistry();
			const store = createStore();
			const check = delayedTranscriptCheck();
			const fixture = createPersistedStageFixture({ store: check.store });
			let ids: { runId: string; stageId: string } | undefined;
			const def = workflow({
				name: "claim-during-release-check",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					await ctx.stage("only").prompt("workflow prompt");
					check.arm();
					return {};
				},
			});
			const running = run(
				def,
				{},
				{
					store,
					stageControlRegistry: registry,
					adapters: fixture.adapters,
					onStageStart: (runId, stage) => {
						ids ??= { runId, stageId: stage.id };
					},
				},
			);
			await check.started;
			const { runId, stageId } = ids!;
			const claimed = registry.claim(runId, stageId);
			check.proceed();
			await running;

			assert.ok(claimed);
			assert.equal(registry.get(runId, stageId), claimed);
			assert.equal(fixture.disposals(), 0);
			await registry.clear();
		});

		test("a lease acquired while the transcript is being checked keeps the session (#3622)", async () => {
			const registry = createStageControlRegistry();
			const store = createStore();
			const check = delayedTranscriptCheck();
			const fixture = createPersistedStageFixture({ store: check.store });
			let ids: { runId: string; stageId: string } | undefined;
			const def = workflow({
				name: "lease-during-release-check",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					await ctx.stage("only").prompt("workflow prompt");
					check.arm();
					return {};
				},
			});
			const running = run(
				def,
				{},
				{
					store,
					stageControlRegistry: registry,
					adapters: fixture.adapters,
					onStageStart: (runId, stage) => {
						ids ??= { runId, stageId: stage.id };
					},
				},
			);
			await check.started;
			const { runId, stageId } = ids!;
			const lease = registry.acquireDetached(runId, stageId, () => registry.get(runId, stageId)!);
			check.proceed();
			await running;

			assert.equal(fixture.disposals(), 0);
			assert.equal(registry.get(runId, stageId), lease.handle);
			await lease.release();
			await registry.releaseIdle(runId);
			assert.equal(fixture.disposals(), 1);
		});

		test("a message sent through a handle released first fails clearly and is delivered after reopening (#3622)", async () => {
			const stage = await completeStageHeldBy(() => undefined);
			const staleHandle = stage.handle;
			assert.equal(staleHandle.isDisposed, true);

			await assert.rejects(staleHandle.sendUserMessage!("too late"), /session has been disposed/);
			assert.equal(stage.fixture.sessions.length, 1, "the stale handle did not resurrect the session");

			const reopened = await ensurePostMortemStageHandle(stage.runId, stage.store.runs()[0]!.stages[0]!, {
				registry: stage.registry,
				adapters: stage.fixture.adapters,
			});
			assert.equal(reopened.ok, true);
			if (!reopened.ok) return;
			await reopened.handle.prompt("too late");
			assert.deepEqual(stage.fixture.sessions[1]!.prompts, ["too late"]);
			await stage.registry.clear();
		});
	});
});

function createHeldPromptAdapters(
	fixture: PersistedStageFixture,
	release: Promise<void>,
): PersistedStageFixture["adapters"] {
	return {
		...fixture.adapters,
		agentSession: {
			async create(options, meta) {
				const created = await fixture.adapters.agentSession!.create(options, meta);
				const session = "session" in created ? created.session : created;
				return {
					...session,
					async prompt(text: string, promptOptions) {
						await session.prompt(text, promptOptions);
						if (text === "held") await release;
					},
				};
			},
		},
	};
}

async function waitForPrompt(fixture: PersistedStageFixture, text: string): Promise<void> {
	const deadline = Date.now() + 1000;
	while (!fixture.sessions.some((record) => record.prompts.includes(text))) {
		if (Date.now() > deadline) throw new Error(`prompt ${text} was never sent`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** A session store whose next transcript read parks, so a test can act in the middle of the release check. */
function delayedTranscriptCheck(): {
	readonly store: PersistedStageFixture["store"];
	readonly started: Promise<void>;
	arm(): void;
	proceed(): void;
} {
	const started = deferred();
	const proceed = deferred();
	let armed = false;
	const inner = createPersistedStageFixture().store;
	const store = Object.create(inner) as PersistedStageFixture["store"];
	store.load = async (sessionId) => {
		if (armed) {
			armed = false;
			started.resolve();
			await proceed.promise;
		}
		return inner.load(sessionId);
	};
	return {
		store,
		started: started.promise,
		arm() {
			armed = true;
		},
		proceed: () => proceed.resolve(),
	};
}
