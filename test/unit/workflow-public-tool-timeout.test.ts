import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
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

const READ_ONLY_ACTIONS = ["models", "list", "get", "inputs", "status", "stages", "stage", "transcript"] as const;
const MUTATING_ACTIONS = ["reload", "run", "send", "pause", "resume", "interrupt", "quit"] as const;
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
			if (action === "interrupt") {
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
		const pending = tool.execute("mid-flight", { action: "interrupt" }, midFlight.signal, undefined, {});
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

	test("returns the exact delayed run identity without retrying or stopping late execution", async () => {
		vi.useFakeTimers();
		const admission = Promise.withResolvers<void>();
		class DelayedAdmissionBackend extends InMemoryDurableBackend {
			override async flush(): Promise<void> {
				await admission.promise;
			}
		}
		setDurableBackend(new DelayedAdmissionBackend());
		const bodyEntered = Promise.withResolvers<void>();
		let bodyExecutions = 0;
		const definition = workflow({
			name: "public-timeout-delayed-admission",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				bodyExecutions += 1;
				bodyEntered.resolve();
				await ctx.tool("tracked-work", {}, async () => "done");
				return {};
			},
		});
		const runtime = createExtensionRuntime({ definitions: [definition] });
		const tool = registeredTool(makeExecuteWorkflowTool(runtime, () => undefined));

		const pending = tool.execute(
			"delayed-admission",
			{ action: "run", workflow: definition.name },
			undefined,
			undefined,
			{},
		);
		await vi.advanceTimersByTimeAsync(0);
		assert.equal(bodyExecutions, 0, "workflow code must remain behind startup admission");
		await vi.advanceTimersByTimeAsync(WORKFLOW_TOOL_REQUEST_TIMEOUT_MS);
		const timeout = await pending;
		assert.equal(timeout.details.action, "run");
		assert.equal(timeout.details.status, "failed", "the deadline must not report startup success");
		assert.equal("code" in timeout.details ? timeout.details.code : undefined, "WORKFLOW_TIMEOUT");
		assert.match("runId" in timeout.details ? (timeout.details.runId ?? "") : "", /^[0-9a-f-]{36}$/u);
		const runId = "runId" in timeout.details ? timeout.details.runId : undefined;
		assert.ok(runId);
		const timeoutContent = timeout.content[0]?.type === "text" ? timeout.content[0].text : "";
		assert.match(timeoutContent, new RegExp(runId, "u"), "the model-visible result must expose the exact run id");
		assert.equal(workflowStore.runs().length, 1, "one request must allocate one run");
		assert.equal(workflowStore.runs()[0]?.id, runId);

		const exactStatus = await tool.execute(
			"inspect-delayed-admission",
			{ action: "status", runId },
			undefined,
			undefined,
			{},
		);
		assert.equal(exactStatus.details.action, "statusDetail");
		assert.equal("runId" in exactStatus.details ? exactStatus.details.runId : undefined, runId);
		assert.equal("detail" in exactStatus.details ? exactStatus.details.detail.status : undefined, "running");
		const detachedJob = jobTracker.get(runId);
		assert.ok(detachedJob, "the timed-out request must leave the exact detached job running");

		admission.resolve();
		await detachedJob.promise;
		await bodyEntered.promise;
		assert.equal(bodyExecutions, 1, "the admitted detached run must execute once after the timed-out request");
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
		const acknowledgement = await execute(
			{ action: "run", workflow: "public-timeout-background-ack" },
			{},
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
