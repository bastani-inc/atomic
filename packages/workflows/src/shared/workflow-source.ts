import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DurableWorkflowDefinitionSource } from "../durable/types.js";
import { isWorkflowRuntimeFrame, normalizeStackPath } from "../runs/shared/prompt-callsite.js";
import { definitionDigest } from "../workers/definitions.js";

const WORKFLOW_SOURCES = new WeakMap<object, string>();
const WORKFLOW_SOURCE_DIGESTS = new WeakMap<object, DurableWorkflowDefinitionSource>();
const OWN_MODULE_PATH = normalizeStackPath(import.meta.url);

export function isWorkflowRuntimeModule(path: string): boolean {
	const normalized = normalizeStackPath(path);
	return normalized === OWN_MODULE_PATH || isWorkflowRuntimeFrame(normalized);
}

export function recordWorkflowSource(definition: object, path: string): void {
	WORKFLOW_SOURCES.set(definition, path);
	try {
		const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
		WORKFLOW_SOURCE_DIGESTS.set(definition, { path, digest });
	} catch {
		WORKFLOW_SOURCE_DIGESTS.delete(definition);
	}
}

export function workflowSource(definition: object): string | undefined {
	return WORKFLOW_SOURCES.get(definition);
}

export function workflowDefinitionSource(definition: object): DurableWorkflowDefinitionSource | undefined {
	return WORKFLOW_SOURCE_DIGESTS.get(definition);
}

export async function resolveWorkflowDefinitionSource(
	definition: object,
	existing?: DurableWorkflowDefinitionSource,
): Promise<DurableWorkflowDefinitionSource | undefined> {
	const recorded = WORKFLOW_SOURCE_DIGESTS.get(definition);
	if (recorded !== undefined) return recorded;
	const path = workflowSource(definition) ?? existing?.path;
	if (path === undefined) return existing;
	try {
		const digest = await definitionDigest(path);
		return { path, digest };
	} catch {
		return existing;
	}
}
