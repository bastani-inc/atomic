import type { DurableWorkflowBackend } from "../durable/backend.js";
import type { PoolControl } from "../durable/journal/sql-pool-queue.js";
import type { PoolUsage } from "../durable/journal/sql-pool-usage.js";
import type { ResolvedInputs, RunOpts, RunResult } from "../runs/foreground/executor-types.js";
import type { Store } from "../shared/store.js";
import type { WorkflowDefinition } from "../shared/types.js";

export interface ChildWorkerDispatcher {
	validateOptions(options: RunOpts): void;
	prepare?(root: string, store?: Store): Promise<void>;
	control?(state: PoolControl["state"]): Promise<void>;
	usage?(): PoolUsage | undefined;
	run(definition: WorkflowDefinition, inputs: ResolvedInputs, options: RunOpts): Promise<RunResult>;
}

export const childWorkerDispatchers = new WeakMap<DurableWorkflowBackend, ChildWorkerDispatcher>();
