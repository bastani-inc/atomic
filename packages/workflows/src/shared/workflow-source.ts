import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { normalize, win32 } from "node:path";
import type { DurableWorkflowDefinitionSource } from "../durable/types.js";
import { isWorkflowRuntimeFrame, normalizeStackPath } from "../runs/shared/prompt-callsite.js";
import { definitionDigest } from "../workers/definitions.js";

const WORKFLOW_SOURCES = new WeakMap<object, string>();
const WORKFLOW_SOURCE_DIGESTS = new WeakMap<object, DurableWorkflowDefinitionSource>();
const OWN_MODULE_PATH = normalizeStackPath(import.meta.url);

export function normalizeWorkflowSourcePath(path: string): string {
	return /^[A-Za-z]:[\\/]/.test(path) ? win32.normalize(path) : normalize(path);
}

export function isWorkflowRuntimeModule(path: string): boolean {
	const normalized = normalizeStackPath(path);
	return normalized === OWN_MODULE_PATH || isWorkflowRuntimeFrame(normalized);
}

export function recordWorkflowSource(definition: object, path: string): void {
	const normalizedPath = normalizeWorkflowSourcePath(path);
	WORKFLOW_SOURCES.set(definition, normalizedPath);
	try {
		const digest = createHash("sha256").update(readFileSync(normalizedPath)).digest("hex");
		WORKFLOW_SOURCE_DIGESTS.set(definition, { path: normalizedPath, digest });
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
	const rawPath = workflowSource(definition) ?? existing?.path;
	if (rawPath === undefined) return existing;
	const path = normalizeWorkflowSourcePath(rawPath);
	try {
		const digest = await definitionDigest(path);
		return { path, digest };
	} catch {
		return existing;
	}
}
