import { initializeDurableBackend } from "../../durable/factory.js";
import { availableRunDurableBackend } from "../../durable/run-owner-backend.js";
import { availableStoreDurableBackend, bindStoreDurableBackend } from "../../durable/store-backend.js";
import { run as engineRun } from "../../engine/run.js";
import { createAgentSessionAdapter } from "../../extension/wiring.js";
import { store as defaultStore } from "../../shared/store.js";
import type { WorkflowDefinition, WorkflowInputValues, WorkflowOutputValues } from "../../shared/types.js";
import type { RunOpts, RunResult } from "./executor-types.js";

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
	const opts = withDefaultAgentSessionAdapter(callerOpts);
	const store = opts.store ?? defaultStore;
	const sourceRunId = opts.continuation?.source.id ?? opts.runId;
	const ownedBackend = sourceRunId === undefined ? undefined : availableRunDurableBackend(store.runs(), sourceRunId);
	const preset =
		opts.journal === undefined
			? (opts.durableBackend ?? ownedBackend ?? availableStoreDurableBackend(store))
			: undefined;
	const backend = preset ?? (await initializeDurableBackend({ journal: opts.journal, cwd: opts.cwd }));
	if (opts.journal === undefined && opts.durableBackend === undefined && ownedBackend === undefined) {
		bindStoreDurableBackend(store, backend);
	}
	return await engineRun(def, inputs, { ...opts, store, durableBackend: backend });
}

/** Stage sessions default to in-process Atomic SDK sessions when the caller supplies no session adapter. */
function withDefaultAgentSessionAdapter(opts: RunOpts): RunOpts {
	if (opts.adapters?.agentSession !== undefined || opts.adapters?.prompt !== undefined) return opts;
	return {
		...opts,
		adapters: {
			...opts.adapters,
			agentSession: createAgentSessionAdapter(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
		},
	};
}
