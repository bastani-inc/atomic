import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import {
	DBOS_ADMISSION_TIMEOUT_MS,
	DbosDependencyError,
	dbosAdmissionContext,
} from "../../packages/workflows/src/durable/dbos-admission.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import type {
	ExtensionAPI,
	PiExecuteContext,
	WorkflowToolArgs,
} from "../../packages/workflows/src/extension/public-types.js";
import type { WorkflowToolResult } from "../../packages/workflows/src/extension/render-result.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { makeExecuteWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool.js";
import {
	registerWorkflowTool,
	WORKFLOW_TOOL_REQUEST_TIMEOUT_MS,
} from "../../packages/workflows/src/extension/workflow-tool-registration.js";
import { jobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createStore, store as workflowStore } from "../../packages/workflows/src/shared/store.js";
import { createMockSdk } from "./durable-dbos-backend-helpers.js";

const READ_ONLY_ACTIONS = ["models", "list", "get", "inputs", "status", "stages", "stage", "transcript"] as const;
const MUTATING_ACTIONS = ["reload", "run", "answer", "pause", "resume", "quit"] as const;
const ALL_ACTIONS = [...READ_ONLY_ACTIONS, ...MUTATING_ACTIONS] as const;

type WorkflowToolExecutor = (
	args: WorkflowToolArgs,
	ctx: PiExecuteContext,
	signal?: AbortSignal,
	onRunAccepted?: (runId: string) => void,
) => Promise<WorkflowToolResult>;

function registeredTool(executor: WorkflowToolExecutor) {
	const pi: Pick<ExtensionAPI, "registerTool"> = { registerTool: () => {} };
	const registered = registerWorkflowTool(pi, executor, async (_policy, run) => run());
	if (registered === undefined) throw new Error("workflow tool was not registered");
	return registered;
}

async function rejectedError<T>(operation: Promise<T>): Promise<Error> {
	try {
		await operation;
	} catch (error) {
		assert.ok(error instanceof Error);
		return error;
	}
	throw new Error("expected operation to reject");
}

function expectedTimeoutError(action: (typeof ALL_ACTIONS)[number]): string {
	const base = `Workflow ${action} request timed out after ${WORKFLOW_TOOL_REQUEST_TIMEOUT_MS}ms.`;
	return MUTATING_ACTIONS.includes(action as (typeof MUTATING_ACTIONS)[number])
		? `${base} The outcome is unknown. Inspect workflow status before retrying.`
		: base;
}

afterEach(() => {
	vi.useRealTimers();
	setDurableBackend(undefined);
	workflowStore.clear();
});

describe("public workflow tool request deadline", () => {
	// #3072 / #3074: ordinary database rejection is not a running or uncertain admission.
	test.each([
		["28P01", 'password authentication failed for user "atomic"'],
		["42501", 'permission denied for table "dbos"."workflow_status"'],
	])("%s admission rejection preserves its diagnostic and discards only the local run", async (code, message) => {
		vi.useFakeTimers();
		const sdk = createMockSdk();
		const startWorkflow = vi.fn(async () => {
			throw Object.assign(new Error(message), { code });
		});
		const backend = new DbosDurableBackend({ ...sdk, startWorkflow });
		setDurableBackend(backend);
		let bodyExecutions = 0;
		const definition = workflow({
			name: "public-auth-rejected-admission",
			description: "",
			inputs: {},
			outputs: {},
			run: async () => {
				bodyExecutions++;
				return {};
			},
		});
		const runtime = createExtensionRuntime({ definitions: [definition] });
		const tool = registeredTool(makeExecuteWorkflowTool(runtime, () => undefined));
		const ctx = {};
		const pending = tool.execute(
			"auth-rejection",
			{ action: "run", workflow: definition.normalizedName },
			undefined,
			undefined,
			ctx,
		);
		await vi.advanceTimersByTimeAsync(0);
		const result = await pending;
		assert.equal(result.details.action, "run");
		assert.equal(result.details.status, "failed");
		const runId = "runId" in result.details ? result.details.runId : undefined;
		assert.ok(runId);
		assert.equal("error" in result.details ? result.details.error : undefined, message);
		assert.equal(workflowStore.runs().length, 0);
		assert.equal(backend.getWorkflow(runId), undefined);
		assert.equal(sdk.state.workflows.has(runId), false);
		assert.equal(sdk.state.steps.size, 0);
		assert.deepEqual(sdk.state.deletions, []);
		await vi.advanceTimersByTimeAsync(WORKFLOW_TOOL_REQUEST_TIMEOUT_MS);
		assert.equal(startWorkflow.mock.calls.length, 1);
		assert.equal(bodyExecutions, 0);
		assert.equal(vi.getTimerCount(), 0);
	});

	// #3072 / verifier F7: failed admission must not re-enter an unavailable DB for cleanup.
	for (const mode of ["frozen", "refusing"] as const) {
		test(`preserves the admission failure and identity through a ${mode} database outage`, async () => {
			vi.useFakeTimers();
			const sdk = createMockSdk();
			const reads = vi.fn(async (): Promise<never> => {
				if (mode === "frozen") return new Promise<never>(() => {});
				throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });
			});
			const backend = new DbosDurableBackend({
				...sdk,
				startWorkflow: async (...args) => {
					if (mode === "refusing") throw new DbosDependencyError();
					// Model an accepted identity whose response never arrives; the pool fence
					// rejects on admission abort, but an unfenced cleanup read would hang.
					await sdk.startWorkflow(...args);
					const signal = dbosAdmissionContext.getStore();
					assert.ok(signal);
					await new Promise<never>((_, reject) => {
						signal.addEventListener("abort", () => reject(signal.reason), { once: true });
					});
				},
				listStepRecords: reads,
				retrieveWorkflow: reads,
				listAllWorkflows: reads,
			});
			setDurableBackend(backend);
			let bodyExecutions = 0;
			const definition = workflow({
				name: `public-admission-outage-${mode}`,
				description: "",
				inputs: {},
				outputs: {},
				run: async () => {
					bodyExecutions++;
					return {};
				},
			});
			const runtime = createExtensionRuntime({ definitions: [definition] });
			const tool = registeredTool(makeExecuteWorkflowTool(runtime, () => undefined));
			const ctx = {};
			let settled = false;
			const pending = tool
				.execute(mode, { action: "run", workflow: definition.normalizedName }, undefined, undefined, ctx)
				.then((result) => {
					settled = true;
					return result;
				});
			await vi.advanceTimersByTimeAsync(mode === "frozen" ? DBOS_ADMISSION_TIMEOUT_MS : 0);
			assert.ok(settled, "admission failure must settle without waiting for the 120-second request timeout");
			const result = await pending;
			assert.equal(result.details.action, "run");
			assert.equal(result.details.status, "failed");
			assert.notEqual("code" in result.details ? result.details.code : undefined, "WORKFLOW_TIMEOUT");
			const runId = "runId" in result.details ? result.details.runId : undefined;
			assert.ok(runId);
			assert.match(runId, /^[0-9a-f-]{36}$/u);
			const error = "error" in result.details ? (result.details.error ?? "") : "";
			assert.match(error, /Workflow database (admission timed out|unavailable during admission)/u);
			assert.match(error, /startup cleanup skipped/u);
			assert.ok(error.includes(runId), "cleanup diagnostic must preserve the exact identity");
			assert.match(error, /may remain without admission metadata/u);
			assert.equal(reads.mock.calls.length, 0, "no unfenced cleanup reads after unavailable admission");
			assert.equal(workflowStore.runs().find((run) => run.id === runId)?.status, "failed");
			const status = await tool.execute("inspect-outage", { action: "status", runId }, undefined, undefined, ctx);
			assert.equal(status.details.action, "statusDetail");
			assert.equal("detail" in status.details ? status.details.detail.status : undefined, "failed");
			await vi.advanceTimersByTimeAsync(WORKFLOW_TOOL_REQUEST_TIMEOUT_MS);
			assert.equal(bodyExecutions, 0);
			assert.deepEqual(sdk.state.deletions, []);
			assert.equal(sdk.state.workflows.has(runId), mode === "frozen", "existing durable identity must survive");
			assert.equal(sdk.state.steps.size, 0, "failed admission publishes no ownership metadata");
			assert.equal(vi.getTimerCount(), 0);
		});
	}

	test("unavailable admission cleanup is scoped to the failed identity until its successful re-admission", async () => {
		// #3072: an independent healthy root can admit before failed startup cleanup runs.
		const sdk = createMockSdk();
		let unavailable = true;
		const backend = new DbosDurableBackend({
			...sdk,
			startWorkflow: async (...args) => {
				if (args[0] === "failed-root" && unavailable) throw new DbosDependencyError();
				await sdk.startWorkflow(...args);
			},
		});
		const admit = (workflowId: string) =>
			backend.admitWorkflow(
				workflowId,
				{
					workflowId,
					name: workflowId,
					inputs: {},
					status: "running",
					createdAt: Date.now(),
				},
				new AbortController().signal,
			);
		await assert.rejects(admit("failed-root"), DbosDependencyError);
		await admit("healthy-root");
		assert.equal(backend.isAdmissionUnavailable("failed-root"), true, "another root cannot clear the cleanup fence");
		assert.equal(backend.isAdmissionUnavailable("healthy-root"), false, "unrelated roots retain normal cleanup");
		assert.equal(backend.isAdmissionUnavailable("unknown-root"), false);
		unavailable = false;
		await admit("failed-root");
		assert.equal(
			backend.isAdmissionUnavailable("failed-root"),
			false,
			"successful same-ID admission clears its fence",
		);
	});

	test("times out every public action once at two minutes, cancels supported work, and ignores late settlement", async () => {
		assert.equal(WORKFLOW_TOOL_REQUEST_TIMEOUT_MS, 120_000);
		vi.useFakeTimers();
		let invocationCount = 0;
		let active:
			| {
					readonly action: (typeof ALL_ACTIONS)[number];
					readonly deferred: PromiseWithResolvers<WorkflowToolResult>;
					readonly signal: AbortSignal;
			  }
			| undefined;
		const tool = registeredTool(async (args, _ctx, signal) => {
			invocationCount += 1;
			if (signal === undefined) throw new Error("workflow operation signal is required");
			const action = args.action as (typeof ALL_ACTIONS)[number];
			const deferred = Promise.withResolvers<WorkflowToolResult>();
			active = { action, deferred, signal };
			if (action === "pause") {
				signal.addEventListener("abort", () => deferred.reject(new Error("Agent process stopped")), { once: true });
			}
			return deferred.promise;
		});

		for (const [index, action] of ALL_ACTIONS.entries()) {
			let settled = false;
			const pending = tool.execute(`timeout-${action}`, { action }, undefined, undefined, {}).then((result) => {
				settled = true;
				return result;
			});
			await vi.advanceTimersByTimeAsync(0);
			assert.equal(active?.action, action);
			assert.equal(invocationCount, index + 1);

			await vi.advanceTimersByTimeAsync(WORKFLOW_TOOL_REQUEST_TIMEOUT_MS - 1);
			assert.equal(settled, false, `${action} must remain pending at ${WORKFLOW_TOOL_REQUEST_TIMEOUT_MS - 1}ms`);
			await vi.advanceTimersByTimeAsync(1);
			const result = await pending;
			assert.equal(settled, true);
			assert.equal(active?.signal.aborted, true, `${action} must abort the delegated operation`);
			assert.deepEqual(result.details, {
				action,
				status: "failed",
				code: "WORKFLOW_TIMEOUT",
				timeoutMs: WORKFLOW_TOOL_REQUEST_TIMEOUT_MS,
				error: expectedTimeoutError(action),
			});
			assert.equal(result.content.length, 1);
			assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /WORKFLOW_TIMEOUT/);
			assert.equal(invocationCount, index + 1, `${action} must not retry`);

			active?.deferred.resolve({ action: "models", models: [] });
			await vi.advanceTimersByTimeAsync(0);
			assert.equal(result.details.status, "failed", `${action} late success must be ignored`);
		}
		assert.equal(vi.getTimerCount(), 0);
	});

	test("keeps the tool usable after timeout and preserves successful acknowledgement results", async () => {
		vi.useFakeTimers();
		let mode: "hang" | "success" = "hang";
		const tool = registeredTool(async (args) => {
			if (mode === "hang") return new Promise<WorkflowToolResult>(() => {});
			if (args.action === "run") {
				return { action: "run", runId: "run-ack", status: "running", message: "started in background" };
			}
			if (args.action === "resume") {
				return { action: "resume", runId: "resume-ack", status: "running", message: "resumed in background" };
			}
			return { action: "models", models: [] };
		});

		const timedOut = tool.execute("hang", { action: "list" }, undefined, undefined, {});
		await vi.advanceTimersByTimeAsync(WORKFLOW_TOOL_REQUEST_TIMEOUT_MS);
		const timeoutDetails = (await timedOut).details;
		assert.equal("code" in timeoutDetails ? timeoutDetails.code : undefined, "WORKFLOW_TIMEOUT");

		mode = "success";
		for (const args of [{ action: "models" }, { action: "run" }, { action: "resume" }] satisfies WorkflowToolArgs[]) {
			const result = await tool.execute("success", args, undefined, undefined, {});
			assert.equal(result.details.action, args.action);
			assert.notEqual("code" in result.details ? result.details.code : undefined, "WORKFLOW_TIMEOUT");
			assert.equal(vi.getTimerCount(), 0);
		}
	});

	test("preserves caller cancellation before and during a request without relabeling it as timeout", async () => {
		vi.useFakeTimers();
		let calls = 0;
		let operationSignal: AbortSignal | undefined;
		const deferred = Promise.withResolvers<WorkflowToolResult>();
		const tool = registeredTool(async (_args, _ctx, signal) => {
			calls += 1;
			operationSignal = signal;
			return deferred.promise;
		});
		const preAborted = new AbortController();
		const preAbortReason = new Error("caller stopped before admission");
		preAborted.abort(preAbortReason);
		assert.equal(
			await rejectedError(tool.execute("pre-aborted", { action: "list" }, preAborted.signal, undefined, {})),
			preAbortReason,
		);
		assert.equal(calls, 0);

		const midFlight = new AbortController();
		const pending = tool.execute("mid-flight", { action: "pause" }, midFlight.signal, undefined, {});
		await vi.advanceTimersByTimeAsync(0);
		const midFlightReason = new Error("caller stopped mid-flight");
		midFlight.abort(midFlightReason);
		assert.equal(await rejectedError(pending), midFlightReason);
		assert.equal(operationSignal?.aborted, true);
		assert.equal(calls, 1);
		assert.equal(vi.getTimerCount(), 0);

		deferred.reject(new Error("Agent process stopped"));
		await vi.advanceTimersByTimeAsync(0);
		assert.equal(vi.getTimerCount(), 0);
	});

	test("the production executor releases an aborted resource wait and accepts the next validated command", async () => {
		const blockedLoad = Promise.withResolvers<void>();
		const runtime = createExtensionRuntime({ definitions: [] });
		const execute = makeExecuteWorkflowTool(
			runtime,
			() => undefined,
			() => blockedLoad.promise,
		);
		const controller = new AbortController();
		const pending = execute({ action: "get", workflow: "missing" }, {}, controller.signal);
		const reason = new Error("request deadline");
		controller.abort(reason);
		assert.equal(await rejectedError(pending), reason);

		const models = await execute({ action: "models" }, {});
		assert.deepEqual(models, { action: "models", models: [] });
		blockedLoad.resolve();
	});

	test("returns the exact run identity when transport acknowledgement is delayed without retrying or stopping execution", async () => {
		vi.useFakeTimers();
		const acknowledgement = Promise.withResolvers<void>();
		const releaseBody = Promise.withResolvers<void>();
		setDurableBackend(new InMemoryDurableBackend());
		const bodyEntered = Promise.withResolvers<void>();
		let bodyExecutions = 0;
		const definition = workflow({
			name: "public-timeout-delayed-acknowledgement",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				bodyExecutions += 1;
				bodyEntered.resolve();
				await releaseBody.promise;
				await ctx.tool("tracked-work", {}, async () => "done");
				return {};
			},
		});
		const runtime = createExtensionRuntime({ definitions: [definition] });
		const execute = makeExecuteWorkflowTool(runtime, () => undefined);
		let requests = 0;
		const tool = registeredTool(async (...args) => {
			if (args[0].action === "run") requests += 1;
			const result = await execute(...args);
			if (args[0].action === "run") {
				// #3072: delay transport, not the separately bounded DB admission.
				await acknowledgement.promise;
			}
			return result;
		});
		const ctx = {};

		const pending = tool.execute(
			"delayed-acknowledgement",
			{ action: "run", workflow: definition.normalizedName },
			undefined,
			undefined,
			ctx,
		);
		await vi.advanceTimersByTimeAsync(0);
		await bodyEntered.promise;
		assert.equal(bodyExecutions, 1, "durable admission must succeed before transport stalls");
		assert.equal(requests, 1);
		await vi.advanceTimersByTimeAsync(WORKFLOW_TOOL_REQUEST_TIMEOUT_MS);
		const timeout = await pending;
		assert.equal(timeout.details.action, "run");
		assert.equal(timeout.details.status, "failed", "the deadline must not report acknowledgement success");
		assert.equal("code" in timeout.details ? timeout.details.code : undefined, "WORKFLOW_TIMEOUT");
		assert.match("runId" in timeout.details ? (timeout.details.runId ?? "") : "", /^[0-9a-f-]{36}$/u);
		const runId = "runId" in timeout.details ? timeout.details.runId : undefined;
		assert.ok(runId);
		const timeoutContent = timeout.content[0]?.type === "text" ? timeout.content[0].text : "";
		assert.match(timeoutContent, new RegExp(runId, "u"), "the model-visible result must expose the exact run id");
		assert.equal(workflowStore.runs().length, 1, "one request must allocate one run");
		assert.equal(workflowStore.runs()[0]?.id, runId);

		const exactStatus = await tool.execute(
			"inspect-delayed-acknowledgement",
			{ action: "status", runId },
			undefined,
			undefined,
			ctx,
		);
		assert.equal(exactStatus.details.action, "statusDetail");
		assert.equal("runId" in exactStatus.details ? exactStatus.details.runId : undefined, runId);
		assert.equal("detail" in exactStatus.details ? exactStatus.details.detail.status : undefined, "running");
		const detachedJob = jobTracker.get(runId);
		assert.ok(detachedJob, "the timed-out request must leave the exact detached job running");

		acknowledgement.resolve();
		releaseBody.resolve();
		await detachedJob.promise;
		assert.equal(requests, 1, "the timed-out request must not retry the run");
		assert.equal(bodyExecutions, 1, "the admitted detached run must execute only once");
		assert.equal(
			workflowStore.runs()[0]?.status,
			"completed",
			"late detached execution must reach its terminal state",
		);
		assert.equal(timeout.details.status, "failed", "late execution must not rewrite the timeout result");
	});

	test("production background run acknowledgement is independent from detached execution", async () => {
		const bodyEntered = Promise.withResolvers<void>();
		const releaseBody = Promise.withResolvers<void>();
		const store = createStore();
		const definition = workflow({
			name: "public-timeout-background-ack",
			description: "",
			inputs: {},
			outputs: {},
			run: async () => {
				bodyEntered.resolve();
				await releaseBody.promise;
				return {};
			},
		});
		const runtime = createExtensionRuntime({ definitions: [definition], store });
		const execute = makeExecuteWorkflowTool(runtime, () => undefined);
		const controller = new AbortController();
		const ctx = {};
		const acknowledgement = await execute(
			{ action: "run", workflow: definition.normalizedName },
			ctx,
			controller.signal,
		);
		assert.equal(acknowledgement.action, "run");
		assert.equal("status" in acknowledgement ? acknowledgement.status : undefined, "running");
		await bodyEntered.promise;
		controller.abort(new Error("request lifetime ended after acknowledgement"));
		assert.equal(store.runs()[0]?.status, "running");
		releaseBody.resolve();
	});
});
