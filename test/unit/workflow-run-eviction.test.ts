import { describe } from "vitest";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import type { DurableToolCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { evictedRun } from "../../packages/workflows/src/runs/foreground/run-residency.js";
import type { StageLifecycleEvent } from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";
import { assert, createStageControlRegistry, test, workflow } from "./executor-shared.js";
import { entriesOf, quietRounds, stagesWaiting, start, until } from "./run-eviction-helpers.js";

useTemporaryAgentDir();

describe("evicting a run whose stages only wait on detached calls (#4373)", () => {
	test("leaves one index entry per waiting stage, and a burst of results rebuilds the run once by replay: no call runs again and no stage is prompted again (#4373)", async () => {
		const stageControlRegistry = createStageControlRegistry();
		const started = start(stagesWaiting(["alpha", "beta", "gamma"]), { stageControlRegistry });
		const { runId, service, seen, store } = started;
		await until(() => entriesOf(runId).length === 3);

		assert.deepEqual(
			entriesOf(runId)
				.map(({ reason, replayKey, toolCallIds }) => ({ reason, replayKey, toolCallIds }))
				.sort((left, right) => left.replayKey.localeCompare(right.replayKey)),
			["alpha", "beta", "gamma"].map((name) => ({
				reason: "tool",
				replayKey: `stage:${name}:1`,
				toolCallIds: [`call-${name}`],
			})),
		);
		for (const entry of entriesOf(runId)) {
			assert.equal(entry.wakeKey, `${runId}/${entry.stageId}`);
			assert.equal(typeof entry.since, "number");
		}
		assert.equal(seen.created - seen.disposed, 0, "no stage keeps a session while its run is evicted");
		assert.deepEqual(stageControlRegistry.forRun(runId), [], "no stage of the evicted run keeps a control handle");
		assert.equal(store.run(runId)?.status, "running");
		assert.deepEqual(
			store.run(runId)?.stages.map((stage) => stage.status),
			["waiting", "waiting", "waiting"],
		);
		assert.equal(started.starts(), 1);

		service.finishAll();
		const result = await started.result;

		assert.equal(result.status, "completed", result.error);
		assert.equal(started.starts(), 2, "one rebuild serves every result of the burst");
		assert.equal(service.dispatches, 3, "no call ran again");
		assert.equal(service.aborted, 0);
		assert.deepEqual(Object.fromEntries(seen.userPrompts), { alpha: 1, beta: 1, gamma: 1 });
		assert.deepEqual(Object.fromEntries(seen.continued), { alpha: 1, beta: 1, gamma: 1 });
		assert.equal(seen.created, 6, "each stage reopened its session once, for the results");
		assert.deepEqual(
			result.stages.map((stage) => stage.status),
			["completed", "completed", "completed"],
		);
		assert.deepEqual(entriesOf(runId), []);
		assert.equal(evictedRun(runId), undefined);
	});

	test("a stage woken alone rebuilds the run: the stages still waiting take their calls over without a session or a record, and the run is evicted again (#4373)", async () => {
		const journal = new MemoryRunJournal();
		const backend = await JournalDurableBackend.open(journal);
		const events: StageLifecycleEvent[] = [];
		const started = start(stagesWaiting(["alpha", "beta"]), {
			durableBackend: backend,
			onStageLifecycleEvent: (_runId, event) => events.push(event),
		});
		const { runId, service, seen, store } = started;
		await until(() => entriesOf(runId).length === 2);
		assert.equal(backend.getWorkflow(runId)?.status, "running", "an evicted run keeps its running status");
		const createdBeforeWake = seen.created;
		const appended: string[] = [];
		const append = journal.append.bind(journal);
		journal.append = (async (...args: Parameters<MemoryRunJournal["append"]>) => {
			appended.push(JSON.stringify(args));
			return append(...args);
		}) as MemoryRunJournal["append"];

		service.finish("call-alpha");
		await until(() => started.starts() === 2 && entriesOf(runId).length === 1);

		assert.deepEqual(
			entriesOf(runId).map((entry) => [entry.replayKey, entry.toolCallIds]),
			[["stage:beta:1", ["call-beta"]]],
		);
		assert.equal(seen.created - createdBeforeWake, 1, "only the woken stage reopened its session");
		assert.equal(seen.continued.get("alpha"), 1);
		assert.equal(seen.continued.get("beta"), undefined);
		assert.equal(
			appended.filter((entry) => entry.includes("stage:beta:1")).length,
			0,
			"the rebuild wrote nothing for the stage that kept waiting",
		);
		assert.ok(
			appended.some((entry) => entry.includes("stage:alpha:1")),
			"the woken stage's records were seen",
		);
		assert.deepEqual(
			events.filter((event) => event.stageName === "beta").map((event) => event.type),
			["stage_waiting"],
			"the stage that kept waiting was not announced again",
		);
		const beta = store.run(runId)?.stages.find((stage) => stage.name === "beta");
		assert.equal(beta?.status, "waiting");
		assert.deepEqual(beta?.wait?.toolCalls, [{ toolCallId: "call-beta", toolName: "wait_for_ci" }]);
		assert.equal(backend.getWorkflow(runId)?.status, "running");

		service.finish("call-beta");
		const result = await started.result;
		assert.equal(result.status, "completed", result.error);
		assert.equal(started.starts(), 3);
		assert.equal(service.dispatches, 2);
		assert.deepEqual(Object.fromEntries(seen.userPrompts), { alpha: 1, beta: 1 });
		assert.deepEqual(Object.fromEntries(seen.continued), { alpha: 1, beta: 1 });
	});

	test("a stage waiting on a tool after earlier calls finished replays them from the record and continues its waiting turn (#4373)", async () => {
		const definition = workflow({
			name: "evict-after-turns",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const stage = ctx.stage("agent");
				await stage.prompt("plan the change");
				await stage.sendUserMessage("run the tests");
				await stage.sendUserMessage("watch ci");
				await stage.sendUserMessage("summarize");
				return {};
			},
		});
		const started = start(definition, { detachWhen: (text) => text.startsWith("watch") });
		const { runId, service, seen } = started;
		await until(() => entriesOf(runId).length === 1);

		service.finishAll();
		const result = await started.result;

		assert.equal(result.status, "completed", result.error);
		assert.equal(started.starts(), 2);
		assert.equal(seen.userPrompts.get("agent"), 4, "no call of the stage was sent again, and the next one was sent");
		assert.equal(seen.continued.get("agent"), 1);
		assert.equal(service.dispatches, 1);
	});

	test("a stage whose two calls finish one before the run is evicted and one after wakes the run once and continues its turn with both results (#4373)", async () => {
		const definition = workflow({
			name: "evict-two-calls",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.stage("agent").prompt("watch ci");
				return {};
			},
		});
		const gate = Promise.withResolvers<void>();
		const started = start(definition, {
			callsPerTurn: 2,
			detachWhen: (text) => text.startsWith("watch"),
			holdStage: { name: "agent", gate: gate.promise, phase: "dispose" },
		});
		const { runId, service, seen } = started;
		await until(() => service.dispatches === 2);
		service.finish("call-agent-1");
		await quietRounds();
		gate.resolve();
		await until(() => entriesOf(runId).length === 1);

		assert.deepEqual(
			entriesOf(runId).map(({ toolCallIds, settledCallIds }) => ({ toolCallIds, settledCallIds })),
			[{ toolCallIds: ["call-agent-1", "call-agent-2"], settledCallIds: ["call-agent-1"] }],
		);
		assert.equal(started.starts(), 1);

		service.finish("call-agent-2");
		const result = await started.result;

		assert.equal(result.status, "completed", result.error);
		assert.equal(started.starts(), 2, "the second call woke the run");
		assert.equal(service.dispatches, 2, "no call ran again");
		assert.equal(seen.userPrompts.get("agent"), 1);
		assert.equal(seen.continued.get("agent"), 1);
		assert.deepEqual(entriesOf(runId), []);
	});

	test("the host hears of the run's start and its persistence is written once, however often the run is rebuilt, and the run keeps its first start (#4373)", async () => {
		const persisted: string[] = [];
		const startedAts: number[] = [];
		const started = start(stagesWaiting(["alpha", "beta"]), {
			persistence: {
				appendEntry: async (type: string) => {
					persisted.push(type);
				},
			},
			onRunStart: (snapshot) => {
				startedAts.push(snapshot.startedAt);
			},
		});
		const { runId, service } = started;
		await until(() => entriesOf(runId).length === 2);
		const firstStart = started.store.run(runId)!.startedAt;

		service.finish("call-alpha");
		await until(() => started.starts() === 2 && entriesOf(runId).length === 1);
		assert.equal(started.store.run(runId)!.startedAt, firstStart);
		service.finishAll();
		const result = await started.result;

		assert.equal(result.status, "completed", result.error);
		assert.equal(started.starts(), 3);
		assert.equal(startedAts.length, 1, "the host's start callback ran once");
		assert.equal(persisted.filter((type) => type === "workflow.run.start").length, 1);
		assert.equal(persisted.filter((type) => type === "workflow.run.end").length, 1);
		assert.equal(started.store.run(runId)!.startedAt, firstStart);
	});

	test("an entry names the file a stage's session reports its conversation is stored in, and has no such key when it reports none (#4373)", async () => {
		const reported = start(stagesWaiting(["alpha"]), { sessionFile: "/stored/alpha.jsonl" });
		await until(() => entriesOf(reported.runId).length === 1);
		const [withFile] = entriesOf(reported.runId);
		assert.equal(withFile!.session.sessionFile, "/stored/alpha.jsonl");
		assert.deepEqual(Object.keys(withFile!.session).sort(), ["cwd", "sessionFile", "sessionId"]);
		reported.service.finishAll();
		assert.equal((await reported.result).status, "completed");

		const unreported = start(stagesWaiting(["alpha"]));
		await until(() => entriesOf(unreported.runId).length === 1);
		assert.deepEqual(Object.keys(entriesOf(unreported.runId)[0]!.session).sort(), ["cwd", "sessionId"]);
		unreported.service.finishAll();
		assert.equal((await unreported.result).status, "completed");
	});

	test("a run that defers its workflow start reports it ready once however often it is rebuilt, and one that does not defer reports nothing (#4373)", async () => {
		let ready = 0;
		const deferred = start(stagesWaiting(["alpha", "beta"]), {
			deferWorkflowStart: true,
			onWorkflowStartReady: () => {
				ready += 1;
			},
		});
		await until(() => entriesOf(deferred.runId).length === 2);
		deferred.service.finish("call-alpha");
		await until(() => deferred.starts() === 2 && entriesOf(deferred.runId).length === 1);
		deferred.service.finishAll();
		assert.equal((await deferred.result).status, "completed");
		assert.equal(deferred.starts(), 3);
		assert.equal(ready, 1);

		let notDeferredReady = 0;
		const direct = start(stagesWaiting(["alpha"]), {
			onWorkflowStartReady: () => {
				notDeferredReady += 1;
			},
		});
		await until(() => entriesOf(direct.runId).length === 1);
		direct.service.finishAll();
		assert.equal((await direct.result).status, "completed");
		assert.equal(notDeferredReady, 0);

		const unobserved = start(stagesWaiting(["alpha"]), { deferWorkflowStart: true });
		await until(() => entriesOf(unobserved.runId).length === 1);
		unobserved.service.finishAll();
		assert.equal((await unobserved.result).status, "completed");
	});

	test("a rebuilt run keeps the time its first execution inherited and its first start, and counts neither twice (#4373)", async () => {
		const backend = await createMemoryTestBackend();
		const runId = crypto.randomUUID();
		await backend.commitWorkflowRegistration({
			workflowId: runId,
			name: "evict-waiting",
			inputs: {},
			createdAt: 1_000,
			status: "running",
		});
		const recordElapsed = (elapsedMs: number): Promise<void> =>
			backend.commitCheckpoint({
				kind: "tool",
				workflowId: runId,
				checkpointId: `run-timing:${elapsedMs}`,
				name: "workflow-run-timing",
				argsHash: "workflow-run-timing",
				output: { elapsedMs },
				completedAt: Date.now(),
			} satisfies DurableToolCheckpoint);
		await recordElapsed(120_000);
		const started = start(stagesWaiting(["alpha", "beta"]), { runId, durableBackend: backend });
		await until(() => entriesOf(runId).length === 2);
		const firstStart = started.store.run(runId)!.startedAt;
		assert.equal(started.store.run(runId)!.accumulatedDurationMs, 120_000);

		await recordElapsed(210_000);
		started.service.finish("call-alpha");
		await until(() => started.starts() === 2 && entriesOf(runId).length === 1);
		assert.equal(started.store.run(runId)!.accumulatedDurationMs, 120_000, "the checkpoint was not inherited again");
		assert.equal(started.store.run(runId)!.startedAt, firstStart);
		started.service.finishAll();
		assert.equal((await started.result).status, "completed");
	});

	test("a stage that waits after earlier calls is rebuilt again when the other stage wakes first: its saved wait survives the first replay (#4373)", async () => {
		const definition = workflow({
			name: "evict-twice",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await Promise.all(
					["alpha", "beta"].map(async (name) => {
						const stage = ctx.stage(name);
						await stage.prompt(`plan ${name}`);
						await stage.sendUserMessage(`watch ${name}`);
					}),
				);
				return {};
			},
		});
		const started = start(definition, { detachWhen: (text) => text.startsWith("watch") });
		const { runId, service } = started;
		await until(() => entriesOf(runId).length === 2);

		service.finish("call-alpha");
		await until(() => started.starts() === 2 && entriesOf(runId).length === 1);
		service.finish("call-beta");
		const result = await started.result;

		assert.equal(result.status, "completed", result.error);
		assert.equal(started.starts(), 3);
		assert.equal(service.dispatches, 2, "no call ran again");
		assert.deepEqual(Object.fromEntries(started.seen.continued), { alpha: 1, beta: 1 });
		assert.deepEqual(Object.fromEntries(started.seen.userPrompts), { alpha: 2, beta: 2 });
	});

	for (const blocker of ["tool", "ui", "stage", "workflow"] as const)
		test(`a run is not evicted while a ${blocker} call runs beside its waiting stage, and is once it settles (#4373)`, async () => {
			const gate = Promise.withResolvers<void>();
			const child = workflow({
				name: "evict-child",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					await ctx.tool("child-wait", {}, async () => {
						await gate.promise;
						return "settled";
					});
					return {};
				},
			});
			const definition = workflow({
				name: `evict-blocked-by-${blocker}`,
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					const waiting = ctx.stage("waiting").prompt("watch ci");
					if (blocker === "tool")
						await ctx.tool("slow", {}, async () => {
							await gate.promise;
							return "settled";
						});
					else if (blocker === "ui") await ctx.ui.input("Anything to add?");
					else if (blocker === "workflow") await ctx.workflow(child, {});
					else await ctx.stage("busy").prompt("plan");
					await waiting;
					return {};
				},
			});
			const started = start(definition, {
				detachWhen: (text) => text !== "plan",
				holdStage: { name: "busy", gate: gate.promise },
				ui: {
					input: async () => {
						await gate.promise;
						return "nothing";
					},
					confirm: async () => true,
					select: async (_message, options) => options[0]!,
					editor: async () => "",
					custom: async () => {
						throw new Error("no custom UI in this test");
					},
				},
			});
			await until(() => started.service.dispatches === 1);
			await quietRounds();
			assert.deepEqual(entriesOf(started.runId), [], `evicted while a ${blocker} call ran`);

			gate.resolve();
			await until(() => entriesOf(started.runId).length === 1);
			started.service.finishAll();
			const result = await started.result;
			assert.equal(result.status, "completed", result.error);
			assert.equal(started.service.dispatches, 1);
		});
});
