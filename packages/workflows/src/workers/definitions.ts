import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { loadWorkflowModule } from "../extension/workflow-module-loader.js";
import { isWorkflowDefinition } from "../runs/foreground/executor-child-helpers.js";
import type { WorkflowDefinition } from "../shared/types.js";

export interface WorkerDefinitionSource {
	readonly path: string;
	readonly exportName: string;
	readonly digest: string;
}
export interface WorkerDefinitionBinding {
	readonly path: string;
	readonly exportName: string;
	readonly definition: WorkflowDefinition;
}

export const workerDefinitionSources = new WeakMap<WorkflowDefinition, WorkerDefinitionSource>();

export async function loadWorkerDefinition(source: WorkerDefinitionSource): Promise<WorkflowDefinition> {
	if (!isAbsolute(source.path) || (await definitionDigest(source.path)) !== source.digest)
		throw new Error(`Worker definition compatibility error: ${source.path}`);
	const exports = loadWorkflowModule(source.path);
	const definition = exports[source.exportName];
	if (!isWorkflowDefinition(definition)) throw new Error(`Worker definition is not importable: ${source.exportName}`);
	workerDefinitionSources.set(definition, { ...source });
	return definition;
}

export async function definitionDigest(path: string): Promise<string> {
	return createHash("sha256")
		.update(await readFile(path))
		.digest("hex");
}
