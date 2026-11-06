import { randomUUID } from "node:crypto";
import { resolveWorktreeSnapshotSettings, SettingsManager } from "@bastani/atomic";
import { initializeDurableBackend } from "../../durable/factory.js";
import { availableRunDurableBackend } from "../../durable/run-owner-backend.js";
import { availableStoreDurableBackendOverride, bindStoreDurableBackend } from "../../durable/store-backend.js";
import { run as engineRun } from "../../engine/run.js";
import { createAgentSessionAdapter } from "../../extension/wiring.js";
import { parseEvictWhenWaiting } from "../../shared/run-eviction.js";
import { parseReleaseWhenWaiting } from "../../shared/stage-wait.js";
import { store as defaultStore } from "../../shared/store.js";
import { currentWorkflowStore } from "../../shared/store-factory.js";
import type { WorkflowDefinition, WorkflowInputValues, WorkflowOutputValues } from "../../shared/types.js";
import { restoreWorkerOptions } from "../../workers/public-pool.js";
import { resolveWorkerTiming } from "../../workers/worker-timing.js";
import type { RunOpts, RunResult } from "./executor-types.js";
import { acquireStandaloneIntercom } from "./sdk-intercom.js";

type WorkflowRunInputArgument = Parameters<typeof engineRun>[1];

export function run<
	TInputs extends WorkflowInputValues,
	TOutputs extends WorkflowOutputValues,
	TRunInputs extends WorkflowInputValues = TInputs,
>(
	def: WorkflowDefinition<TInputs, TOutputs, TRunInputs>,
	inputs: WorkflowRunInputArgument,
	opts?: RunOpts,
): Promise<RunResult<TOutputs>>;
export async function run<TInputs extends WorkflowInputValues, TRunInputs extends WorkflowInputValues = TInputs>(
	def: WorkflowDefinition<TInputs, WorkflowOutputValues, TRunInputs>,
	inputs: WorkflowRunInputArgument,
	callerOpts: RunOpts = {},
): Promise<RunResult> {
	// The caller's local worker timing is checked before anything is opened or written for the run.
	if (callerOpts.localWorkers !== undefined) resolveWorkerTiming(callerOpts.localWorkers, "sdk");
	parseReleaseWhenWaiting(callerOpts.releaseWhenWaiting);
	parseEvictWhenWaiting(callerOpts.evictWhenWaiting);
	resolveWorktreeSnapshotSettings(callerOpts.snapshots, "sdk", "snapshots");
	const inheritedSnapshots = SettingsManager.create(callerOpts.cwd ?? process.cwd()).getWorktreeSnapshotSettings();
	let opts: RunOpts = {
		...callerOpts,
		snapshots: resolveWorktreeSnapshotSettings(callerOpts.snapshots, "sdk", "snapshots", inheritedSnapshots),
	};
	const store = opts.store === undefined || opts.store === defaultStore ? currentWorkflowStore() : opts.store;
	const sourceRunId = opts.continuation?.source.id ?? opts.runId;
	const ownedBackend = sourceRunId === undefined ? undefined : availableRunDurableBackend(store, sourceRunId);
	const preset =
		opts.journal === undefined
			? (opts.durableBackend ?? ownedBackend ?? availableStoreDurableBackendOverride(store))
			: undefined;
	const backend = preset ?? (await initializeDurableBackend({ journal: opts.journal, cwd: opts.cwd }));
	if (opts.journal === undefined && opts.durableBackend === undefined && ownedBackend === undefined) {
		bindStoreDurableBackend(store, backend);
	}
	const runId = opts.runId ?? randomUUID();
	if (sourceRunId !== undefined || opts.localWorkers || opts.admission) {
		opts = await restoreWorkerOptions(backend, { ...opts, runId });
	}
	opts = withDefaultAgentSessionAdapter(opts);
	const releaseIntercom = await acquireStandaloneIntercom(store, runId, opts.cwd ?? process.cwd());
	try {
		return await engineRun(def, inputs, { ...opts, runId, store, durableBackend: backend });
	} finally {
		await releaseIntercom();
	}
}

/** Stage sessions default to in-process Atomic SDK sessions when the caller supplies no session adapter. */
function withDefaultAgentSessionAdapter(opts: RunOpts): RunOpts {
	if (opts.localWorkers || opts.adapters?.agentSession !== undefined || opts.adapters?.prompt !== undefined)
		return opts;
	return {
		...opts,
		adapters: {
			...opts.adapters,
			agentSession: createAgentSessionAdapter(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
		},
	};
}
