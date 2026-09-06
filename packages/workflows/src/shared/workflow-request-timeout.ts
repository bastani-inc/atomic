/** A request deadline abandons acknowledgement, unlike an explicit user cancellation. */
export class WorkflowRequestTimeoutError extends Error {
	override readonly name = "WorkflowRequestTimeoutError";
}
