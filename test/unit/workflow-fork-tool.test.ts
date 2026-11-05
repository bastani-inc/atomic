import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { afterEach, beforeEach, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { ForkConfigError } from "../../packages/workflows/src/durable/fork-errors.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import type { PiExecuteContext } from "../../packages/workflows/src/extension/public-types.js";
import type { ForkResult } from "../../packages/workflows/src/extension/render-result.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import {
	workflowArgumentCompletions,
	workflowArgumentCompletionsNeedWorkflowResources,
} from "../../packages/workflows/src/extension/workflow-command-completions.js";
import { parseWorkflowForkArgs } from "../../packages/workflows/src/extension/workflow-command-registration.js";
import { WorkflowParametersSchema } from "../../packages/workflows/src/extension/workflow-schema.js";
import { makeExecuteWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool.js";
import { renderWorkflowToolContent } from "../../packages/workflows/src/extension/workflow-tool-content.js";
import { workflowForkAction } from "../../packages/workflows/src/extension/workflow-tool-fork.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createStore, store } from "../../packages/workflows/src/shared/store.js";
import { workflowPolicyFromContext } from "../../packages/workflows/src/extension/workflow-policy.js";
import { testRunId } from "../helpers/run-id.js";
import { configureCurrentTestStoreBackend as setDurableBackend } from "../helpers/store-backend.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";
import { registerWorkflowCommand } from "./slash-dispatch-utils.js";

function context(): PiExecuteContext {
	return {
		sessionManager: { getSessionId: () => "fork-tool-session" },
		cwd: process.cwd(),
		ui: { notify: () => undefined },
		hasUI: false,
	};
}

beforeEach(() => {
	store.clear();
	setDurableBackend(undefined);
});
afterEach(() => {
	store.clear();
	setDurableBackend(undefined);
});

async function forkToolFixture(seed: string) {
	const backend = await createMemoryTestBackend();
	setDurableBackend(backend);
	const calls: string[] = [];
	const definition = workflow({
		name: "fork-tool-demo",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.tool("prepare", {}, async () => {
				calls.push("prepare");
				return "ok";
			});
			await ctx.stage("plan").complete("plan");
			await ctx.stage("implement").complete("implement");
			return {};
		},
	});
	const adapters = {
		complete: {
			complete: async (text: string) => {
				calls.push(text);
				return text;
			},
		},
	};
	const runId = testRunId(seed);
	await run(definition, {}, { runId, durableBackend: backend, store: createStore(), cwd: process.cwd(), adapters });
	calls.length = 0;
	const jobs = createJobTracker();
	const execute = makeExecuteWorkflowTool(
		createExtensionRuntime({ definitions: [definition], store, jobs, adapters, cwd: process.cwd() }),
		() => undefined,
		() => undefined,
	);
	return { backend, calls, runId, execute, jobs };
}

test("the workflow tool's fork action forks from a stage and runs the fork in the background (#4321)", async () => {
	const { backend, calls, runId, execute, jobs } = await forkToolFixture("fork-tool-source");
	const result = (await execute({ action: "fork", runId, fromStage: "implement" }, context())) as ForkResult;
	assert.equal(result.action, "fork");
	assert.equal(result.status, "running", result.message);
	assert.equal(result.sourceRunId, runId);
	assert.deepEqual(result.forkedFrom, { runId, stagePath: "implement" });
	assert.notEqual(result.runId, runId);
	await jobs.get(result.runId)?.promise;
	assert.equal(backend.getWorkflow(result.runId)?.status, "completed");
	assert.deepEqual(calls, ["implement"], "the tool and the stage before the fork point replay");
	assert.ok(result.message.startsWith(`Forked workflow ${runId} from stage "implement" into ${result.runId}. `));
	assert.equal(
		renderWorkflowToolContent(result, { action: "fork", runId }),
		`fork: ${result.runId} running — ${result.message}`,
	);
	const status = await execute({ action: "status", runId: result.runId, summary: true }, context());
	assert.ok(status.action === "statusSummary");
	assert.deepEqual(status.summary.forkedFrom, { runId, stagePath: "implement" });
});

test("the fork action reports a typed failure with its code and hint and creates no run (#4321)", async () => {
	const { backend, runId, execute } = await forkToolFixture("fork-tool-missing-stage");
	const runsBefore = await backend.journal.listRuns();
	const result = (await execute({ action: "fork", runId, fromStage: "nowhere" }, context())) as ForkResult;
	assert.equal(result.status, "failed");
	assert.equal(result.code, "target-not-found");
	assert.equal(result.runId, "");
	assert.equal(result.sourceRunId, runId);
	assert.match(result.hint ?? "", /Pass one of: plan, implement/);
	assert.deepEqual(await backend.journal.listRuns(), runsBefore);
	const invalid = (await execute({ action: "fork", runId, carryMessages: "later" as "all" }, context())) as ForkResult;
	assert.equal(invalid.code, "invalid-option");
	assert.match(invalid.message, /carryMessages/);
});

test("a fork from the first stage re-runs every stage and reports the accepted run to the caller (#4321)", async () => {
	const { backend, calls, runId, execute, jobs } = await forkToolFixture("fork-tool-first-stage");
	const accepted: string[] = [];
	const result = (await execute({ action: "fork", runId, fromStage: "plan" }, context(), undefined, (id) =>
		accepted.push(id),
	)) as ForkResult;
	assert.equal(result.status, "running", result.message);
	assert.deepEqual(accepted, [result.runId]);
	await jobs.get(result.runId)?.promise;
	assert.equal(backend.getWorkflow(result.runId)?.status, "completed");
	assert.equal(backend.getWorkflow(result.runId)?.modelOwner, "fork-tool-session");
	assert.deepEqual(calls, ["plan", "implement"], "only the tool before the first stage replays");
});

test("the fork action carries messages queued after the fork point only when asked to (#4321)", async () => {
	for (const carryMessages of [undefined, "all"] as const) {
		const { backend, runId, execute, jobs } = await forkToolFixture(`fork-tool-carry-${carryMessages ?? "default"}`);
		await backend.persistPendingStageMessages(runId, [
			{
				id: "late",
				runId,
				stageKey: `workflow:${runId}/review`,
				from: { id: "sender", name: "sender" },
				message: { id: "late-message", timestamp: 1, content: { text: "late" } },
				queuedAt: new Date(1).toISOString(),
				admissionOrder: 1,
				status: "queued",
			} as never,
		]);
		await backend.releaseWorkflow(runId);
		const result = (await execute(
			{ action: "fork", runId, fromStage: "implement", ...(carryMessages === undefined ? {} : { carryMessages }) },
			context(),
		)) as ForkResult;
		assert.equal(result.status, "running", result.message);
		await jobs.get(result.runId)?.promise;
		const carried = (backend.getWorkflow(result.runId)?.pendingStageMessages ?? []).map((message) => message.id);
		assert.deepEqual(carried, carryMessages === "all" ? ["late"] : [], carryMessages);
	}
});

test("the fork action forwards its options to the runtime unchanged (#4321)", async () => {
	const { execute: _unused, ...fixture } = await forkToolFixture("fork-tool-forwarding");
	const runtime = createExtensionRuntime({ definitions: [], store, cwd: process.cwd() });
	const seen: Parameters<typeof runtime.forkDurableWorkflow>[] = [];
	const forwarding = {
		...runtime,
		forkDurableWorkflow: async (...args: Parameters<typeof runtime.forkDurableWorkflow>) => {
			seen.push(args);
			return {
				ok: false as const,
				error: new ForkConfigError({ source: "sdk", field: "inputs", expected: "x" }),
				message: "m",
			};
		},
	};
	const execute = makeExecuteWorkflowTool(
		forwarding,
		() => undefined,
		() => undefined,
	);
	const signal = new AbortController().signal;
	const onRunAccepted = () => undefined;
	const result = (await execute(
		{ action: "fork", runId: ` ${fixture.runId} `, fromStage: "plan", inputs: { a: 1 }, carryMessages: "all" },
		context(),
		signal,
		onRunAccepted,
	)) as ForkResult;
	assert.deepEqual(result, {
		action: "fork",
		runId: "",
		sourceRunId: fixture.runId,
		status: "failed",
		message: result.message,
		code: "invalid-option",
		hint: "Pass inputs as x.",
	});
	assert.equal(seen.length, 1);
	const [sourceRunId, options] = seen[0]!;
	assert.equal(sourceRunId, fixture.runId);
	assert.deepEqual(
		{ ...options, policy: undefined },
		{
			source: "sdk",
			fromStage: "plan",
			inputs: { a: 1 },
			carryMessages: "all",
			policy: undefined,
			modelOwner: "fork-tool-session",
			signal,
			onRunAccepted,
		},
	);
	assert.ok(options.policy !== undefined);
	const noRun = (await execute({ action: "fork" }, context())) as ForkResult;
	assert.deepEqual([noRun.status, noRun.code, noRun.sourceRunId], ["failed", "invalid-option", ""]);
	assert.equal(seen.length, 1, "invalid arguments never reach the runtime");
	for (const invalid of [
		{ carryMessages: "later" as "all" },
		{ fromStage: "" },
		{ inputs: [] as unknown as Record<string, never> },
	]) {
		const rejected = (await execute({ action: "fork", runId: fixture.runId, ...invalid }, context())) as ForkResult;
		assert.equal(rejected.code, "invalid-option", JSON.stringify(invalid));
		assert.equal(seen.length, 1, `${JSON.stringify(invalid)} is rejected before the runtime`);
	}
});

test("the workflow tool schema accepts the fork action and its options (#4321)", () => {
	assert.ok(
		Value.Check(WorkflowParametersSchema, {
			action: "fork",
			runId: testRunId("schema"),
			fromStage: "implement-api.review-2",
			carryMessages: "all",
			inputs: { objective: "corrected" },
		}),
	);
	assert.ok(!Value.Check(WorkflowParametersSchema, { action: "fork", carryMessages: "later" }));
});

test("/workflow fork parses a run and an optional --from stage, rejecting other shapes with one typed error (#4321)", () => {
	const runId = testRunId("slash-fork");
	assert.deepEqual(parseWorkflowForkArgs([runId]), { runId });
	assert.deepEqual(parseWorkflowForkArgs([runId, "--from", "implement-api.review-2"]), {
		runId,
		fromStage: "implement-api.review-2",
	});
	assert.deepEqual(parseWorkflowForkArgs(["--from=plan", runId]), { runId, fromStage: "plan" });
	const missing = parseWorkflowForkArgs(["--from"]);
	assert.ok(missing instanceof ForkConfigError);
	assert.equal(missing.source, "cli");
	assert.deepEqual(
		missing.issues.map((issue) => issue.field),
		["runId", "fromStage"],
	);
	const extra = parseWorkflowForkArgs([runId, "other"]);
	assert.ok(extra instanceof ForkConfigError);
	assert.equal(extra.field, "runId");
});

test("/workflow fork completes the subcommand and --from (#4321)", async () => {
	const runtime = createExtensionRuntime({ definitions: [], store });
	const subcommands = workflowArgumentCompletions("fo", runtime, store);
	assert.ok(
		subcommands?.some((item) => item.value === "fork "),
		JSON.stringify(subcommands),
	);
	const flags = workflowArgumentCompletions("fork --f", runtime, store);
	assert.ok(flags?.some((item) => item.value === "fork --from "));
});
