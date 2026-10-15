import type { WorkflowRegistrationInput } from "../durable/backend.js";
import type { ResolvedInputs } from "../runs/foreground/executor-types.js";
import type { WorkflowSerializableValue } from "../shared/types.js";

export function durableRootRegistrationForRun(args: {
	readonly runId: string;
	readonly name: string;
	readonly inputs: ResolvedInputs;
	readonly createdAt: number;
	readonly hasPersistence: boolean;
	readonly isChildRun: boolean;
	readonly continuationSourceId: string | undefined;
	readonly possibleStages?: readonly string[];
}): WorkflowRegistrationInput | undefined {
	if (args.isChildRun || args.continuationSourceId === args.runId) return undefined;
	return {
		workflowId: args.runId,
		name: args.name,
		inputs: args.inputs as Record<string, WorkflowSerializableValue>,
		createdAt: args.createdAt,
		status: "running",
		rootWorkflowId: args.runId,
		resumable: true,
		...(args.hasPersistence ? { sessionFile: undefined } : {}),
		...(args.possibleStages !== undefined ? { possibleStages: args.possibleStages } : {}),
	};
}

export class WorkflowRunControlError extends Error {
	constructor(
		readonly runId: string,
		readonly status: "paused" | "running",
		readonly reason: "transition-refused" | "superseded",
	) {
		super(`Workflow ${runId} ${status} control ${reason}`);
		this.name = "WorkflowRunControlError";
	}
}
