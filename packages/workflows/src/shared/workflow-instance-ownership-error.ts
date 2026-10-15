/** A workflow instance cannot be controlled by this execution or caller. */
export class WorkflowInstanceOwnershipError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkflowInstanceOwnershipError";
	}
}
