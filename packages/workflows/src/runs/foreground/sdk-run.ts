import { InMemoryDurableBackend } from "../../durable/backend.js";
import { getDurableBackendProcessOwner } from "../../durable/backend-process-owner.js";
import { acquireDbosLease } from "../../durable/dbos-lifecycle.js";
import { readDbosFailureDetail } from "../../durable/dbos-registration-diagnostics.js";
import { requestDbosSystemDatabaseUrl } from "../../durable/dbos-system-database-url.js";
import { initializeDurableBackend, initializeRequiredDurableBackend } from "../../durable/factory.js";
import { run as engineRun } from "../../engine/run.js";
import type { WorkflowDefinition, WorkflowInputValues, WorkflowOutputValues } from "../../shared/types.js";
import { requiresDurableExecution, WorkflowDurabilityRequiredError } from "../../shared/workflow-durability.js";
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
	const durability = opts.durability;
	if (durability?.mode === "memory") {
		return await engineRun(def, inputs, { ...opts, durableBackend: new InMemoryDurableBackend() });
	}
	if (opts.durableBackend !== undefined || getDurableBackendProcessOwner().injectedBackend !== undefined) {
		return await engineRun(def, inputs, opts);
	}
	if (durability?.systemDatabaseUrl !== undefined) requestDbosSystemDatabaseUrl(durability.systemDatabaseUrl);
	const releaseLease = acquireDbosLease();
	try {
		if (requiresDurableExecution(def, opts)) await initializeRequired(def.name);
		else await initializeDurableBackend();
		return await engineRun(def, inputs, opts);
	} finally {
		await releaseLease();
	}
}

async function initializeRequired(workflowName: string): Promise<void> {
	try {
		await initializeRequiredDurableBackend();
	} catch (error) {
		throw new WorkflowDurabilityRequiredError(
			workflowName,
			`the durable backend could not start: ${readDbosFailureDetail(error)}`,
			{ cause: error },
		);
	}
}
