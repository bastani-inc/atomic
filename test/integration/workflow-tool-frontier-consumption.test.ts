import assert from "node:assert/strict";
import { Type } from "typebox";
import { afterEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import {
	workflowInterruptAction,
	workflowQuitAction,
	workflowResumeAction,
} from "../../packages/workflows/src/extension/workflow-tool-control.js";
import { killRun } from "../../packages/workflows/src/runs/background/status.js";
import { restoreOnSessionStart, type SessionEntry } from "../../packages/workflows/src/shared/persistence-restore.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import { INTERACTIVE_WORKFLOW_POLICY } from "../../packages/workflows/src/shared/types.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { sleep } from "../helpers/runtime.js";
import { TEST_TIMEOUT_MS } from "../helpers/test-timeout.js";
import { createMockSdk } from "../unit/durable-dbos-backend-helpers.js";

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + TEST_TIMEOUT_MS / 2;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, "workflow did not reach expected state");
		await sleep(10);
	}
}

afterEach(() => {
	store.clear();
	setDurableBackend(undefined);
});

// PR #2864 discussion_r3939119993: replay is not proof that the unfinished call was reached.
test.each(
	[
		"return",
		"completed",
		"durable-return",
		"durable-completed",
		"default-exit",
		"caught-exit",
		"replacement",
		"replacement-model",
		"replacement-child",
		"durable-replacement-model",
		"durable-replacement-child",
		"budget-replacement-child",
		"replacement-task",
		"replacement-chain",
		"replacement-parallel",
		"replacement-stage-worktree",
		"replacement-task-worktree",
		"cached-child",
		"cached-task",
		"failed",
		"blocked",
		"cancelled",
		"skipped",
		"returned-failed",
		"returned-blocked",
		"kill",
		"caught-cancel",
		"quit",
	].flatMap((ending) => [false, true].map((mixed) => ({ ending, mixed }))),
)(
	"public restored resume enforces its frontier without overriding terminal control ($ending, mixed=$mixed)",
	async ({ ending, mixed }) => {
		const sdk = createMockSdk();
		let backend = new DbosDurableBackend(sdk);
		setDurableBackend(backend);
		let completedCalls = 0;
		let modelCalls = 0;
		let targetCalls = 0;
		let replacementCalls = 0;
		let completedChildCalls = 0;
		let completedTaskCalls = 0;
		const child = workflow({
			name: "completed-child",
			description: "replay a completed child before the frontier",
			inputs: {},
			outputs: {},
			run: async (childCtx) => {
				completedChildCalls++;
				await childCtx.tool("child-effect", {}, async () => true);
				return {};
			},
		});
		let omitTarget = false;
		const beforeKill = Promise.withResolvers<void>();
		let awaitingKill = false;
		const definition = workflow({
			name: "frontier-consumption",
			description: "offline frontier consumption regression",
			inputs: {},
			outputs: { status: Type.Optional(Type.String()) },
			...(ending.startsWith("budget-") ? { budget: { maxDurationMs: 60_000 } } : {}),
			run: async (ctx) => {
				await Promise.all(
					["sibling-a", "sibling-b"].map((name) =>
						ctx.tool(name, { raw: "  unchanged\n", items: ["b", "a", "b"] }, async () => {
							completedCalls++;
							return name;
						}),
					),
				);
				if (mixed) await ctx.stage("completed-model").prompt("completed-model");
				if (ending === "cached-child") await ctx.workflow(child);
				if (ending === "cached-task") await ctx.task("completed-task", { prompt: "completed-task" });
				if (omitTarget && ending === "kill") {
					awaitingKill = true;
					await beforeKill.promise;
					return {};
				}
				if (omitTarget && ending !== "caught-cancel" && ending !== "quit") {
					if (ending === "completed" || ending === "durable-completed") return ctx.exit({ status: "completed" });
					if (ending === "default-exit") return ctx.exit();
					if (ending === "caught-exit") {
						try {
							ctx.exit({ status: "completed" });
						} catch {
							return {};
						}
					}
					if (ending === "failed" || ending === "blocked" || ending === "cancelled" || ending === "skipped")
						return ctx.exit({ status: ending, reason: "  deliberate\n" });
					if (ending === "returned-failed") return { status: "failed" };
					if (ending === "returned-blocked") return { status: "blocked" };
					if (ending.endsWith("replacement-child"))
						await ctx.workflow(
							workflow({
								name: "replacement-child",
								description: "must not execute before the tool frontier",
								inputs: {},
								outputs: {},
								run: async (childCtx) => {
									await childCtx.tool("replacement-effect", {}, async () => {
										replacementCalls++;
										return true;
									});
									return {};
								},
							}),
						);
					if (ending === "replacement-stage-worktree")
						await ctx.stage("replacement-worktree", { gitWorktreeDir: ctx.cwd }).prompt("replacement");
					if (ending === "replacement-task-worktree")
						await ctx.task("replacement-worktree", {
							prompt: "replacement",
							worktree: true,
							gitWorktreeDir: ctx.cwd,
						});
					if (ending.endsWith("replacement-model")) await ctx.stage("replacement-model").prompt("replacement");
					if (ending === "replacement-task") await ctx.task("replacement-task", { prompt: "replacement" });
					if (ending === "replacement-chain")
						await ctx.chain([{ name: "replacement-chain", prompt: "replacement" }]);
					if (ending === "replacement-parallel")
						await ctx.parallel([{ name: "replacement-parallel", prompt: "replacement" }]);
					if (ending === "replacement")
						await ctx.tool("replacement", {}, async () => {
							replacementCalls++;
							return true;
						});
					return {};
				}
				try {
					await ctx.tool("unfinished\ntarget", {}, async ({ signal }) => {
						targetCalls++;
						if (targetCalls === 1 || ending === "caught-cancel" || ending === "quit")
							await new Promise<void>((_resolve, reject) =>
								signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
							);
						return "ready";
					});
				} catch (error) {
					if (!omitTarget || (ending !== "caught-cancel" && ending !== "quit")) throw error;
				}
				if (ending === "completed") return ctx.exit({ status: "completed" });
				return {};
			},
		});
		const entries: SessionEntry[] = [];
		const runtime = createExtensionRuntime({
			store,
			registry: createRegistry([definition]),
			adapters: {
				prompt: {
					prompt: async (text) => {
						if (text === "completed-task") completedTaskCalls++;
						else modelCalls++;
						return text;
					},
				},
			},
			persistence: {
				appendEntry: (type, payload) => {
					entries.push({
						id: String(entries.length),
						type,
						payload: structuredClone(payload) as NonNullable<SessionEntry["payload"]>,
					});
				},
			},
		});
		const started = await runtime.dispatch({ action: "run", workflow: definition.name, inputs: {} });
		assert.ok(started.action === "run");
		await waitFor(() => targetCalls === 1);
		const source = store.runs().find((run) => run.id === started.runId)!;
		const target = source.toolNodes!.find((node) => node.name === "unfinished\ntarget")!;
		await workflowInterruptAction({ action: "interrupt", runId: source.id, stageId: target.id });
		await waitFor(() => source.endedAt !== undefined);
		assert.equal(source.status, "failed");
		assert.equal(source.failedToolNodeId, target.id);
		await backend.flush(source.id);
		backend = new DbosDurableBackend(sdk);
		await backend.hydrateWorkflow(source.id);
		setDurableBackend(backend);
		store.clear();
		const durableOnly = ending.startsWith("durable-");
		if (!durableOnly) {
			restoreOnSessionStart({ getEntries: () => entries }, { resumeInFlight: "never", persistRuns: true }, store);
			assert.equal(store.runs()[0]?.toolNodes?.length, 1, "restore actual sparse lifecycle entries");
		}
		omitTarget = true;
		const resumed = await workflowResumeAction(
			{ action: "resume", runId: source.id },
			{
				getRuntime: () => runtime,
				policy: INTERACTIVE_WORKFLOW_POLICY,
				ensureWorkflowResourcesLoaded: async () => {},
			},
		);
		assert.ok(resumed.action === "resume");
		assert.equal(resumed.status, "running", resumed.message);
		if (ending === "kill") {
			await waitFor(() => awaitingKill);
			const pending = store.runs().find((run) => run.resumedFromRunId === source.id)!;
			assert.equal(killRun(pending.id, { store }).ok, true);
			beforeKill.resolve();
		} else if (ending === "caught-cancel" || ending === "quit") {
			await waitFor(() => targetCalls === 2);
			const pending = store.runs().find((run) => run.resumedFromRunId === source.id)!;
			if (ending === "quit") {
				await workflowQuitAction({ action: "quit", runId: pending.id });
				assert.equal(pending.status, "paused");
				assert.equal(pending.resumable, true);
				assert.equal(backend.getWorkflow(pending.id)?.status, "paused");
				assert.deepEqual([completedCalls, modelCalls, targetCalls], [2, mixed ? 1 : 0, 2]);
				return;
			}
			await workflowInterruptAction({ action: "interrupt", runId: pending.id, stageId: target.id });
		}
		const isContinuation = (run: { id: string; resumedFromRunId?: string }): boolean =>
			durableOnly ? run.id === source.id : run.resumedFromRunId === source.id;
		await waitFor(() => store.runs().some((run) => isContinuation(run) && run.endedAt !== undefined));
		const continuation = store.runs().find(isContinuation)!;
		if (ending === "kill" || ending === "caught-cancel") {
			assert.equal(continuation.status, ending === "kill" ? "killed" : "completed");
			assert.doesNotMatch(continuation.error ?? "", /replay topology mismatch/);
			assert.deepEqual([completedCalls, modelCalls, targetCalls], [2, mixed ? 1 : 0, ending === "kill" ? 1 : 2]);
			return;
		}
		assert.deepEqual([completedCalls, modelCalls, targetCalls, replacementCalls], [2, mixed ? 1 : 0, 1, 0]);
		if (ending === "failed" || ending === "blocked" || ending === "cancelled" || ending === "skipped") {
			assert.equal(continuation.status, ending);
			assert.equal(continuation.exited, true);
			assert.equal(continuation.exitReason, "  deliberate\n");
			assert.equal(continuation.error, undefined);
			// The backend has no skipped state; the public exit remains an intentional no-op.
			assert.equal(backend.getWorkflow(continuation.id)?.status, ending === "skipped" ? "completed" : ending);
			return;
		}
		if (ending === "returned-failed" || ending === "returned-blocked") {
			assert.equal(continuation.status, ending === "returned-failed" ? "failed" : "blocked");
			assert.doesNotMatch(continuation.error ?? "", /replay topology mismatch/);
			return;
		}
		assert.equal(continuation.status, "failed", continuation.error ?? "pending frontier must not succeed");
		assert.match(continuation.error ?? "", /insufficient_state: replay topology mismatch/);
		assert.ok(continuation.error?.includes(target.id), "diagnostic names the exact unconsumed frontier");
		assert.deepEqual([completedCalls, modelCalls, targetCalls], [2, mixed ? 1 : 0, 1]);
		assert.equal(backend.getWorkflow(continuation.id)?.status, "failed");
		assert.equal(backend.getToolCheckpoint(continuation.id, target.argsHash), undefined);
		assert.equal(continuation.result, undefined);
		assert.equal(continuation.exited, undefined);
		assert.equal(
			entries.some(
				(entry) =>
					entry.type === "workflow.run.end" &&
					entry.payload?.runId === continuation.id &&
					entry.payload?.status === "completed",
			),
			false,
		);
		if (durableOnly) {
			const retained = backend
				.listCheckpoints(source.id)
				.find((checkpoint) => checkpoint.kind === "tool" && checkpoint.argsHash === target.argsHash);
			assert.ok(retained?.kind === "tool");
			assert.equal(retained.cancelled, true);
			assert.equal(retained.topology?.nodeId, target.id);
			return;
		}

		// A rejected continuation must not consume or destroy the source's recovery evidence.
		omitTarget = false;
		const retried = await runtime.resumeFailedRun(source.id);
		assert.ok(retried.ok, retried.message);
		await waitFor(() => store.runs().some((run) => run.id === retried.runId && run.endedAt !== undefined));
		assert.equal(store.runs().find((run) => run.id === retried.runId)?.status, "completed");
		assert.equal(completedChildCalls, ending === "cached-child" ? 1 : 0);
		assert.equal(completedTaskCalls, ending === "cached-task" ? 1 : 0);
		assert.deepEqual([completedCalls, modelCalls, targetCalls], [2, mixed ? 1 : 0, 2]);
	},
);
