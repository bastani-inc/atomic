import { getDurableBackendProcessOwner } from "../../durable/backend-process-owner.js";
import { acquireDbosLease } from "../../durable/dbos-lifecycle.js";
import { initializeDurableBackend } from "../../durable/factory.js";
import { run as engineRun } from "../../engine/run.js";
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
	opts: RunOpts = {},
): Promise<RunResult> {
	if (opts.durableBackend !== undefined || getDurableBackendProcessOwner().injectedBackend !== undefined) {
		return await engineRun(def, inputs, opts);
	}
	const releaseLease = acquireDbosLease();
	try {
		await initializeDurableBackend();
		return await engineRun(def, inputs, opts);
	} finally {
		await releaseLease();
	}
}
