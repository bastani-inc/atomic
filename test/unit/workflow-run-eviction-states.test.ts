import v8 from "node:v8";
import vm from "node:vm";
import { describe } from "vitest";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { StageLifecycleEvent } from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import type { StageContext } from "../../packages/workflows/src/shared/types.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import { assert, test, workflow } from "./executor-shared.js";
import { entriesOf, quietRounds, start, until } from "./run-eviction-helpers.js";

useTemporaryAgentDir();

const watching = (text: string): boolean => text.startsWith("watch");

/** A promise that settles once the stage `name` reports it waits on a tool. */
function waitingSignal(): {
	readonly waiting: (name: string) => Promise<void>;
	readonly listener: (runId: string, event: StageLifecycleEvent) => void;
} {
	const signals = new Map<string, PromiseWithResolvers<void>>();
	const signal = (name: string): PromiseWithResolvers<void> => {
		let found = signals.get(name);
		if (found === undefined) {
			found = Promise.withResolvers<void>();
			signals.set(name, found);
		}
		return found;
	};
	return {
		waiting: (name) => signal(name).promise,
		listener: (_runId, event) => {
			if (event.type === "stage_waiting" && event.wait.kind === "tool") signal(event.stageName).resolve();
		},
	};
}

function resolveCollect(): () => void {
	const existing = (globalThis as { gc?: () => void }).gc;
	if (typeof existing === "function") return existing;
	v8.setFlagsFromString("--expose-gc");
	try {
		return vm.runInNewContext("gc") as () => void;
	} finally {
		v8.setFlagsFromString("--no-expose-gc");
	}
}

describe("a stage beside the waiting ones keeps its run resident while it holds anything (#4373)", () => {
	test("a stage that keeps its session resident (#4373)", async () => {
		const definition = workflow({
			name: "evict-beside-resident",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const planner = ctx.stage("planner", { releaseWhenWaiting: false });
				await planner.prompt("plan");
				await ctx.stage("ci").prompt("watch ci");
				await planner.sendUserMessage("report");
				return {};
			},
		});
		const started = start(definition, { detachWhen: watching });
		await until(() => started.service.dispatches === 1 && started.seen.disposed === 1);
		await quietRounds();
		assert.deepEqual(entriesOf(started.runId), [], "evicted while a stage held its session");

		started.service.finishAll();
		const result = await started.result;
		assert.equal(result.status, "completed", result.error);
		assert.equal(started.starts(), 1);
	});

	test("a stage holding a message sent while it waits (#4373)", async () => {
		const signal = waitingSignal();
		const definition = workflow({
			name: "evict-beside-held-input",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const ci = ctx.stage("ci");
				const done = ci.prompt("watch ci");
				await signal.waiting("ci");
				await ci.steer("check the flaky test too");
				await done;
				return {};
			},
		});
		const started = start(definition, { detachWhen: watching, onStageLifecycleEvent: signal.listener });
		await signal.waiting("ci");
		await quietRounds();
		assert.deepEqual(entriesOf(started.runId), [], "evicted while a stage held a message");

		started.service.finishAll();
		const result = await started.result;
		assert.equal(result.status, "completed", result.error);
		assert.equal(started.starts(), 1);
		assert.deepEqual(started.seen.queued, ["ci: steer check the flaky test too"]);
	});

	test("a stage whose session is opening (#4373)", async () => {
		const signal = waitingSignal();
		const gate = Promise.withResolvers<void>();
		const definition = workflow({
			name: "evict-beside-opening",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const ci = ctx.stage("ci").prompt("watch ci");
				await signal.waiting("ci");
				await ctx.stage("opening").setModel("faux/faux-1" as never);
				await ci;
				return {};
			},
		});
		const started = start(definition, {
			detachWhen: watching,
			onStageLifecycleEvent: signal.listener,
			holdStage: { name: "opening", gate: gate.promise, phase: "create" },
		});
		await signal.waiting("ci");
		await quietRounds();
		assert.deepEqual(entriesOf(started.runId), [], "evicted while a stage's session was opening");

		gate.resolve();
		started.service.finishAll();
		const result = await started.result;
		assert.equal(result.status, "completed", result.error);
	});

	test("a stage still giving up its session between turns (#4373)", async () => {
		const gate = Promise.withResolvers<void>();
		const definition = workflow({
			name: "evict-beside-releasing",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const planner = ctx.stage("planner");
				await planner.prompt("plan");
				await ctx.stage("ci").prompt("watch ci");
				await planner.sendUserMessage("report");
				return {};
			},
		});
		const started = start(definition, {
			detachWhen: watching,
			holdStage: { name: "planner", gate: gate.promise, phase: "dispose" },
		});
		await until(() => started.service.dispatches === 1 && started.seen.disposed === 1);
		await quietRounds();
		assert.deepEqual(entriesOf(started.runId), [], "evicted while a stage was giving up its session");

		gate.resolve();
		await until(() => entriesOf(started.runId).length === 1);
		started.service.finishAll();
		const result = await started.result;
		assert.equal(result.status, "completed", result.error);
		assert.equal(started.starts(), 2);
	});

	test("a waiting stage that is paused (#4373)", async () => {
		const signal = waitingSignal();
		const stageControlRegistry = createStageControlRegistry();
		const started = start(
			workflow({
				name: "evict-paused-stage",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					await ctx.stage("ci").prompt("watch ci");
					return {};
				},
			}),
			{
				detachWhen: watching,
				onStageLifecycleEvent: signal.listener,
				stageControlRegistry,
				evictWhenWaiting: { afterMs: 50 },
			},
		);
		await signal.waiting("ci");
		const [handle] = stageControlRegistry.forRun(started.runId);
		assert.ok(handle);
		await handle.pause();
		await quietRounds();
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.deepEqual(entriesOf(started.runId), [], "evicted while a stage was paused");

		await handle.resume();
		await until(() => entriesOf(started.runId).length === 1);
		started.service.finishAll();
		const result = await started.result;
		assert.equal(result.status, "completed", result.error);
	});

	test("a stage that was never called, or was disposed with its session, holds nothing (#4373)", async () => {
		const collect = resolveCollect();
		const definition = workflow({
			name: "evict-beside-unused-and-disposed",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const unused: StageContext = ctx.stage("unused");
				await ctx.stage("planner", { releaseWhenWaiting: false }).prompt("plan");
				await ctx.stage("ci").prompt("watch ci");
				void unused;
				return {};
			},
		});
		const started = start(definition, { detachWhen: watching });
		await until(() => started.service.dispatches === 1);
		for (let round = 0; round < 200 && entriesOf(started.runId).length === 0; round++) {
			collect();
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(entriesOf(started.runId).length, 1, "the run was not evicted once its finished stage was disposed");

		started.service.finishAll();
		const result = await started.result;
		assert.equal(result.status, "completed", result.error);
	});
});

describe("a run with nothing but waiting stages left (#4373)", () => {
	test("is not evicted while every stage holds nothing and its workflow body awaits something else (#4373)", async () => {
		const gate = Promise.withResolvers<void>();
		const started = start(
			workflow({
				name: "evict-nothing-waits",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					await ctx.stage("plain").prompt("plain");
					await gate.promise;
					return {};
				},
			}),
			{ detachWhen: watching },
		);
		await until(() => started.seen.disposed === 1);
		await quietRounds();
		assert.deepEqual(entriesOf(started.runId), []);
		assert.equal(started.starts(), 1);

		gate.resolve();
		const result = await started.result;
		assert.equal(result.status, "completed", result.error);
		assert.equal(started.starts(), 1, "the body was never replayed");
	});

	test("is not evicted while its owner holds it paused, and is once resumed (#4373)", async () => {
		const signal = waitingSignal();
		const { createToolControlRegistry } = await import(
			"../../packages/workflows/src/engine/run-tool-control-registry.js"
		);
		const toolControlRegistry = createToolControlRegistry();
		const started = start(
			workflow({
				name: "evict-paused-run",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					await ctx.stage("ci").prompt("watch ci");
					return {};
				},
			}),
			{
				detachWhen: watching,
				onStageLifecycleEvent: signal.listener,
				toolControlRegistry,
				evictWhenWaiting: { afterMs: 50 },
			},
		);
		await signal.waiting("ci");
		await toolControlRegistry.runControl(started.runId)!.pause();
		await quietRounds();
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.deepEqual(entriesOf(started.runId), [], "evicted while paused");

		await toolControlRegistry.runControl(started.runId)!.resume();
		await until(() => entriesOf(started.runId).length === 1);
		started.service.finishAll();
		const result = await started.result;
		assert.equal(result.status, "completed", result.error);
		assert.equal(started.starts(), 2);
	});

	for (const ending of ["returned", "thrown"] as const)
		test(`is not evicted once its workflow body has ${ending}, even while a stage it left behind waits (#4373)`, async () => {
			const signal = waitingSignal();
			const gate = Promise.withResolvers<void>();
			const started = start(
				workflow({
					name: "evict-after-body",
					description: "",
					inputs: {},
					outputs: {},
					run: async (ctx) => {
						void ctx
							.stage("left")
							.prompt("watch ci")
							.catch(() => {});
						await signal.waiting("left");
						if (ending === "thrown") throw new Error("the body failed");
						return {};
					},
				}),
				{
					detachWhen: watching,
					onStageLifecycleEvent: signal.listener,
					persistence: {
						appendEntry: async (type: string) => {
							if (type === "workflow.run.end") await gate.promise;
						},
					},
				},
			);
			await signal.waiting("left");
			await quietRounds();
			assert.deepEqual(entriesOf(started.runId), [], `evicted after the workflow body ${ending}`);
			gate.resolve();
			const result = await started.result;
			assert.equal(started.starts(), 1);
			assert.deepEqual(entriesOf(started.runId), []);
			assert.notEqual(result.status, "running");
		});
});
