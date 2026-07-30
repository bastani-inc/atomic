import type {
	WorkflowChildResult,
	WorkflowExitStatus,
	WorkflowOutputValues,
	WorkflowSerializableValue,
} from "../shared/types.js";

/** Parse the exact durable child-result union without trusting persisted casts. */
export function parseWorkflowChildResult(
	value: WorkflowSerializableValue | undefined,
): WorkflowChildResult<WorkflowOutputValues> | undefined {
	if (!isOrdinaryObject(value)) return undefined;
	const workflow = value.workflow;
	const runId = value.runId;
	const status = value.status;
	const exited = value.exited;
	const outputs = value.outputs;
	const exitReason = value.exitReason;
	if (typeof workflow !== "string" || typeof runId !== "string" || !isOrdinaryObject(outputs)) return undefined;
	if (exited === false) {
		if (status !== "completed" || exitReason !== undefined) return undefined;
		return value as WorkflowChildResult<WorkflowOutputValues>;
	}
	if (exited !== true || !isWorkflowExitStatus(status) || (exitReason !== undefined && typeof exitReason !== "string"))
		return undefined;
	return value as WorkflowChildResult<WorkflowOutputValues>;
}

export function parseLegacyWorkflowChildResult(
	value: WorkflowSerializableValue | undefined,
): WorkflowChildResult<WorkflowOutputValues> | undefined {
	if (!isOrdinaryObject(value)) return undefined;
	if (
		typeof value.workflow !== "string" ||
		typeof value.runId !== "string" ||
		value.status !== "completed" ||
		value.exited !== undefined ||
		value.exitReason !== undefined ||
		!isOrdinaryObject(value.outputs)
	)
		return undefined;
	return value as WorkflowChildResult<WorkflowOutputValues>;
}

export function isWorkflowChildResult(
	value: WorkflowSerializableValue | undefined,
): value is WorkflowChildResult<WorkflowOutputValues> {
	return parseWorkflowChildResult(value) !== undefined;
}

function isWorkflowExitStatus(value: WorkflowSerializableValue | undefined): value is WorkflowExitStatus {
	return value === "completed" || value === "skipped" || value === "cancelled" || value === "blocked";
}

function isOrdinaryObject(
	value: WorkflowSerializableValue | undefined,
): value is Readonly<Record<string, WorkflowSerializableValue | undefined>> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
