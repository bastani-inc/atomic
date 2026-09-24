export class WorkflowDurabilityRequiredError extends Error {
	constructor(workflowName: string, detail: string, options?: { readonly cause?: unknown }) {
		super(`Workflow "${workflowName}" requires durable execution, but ${detail}`, options);
		this.name = "WorkflowDurabilityRequiredError";
	}
}

interface DurabilityDeclaration {
	readonly durability?: "required";
}

interface DurabilityRequest {
	readonly durability?: { readonly mode: "durable" | "memory" };
}

export function requiresDurableExecution(def: DurabilityDeclaration, opts: DurabilityRequest): boolean {
	return def.durability === "required" || opts.durability?.mode === "durable";
}
