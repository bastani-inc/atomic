import assert from "node:assert/strict";
import { Type } from "typebox";
import { afterEach, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import type { DurableWorkflowBackend } from "../../packages/workflows/src/durable/backend.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import type { PiExecuteContext } from "../../packages/workflows/src/extension/public-types.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { captureWorkflowOwnerResources } from "../../packages/workflows/src/extension/workflow-owner-resources.js";
import { makeExecuteWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowInputValues } from "../../packages/workflows/src/shared/types.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { createMockSdk, restoreMockSdkState, serializeMockSdkState } from "./durable-dbos-backend-helpers.js";
import { waitForExecutorStagePendingPrompt } from "./executor-shared.js";

afterEach(() => {
	setDurableBackend(undefined);
	vi.restoreAllMocks();
});

function fixture(lifecycle = false, failOnce = false, backend: DurableWorkflowBackend = new InMemoryDurableBackend()) {
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
	const ctx: PiExecuteContext = { sessionId: "owner" };
	const launch = async (caller: PiExecuteContext = ctx, inputs: WorkflowInputValues = { objective: "approved" }) => {
		const started = await execute({ action: "run", workflow: "registered", inputs }, caller);
		assert.equal(started.action, "run");
		return started;
	};
	return {
		store,
		jobs,
		definition,
		execute,
		ctx,
		launch,
		body,
		runtime,
		gapReached,
		releaseGap,
		get gapCount() {
			return gapCount;
		},
	};
}

function runIdOf(result: Awaited<ReturnType<ReturnType<typeof fixture>["launch"]>>): string {
	assert.ok("runId" in result && result.runId, JSON.stringify(result));
	return result.runId;
}

test("model run launches the named workflow and rejects invalid inputs without admission", async () => {
	const f = fixture();
	const invalid = await f.launch(f.ctx, { objective: 42 });
	assert.equal("status" in invalid && invalid.status, "failed");
	assert.equal(f.store.runs().length, 0);
	const unknown = await f.execute({ action: "run", workflow: "missing", inputs: {} }, f.ctx);
	assert.equal("status" in unknown && unknown.status, "failed");
	const started = await f.launch();
	assert.equal("status" in started && started.status, "running");
	await Promise.all(f.jobs.runIds().map((id) => f.jobs.get(id)!.promise));
	assert.equal(f.store.runs().length, 1);
	assert.equal(f.store.runs()[0]!.id, runIdOf(started));
	assert.equal(f.body.mock.calls.length, 1);
});

test("distinct runs execute independently and remain inspectable only by their owner", async () => {
	const f = fixture();
	const ids = (await Promise.all([f.launch(), f.launch()])).map(runIdOf);
	assert.notEqual(ids[0], ids[1]);
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

test("agent-launched identity survives pending input and pause/resume", async () => {
	const f = fixture(true);
	const runId = runIdOf(await f.launch());
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
});

test("foreign caller cannot pause the implicit active agent-launched instance", async () => {
	const f = fixture(true);
	try {
		await f.launch();
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

test("terminal ownership survives model tool recreation", async () => {
	const f = fixture();
	const runId = runIdOf(await f.launch());
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
	await assert.rejects(recreated({ action: "status", runId }, { ...f.ctx, sessionId: "foreign" }), /another caller/);
	const result = await recreated({ action: "status", runId }, f.ctx);
	assert.equal(result.action, "statusDetail");
	assert.equal("detail" in result && result.detail.status, "completed");
});

test("lifecycle authorizes padded/default/prefix selectors and prompts after recreation", async () => {
	const f = fixture(true);
	const runId = runIdOf(await f.launch());
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

test.each(["pause", "quit"] as const)(
	"%s bulk selectors preauthorize every actual target atomically",
	async (action) => {
		const f = fixture(true);
		const contexts = [f.ctx, { ...f.ctx, sessionId: "other-owner" }];
		for (const ctx of contexts) await f.launch(ctx);
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

test("terminal ownership survives runtime replacement and durable-only inspection", async () => {
	const sdk = createMockSdk();
	const backend = new DbosDurableBackend(sdk);
	const f = fixture(false, false, backend);
	const runId = runIdOf(await f.launch());
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
		for (const selector of [runId, ` ${runId} `, runId.slice(0, 8).toUpperCase()]) {
			await assert.rejects(
				execute({ action, runId: selector }, foreign),
				/another caller/,
				`${action}: ${selector}`,
			);
		}
	}
	const status = await execute({ action: "status", runId }, { ...f.ctx });
	assert.equal(status.action, "statusDetail");
	assert.equal("detail" in status && status.detail.status, "completed");
	assert.equal(f.body.mock.calls.length, 1);
});

test("checkpointed agent-launched instance resumes under its owner after runtime replacement", async () => {
	const f = fixture(false, true);
	const runId = runIdOf(await f.launch());
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

// Missing model-owner metadata fails closed, without gating explicit user/internal launches.
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

test("owner can pause all and resume each independent agent-launched instance", async () => {
	const f = fixture(true);
	const ids: string[] = [];
	for (let index = 0; index < 2; index++) {
		const started = await f.launch();
		assert.equal("status" in started && started.status, "running", JSON.stringify(started));
		ids.push(runIdOf(started));
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
