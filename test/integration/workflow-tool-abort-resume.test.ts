import assert from "node:assert/strict";
import { Type } from "typebox";
import { afterEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { durableWorkflowRunSnapshots } from "../../packages/workflows/src/durable/completed-catalog.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import {
	workflowInterruptAction,
	workflowResumeAction,
} from "../../packages/workflows/src/extension/workflow-tool-control.js";
import { restoreOnSessionStart, type SessionEntry } from "../../packages/workflows/src/shared/persistence-restore.js";
import { createStore, store } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
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

test.each([
	"live",
	"restored",
	"session-mixed",
	"session-tools",
	"session-corrupt-parent",
	"session-missing-checkpoint",
	"dbos",
	"dbos-session",
	"dbos-direct",
	"legacy",
	"legacy-missing",
	"changed-args",
] as const)(
	"public resume replays completed work from live, lifecycle-restored, or durable state and rejects unsafe frontiers (%s)",
	async (mode) => {
		const sdk = createMockSdk();
		let backend = mode.startsWith("dbos") ? new DbosDurableBackend(sdk) : new InMemoryDurableBackend();
		setDurableBackend(backend);
		let completedCalls = 0;
		let modelCalls = 0;
		let waitCalls = 0;
		let changedArgs = false;
		const definition = workflow({
			name: "tool-abort-resume",
			description: "bounded release-shaped fixture, no release actions",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				await ctx.tool("prepare", { raw: "  unchanged\n", items: ["a", "a"] }, async () => {
					completedCalls++;
					return "prepared";
				});
				if (mode !== "session-tools") await ctx.stage("completed-model").prompt("completed-model");
				const result = await ctx.tool("wait-required-ci", { changed: changedArgs }, async ({ signal }) => {
					waitCalls++;
					if (waitCalls > 1) return "ready";
					await new Promise<void>((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(signal.reason), { once: true });
					});
					return "unexpected";
				});
				return { result };
			},
		});
		const entries: SessionEntry[] = [];
		const runtime = createExtensionRuntime({
			store,
			registry: createRegistry([definition]),
			adapters: {
				prompt: {
					prompt: async (text) => {
						modelCalls++;
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
		assert.equal(started.action, "run");
		assert.ok("runId" in started);
		const runId = started.runId;
		await waitFor(() => waitCalls === 1);
		const interrupted = await workflowInterruptAction({ action: "interrupt", runId, stageId: "wait-required-ci" });
		assert.ok(interrupted.action === "interrupt");
		assert.equal(interrupted.status, "cancelled");
		await waitFor(() => store.runs().some((run) => run.id === runId && run.endedAt !== undefined));
		const source = store.runs().find((run) => run.id === runId)!;
		assert.equal(source.status, "failed");
		const restoredSessionStore = createStore();
		restoreOnSessionStart(
			{ getEntries: () => entries },
			{ resumeInFlight: "never", persistRuns: true },
			restoredSessionStore,
		);
		assert.equal(restoredSessionStore.runs()[0]?.toolNodes?.[0]?.status, "cancelled");
		await backend.flush(runId);
		if (mode.startsWith("dbos")) {
			backend = new DbosDurableBackend(sdk);
			await backend.hydrateWorkflow(runId);
			setDurableBackend(backend);
		}
		if (mode === "legacy-missing" || mode === "legacy") {
			const old = backend;
			backend = new InMemoryDurableBackend();
			backend.registerWorkflow({ ...old.getWorkflow(runId)!, failedToolNodeId: undefined });
			for (const checkpoint of old.listCheckpoints(runId)) {
				if (checkpoint.kind === "tool" && checkpoint.throwingFailureError !== undefined) {
					if (mode === "legacy-missing") continue;
					const inspection = { ...checkpoint };
					delete inspection.cancelled;
					backend.recordCheckpoint(inspection);
				} else backend.recordCheckpoint(checkpoint);
			}
			setDurableBackend(backend);
		}
		if (mode.includes("session")) {
			store.clear();
			restoreOnSessionStart({ getEntries: () => entries }, { resumeInFlight: "never", persistRuns: true }, store);
			assert.equal(store.runs()[0]?.toolNodes?.length, 1, "resume the actual sparse lifecycle snapshot");
			if (mode === "session-corrupt-parent") {
				const restored = store.runs()[0]!;
				const frontier = restored.toolNodes![0]!;
				store.clear();
				store.recordRunStart({ ...restored, toolNodes: [{ ...frontier, parentIds: [frontier.id] }] });
			}
			if (mode === "session-missing-checkpoint") {
				const retained = backend;
				backend = new InMemoryDurableBackend();
				backend.registerWorkflow(retained.getWorkflow(runId)!);
				for (const checkpoint of retained.listCheckpoints(runId)) {
					if (checkpoint.kind === "tool" && checkpoint.name === "prepare") continue;
					backend.recordCheckpoint(checkpoint);
				}
				setDurableBackend(backend);
			}
		} else if (mode !== "live") {
			const snapshots = durableWorkflowRunSnapshots(backend, backend.getWorkflow(runId)!);
			assert.equal(
				snapshots[0]?.toolNodes?.length,
				(source.toolNodes?.length ?? 0) - (mode === "legacy-missing" ? 1 : 0),
				"persist the cancelled frontier as well as completed tools",
			);
			if (mode !== "legacy-missing")
				assert.equal(
					snapshots[0]?.toolNodes?.find((node) => node.name === "wait-required-ci")?.status,
					mode === "legacy" ? "failed" : "cancelled",
				);
			store.clear();
			for (const snapshot of snapshots) {
				if (mode === "legacy") delete snapshot.failedToolNodeId;
				if (mode !== "dbos-direct") store.recordRunStart(snapshot);
			}
		}
		changedArgs = mode === "changed-args";
		const resumed = await workflowResumeAction(
			{ action: "resume", runId },
			{
				getRuntime: () => runtime,
				policy: INTERACTIVE_WORKFLOW_POLICY,
				ensureWorkflowResourcesLoaded: async () => {},
			},
		);
		assert.ok(resumed.action === "resume");
		if (mode === "session-corrupt-parent" || mode === "session-missing-checkpoint") {
			assert.equal(resumed.status, "noop");
			assert.match(resumed.message ?? "", /insufficient_state/);
			assert.deepEqual([completedCalls, modelCalls, waitCalls], [1, 1, 1]);
			assert.equal(store.runs().length, 1);
			assert.equal(backend.getWorkflow(runId)?.status, "failed");
			return;
		}
		if (mode === "legacy-missing") {
			assert.equal(resumed.status, "noop");
			assert.match(resumed.message ?? "", /insufficient_state/);
			assert.deepEqual([completedCalls, modelCalls, waitCalls], [1, 1, 1]);
			let recoveryCalls = 0;
			const recovery = workflow({
				name: "explicit-recovery-only",
				description: "operator-reviewed remaining read-only operation",
				inputs: { reviewed: Type.String() },
				outputs: { value: Type.String() },
				run: async (ctx) => ({
					value: await ctx.tool("remaining-check", { reviewed: ctx.inputs.reviewed }, async () => {
						recoveryCalls++;
						return ctx.inputs.reviewed;
					}),
				}),
			});
			const recoveryRuntime = createExtensionRuntime({ store, registry: createRegistry().register(recovery) });
			const fresh = await recoveryRuntime.dispatch({
				action: "run",
				workflow: recovery.name,
				inputs: { reviewed: "verified external state" },
			});
			assert.ok(fresh.action === "run");
			await waitFor(() => store.runs().some((run) => run.id === fresh.runId && run.endedAt !== undefined));
			assert.equal(store.runs().find((run) => run.id === fresh.runId)?.status, "completed");
			assert.equal(recoveryCalls, 1);
			assert.deepEqual([completedCalls, modelCalls, waitCalls], [1, 1, 1]);
			assert.equal(backend.getWorkflow(runId)?.status, "failed");
			return;
		}
		assert.equal(resumed.status, "running", resumed.message);
		await waitFor(() =>
			store
				.runs()
				.some(
					(run) =>
						(run.resumedFromRunId === runId || (mode === "dbos-direct" && run.id === runId)) &&
						run.endedAt !== undefined,
				),
		);
		const continuation = store
			.runs()
			.find((run) => run.resumedFromRunId === runId || (mode === "dbos-direct" && run.id === runId))!;
		if (mode === "changed-args") {
			assert.equal(continuation.status, "failed");
			assert.match(continuation.error ?? "", /insufficient_state/);
			assert.deepEqual([completedCalls, modelCalls, waitCalls], [1, 1, 1]);
			return;
		}
		assert.equal(continuation.status, "completed", continuation.error);
		assert.equal(completedCalls, 1);
		assert.equal(modelCalls, mode === "session-tools" ? 0 : 1);
		assert.equal(waitCalls, 2);
		assert.equal(source.failedStageId, undefined);
		assert.equal(source.failedToolNodeId, source.toolNodes?.find((node) => node.name === "wait-required-ci")?.id);
		assert.equal(continuation.toolNodes?.[0]?.replayed, true);
		if (mode === "session-tools") {
			assert.deepEqual(continuation.stages, []);
			assert.deepEqual(continuation.toolNodes?.[1]?.parentIds, [continuation.toolNodes?.[0]?.id]);
		} else {
			assert.deepEqual(continuation.stages[0]?.parentIds, [continuation.toolNodes?.[0]?.id]);
			assert.deepEqual(continuation.toolNodes?.[1]?.parentIds, [continuation.stages[0]?.id]);
			assert.equal(continuation.stages[0]?.replayed, true);
		}
		const reconstructed = durableWorkflowRunSnapshots(backend, backend.getWorkflow(continuation.id)!)[0];
		assert.ok(reconstructed);
		assert.deepEqual(
			reconstructed.toolNodes?.map((node) => [node.id, node.parentIds]),
			continuation.toolNodes?.map((node) => [node.id, node.parentIds]),
		);
		assert.deepEqual(
			continuation.toolNodes?.map((node) => [node.id, node.argsHash, node.ordinal]),
			source.toolNodes?.map((node) => [node.id, node.argsHash, node.ordinal]),
		);
	},
);

test.each(["missing-parent", "cycle", "ambiguous", "completed", "missing", "unrecorded"] as const)(
	"public tool resume rejects %s frontier before dispatch",
	async (corruption) => {
		let calls = 0;
		const definition = workflow({
			name: "corrupt-tool-frontier",
			description: "",
			inputs: {},
			outputs: { done: Type.Boolean() },
			run: async (ctx) => {
				await ctx.tool("wait", {}, async () => {
					calls++;
					return true;
				});
				return { done: true };
			},
		});
		let source: RunSnapshot = {
			id: "d5169bc8-336c-4019-9bb4-93b208469bc7",
			name: definition.name,
			inputs: {},
			status: "failed",
			stages: [],
			startedAt: 1,
			endedAt: 3,
			failedToolNodeId: "tool:missing",
			resumable: true,
			error: "atomic-workflows: ctx.tool wait aborted by node abort",
			toolNodes: [
				{
					kind: "tool",
					id: "tool:missing",
					name: "wait",
					argsHash: "missing",
					ordinal: 1,
					parentIds: ["lost-completed-tool"],
					status: "cancelled",
					error: "atomic-workflows: ctx.tool wait aborted by node abort",
					attachable: false,
				},
			],
		};
		const frontier = source.toolNodes![0]!;
		if (corruption === "cycle") source = { ...source, toolNodes: [{ ...frontier, parentIds: [frontier.id] }] };
		if (corruption === "ambiguous") {
			delete source.failedToolNodeId;
			source = { ...source, toolNodes: [frontier, { ...frontier, id: "tool:other", argsHash: "other" }] };
		}
		if (corruption === "completed") source = { ...source, toolNodes: [{ ...frontier, status: "completed" }] };
		if (corruption === "missing") source = { ...source, toolNodes: [] };
		if (corruption === "unrecorded") {
			delete source.failedToolNodeId;
			source = { ...source, toolNodes: [{ ...frontier, parentIds: [] }] };
		}
		const backend = new InMemoryDurableBackend();
		backend.registerWorkflow({
			workflowId: source.id,
			name: source.name,
			inputs: {},
			createdAt: 1,
			status: "failed",
		});
		setDurableBackend(backend);
		store.recordRunStart(source);
		const runtime = createExtensionRuntime({ store, registry: createRegistry([definition]) });
		const resumed = await runtime.resumeFailedRun(source.id);
		assert.equal(resumed.ok, false, JSON.stringify(resumed));
		assert.equal(calls, 0);
		assert.equal(store.runs().length, 1);
	},
);

test("tool-only return-mode resume preserves repeated-call ordinals and never replays cancellation as data", async () => {
	const backend = new InMemoryDurableBackend();
	setDurableBackend(backend);
	let calls = 0;
	const args = { raw: "  untouched\n", items: ["b", "a", "b"] };
	const definition = workflow({
		name: "repeated-return-tool",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			for (let index = 0; index < 2; index++) {
				const outcome = await ctx.tool(
					"repeat",
					args,
					async ({ signal }) => {
						calls++;
						if (calls === 2)
							await new Promise<void>((_resolve, reject) =>
								signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
							);
						return args.raw;
					},
					{ failureMode: "return", timeoutMs: TEST_TIMEOUT_MS / 2 },
				);
				assert.equal(outcome.ok, true);
				if (outcome.ok) assert.equal(outcome.value, args.raw);
			}
			return {};
		},
	});
	const runtime = createExtensionRuntime({ store, registry: createRegistry([definition]) });
	const started = await runtime.dispatch({ action: "run", workflow: definition.name, inputs: {} });
	assert.ok(started.action === "run");
	await waitFor(() => calls === 2);
	const source = store.runs().find((run) => run.id === started.runId)!;
	const target = source.toolNodes?.[1];
	assert.ok(target);
	await workflowInterruptAction({ action: "interrupt", runId: source.id, stageId: target.id });
	await waitFor(() => source.endedAt !== undefined);
	assert.deepEqual(source.stages, []);
	assert.equal(backend.getToolCheckpoint(source.id, target.argsHash), undefined);
	const inspection = backend
		.listCheckpoints(source.id)
		.find((entry) => entry.kind === "tool" && entry.argsHash === target.argsHash);
	assert.ok(inspection?.kind === "tool");
	assert.equal(inspection.cancelled, true);
	assert.equal(inspection.outcomeKind, undefined);
	const resumed = await runtime.resumeFailedRun(source.id);
	assert.ok(resumed.ok, resumed.message);
	assert.equal(resumed.resumeFromStageId, undefined);
	assert.equal(resumed.resumeFromToolNodeId, target.id);
	await waitFor(() => store.runs().some((run) => run.id === resumed.runId && run.endedAt !== undefined));
	const continuation = store.runs().find((run) => run.id === resumed.runId)!;
	assert.equal(continuation.status, "completed", continuation.error);
	assert.equal(calls, 3);
	assert.deepEqual(
		continuation.toolNodes?.map((node) => [node.id, node.argsHash, node.ordinal, node.args, node.parentIds]),
		source.toolNodes?.map((node) => [node.id, node.argsHash, node.ordinal, node.args, node.parentIds]),
	);
	assert.deepEqual(
		continuation.toolNodes?.map((node) => node.status),
		["cached", "completed"],
	);
});

test("fresh DBOS rejects a cyclic persisted tool frontier without executing callbacks", async () => {
	const sdk = createMockSdk();
	const writer = new DbosDurableBackend(sdk);
	const workflowId = "78607844-1088-4e90-83ac-ce1b957689ed";
	writer.registerWorkflow({
		workflowId,
		name: "cyclic-tool",
		inputs: {},
		createdAt: 1,
		status: "failed",
		failedToolNodeId: "tool:bad",
		resumable: true,
	});
	writer.recordCheckpoint({
		kind: "tool",
		workflowId,
		checkpointId: "tool-failure:bad:1",
		name: "wait",
		argsHash: "bad",
		output: null,
		cancelled: true,
		throwingFailureError: "aborted",
		completedAt: 3,
		topology: {
			version: 1,
			nodeId: "tool:bad",
			ordinal: 1,
			order: 1,
			parentIds: ["tool:bad"],
			startedAt: 2,
			endedAt: 3,
			run: { runId: workflowId, runName: "cyclic-tool" },
		},
	});
	await writer.flush(workflowId);
	const fresh = new DbosDurableBackend(sdk);
	await fresh.hydrateWorkflow(workflowId);
	setDurableBackend(fresh);
	assert.deepEqual(durableWorkflowRunSnapshots(fresh, fresh.getWorkflow(workflowId)!), []);
	let calls = 0;
	const definition = workflow({
		name: "cyclic-tool",
		description: "",
		inputs: {},
		outputs: {},
		run: async () => {
			calls++;
			return {};
		},
	});
	const runtime = createExtensionRuntime({ store, registry: createRegistry([definition]) });
	const resumed = await runtime.resumeDurableWorkflow(workflowId);
	assert.equal(resumed.ok, false);
	assert.match(resumed.message, /insufficient_state/);
	assert.equal(calls, 0);
	assert.equal(fresh.getWorkflow(workflowId)?.status, "failed");
});

test.each(
	["wait", "wait\nfor-ci", "wait\rfor-ci", "wait\u2028for-ci", "wait\u2029for-ci"].flatMap((name) =>
		[false, true].map((typed) => ({ name, typed })),
	),
)("public durable resume requires typed legacy evidence for name=$name, typed=$typed", async ({ name, typed }) => {
	const sdk = createMockSdk();
	const original = new DbosDurableBackend(sdk);
	setDurableBackend(original);
	let completedCalls = 0;
	let targetCalls = 0;
	const definition = workflow({
		name: "legacy-tool-name",
		description: "offline legacy name fixture",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.tool("prepare", {}, async () => {
				completedCalls++;
				return null;
			});
			await ctx.tool(name, {}, async ({ signal }) => {
				targetCalls++;
				if (targetCalls === 1)
					await new Promise<void>((_resolve, reject) =>
						signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
					);
				return true;
			});
			return {};
		},
	});
	const runtime = createExtensionRuntime({ store, registry: createRegistry([definition]) });
	const started = await runtime.dispatch({ action: "run", workflow: definition.name, inputs: {} });
	assert.ok(started.action === "run");
	await waitFor(() => targetCalls === 1);
	const source = store.runs().find((run) => run.id === started.runId)!;
	const target = source.toolNodes![1]!;
	await workflowInterruptAction({ action: "interrupt", runId: source.id, stageId: target.id });
	await waitFor(() => source.endedAt !== undefined);
	await original.flush(source.id);
	const legacySdk = createMockSdk();
	const writer = new DbosDurableBackend(legacySdk);
	writer.registerWorkflow({ ...original.getWorkflow(source.id)!, failedToolNodeId: undefined });
	for (const checkpoint of original.listCheckpoints(source.id)) {
		if (checkpoint.kind === "tool" && checkpoint.throwingFailureError !== undefined) {
			if (!typed) continue;
			const legacy = { ...checkpoint };
			delete legacy.cancelled;
			writer.recordCheckpoint(legacy);
			continue;
		}
		writer.recordCheckpoint(checkpoint);
	}
	await writer.flush(source.id);
	const backend = new DbosDurableBackend(legacySdk);
	await backend.hydrateWorkflow(source.id);
	setDurableBackend(backend);
	store.clear();
	const resumed = await workflowResumeAction(
		{ action: "resume", runId: source.id },
		{
			getRuntime: () => runtime,
			policy: INTERACTIVE_WORKFLOW_POLICY,
			ensureWorkflowResourcesLoaded: async () => {},
		},
	);
	assert.ok(resumed.action === "resume");
	if (!typed) {
		assert.equal(resumed.status, "noop");
		assert.match(resumed.message ?? "", /insufficient_state/);
		assert.deepEqual([completedCalls, targetCalls], [1, 1]);
		assert.equal(backend.getWorkflow(source.id)?.status, "failed");
		return;
	}
	assert.equal(resumed.status, "running", resumed.message);
	await waitFor(() => store.runs().some((run) => run.id === source.id && run.endedAt !== undefined));
	const continuation = store.runs().find((run) => run.id === source.id)!;
	assert.equal(continuation.status, "completed", continuation.error);
	assert.deepEqual([completedCalls, targetCalls], [1, 2]);
	assert.equal(continuation.failedStageId, undefined);
	const retried = continuation.toolNodes?.find((node) => node.name === name);
	assert.ok(retried, "tool name is preserved verbatim");
	assert.deepEqual(
		[retried.name, retried.id, retried.argsHash, retried.ordinal, retried.parentIds],
		[target.name, target.id, target.argsHash, target.ordinal, target.parentIds],
	);
});
