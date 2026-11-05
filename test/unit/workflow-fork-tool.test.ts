import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultSessionDirPath, JsonlSessionStore } from "@bastani/atomic";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, beforeEach, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import {
	ForkConfigError,
	ForkSourceOwnershipError,
	isForkSourceOwnershipError,
} from "../../packages/workflows/src/durable/fork-errors.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import type { PiExecuteContext } from "../../packages/workflows/src/extension/public-types.js";
import type { ForkResult } from "../../packages/workflows/src/extension/render-result.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import {
	workflowArgumentCompletions,
	workflowArgumentCompletionsNeedWorkflowResources,
} from "../../packages/workflows/src/extension/workflow-command-completions.js";
import { parseWorkflowForkArgs } from "../../packages/workflows/src/extension/workflow-command-registration.js";
import {
	assertWorkflowForkSourceOwner,
	workflowCaller,
} from "../../packages/workflows/src/extension/workflow-instance-owner.js";
import { workflowPolicyFromContext } from "../../packages/workflows/src/extension/workflow-policy.js";
import { WorkflowParametersSchema } from "../../packages/workflows/src/extension/workflow-schema.js";
import { makeExecuteWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool.js";
import { renderWorkflowToolContent } from "../../packages/workflows/src/extension/workflow-tool-content.js";
import { workflowForkAction } from "../../packages/workflows/src/extension/workflow-tool-fork.js";
import { createJobTracker, currentJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createStore, store } from "../../packages/workflows/src/shared/store.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { testRunId } from "../helpers/run-id.js";
import { readText, writeFileEnsuringDir } from "../helpers/runtime.js";
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

test("the fork action starts in the source run's selected journal instead of the default journal (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const defaultBackend = await createMemoryTestBackend();
	setDurableBackend(defaultBackend);
	let executions = 0;
	const definition = workflow({
		name: "fork-selected-journal",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.tool("record", {}, async () => ++executions);
			return {};
		},
	});
	const sourceId = testRunId("fork-selected-journal");
	await run(definition, {}, { runId: sourceId, durableBackend: backend, store, cwd: process.cwd() });
	const sourceEvents: string[] = [];
	for await (const event of backend.journal.read(sourceId)) sourceEvents.push(JSON.stringify(event));
	const jobs = createJobTracker();
	const runtime = createExtensionRuntime({ definitions: [definition], store, jobs, cwd: process.cwd() });
	const result = await runtime.forkDurableWorkflow(sourceId, { source: "sdk" });
	assert.ok(result.ok, result.message);
	assert.equal(result.started, true, result.message);
	await jobs.get(result.runId)?.promise;
	assert.equal(backend.getWorkflow(result.runId)?.status, "completed");
	assert.equal(executions, 1, "the fork replays its saved tool in the selected journal");
	const retainedEvents: string[] = [];
	for await (const event of backend.journal.read(sourceId)) retainedEvents.push(JSON.stringify(event));
	assert.deepEqual(retainedEvents, sourceEvents);
	assert.deepEqual(await defaultBackend.journal.listRuns(), [], "the default journal is never written");
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

test("the fork action refuses a source run another session owns before copying anything (#4321)", async () => {
	const root = mkdtempSync(join(tmpdir(), "workflow-fork-tool-owner-"));
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", join(root, "agent"));
	try {
		const sourceCwd = join(root, "source");
		vi.stubEnv("ATOMIC_CODING_AGENT_SESSION_DIR", getDefaultSessionDirPath(sourceCwd));
		const sourcePath = join(getDefaultSessionDirPath(sourceCwd), "source.jsonl");
		const history = `${JSON.stringify({
			type: "session",
			version: 4,
			id: "source-session",
			createdAt: new Date().toISOString(),
			cwd: sourceCwd,
		})}\n`;
		await writeFileEnsuringDir(sourcePath, history);
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		const runId = testRunId("fork-tool-foreign-owner");
		await backend.commitWorkflowRegistration({
			workflowId: runId,
			name: "fork-tool-owned",
			inputs: {},
			status: "completed",
			createdAt: 1,
			invocationCwd: sourceCwd,
			origin: "agent",
			modelOwner: "owner-session",
		});
		await backend.commitCheckpoint({
			kind: "stage",
			workflowId: runId,
			checkpointId: "stage:plan",
			name: "plan",
			replayKey: "stage:plan:1",
			sessionId: "source-session",
			sessionFile: sourcePath,
			output: "planned",
			completedAt: 1,
		});
		const destination = await JsonlSessionStore.open(join(root, "destination"), { exactDirectory: true });
		const writes = (["create", "append", "replace", "delete"] as const).map((method) =>
			vi.spyOn(destination, method),
		);
		const sessionWrites = () => writes.reduce((count, spy) => count + spy.mock.calls.length, 0);
		const definition = workflow({
			name: "fork-tool-owned",
			description: "",
			inputs: {},
			outputs: {},
			run: async () => ({}),
		});
		const jobs = createJobTracker();
		let onResourceLoad: () => void = () => undefined;
		const execute = makeExecuteWorkflowTool(
			createExtensionRuntime({
				definitions: [definition],
				store,
				jobs,
				adapters: { sessionStore: destination },
				cwd: join(root, "target"),
			}),
			() => undefined,
			() => onResourceLoad(),
		);
		assert.equal(store.run(runId), undefined, "the source run is not in this session's store");
		const runsBefore = await backend.journal.listRuns();
		const leaseChecks = vi.spyOn(backend.journal, "leaseState");
		const takeovers = vi.spyOn(backend.journal, "takeoverExpired");
		for (const target of [runId, runId.slice(0, 8)]) {
			const refused = (await execute({ action: "fork", runId: target }, context())) as ForkResult;
			assert.deepEqual(
				{ ...refused, message: undefined },
				{
					action: "fork",
					runId: "",
					sourceRunId: target,
					status: "failed",
					message: undefined,
					code: "source-not-owned",
					hint: `Fork it from the session that started it, or ask the user to run /workflow fork ${runId}.`,
				},
			);
		}
		const activeExecution = vi.spyOn(backend, "hasWorkflowExecution").mockReturnValue(true);
		const busySource = (await execute({ action: "fork", runId }, context())) as ForkResult;
		assert.equal(busySource.code, "source-not-owned", "foreign callers cannot inspect execution state");
		assert.equal(activeExecution.mock.calls.length, 0);
		activeExecution.mockRestore();
		let activeCaller = "foreign-session";
		const changingContext: PiExecuteContext = {
			...context(),
			sessionManager: { getSessionId: () => activeCaller },
		};
		onResourceLoad = () => {
			activeCaller = "owner-session";
		};
		const changedCaller = (await execute({ action: "fork", runId }, changingContext)) as ForkResult;
		await jobs.get(changedCaller.runId)?.promise;
		assert.equal(changedCaller.status, "failed", "resource loading cannot change a request's authority");
		assert.equal(changedCaller.code, "source-not-owned");
		onResourceLoad = () => undefined;
		assert.equal(leaseChecks.mock.calls.length, 0, "a refused fork never inspects a lease");
		assert.equal(takeovers.mock.calls.length, 0, "a refused fork never writes a lease");
		assert.deepEqual(await backend.journal.listRuns(), runsBefore, "a refused fork writes no run");
		assert.equal(sessionWrites(), 0, "a refused fork writes no stage conversation");
		assert.equal(await readText(sourcePath), history);
		const owner: PiExecuteContext = {
			...context(),
			sessionManager: { getSessionId: () => "owner-session" },
			cwd: join(root, "elsewhere"),
		};
		const forked = (await execute({ action: "fork", runId }, owner)) as ForkResult;
		assert.equal(forked.status, "running", forked.message);
		await jobs.get(forked.runId)?.promise;
		assert.equal(backend.getWorkflow(forked.runId)?.modelOwner, "owner-session");
		assert.equal(writes[0]?.mock.calls.length, 1, "the owner's fork copies the stage conversation");
		await destination.close();
	} finally {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	}
});

test("the fork source owner check accepts the owner and unowned user runs and refuses both other cases (#4321)", () => {
	const runId = testRunId("fork-owner-check");
	const handle = {
		workflowId: runId,
		name: "w",
		inputs: {},
		status: "completed" as const,
		createdAt: 1,
		updatedAt: 1,
		completedCheckpoints: 0,
		pendingPrompts: 0,
	};
	const caller = workflowCaller(context());
	assert.doesNotThrow(() => assertWorkflowForkSourceOwner({ ...handle, modelOwner: caller }, caller));
	assert.doesNotThrow(() => assertWorkflowForkSourceOwner({ ...handle, origin: "user" }, caller));
	assert.doesNotThrow(() => assertWorkflowForkSourceOwner(handle, caller));
	for (const [owned, reason] of [
		[{ ...handle, modelOwner: "other-session", origin: "user" as const }, "foreign-owner"],
		[{ ...handle, origin: "agent" as const }, "owner-unavailable"],
	] as const) {
		assert.throws(
			() => assertWorkflowForkSourceOwner(owned, caller),
			(error: Error) =>
				error instanceof ForkSourceOwnershipError &&
				isForkSourceOwnershipError(error) &&
				error.code === "source-not-owned" &&
				error.reason === reason &&
				error.runId === runId &&
				error.retryable === false,
		);
	}
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
		{ ...options, policy: undefined, validateSource: undefined },
		{
			source: "sdk",
			fromStage: "plan",
			inputs: { a: 1 },
			carryMessages: "all",
			policy: undefined,
			modelOwner: "fork-tool-session",
			signal,
			onRunAccepted,
			validateSource: undefined,
		},
	);
	assert.ok(options.policy !== undefined);
	assert.equal(typeof options.validateSource, "function", "the source owner is checked by the fork");
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

test("the fork action keeps the source run's inputs when given the schema's empty default, and replaces them when given values (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	setDurableBackend(backend);
	const definition = workflow({
		name: "fork-tool-inputs",
		description: "",
		inputs: { objective: Type.String({ default: "default objective" }) },
		outputs: {},
		run: async (ctx) => {
			await ctx.tool("record", { objective: ctx.inputs.objective }, async () => ctx.inputs.objective);
			return {};
		},
	});
	const runId = testRunId("fork-tool-inputs");
	await run(definition, { objective: "recorded objective" }, { runId, durableBackend: backend, store: createStore() });
	const jobs = createJobTracker();
	const execute = makeExecuteWorkflowTool(
		createExtensionRuntime({ registry: createRegistry().register(definition), store, jobs, cwd: process.cwd() }),
		() => undefined,
		() => undefined,
	);
	const kept = (await execute({ action: "fork", runId, inputs: {} }, context())) as ForkResult;
	assert.equal(kept.status, "running", kept.message);
	assert.deepEqual(backend.getWorkflow(kept.runId)?.inputs, { objective: "recorded objective" });
	await jobs.get(kept.runId)?.promise;
	const replaced = (await execute(
		{ action: "fork", runId, inputs: { objective: "corrected objective" } },
		context(),
	)) as ForkResult;
	assert.equal(replaced.status, "running", replaced.message);
	assert.deepEqual(backend.getWorkflow(replaced.runId)?.inputs, { objective: "corrected objective" });
	await jobs.get(replaced.runId)?.promise;
});

test("the fork action reports a nested run's id as a nested run of its root (#4321)", async () => {
	const { runId, execute } = await forkToolFixture("fork-tool-nested");
	const nestedId = testRunId("fork-tool-nested-child");
	store.recordRunStart({
		id: nestedId,
		name: "nested-child",
		inputs: {},
		status: "completed",
		toolNodes: [],
		stages: [],
		startedAt: 1,
		parentRunId: runId,
		rootRunId: runId,
	});
	const refused = (await execute({ action: "fork", runId: nestedId }, context())) as ForkResult;
	assert.deepEqual([refused.status, refused.code], ["failed", "source-not-found"]);
	assert.equal(refused.hint, `Fork the root run ${runId}; listForkPoints("${runId}") lists the nested stage paths.`);
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
	assert.ok(Value.Check(WorkflowParametersSchema, { action: "fork", carryMessages: "before" }));
	assert.ok(!Value.Check(WorkflowParametersSchema, { action: "fork", carryMessages: "later" }));
	const { action, runId, inputs, fromStage, carryMessages } = WorkflowParametersSchema.properties as Record<
		string,
		{ readonly description?: string }
	>;
	assert.match(action?.description ?? "", /fork a durable run into a new run \(optionally re-running from fromStage/);
	assert.match(runId?.description ?? "", /quit\/fork \(for fork, the source run\)/);
	assert.match(
		inputs?.description ?? "",
		/replacement inputs for action 'fork' \(omitted or empty: the source run's inputs\)/,
	);
	assert.match(fromStage?.description ?? "", /^Fork-only: dot path of the completed stage the fork re-runs from/);
	assert.match(carryMessages?.description ?? "", /^Fork-only: .*\('before', default\) or all of them \('all'\)/);
});

const RUN_ISSUE = {
	field: "runId",
	expected: "exactly one run id or 8-character prefix: /workflow fork <run> [--from <stage>]",
};
const FROM_ISSUE = { field: "fromStage", expected: "one stage path after --from" };

test("/workflow fork parses a run and an optional --from stage, rejecting other shapes with one typed error (#4321)", () => {
	const runId = testRunId("slash-fork");
	assert.deepEqual(parseWorkflowForkArgs([runId]), { runId });
	assert.deepEqual(parseWorkflowForkArgs([runId, "--from", "implement-api.review-2"]), {
		runId,
		fromStage: "implement-api.review-2",
	});
	assert.deepEqual(parseWorkflowForkArgs(["--from=plan", runId]), { runId, fromStage: "plan" });
	const rejected = (tokens: string[]) => {
		const error = parseWorkflowForkArgs(tokens);
		assert.ok(error instanceof ForkConfigError, JSON.stringify(tokens));
		assert.equal(error.source, "cli");
		assert.equal(error.field, error.issues[0]!.field);
		assert.equal(error.expected, error.issues[0]!.expected);
		return error.issues;
	};
	assert.deepEqual(rejected(["--from"]), [RUN_ISSUE, FROM_ISSUE]);
	assert.deepEqual(rejected([runId, "other"]), [RUN_ISSUE]);
	assert.deepEqual(rejected([]), [RUN_ISSUE]);
	assert.deepEqual(rejected([runId, "--from", "--plan"]), [FROM_ISSUE]);
	assert.deepEqual(rejected([runId, "--from", "a", "--from", "b"]), [FROM_ISSUE]);
	assert.deepEqual(rejected([runId, "--from", "a", "--from=b"]), [FROM_ISSUE]);
	assert.deepEqual(rejected([runId, "--from=a", "--from=b"]), [FROM_ISSUE]);
	assert.deepEqual(rejected([runId, "--from="]), [FROM_ISSUE]);
	assert.deepEqual(rejected(["--bogus"]), [RUN_ISSUE]);
	assert.deepEqual(rejected(["--bogus", "--from", "a"]), [RUN_ISSUE]);
	assert.equal(
		(parseWorkflowForkArgs([runId, "--from"]) as ForkConfigError).message,
		new ForkConfigError({ source: "cli", field: "fromStage", expected: FROM_ISSUE.expected }).message,
	);
});

test("/workflow fork completes the subcommand, --from and run ids, and nothing else is mistaken for it (#4321)", () => {
	const completeDemo = workflow({
		name: "complete-demo",
		description: "",
		inputs: { mode: Type.Union([Type.Literal("fast"), Type.Literal("slow")]) },
		outputs: {},
		run: async () => ({}),
	});
	const runtime = createExtensionRuntime({ registry: createRegistry().register(completeDemo), store });
	const forkItem = {
		value: "fork ",
		label: "fork",
		description: "Fork a run into a new run, optionally --from a stage",
	};
	assert.deepEqual(workflowArgumentCompletions("fo", runtime, store), [forkItem]);
	const fromItem = {
		value: "fork --from ",
		label: "--from",
		description: "Dot path of the stage the fork re-runs from",
	};
	assert.deepEqual(workflowArgumentCompletions("fork --f", runtime, store), [fromItem]);
	const runStore = createStore();
	const forkable = testRunId("complete-run");
	runStore.recordRunStart({
		id: forkable,
		name: "complete-demo",
		inputs: {},
		status: "completed",
		stages: [],
		toolNodes: [],
		startedAt: 1,
	});
	assert.deepEqual(workflowArgumentCompletions("fork ", runtime, runStore), [
		{ ...fromItem, value: "fork --from " },
		{ value: `fork ${forkable} `, label: forkable, description: "complete-demo — completed" },
	]);
	assert.deepEqual(workflowArgumentCompletions("quit ", runtime, runStore), [
		{
			value: "quit --all ",
			label: "--all",
			description: "Quit and keep all in-flight runs resumable",
		},
		{ value: `quit ${forkable} `, label: forkable, description: "complete-demo — completed" },
	]);
	assert.deepEqual(
		workflowArgumentCompletions("complete-demo mode=", runtime, runStore)?.map((item) => item.value),
		["complete-demo mode=fast ", "complete-demo mode=slow "],
	);
	assert.equal(workflowArgumentCompletions("unknown-workflow ", runtime, runStore), null);
});

test("completing a run-targeting subcommand never loads workflow resources, and a workflow name does (#4321)", () => {
	for (const subcommand of ["status", "connect", "resume", "attach", "pause", "quit", "reload", "fork"]) {
		assert.equal(workflowArgumentCompletionsNeedWorkflowResources(`${subcommand} `), false, subcommand);
		assert.equal(workflowArgumentCompletionsNeedWorkflowResources(`${subcommand} abc`), false, subcommand);
		assert.equal(
			workflowArgumentCompletionsNeedWorkflowResources(subcommand),
			true,
			`${subcommand} still being typed`,
		);
	}
	assert.equal(workflowArgumentCompletionsNeedWorkflowResources("inputs x"), true);
	assert.equal(workflowArgumentCompletionsNeedWorkflowResources("complete-demo mode="), true);
});

const DISCOVERED = "fork-discovered";

async function discoverableSource(seed: string) {
	const backend = await createMemoryTestBackend();
	setDurableBackend(backend);
	const root = mkdtempSync(join(tmpdir(), "fork-discovery-"));
	const sourceDir = join(root, "source");
	const runtimeDir = join(root, "runtime");
	mkdirSync(join(sourceDir, ".atomic", "workflows"), { recursive: true });
	mkdirSync(runtimeDir);
	writeFileSync(
		join(sourceDir, ".atomic", "workflows", `${DISCOVERED}.ts`),
		`import { workflow } from "@bastani/atomic/workflows";
export default workflow({
	name: "${DISCOVERED}",
	description: "",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		await ctx.tool("noop", {}, async () => "ok");
		return {};
	},
});
`,
	);
	const runId = testRunId(seed);
	await backend.commitWorkflowRegistration({
		workflowId: runId,
		name: DISCOVERED,
		inputs: {},
		status: "completed",
		createdAt: 1,
		invocationCwd: sourceDir,
	});
	await backend.commitCheckpoint({
		kind: "stage",
		workflowId: runId,
		checkpointId: "stage:plan",
		name: "plan",
		replayKey: "stage:plan:1",
		output: "done",
		completedAt: 2,
	});
	const jobs = createJobTracker();
	const runtime = createExtensionRuntime({ definitions: [], store, jobs, cwd: runtimeDir });
	const execute = makeExecuteWorkflowTool(
		runtime,
		() => undefined,
		() => undefined,
	);
	return { backend, root, runId, runtimeDir, runtime, execute, jobs };
}

test("resuming a run in its own project still finds its workflow by discovery when no fork definition is given (#4321)", async () => {
	const { backend, root, runId } = await discoverableSource("resume-discovered");
	try {
		const sourceDir = backend.getWorkflow(runId)!.invocationCwd!;
		await backend.commitWorkflowStatus(runId, "paused", 0, true);
		const jobs = createJobTracker();
		const runtime = createExtensionRuntime({ definitions: [], store, jobs, cwd: sourceDir });
		const resumed = await runtime.resumeDurableWorkflow(runId);
		assert.ok(resumed.ok, resumed.message);
		await jobs.get(runId)?.promise;
		assert.equal(backend.getWorkflow(runId)?.status, "completed");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a fork of a workflow defined only in the source's project runs that definition to completion (#4321)", async () => {
	const { backend, root, runId, execute, jobs } = await discoverableSource("fork-discovery");
	try {
		const staged = (await execute({ action: "fork", runId, fromStage: "plan" }, context())) as ForkResult;
		assert.equal(staged.status, "running", staged.message);
		assert.equal("startFailure" in staged, false);
		assert.match(
			staged.message,
			new RegExp(
				`^Forked workflow ${runId} from stage "plan" into ${staged.runId}\\. Resuming durable workflow "${DISCOVERED}"`,
			),
		);
		assert.deepEqual(staged.forkedFrom, { runId, stagePath: "plan" });
		await jobs.get(staged.runId)?.promise;
		assert.equal(backend.getWorkflow(staged.runId)?.status, "completed");
		assert.equal(
			renderWorkflowToolContent(staged, { action: "fork", runId }),
			`fork: ${staged.runId} running — ${staged.message}`,
		);
		const whole = (await execute({ action: "fork", runId }, context())) as ForkResult;
		assert.equal(whole.status, "running", whole.message);
		assert.match(whole.message, new RegExp(`^Forked workflow ${runId} into ${whole.runId}\\. `));
		assert.deepEqual(whole.forkedFrom, { runId });
		await jobs.get(whole.runId)?.promise;
		assert.equal(backend.getWorkflow(whole.runId)?.status, "completed");
		assert.equal((await backend.journal.listRuns()).length, 3, "the source and its two forks");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a fork written but unable to start reports why with a code and the next step that works here (#4321)", async () => {
	const refuseStart = (backend: { commitWorkflowRegistration: (...args: never[]) => Promise<void> }) =>
		vi.spyOn(backend, "commitWorkflowRegistration").mockRejectedValue(new Error("registration refused"));
	const discovered = await discoverableSource("fork-not-started");
	try {
		refuseStart(discovered.backend);
		const elsewhere = (await discovered.execute(
			{ action: "fork", runId: discovered.runId, fromStage: "plan" },
			context(),
		)) as ForkResult;
		assert.deepEqual([elsewhere.status, elsewhere.startFailure], ["forked", "control_failed"]);
		assert.equal(
			elsewhere.message,
			`Forked workflow ${discovered.runId} from stage "plan" into ${elsewhere.runId}; it did not start: Failed to resume durable workflow ${elsewhere.runId}: registration refused Workflow "${DISCOVERED}" is not defined in this directory, so /workflow resume cannot start the fork here; fork the source again with /workflow fork ${discovered.runId}.`,
		);
		assert.equal((await discovered.backend.journal.getRun(elsewhere.runId))?.runId, elsewhere.runId);
	} finally {
		vi.restoreAllMocks();
		rmSync(discovered.root, { recursive: true, force: true });
	}
	const local = await forkToolFixture("fork-not-started-local");
	refuseStart(local.backend);
	const here = (await local.execute(
		{ action: "fork", runId: local.runId, fromStage: "plan" },
		context(),
	)) as ForkResult;
	assert.deepEqual([here.status, here.startFailure], ["forked", "control_failed"]);
	assert.ok(
		here.message.endsWith(`registration refused Resume it with /workflow resume ${here.runId}.`),
		here.message,
	);
});

test("a fork of a run this process is still executing is refused as busy and creates no run (#4321)", async () => {
	const { backend, root, runId, execute } = await discoverableSource("fork-live");
	try {
		store.recordRunStart({
			id: runId,
			name: DISCOVERED,
			inputs: {},
			status: "running",
			stages: [],
			toolNodes: [],
			startedAt: 1,
		});
		const runsBefore = await backend.journal.listRuns();
		const refused = (await execute({ action: "fork", runId, fromStage: "plan" }, context())) as ForkResult;
		assert.equal(refused.status, "failed");
		assert.equal(refused.code, "source-busy");
		assert.deepEqual(await backend.journal.listRuns(), runsBefore);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a fork that fails for a reason other than a fork error rejects instead of reporting a failed fork (#4321)", async () => {
	const { backend, root, runId, runtime } = await discoverableSource("fork-unexpected");
	try {
		vi.spyOn(backend, "hasWorkflowExecution").mockImplementation(() => {
			throw new Error("journal exploded");
		});
		await assert.rejects(
			runtime.forkDurableWorkflow(runId, { source: "sdk", fromStage: "plan" }),
			/journal exploded/,
		);
		assert.equal((await backend.journal.listRuns()).length, 1, "only the source run exists");
	} finally {
		vi.restoreAllMocks();
		rmSync(root, { recursive: true, force: true });
	}
});

test("a validation failure that is not a fork error propagates from the fork action (#4321)", async () => {
	const failure = new Error("arguments unreadable");
	const args = {
		action: "fork" as const,
		runId: "abc",
		get inputs(): never {
			throw failure;
		},
	};
	const runtime = createExtensionRuntime({ definitions: [], store });
	await assert.rejects(
		workflowForkAction(args, {
			getRuntime: () => runtime,
			policy: workflowPolicyFromContext(context()),
			source: "cli",
		}),
		failure,
	);
});

test("/workflow fork forks a run, prints what happened and reports bad arguments and fork failures (#4321)", async () => {
	const { backend, root, runId } = await discoverableSource("fork-slash");
	try {
		const { workflowCmd } = await registerWorkflowCommand();
		assert.match(workflowCmd.options.description, /\/workflow fork <run> \[--from <stage>\]/);
		const run = async (args: string) => {
			const messages: string[] = [];
			const levels: (string | undefined)[] = [];
			await workflowCmd.options.handler(args, {
				ui: {
					notify: (message: string, level?: string) => {
						messages.push(message);
						levels.push(level);
					},
				},
			});
			return { messages, levels };
		};
		const { messages: staged, levels: stagedLevels } = await run(`fork ${runId} --from plan`);
		assert.equal(staged.length, 1, staged.join("\n"));
		const stagedMatch =
			/^Forked workflow (\S+) from stage "plan" into (\S+)\. Resuming durable workflow "fork-discovered"/.exec(
				staged[0]!,
			);
		assert.ok(stagedMatch, staged[0]);
		assert.deepEqual(stagedLevels, ["info"]);
		assert.equal(stagedMatch[1], runId);
		assert.deepEqual(backend.getWorkflow(stagedMatch[2]!)?.forkedFrom, { runId, stagePath: "plan" });
		await currentJobTracker().get(stagedMatch[2]!)?.promise;
		assert.equal(backend.getWorkflow(stagedMatch[2]!)?.status, "completed");
		const { messages: whole } = await run(`fork ${runId}`);
		assert.equal(whole.length, 1, whole.join("\n"));
		const wholeMatch = new RegExp(`^Forked workflow ${runId} into (\\S+)\\. Resuming durable workflow `).exec(
			whole[0]!,
		);
		assert.ok(wholeMatch, whole[0]);
		await currentJobTracker().get(wholeMatch[1]!)?.promise;
		assert.equal(backend.getWorkflow(wholeMatch[1]!)?.status, "completed");
		const runsBefore = await backend.journal.listRuns();
		const { messages: invalid, levels: invalidLevels } = await run("fork");
		assert.deepEqual(invalid, [(parseWorkflowForkArgs([]) as ForkConfigError).message]);
		assert.deepEqual(invalidLevels, ["error"]);
		const { messages: badFrom } = await run(`fork ${runId} --from`);
		assert.deepEqual(badFrom, [(parseWorkflowForkArgs([runId, "--from"]) as ForkConfigError).message]);
		const { messages: missing, levels: missingLevels } = await run(`fork ${testRunId("fork-slash-missing")}`);
		assert.equal(missing.length, 1);
		assert.deepEqual(missingLevels, ["error"]);
		assert.match(missing[0]!, /not found/i);
		const { messages: noStage } = await run(`fork ${runId} --from nowhere`);
		assert.equal(noStage.length, 1);
		assert.match(noStage[0]!, /nowhere/);
		assert.deepEqual(await backend.journal.listRuns(), runsBefore);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the fork action's tool content names the fork, or the source when no fork exists, and other actions keep theirs (#4321)", () => {
	const failed: ForkResult = {
		action: "fork",
		runId: "",
		sourceRunId: "source-run",
		status: "failed",
		message: "boom",
	};
	assert.equal(renderWorkflowToolContent(failed, { action: "fork" }), "fork: source-run failed — boom");
	assert.equal(
		renderWorkflowToolContent({ ...failed, runId: "fork-run", status: "running" }, { action: "fork" }),
		"fork: fork-run running — boom",
	);
	assert.equal(
		renderWorkflowToolContent(
			{ action: "pause", runId: "paused-run", status: "paused", message: "ok" },
			{ action: "pause" },
		),
		"pause: paused-run paused — ok",
	);
	assert.equal(
		renderWorkflowToolContent(
			{ action: "answer", runId: "r", stageId: "s", status: "ok", message: "sent" },
			{ action: "answer" },
		),
		"answer: r/s ok — sent",
	);
});
