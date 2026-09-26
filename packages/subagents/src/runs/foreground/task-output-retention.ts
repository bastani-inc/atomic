import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SingleResult } from "../../shared/types.js";

/** Bytes of settled agent output inlined into a wait, status, or launch result. */
export const INLINE_TASK_OUTPUT_MAX_BYTES = 16 * 1024;

/** Settled agent outputs kept per process; older entries still have their file. */
const MAX_RETAINED_TASK_OUTPUTS = 256;

export type RetainedTaskOutput = {
	/** Absolute file holding the full output, when one could be written. */
	readonly path?: string;
	/** Why the requested `output` file could not be written. */
	readonly saveError?: string;
	/** Leading bytes of the output, bounded by INLINE_TASK_OUTPUT_MAX_BYTES. */
	readonly head: string;
	readonly totalBytes: number;
};

const retained = new Map<string, RetainedTaskOutput>();

function retentionKey(ownerId: string, taskId: string): string {
	return `${ownerId}\u0000${taskId}`;
}

function fileSafe(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function writeFallbackOutput(ownerId: string, taskId: string, text: string): string | undefined {
	try {
		const dir = join(tmpdir(), "atomic-subagent-output", fileSafe(ownerId));
		mkdirSync(dir, { recursive: true });
		const path = join(dir, `${fileSafe(taskId)}.md`);
		writeFileSync(path, text, "utf-8");
		return path;
	} catch {
		return undefined;
	}
}

export type TaskOutputLocation = { readonly path?: string; readonly saveError?: string };

/**
 * Find or create a file holding a settled child's full output, so a parent
 * observing only the task can reach the whole result (#3294). Prefers the
 * caller's `output` path, then the run artifact, then a temp file.
 */
export function locateTaskOutput(
	child: SingleResult,
	text: string,
	ref: { ownerId: string; taskId: string },
): TaskOutputLocation {
	const saveError = child.outputSaveError ? { saveError: child.outputSaveError } : {};
	if (child.outputReference) return { path: child.outputReference.path };
	const artifact = child.artifactPaths?.outputPath;
	const path = artifact && existsSync(artifact) ? artifact : writeFallbackOutput(ref.ownerId, ref.taskId, text);
	return path ? { path, ...saveError } : saveError;
}

export function retainTaskOutput(ownerId: string, taskId: string, text: string, location: TaskOutputLocation): void {
	const bytes = Buffer.from(text);
	const key = retentionKey(ownerId, taskId);
	retained.delete(key);
	retained.set(key, {
		...location,
		head: new TextDecoder().decode(bytes.subarray(0, INLINE_TASK_OUTPUT_MAX_BYTES)),
		totalBytes: bytes.byteLength,
	});
	while (retained.size > MAX_RETAINED_TASK_OUTPUTS) {
		const oldest = retained.keys().next().value;
		if (oldest === undefined) break;
		retained.delete(oldest);
	}
}

export function retainedTaskOutput(ownerId: string, taskId: string): RetainedTaskOutput | undefined {
	return retained.get(retentionKey(ownerId, taskId));
}
