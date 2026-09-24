export class WorkflowDurabilityRequiredError extends Error {
	constructor(workflowName: string, detail: string, options?: { readonly cause?: unknown }) {
		super(`Workflow "${workflowName}" requested durable execution, but ${detail}`, options);
		this.name = "WorkflowDurabilityRequiredError";
	}
}
