import { isWorkflowRuntimeFrame, normalizeStackPath } from "../runs/shared/prompt-callsite.js";

const WORKFLOW_SOURCES = new WeakMap<object, string>();
const OWN_MODULE_PATH = normalizeStackPath(import.meta.url);

export function isWorkflowRuntimeModule(path: string): boolean {
	const normalized = normalizeStackPath(path);
	return normalized === OWN_MODULE_PATH || isWorkflowRuntimeFrame(normalized);
}

export function recordWorkflowSource(definition: object, path: string): void {
	WORKFLOW_SOURCES.set(definition, path);
}

export function workflowSource(definition: object): string | undefined {
	return WORKFLOW_SOURCES.get(definition);
}
