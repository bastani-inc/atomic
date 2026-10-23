import type { DurableWorkflowBackend } from "../durable/backend.js";
import type { ResolvedInputs, RunOpts, RunResult } from "../runs/foreground/executor-types.js";
import type { WorkflowDefinition } from "../shared/types.js";

export interface ChildWorkerDispatcher {
	validateOptions(options: RunOpts): void;
	run(definition: WorkflowDefinition, inputs: ResolvedInputs, options: RunOpts): Promise<RunResult>;
}

export const childWorkerDispatchers = new WeakMap<DurableWorkflowBackend, ChildWorkerDispatcher>();
