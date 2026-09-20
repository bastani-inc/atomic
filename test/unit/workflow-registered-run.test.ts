import assert from "node:assert/strict";
import { Type } from "typebox";
import { afterEach, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import type { DurableWorkflowBackend } from "../../packages/workflows/src/durable/backend.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import type { WorkflowToolArgs } from "../../packages/workflows/src/extension/public-types.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { captureWorkflowOwnerResources } from "../../packages/workflows/src/extension/workflow-owner-resources.js";
import { makeExecuteWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { type JevFixtureRequest, jevFixtureResponse } from "../helpers/jev-tournament.js";
import { messageStream } from "../helpers/structured-output.js";
import { workflowDecisionMessage, workflowRouterContext } from "../helpers/workflow-router.js";
import { createMockSdk, restoreMockSdkState, serializeMockSdkState } from "./durable-dbos-backend-helpers.js";
import { waitForExecutorStagePendingPrompt } from "./executor-shared.js";

afterEach(() => {
	setDurableBackend(undefined);
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

function fixture(
	provider: "structured" | "jev" = "structured",
	lifecycle = false,
	failOnce = false,
	backend: DurableWorkflowBackend = new InMemoryDurableBackend(),
) {
	setDurableBackend(backend);
	const store = createStore();
	const jobs = createJobTracker();
	const body = vi.fn(async () => ({}));
	let markGap!: () => void;
	let gapCount = 0;
	const gapReached = new Promise<void>((resolve) => {
		markGap = resolve;
	});
	let releaseGap!: () => void;
	const gap = new Promise<void>((resolve) => {
		releaseGap = resolve;
	});
	const definition = workflow({
		name: "registered",
		description: "Approved implementation",
		inputs: { objective: Type.String() },
		outputs: {},
		run: async (ctx) => {
			await ctx.tool("effect", {}, body);
			if (failOnce) {
				failOnce = false;
				throw new Error("Recoverable interruption after checkpoint");
			}
			if (lifecycle) {
				gapCount++;
				markGap();
				await gap;
				assert.equal(await ctx.ui.input("Approve next step"), "approved");
				await ctx.tool("after-approval", {}, body);
			}
			return {};
		},
	});
	const runtime = createExtensionRuntime({ registry: createRegistry().register(definition), store, jobs });
	const execute = makeExecuteWorkflowTool(
		runtime,
		() => undefined,
		() => {},
		{ ...captureWorkflowOwnerResources(), store, jobs },
	);
	const ctx = { ...workflowRouterContext("registered"), sessionId: "owner" };
	const inference = vi.spyOn(ctx.modelRegistry!, "streamSimple");
	if (provider === "jev") {
		ctx.getRouterModel = () => "typesafe-ai/jev-latest";
		vi.stubEnv("TYPESAFE_API_KEY", "fixture-key");
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init: RequestInit) => {
				const request = JSON.parse(String(init.body)) as JevFixtureRequest;
				return Response.json(
					jevFixtureResponse(
						request,
						(_keys, id) =>
							({
								workflow: "registered",
								duration: "15min",
								interaction: "executable",
								complexity: "workflow_beneficial",
								preference: "unspecified",
								budget: "preserve",
							})[id]!,
					),
				);
			}),
		);
	}
	return {
		store,
		jobs,
		definition,
		execute,
		ctx,
		inference,
		body,
		runtime,
		gapReached,
		releaseGap,
		get gapCount() {
			return gapCount;
		},
	};
}

// #3106: real model-tool admission, dispatcher and durable runner, deterministic inference.
test.each(["structured", "jev"] as const)(
	"%s route reserves without launch and corrected inputs admit one stable instance",
	async (provider) => {
		const f = fixture(provider);
		const route = await f.execute(
			{ action: "route", state: { task: "Implement the approved change", conversation: [], documents: [] } },
			f.ctx,
		);
		assert.equal(route.action, "route");
		if (route.action !== "route") throw new Error("wrong action");
		assert.equal("workflowType" in route, false);
		assert.equal(route.routerDecision?.workflowType, "registered");
		assert.equal("estimatedDuration" in route, false);
		assert.equal(route.routerDecision?.estimatedDuration, "15min");
		assert.deepEqual(route.inputSchema, f.definition.inputs);
		assert.equal(f.store.runs().length, 0);
		const args = { action: "run" as const, workflowId: route.workflowId };
		const missing = await f.execute(args, f.ctx);
		assert.equal("status" in missing && missing.status, "needs_input");
		assert.equal("runId" in missing && missing.runId, route.workflowId);
		const results = await Promise.all(
			Array.from({ length: 4 }, () => f.execute({ ...args, inputs: { objective: "approved" } }, f.ctx)),
		);
		assert.equal(results.filter((r) => "status" in r && r.status !== "failed").length, 1, JSON.stringify(results));
		await Promise.all(f.jobs.runIds().map((id) => f.jobs.get(id)!.promise));
		assert.equal(f.body.mock.calls.length, 1);
		assert.equal(f.store.runs().length, 1);
		assert.equal(f.store.runs()[0]!.id, route.workflowId);
		assert.equal(provider === "jev" ? vi.mocked(fetch).mock.calls.length : f.inference.mock.calls.length, 1);
		const retry = await f.execute({ ...args, inputs: { objective: "approved" } }, f.ctx);
		assert.match("error" in retry ? (retry.error ?? "") : "", /Terminal/);
		for (const result of [missing, ...results, retry]) {
			assert.equal("estimatedDuration" in result, false);
			assert.ok("routerDecision" in result);
			assert.deepEqual(result.routerDecision, route.routerDecision);
		}
		assert.equal(f.body.mock.calls.length, 1);
	},
);

test("registered run rejects absent, forged, foreign and overridden IDs without inference", async () => {
	const f = fixture();
	for (const workflowId of [undefined, "", "forged", crypto.randomUUID()]) {
		const result = await f.execute({ action: "run", workflowId }, f.ctx);
		assert.equal("status" in result && result.status, "failed");
	}
	assert.equal(f.inference.mock.calls.length, 0);
	const route = await f.execute({ action: "route", state: { task: "Implement approved work" } }, f.ctx);
	if (route.action !== "route") throw new Error("wrong action");
	const foreign = await f.execute({ action: "run", workflowId: route.workflowId }, { ...f.ctx, sessionId: "foreign" });
	assert.match("error" in foreign ? (foreign.error ?? "") : "", /another caller/);
	const override = await f.execute({ action: "run", workflowId: route.workflowId, workflow: "other" }, f.ctx);
	assert.match("error" in override ? (override.error ?? "") : "", /override/);
	const omitted = await f.execute({ workflowId: route.workflowId }, f.ctx);
	assert.equal("status" in omitted && omitted.status, "failed");
	assert.equal(f.store.runs().length, 0);
});

// #3106: a reservation's contract cannot silently change between assessment and admission.
test("registry replacement invalidates a reservation and repeated stale admission never infers", async () => {
	const f = fixture();
	const route = await f.execute({ action: "route", state: { task: "Implement approved work" } }, f.ctx);
	assert.equal(route.action, "route");
	const replacement = createRegistry().register(
		workflow({
			name: "registered",
			description: "Changed",
			inputs: { changed: Type.Number() },
			outputs: {},
			run: async () => ({}),
		}),
	);
	Object.defineProperty(f.runtime, "registry", { value: replacement });
	for (let attempt = 0; attempt < 2; attempt++) {
		const result = await f.execute(
			{ action: "run", workflowId: route.workflowId, inputs: { objective: "approved" } },
			f.ctx,
		);
		assert.equal("status" in result && result.status, "failed");
		assert.match("error" in result ? (result.error ?? "") : "", /registry changed|invalidated/);
	}
	assert.equal(f.inference.mock.calls.length, 1);
	assert.equal(f.body.mock.calls.length, 0);
});

test("distinct registered IDs execute independently and remain inspectable after completion", async () => {
	const f = fixture();
	const routes = await Promise.all(
		[1, 2].map(() => f.execute({ action: "route", state: { task: "Implement approved work" } }, f.ctx)),
	);
	const ids = routes.map((route) => {
		assert.equal(route.action, "route");
		return route.workflowId;
	});
	assert.notEqual(ids[0], ids[1]);
	await Promise.all(
		ids.map((workflowId) => f.execute({ action: "run", workflowId, inputs: { objective: "approved" } }, f.ctx)),
	);
	await Promise.all(f.jobs.runIds().map((id) => f.jobs.get(id)!.promise));
	assert.equal(f.body.mock.calls.length, 2);
	for (const runId of ids) {
		const result = await f.execute({ action: "status", runId }, f.ctx);
		assert.equal(result.action, "statusDetail");
		assert.ok("detail" in result);
		assert.equal(result.detail.status, "completed");
		await assert.rejects(
			f.execute({ action: "status", runId }, { ...f.ctx, sessionId: "foreign" }),
			/another caller/,
		);
	}
});

// #3106: executable public-tool route → correction → pending input → controls → terminal.
test.each(["structured", "jev"] as const)(
	"%s registered identity survives pending input and pause/resume",
	async (provider) => {
		const f = fixture(provider, true);
		const route = await f.execute(
			{ action: "route", state: { task: "Implement approved work with a human gate" } },
			f.ctx,
		);
		assert.equal(route.action, "route");
		const runId = route.workflowId;
		assert.equal(f.store.runs().length, 0);
		const invalid = await f.execute({ action: "run", workflowId: runId, inputs: { objective: 42 } }, f.ctx);
		assert.equal("status" in invalid && invalid.status, "needs_input");
		const started = await f.execute({ action: "run", workflowId: runId, inputs: { objective: "approved" } }, f.ctx);
		assert.equal("runId" in started && started.runId, runId);
		await f.gapReached;
		assert.equal(f.body.mock.calls.length, 1);
		const paused = await f.execute({ action: "pause", runId }, f.ctx);
		assert.equal("status" in paused && paused.status, "paused", JSON.stringify(paused));
		const resumed = await f.execute({ action: "resume", runId }, f.ctx);
		assert.equal("runId" in resumed && resumed.runId, runId);
		assert.equal("status" in resumed && resumed.status, "ok");
		f.releaseGap();
		const pending = await waitForExecutorStagePendingPrompt(f.store);
		assert.equal(pending.runId, runId);
		const answer = await f.execute({ action: "answer", runId, stageId: pending.stageId, text: "approved" }, f.ctx);
		assert.equal("status" in answer && answer.status, "ok");
		await Promise.all(f.jobs.runIds().map((id) => f.jobs.get(id)!.promise));
		const terminal = await f.execute({ action: "status", runId }, f.ctx);
		assert.equal(terminal.action, "statusDetail");
		assert.equal("detail" in terminal && terminal.detail.status, "completed");
		assert.equal(f.store.runs().length, 1);
		assert.equal(f.body.mock.calls.length, 2);
		assert.equal(provider === "jev" ? vi.mocked(fetch).mock.calls.length : f.inference.mock.calls.length, 1);
		const duplicate = await f.execute({ action: "run", workflowId: runId, inputs: { objective: "approved" } }, f.ctx);
		assert.match("error" in duplicate ? (duplicate.error ?? "") : "", /Terminal/);
		assert.equal(f.body.mock.calls.length, 2);
	},
);

// #3106: authorize the resolved default target, not the optional raw selector.
test("foreign caller cannot pause the implicit active registered instance", async () => {
	const f = fixture("structured", true);
	try {
		const route = await f.execute({ action: "route", state: { task: "Implement approved work" } }, f.ctx);
		assert.equal(route.action, "route");
		await f.execute({ action: "run", workflowId: route.workflowId, inputs: { objective: "approved" } }, f.ctx);
		await f.gapReached;
		await assert.rejects(f.execute({ action: "pause" }, { ...f.ctx, sessionId: "foreign" }), /another caller/);
		assert.equal(f.store.runs()[0]!.status, "running");
	} finally {
		await f.execute({ action: "resume" }, f.ctx);
		f.releaseGap();
		const pending = await waitForExecutorStagePendingPrompt(f.store);
		await f.execute({ action: "answer", runId: pending.runId, stageId: pending.stageId, text: "approved" }, f.ctx);
		await Promise.all(f.jobs.runIds().map((id) => f.jobs.get(id)!.promise));
	}
});

// #3106: recreating a tool must not dispose the admitted instance's authority.
test("registered terminal ownership survives model tool recreation", async () => {
	const f = fixture();
	const route = await f.execute({ action: "route", state: { task: "Implement approved work" } }, f.ctx);
	assert.equal(route.action, "route");
	await f.execute({ action: "run", workflowId: route.workflowId, inputs: { objective: "approved" } }, f.ctx);
	await Promise.all(f.jobs.runIds().map((id) => f.jobs.get(id)!.promise));
	const recreated = makeExecuteWorkflowTool(
		f.runtime,
		() => undefined,
		() => {},
		{
			...captureWorkflowOwnerResources(),
			store: f.store,
			jobs: f.jobs,
		},
	);
	await assert.rejects(
		recreated({ action: "status", runId: route.workflowId }, { ...f.ctx, sessionId: "foreign" }),
		/another caller/,
	);
	const result = await recreated({ action: "status", runId: route.workflowId }, f.ctx);
	assert.equal(result.action, "statusDetail");
	assert.equal("detail" in result && result.detail.status, "completed");
});

// #3106: legal selectors stay legal for the owner and never grant a foreign caller authority.
test("registered lifecycle authorizes padded/default/prefix selectors and prompts after recreation", async () => {
	const f = fixture("structured", true);
	const route = await f.execute({ action: "route", state: { task: "Implement approved work" } }, f.ctx);
	assert.equal(route.action, "route");
	const runId = route.workflowId;
	await f.execute({ action: "run", workflowId: runId, inputs: { objective: "approved" } }, f.ctx);
	await f.gapReached;
	const execute = makeExecuteWorkflowTool(
		f.runtime,
		() => undefined,
		() => {},
		{
			...captureWorkflowOwnerResources(),
			store: f.store,
			jobs: f.jobs,
		},
	);
	const foreign = { ...f.ctx, sessionId: "foreign" };
	for (const action of ["pause", "quit", "resume", "stages", "stage", "transcript", "answer"] as const) {
		for (const selector of [undefined, "", "  ", runId, ` ${runId} `, runId.slice(0, 8).toUpperCase()]) {
			await assert.rejects(execute({ action, runId: selector, text: "wrong" }, foreign), /another caller/);
		}
	}
	assert.equal(f.store.runs()[0]!.status, "running");
	const paused = await execute({ action: "pause", runId: ` ${runId} ` }, f.ctx);
	assert.equal("status" in paused && paused.status, "paused");
	await assert.rejects(execute({ action: "resume", runId: ` ${runId} ` }, foreign), /another caller/);
	assert.equal(f.store.runs()[0]!.status, "paused");
	const resumed = await execute({ action: "resume", runId: runId.slice(0, 8).toUpperCase() }, f.ctx);
	assert.equal("status" in resumed && resumed.status, "ok");
	f.releaseGap();
	const pending = await waitForExecutorStagePendingPrompt(f.store);
	await assert.rejects(
		execute({ action: "answer", promptId: pending.promptId, text: "wrong" }, foreign),
		/another caller/,
	);
	const answered = await execute({ action: "answer", text: "approved" }, f.ctx);
	assert.equal("status" in answered && answered.status, "ok");
	await Promise.all(f.jobs.runIds().map((id) => f.jobs.get(id)!.promise));
	for (const action of ["status", "stages", "stage", "transcript"] as const) {
		await assert.rejects(execute({ action, runId }, foreign), /another caller/);
		const result = await execute({ action, runId, stageId: pending.stageId }, f.ctx);
		assert.ok(!("error" in result) || !result.error, JSON.stringify(result));
	}
	assert.equal(f.body.mock.calls.length, 2);
});

// #3106: a mixed-owner batch must fail before mutating even its first authorized member.
test.each(["pause", "quit"] as const)(
	"%s bulk selectors preauthorize every actual target atomically",
	async (action) => {
		const f = fixture("structured", true);
		const contexts = [f.ctx, { ...f.ctx, sessionId: "other-owner" }];
		for (const ctx of contexts) {
			const route = await f.execute({ action: "route", state: { task: "Implement approved work" } }, ctx);
			assert.equal(route.action, "route");
			await f.execute({ action: "run", workflowId: route.workflowId, inputs: { objective: "approved" } }, ctx);
		}
		await vi.waitFor(() => assert.equal(f.gapCount, 2));
		assert.equal(f.store.runs().length, 2);
		for (const selector of [
			{ all: true },
			{ runId: "--all" },
			{ runId: " --all " },
			{ all: true, runId: f.store.runs()[0]!.id },
		]) {
			await assert.rejects(f.execute({ action, ...selector }, f.ctx), /another caller/);
			assert.ok(f.store.runs().every((run) => run.status === "running"));
		}
		f.releaseGap();
		for (const [index, run] of f.store.runs().entries()) {
			const stage = await vi.waitFor(() => {
				const pending = f.store
					.runs()
					.find((candidate) => candidate.id === run.id)!
					.stages.find((candidate) => candidate.pendingPrompt !== undefined);
				assert.ok(pending);
				return pending;
			});
			await f.execute({ action: "answer", runId: run.id, stageId: stage.id, text: "approved" }, contexts[index]!);
		}
		await Promise.all(f.jobs.runIds().map((id) => f.jobs.get(id)!.promise));
		assert.equal(f.body.mock.calls.length, 4);
	},
);

// #3106: a fresh runtime/store reads durable authority, not a prior closure or live snapshot.
test("terminal ownership survives runtime replacement and durable-only inspection", async () => {
	const sdk = createMockSdk();
	const backend = new DbosDurableBackend(sdk);
	const f = fixture("structured", false, false, backend);
	const route = await f.execute({ action: "route", state: { task: "Implement approved work" } }, f.ctx);
	assert.equal(route.action, "route");
	await f.execute({ action: "run", workflowId: route.workflowId, inputs: { objective: "approved" } }, f.ctx);
	await Promise.all(f.jobs.runIds().map((id) => f.jobs.get(id)!.promise));
	await backend.flush();
	const restoredSdk = createMockSdk();
	restoreMockSdkState(restoredSdk, JSON.parse(JSON.stringify(serializeMockSdkState(sdk))));
	setDurableBackend(new DbosDurableBackend(restoredSdk));
	const store = createStore();
	const jobs = createJobTracker();
	const runtime = createExtensionRuntime({ registry: createRegistry().register(f.definition), store, jobs });
	const execute = makeExecuteWorkflowTool(
		runtime,
		() => undefined,
		() => {},
		{ ...captureWorkflowOwnerResources(), store, jobs },
	);
	const foreign = { ...f.ctx, sessionId: "foreign" };
	for (const action of ["status", "stages", "stage", "transcript", "resume"] as const) {
		for (const runId of [route.workflowId, ` ${route.workflowId} `, route.workflowId.slice(0, 8).toUpperCase()]) {
			await assert.rejects(execute({ action, runId }, foreign), /another caller/, `${action}: ${runId}`);
		}
	}
	const status = await execute({ action: "status", runId: route.workflowId }, { ...f.ctx });
	assert.equal(status.action, "statusDetail");
	assert.equal("detail" in status && status.detail.status, "completed");
	for (const args of [
		{ action: "run", workflowId: route.workflowId },
		{ workflowId: route.workflowId },
	] satisfies WorkflowToolArgs[]) {
		const result = await execute(args, f.ctx);
		assert.equal("status" in result && result.status, "failed");
	}
	assert.equal(f.body.mock.calls.length, 1);
});

// #3106: durable resume after host replacement retains caller ownership and completed effects.
test("checkpointed registered instance resumes under its owner after runtime replacement", async () => {
	const f = fixture("structured", false, true);
	const route = await f.execute({ action: "route", state: { task: "Implement approved work" } }, f.ctx);
	assert.equal(route.action, "route");
	const runId = route.workflowId;
	await f.execute({ action: "run", workflowId: runId, inputs: { objective: "approved" } }, f.ctx);
	await Promise.all(f.jobs.runIds().map((id) => f.jobs.get(id)!.promise));
	const store = createStore();
	const jobs = createJobTracker();
	const runtime = createExtensionRuntime({ registry: createRegistry().register(f.definition), store, jobs });
	const execute = makeExecuteWorkflowTool(
		runtime,
		() => undefined,
		() => {},
		{ ...captureWorkflowOwnerResources(), store, jobs },
	);
	for (const selector of [runId, ` ${runId} `, runId.slice(0, 8).toUpperCase()]) {
		await assert.rejects(
			execute({ action: "resume", runId: selector }, { ...f.ctx, sessionId: "foreign" }),
			/another caller/,
		);
	}
	assert.equal(f.body.mock.calls.length, 1);
	const resumed = await execute({ action: "resume", runId: runId.slice(0, 8) }, { ...f.ctx });
	assert.equal("status" in resumed && resumed.status, "running", JSON.stringify(resumed));
	await Promise.all(jobs.runIds().map((id) => jobs.get(id)!.promise));
	const terminal = await execute({ action: "status", runId }, f.ctx);
	assert.equal("detail" in terminal && terminal.detail.status, "completed");
	assert.equal(f.body.mock.calls.length, 1);
	assert.equal(store.runs().length, 1);
});

// #3106: an explicit user request to work inline, judged by the router from the user's
// words, cannot be turned into a reservation or an execution by either provider.
test.each(["structured", "jev"] as const)(
	"%s cannot reserve or execute contrary to explicit inline preference",
	async (provider) => {
		const f = fixture(provider);
		// Both adapters still select the registered workflow; only the preference
		// judgment, made from the user's words, differs from the default fixture.
		if (provider === "jev") {
			vi.stubGlobal(
				"fetch",
				vi.fn(async (_url: string, init: RequestInit) => {
					const request = JSON.parse(String(init.body)) as JevFixtureRequest;
					assert.equal("executionPreference" in (request.state.task as object), false);
					return Response.json(
						jevFixtureResponse(
							request,
							(_keys, id) =>
								({
									workflow: "registered",
									duration: "15min",
									interaction: "executable",
									complexity: "workflow_beneficial",
									preference: "explicit_inline",
									budget: "preserve",
								})[id]!,
						),
					);
				}),
			);
		} else {
			f.inference.mockImplementation(() =>
				messageStream(
					workflowDecisionMessage({
						workflowType: "registered",
						estimatedDuration: "15min",
						preference: "explicit_inline",
						maxBudget: {},
					}),
				),
			);
		}
		const result = await f.execute(
			{
				action: "route",
				state: {
					task: "Implement this inline, no workflow.",
					conversation: [{ role: "user", text: "Implement this inline, no workflow." }],
				},
			},
			f.ctx,
		);
		assert.equal(result.action, "route");
		assert.equal("workflowType" in result, false);
		assert.equal(result.routerDecision?.workflowType, "none");
		assert.equal(result.workflowId, "");
		assert.equal("estimatedDuration" in result, false);
		assert.equal(result.routerDecision?.estimatedDuration, "15min");
		const run = await f.execute(
			{ action: "run", workflowId: result.workflowId, inputs: { objective: "approved" } },
			f.ctx,
		);
		assert.equal("status" in run && run.status, "failed");
		assert.equal(f.store.runs().length, 0);
		assert.equal(f.body.mock.calls.length, 0);
	},
);

// #3106: missing model-owner metadata fails closed, without gating explicit user/internal launches.
test.each(["agent", "user", undefined] as const)(
	"lifecycle admission distinguishes %s origin without model ownership",
	async (origin) => {
		const f = fixture();
		const started = await f.runtime.dispatch(
			{ action: "run", workflow: "registered", inputs: { objective: "approved" } },
			{ origin },
		);
		assert.equal(started.action, "run");
		await Promise.all(f.jobs.runIds().map((id) => f.jobs.get(id)!.promise));
		const request = f.execute({ action: "status", runId: started.runId }, { ...f.ctx, sessionId: "foreign" });
		if (origin === "agent") await assert.rejects(request, /ownership is unavailable/);
		else {
			const result = await request;
			assert.equal("detail" in result && result.detail.status, "completed");
		}
	},
);

// #3106: preserve supported all selectors for callers owning every affected instance.
test("owner can pause all and resume each independent registered instance", async () => {
	const f = fixture("structured", true);
	const ids: string[] = [];
	for (let index = 0; index < 2; index++) {
		const route = await f.execute({ action: "route", state: { task: "Implement approved work" } }, f.ctx);
		assert.equal(route.action, "route");
		ids.push(route.workflowId);
		const started = await f.execute(
			{ action: "run", workflowId: route.workflowId, inputs: { objective: "approved" } },
			f.ctx,
		);
		assert.equal("status" in started && started.status, "running", JSON.stringify(started));
	}
	await vi.waitFor(() => assert.equal(f.gapCount, 2));
	assert.equal(f.store.runs().length, 2);
	const paused = await f.execute({ action: "pause", runId: " --all " }, f.ctx);
	assert.match("message" in paused ? (paused.message ?? "") : "", /Paused 2 run/);
	assert.ok(f.store.runs().every((run) => run.status === "paused"));
	for (const runId of ids) await f.execute({ action: "resume", runId }, f.ctx);
	f.releaseGap();
	for (const runId of ids) {
		await vi.waitFor(() =>
			assert.ok(
				f.store
					.runs()
					.find((run) => run.id === runId)!
					.stages.some((stage) => stage.pendingPrompt),
			),
		);
		await f.execute({ action: "answer", runId, text: "approved" }, f.ctx);
	}
	await Promise.all(f.jobs.runIds().map((id) => f.jobs.get(id)!.promise));
	assert.equal(f.body.mock.calls.length, 4);
});

test("route inference failure returns no fabricated decision or duration", async () => {
	const f = fixture();
	f.inference.mockImplementation(() => {
		throw new Error("Routing unavailable");
	});
	const result = await f.execute({ action: "route", state: { task: "Implement approved work" } }, f.ctx);
	assert.equal(result.action, "route");
	assert.equal(result.status, "failed");
	assert.equal(result.workflowId, "");
	assert.match(result.error ?? "", /Structured output provider request failed/);
	assert.equal("routerDecision" in result, false);
	assert.equal("workflowType" in result, false);
	assert.equal("estimatedDuration" in result, false);
	assert.equal(f.store.runs().length, 0);
});
