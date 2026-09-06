import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { isDurableWorkflowResumable } from "../../packages/workflows/src/durable/resume-eligibility.js";
import { toolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { workflowAnswerAction } from "../../packages/workflows/src/extension/workflow-tool-answer.js";
import {
	workflowInterruptAction,
	workflowPauseAction,
	workflowResumeAction,
} from "../../packages/workflows/src/extension/workflow-tool-control.js";
import { jobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { quitRun } from "../../packages/workflows/src/runs/background/quit.js";
import { runDetached } from "../../packages/workflows/src/runs/background/runner.js";
import { pauseRun, resumeRun } from "../../packages/workflows/src/runs/background/status.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStore, store } from "../../packages/workflows/src/shared/store.js";
import { INTERACTIVE_WORKFLOW_POLICY } from "../../packages/workflows/src/shared/types.js";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
afterEach(() => {
	store.clear();
	setDurableBackend(undefined);
});

// PR #2885: executor-only control must retain the live owner and actually resume it.
for (const action of ["pause", "interrupt"] as const) {
	test(`${action} gates node-less body work and public resume advances the same owner exactly once`, async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		const entered = Promise.withResolvers<void>();
		const body = Promise.withResolvers<void>();
		const advanced = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		let bodyCalls = 0;
		let toolCalls = 0;
		const definition = workflow({
			name: `body-${action}`,
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				bodyCalls++;
				entered.resolve();
				await body.promise;
				await ctx.tool("after-pause", {}, async () => {
					toolCalls++;
					return "done";
				});
				advanced.resolve();
				await finish.promise;
				return {};
			},
		});
		const runtime = createExtensionRuntime({ definitions: [definition], store });
		const { runId } = runDetached(definition, {}, { store });
		const job = jobTracker.get(runId)!;
		await entered.promise;
		const owner = toolControlRegistry.runControl(runId);
		try {
			const result = await (action === "pause" ? workflowPauseAction : workflowInterruptAction)({ action, runId });
			assert.ok(result.action === "pause" || result.action === "interrupt");
			assert.equal(result.status, "paused");
			assert.match(result.message ?? "", action === "pause" ? /paused/i : /interrupted/i);
			assert.doesNotMatch(result.message ?? "", /quit|cannot be resumed/i);
			assert.equal(store.runs()[0]?.exitReason, undefined);
			assert.equal(store.runs()[0]?.resumable, true);
			assert.equal(backend.getWorkflow(runId)?.status, "paused");
			assert.equal(
				isDurableWorkflowResumable(backend.getWorkflow(runId)!),
				false,
				"no checkpoint means live-only resume",
			);
			body.resolve();
			await turn();
			assert.equal(toolCalls, 0, "later ctx.tool admission waits for explicit resume");
			assert.deepEqual(store.runs()[0]?.toolNodes, []);
			assert.deepEqual(store.runs()[0]?.stages, []);
			assert.equal(jobTracker.get(runId), job);
			assert.equal(toolControlRegistry.runControl(runId), owner);
			const resumed = await workflowResumeAction(
				{ action: "resume", runId },
				{
					getRuntime: () => runtime,
					policy: INTERACTIVE_WORKFLOW_POLICY,
					ensureWorkflowResourcesLoaded: async () => {},
				},
			);
			assert.equal(resumed.action, "resume");
			assert.ok(resumed.action === "resume");
			assert.equal(resumed.status, "ok");
			assert.match(resumed.message ?? "", /resumed workflow runtime/i);
			await advanced.promise;
			assert.equal(backend.getWorkflow(runId)?.status, "running");
			assert.equal(store.runs()[0]?.status, "running");
			assert.equal(jobTracker.get(runId), job);
			assert.equal(toolControlRegistry.runControl(runId), owner);
			assert.equal(bodyCalls, 1);
			assert.equal(toolCalls, 1);
			finish.resolve();
			await job.promise;
			assert.equal(store.runs()[0]?.status, "completed");
		} finally {
			body.resolve();
			finish.resolve();
			job.controller.abort();
			await job.promise;
		}
	});
}

for (const outcome of ["resolve", "reject"] as const) {
	test(`node-less body ${outcome} cannot settle a paused owner before resume`, async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		const entered = Promise.withResolvers<void>();
		const body = Promise.withResolvers<void>();
		const definition = workflow({
			name: "body-settlement",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.tool("checkpoint", {}, async () => "done");
				entered.resolve();
				await body.promise;
				return {};
			},
		});
		const { runId } = runDetached(definition, {}, { store });
		const job = jobTracker.get(runId)!;
		await entered.promise;
		try {
			await pauseRun(runId);
			if (outcome === "resolve") body.resolve();
			else body.reject(new Error("late body error"));
			await turn();
			assert.equal(store.runs()[0]?.status, "paused");
			assert.equal(store.runs()[0]?.endedAt, undefined);
			assert.equal(jobTracker.get(runId), job);
			await resumeRun(runId);
			await job.promise;
			assert.equal(store.runs()[0]?.status, outcome === "resolve" ? "completed" : "failed");
		} finally {
			body.resolve();
			job.controller.abort();
			await job.promise;
		}
	});
}

for (const outcome of ["resolve", "reject"] as const) {
	test(`quit retires a paused zero-progress owner before late body ${outcome}`, async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		const entered = Promise.withResolvers<void>();
		const body = Promise.withResolvers<void>();
		let toolCalls = 0;
		const definition = workflow({
			name: "quit-paused-body",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				entered.resolve();
				await body.promise;
				await ctx.tool("late", {}, async () => {
					toolCalls++;
					return "late";
				});
				return {};
			},
		});
		const { runId } = runDetached(definition, {}, { store });
		const job = jobTracker.get(runId)!;
		await entered.promise;
		try {
			await pauseRun(runId);
			const quit = await quitRun(runId);
			assert.equal(quit.ok, true);
			assert.equal(store.runs()[0]?.resumable, false);
			assert.equal(store.runs()[0]?.exitReason, "quit");
			await job.promise;
			assert.equal(toolControlRegistry.runControl(runId), undefined);
			assert.equal(jobTracker.get(runId), undefined);
			if (outcome === "resolve") body.resolve();
			else body.reject(new Error("late rejection"));
			await turn();
			assert.equal(toolCalls, 0);
			assert.deepEqual(store.runs()[0]?.toolNodes, []);
			assert.equal(store.runs()[0]?.status, "paused");
			assert.equal(backend.getWorkflow(runId)?.status, "paused");
			assert.equal(backend.getWorkflow(runId)?.resumable, false);
		} finally {
			body.resolve();
			job.controller.abort();
			await job.promise;
		}
	});
}

for (const cached of [false, true]) {
	test(`${cached ? "cached" : "live"} stage admission waits on the executor pause barrier`, async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		const entered = Promise.withResolvers<void>();
		const body = Promise.withResolvers<void>();
		let waiting = !cached;
		let modelCalls = 0;
		let advanced = 0;
		const definition = workflow({
			name: "paused-stage",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				if (waiting) {
					entered.resolve();
					await body.promise;
				}
				await ctx.stage("stage").prompt("stage");
				advanced++;
				return {};
			},
		});
		const adapters = {
			prompt: {
				prompt: async () => {
					modelCalls++;
					return "done";
				},
			},
		};
		const runId = crypto.randomUUID();
		if (cached) await run(definition, {}, { runId, store: createStore(), adapters });
		waiting = true;
		runDetached(definition, {}, { runId, store, adapters });
		const job = jobTracker.get(runId)!;
		await entered.promise;
		try {
			await pauseRun(runId);
			body.resolve();
			await turn();
			assert.deepEqual(
				store.runs()[0]?.stages,
				[],
				"neither live admission nor cached hydration may pass the barrier",
			);
			assert.equal(advanced, cached ? 1 : 0);
			await resumeRun(runId);
			await job.promise;
			assert.equal(modelCalls, 1);
			assert.equal(advanced, cached ? 2 : 1);
			assert.equal(store.runs()[0]?.status, "completed");
		} finally {
			body.resolve();
			job.controller.abort();
			await job.promise;
		}
	});
}

for (const primitive of ["task", "workflow", "ui", "tool"] as const) {
	test(`cached ${primitive} replay cannot pass a paused node-less owner`, async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		const entered = Promise.withResolvers<void>();
		const body = Promise.withResolvers<void>();
		let waiting = false;
		let effects = 0;
		let advanced = 0;
		const effect = async () => {
			effects++;
			return "done";
		};
		const child = workflow({
			name: "cached-child",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.tool("child-tool", {}, effect);
				return {};
			},
		});
		const definition = workflow({
			name: `cached-${primitive}`,
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				if (waiting) {
					entered.resolve();
					await body.promise;
				}
				if (primitive === "task") await ctx.task("cached-task", { task: "cached-task" });
				else if (primitive === "workflow") await ctx.workflow(child, {});
				else if (primitive === "ui") await ctx.ui.confirm("cached-ui");
				else await ctx.tool("cached-tool", {}, effect);
				advanced++;
				await ctx.tool("checkpoint", {}, async () => "done");
				return {};
			},
		});
		const opts = {
			adapters: { prompt: { prompt: effect } },
			ui: {
				input: async () => {
					throw new Error("unexpected input");
				},
				select: async () => {
					throw new Error("unexpected select");
				},
				editor: async () => {
					throw new Error("unexpected editor");
				},
				confirm: async () => {
					effects++;
					return true;
				},
			},
		};
		const runId = crypto.randomUUID();
		await run(definition, {}, { ...opts, runId, store: createStore() });
		assert.equal(effects, 1);
		waiting = true;
		runDetached(definition, {}, { ...opts, runId, store });
		const job = jobTracker.get(runId)!;
		await entered.promise;
		try {
			await pauseRun(runId);
			body.resolve();
			await turn();
			assert.equal(advanced, 1, "cached replay must await explicit resume");
			assert.deepEqual(store.runs()[0]?.stages, []);
			assert.deepEqual(store.runs()[0]?.toolNodes, []);
			await resumeRun(runId);
			await job.promise;
			assert.equal(advanced, 2);
			assert.equal(effects, 1);
			assert.equal(store.runs()[0]?.status, "completed");
		} finally {
			body.resolve();
			job.controller.abort();
			await job.promise;
		}
	});
}

test("an author exit after a node-less pause waits for resume", async () => {
	setDurableBackend(new InMemoryDurableBackend());
	const entered = Promise.withResolvers<void>();
	const body = Promise.withResolvers<void>();
	const definition = workflow({
		name: "paused-exit",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			entered.resolve();
			await body.promise;
			ctx.exit({ reason: "author completed" });
		},
	});
	const { runId } = runDetached(definition, {}, { store });
	const job = jobTracker.get(runId)!;
	await entered.promise;
	try {
		await pauseRun(runId);
		body.resolve();
		await turn();
		assert.equal(store.runs()[0]?.status, "paused");
		assert.equal(store.runs()[0]?.exitReason, undefined);
		await resumeRun(runId);
		await job.promise;
		assert.equal(store.runs()[0]?.status, "completed");
		assert.equal(store.runs()[0]?.exitReason, "author completed");
	} finally {
		body.resolve();
		job.controller.abort();
		await job.promise;
	}
});

test("paused stage declarations retain replay identity when methods run in reverse order", async () => {
	setDurableBackend(new InMemoryDurableBackend());
	const entered = Promise.withResolvers<void>();
	const body = Promise.withResolvers<void>();
	let waiting = false;
	const observed: string[] = [];
	let modelCalls = 0;
	const definition = workflow({
		name: "paused-stage-order",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			if (waiting) {
				entered.resolve();
				await body.promise;
			}
			const first = ctx.stage("same-name");
			const second = ctx.stage("same-name");
			observed.push(await second.prompt("second"), await first.prompt("first"));
			return {};
		},
	});
	const adapters = {
		prompt: {
			prompt: async (text: string) => {
				modelCalls++;
				return text;
			},
		},
	};
	const runId = crypto.randomUUID();
	await run(definition, {}, { runId, store: createStore(), adapters });
	assert.deepEqual(observed, ["second", "first"]);
	waiting = true;
	runDetached(definition, {}, { runId, store, adapters });
	const job = jobTracker.get(runId)!;
	await entered.promise;
	try {
		await pauseRun(runId);
		body.resolve();
		await turn();
		assert.deepEqual(store.runs()[0]?.stages, []);
		await resumeRun(runId);
		await job.promise;
		assert.deepEqual(observed, ["second", "first", "second", "first"]);
		assert.equal(modelCalls, 2);
	} finally {
		body.resolve();
		job.controller.abort();
		await job.promise;
	}
});

test("prompt-node continuation UI waits for the node-less pause barrier", async () => {
	setDurableBackend(new InMemoryDurableBackend());
	const entered = Promise.withResolvers<void>();
	const body = Promise.withResolvers<void>();
	let answers = 0;
	const definition = workflow({
		name: "paused-prompt-continuation",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			entered.resolve();
			await body.promise;
			await ctx.ui.confirm("continue?");
			answers++;
			return {};
		},
	});
	const { runId } = runDetached(
		definition,
		{},
		{
			store,
			usePromptNodesForUi: true,
			continuation: {
				source: {
					id: crypto.randomUUID(),
					name: definition.name,
					inputs: {},
					status: "failed",
					startedAt: 1,
					endedAt: 2,
					stages: [],
				},
			},
		},
	);
	const job = jobTracker.get(runId)!;
	await entered.promise;
	try {
		await pauseRun(runId);
		body.resolve();
		await turn();
		assert.deepEqual(store.runs()[0]?.stages, []);
		await resumeRun(runId);
		await turn();
		const stage = store.runs()[0]?.stages[0];
		assert.ok(stage?.pendingPrompt);
		await workflowAnswerAction({ action: "answer", runId, promptId: stage.pendingPrompt.id, response: true });
		await job.promise;
		assert.equal(answers, 1);
		assert.equal(store.runs()[0]?.stages.length, 1);
		assert.equal(store.runs()[0]?.status, "completed");
	} finally {
		body.resolve();
		job.controller.abort();
		await job.promise;
	}
});

// PR #2885: a child already awaiting author code has its own executor barrier.
for (const primitive of ["tool", "stage", "completion"] as const) {
	for (const action of ["resume", "quit"] as const) {
		test(`whole-run pause holds an already-live child's ${primitive} until ${action}`, async () => {
			const backend = new InMemoryDurableBackend();
			setDurableBackend(backend);
			const entered = Promise.withResolvers<string>();
			const body = Promise.withResolvers<void>();
			let effects = 0;
			let childCalls = 0;
			let rootId = "";
			const effectStatuses: (string | undefined)[] = [];
			const effect = async () => {
				effectStatuses.push(backend.getWorkflow(rootId)?.status);
				effects++;
				return "done";
			};
			const child = workflow({
				name: "already-live-child",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					childCalls++;
					// A successful workflow needs tracked progress, even when its remaining body only returns.
					if (primitive === "completion") await ctx.tool("checkpoint", {}, async () => "done");
					entered.resolve(ctx.runId);
					await body.promise;
					if (primitive === "tool") await ctx.tool("after-pause", {}, effect);
					else if (primitive === "stage") await ctx.stage("after-pause").prompt("stage");
					return {};
				},
			});
			const definition = workflow({
				name: "parent-of-live-child",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					await ctx.workflow(child, {});
					return {};
				},
			});
			const runtime = createExtensionRuntime({ definitions: [definition], store });
			const { runId } = runDetached(definition, {}, { store, adapters: { prompt: { prompt: effect } } });
			rootId = runId;
			const job = jobTracker.get(runId)!;
			const childId = await entered.promise;
			const owner = toolControlRegistry.runControl(childId);
			const toolsBeforePause = structuredClone(
				store.runs().find((candidate) => candidate.id === childId)?.toolNodes,
			);
			try {
				const paused = await pauseRun(runId);
				assert.equal(paused.ok, true);
				assert.equal(backend.getWorkflow(runId)?.status, "paused");
				body.resolve();
				await turn();
				assert.equal(effects, 0, "an already-live child must not admit tracked work before parent resume");
				assert.equal(owner?.paused, true);
				const snapshot = store.runs().find((candidate) => candidate.id === childId)!;
				assert.equal(snapshot.status, "paused");
				assert.equal(snapshot.endedAt, undefined);
				assert.deepEqual(snapshot.stages, []);
				assert.deepEqual(snapshot.toolNodes, toolsBeforePause);
				assert.equal(toolControlRegistry.runControl(childId), owner);
				if (action === "quit") {
					assert.equal((await quitRun(runId)).ok, true);
					await job.promise;
					assert.equal(effects, 0);
					assert.equal(toolControlRegistry.runControl(childId), undefined);
					assert.equal(toolControlRegistry.runControl(runId), undefined);
					assert.equal(store.runs().find((candidate) => candidate.id === runId)?.exitReason, "quit");
					assert.equal(snapshot.status, "paused");
					assert.equal(snapshot.endedAt, undefined);
					assert.equal(backend.getWorkflow(runId)?.status, "paused");
				} else {
					const resumed = await workflowResumeAction(
						{ action: "resume", runId },
						{
							getRuntime: () => runtime,
							policy: INTERACTIVE_WORKFLOW_POLICY,
							ensureWorkflowResourcesLoaded: async () => {},
						},
					);
					assert.ok(resumed.action === "resume");
					assert.equal(resumed.status, "ok");
					await job.promise;
					assert.equal(effects, primitive === "completion" ? 0 : 1);
					assert.deepEqual(effectStatuses, primitive === "completion" ? [] : ["running"]);
					assert.deepEqual(
						store.runs().map((candidate) => ({ status: candidate.status, error: candidate.error })),
						[
							{ status: "completed", error: undefined },
							{ status: "completed", error: undefined },
						],
					);
				}
				assert.equal(childCalls, 1);
			} finally {
				body.resolve();
				job.controller.abort();
				await job.promise;
			}
		});
	}
}

for (const scope of ["root", "branch"] as const) {
	test(`${scope} executor pause traverses owned grandchildren without crossing sibling scopes`, async () => {
		setDurableBackend(new InMemoryDurableBackend());
		const leafEntered = Promise.withResolvers<string>();
		const siblingEntered = Promise.withResolvers<string>();
		const body = Promise.withResolvers<void>();
		const effects: string[] = [];
		const makeChild = (name: string, entered: PromiseWithResolvers<string>) =>
			workflow({
				name,
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					assert.ok(ctx.runId);
					entered.resolve(ctx.runId);
					await body.promise;
					await ctx.tool(name, {}, async () => {
						effects.push(name);
						return "done";
					});
					return {};
				},
			});
		const leaf = makeChild("leaf", leafEntered);
		const sibling = makeChild("sibling", siblingEntered);
		let branchId = "";
		const branch = workflow({
			name: "branch",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				assert.ok(ctx.runId);
				branchId = ctx.runId;
				await ctx.workflow(leaf, {});
				return {};
			},
		});
		const definition = workflow({
			name: "tree",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await Promise.all([ctx.workflow(branch, {}), ctx.workflow(sibling, {})]);
				return {};
			},
		});
		const { runId } = runDetached(definition, {}, { store });
		const job = jobTracker.get(runId)!;
		const [leafId, siblingId] = await Promise.all([leafEntered.promise, siblingEntered.promise]);
		try {
			const targetId = scope === "root" ? runId : branchId;
			assert.equal((await pauseRun(targetId)).ok, true);
			assert.equal(toolControlRegistry.runControl(runId)?.paused, scope === "root");
			assert.equal(toolControlRegistry.runControl(branchId)?.paused, true);
			assert.equal(toolControlRegistry.runControl(leafId)?.paused, true);
			assert.equal(toolControlRegistry.runControl(siblingId)?.paused, scope === "root");
			body.resolve();
			await turn();
			assert.deepEqual(effects, scope === "root" ? [] : ["sibling"]);
			assert.equal(store.runs().find((candidate) => candidate.id === leafId)?.endedAt, undefined);
			assert.equal((await resumeRun(targetId)).ok, true);
			await job.promise;
			assert.deepEqual(effects.sort(), ["leaf", "sibling"]);
			assert.ok(store.runs().every((candidate) => candidate.status === "completed"));
		} finally {
			body.resolve();
			job.controller.abort();
			await job.promise;
		}
	});
}
