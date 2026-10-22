const WORKFLOW_SOURCES = new WeakMap<object, string>();

export function recordWorkflowSource(definition: object, path: string): void {
	WORKFLOW_SOURCES.set(definition, path);
}

export function workflowSource(definition: object): string | undefined {
	return WORKFLOW_SOURCES.get(definition);
}
