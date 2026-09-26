import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SingleResult } from "../../shared/types.js";
import { formatSavedOutputReference } from "../shared/single-output.js";

/** Bytes of settled agent output inlined into a wait, status, or launch result. */
export const INLINE_TASK_OUTPUT_MAX_BYTES = 16 * 1024;

/** Settled agent outputs kept per process; older entries still have their file. */
const MAX_RETAINED_TASK_OUTPUTS = 256;

export type RetainedTaskOutput = {
	/** Absolute file holding the full output, when one could be written. */
	readonly path?: string;
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

/**
 * Give a settled child's output a readable file and lead the text with where it
 * lives, so a parent observing only the task can reach the full result (#3294).
 * Prefers the caller's `output` path, then the run artifact, then a temp file.
 */
export function locateTaskOutput(
	child: SingleResult,
	text: string,
	ref: { ownerId: string; taskId: string },
): { text: string; path?: string } {
	if (child.outputReference) {
		return {
			text:
				child.outputMode === "file-only"
					? child.outputReference.message
					: `${child.outputReference.message}\n\n${text}`,
			path: child.outputReference.path,
		};
	}
	const saveError = child.outputSaveError ? `Output file error: ${child.outputSaveError}\n` : "";
	const artifact = child.artifactPaths?.outputPath;
	const path = artifact && existsSync(artifact) ? artifact : writeFallbackOutput(ref.ownerId, ref.taskId, text);
	if (!path) return { text: `${saveError}${saveError ? "\n" : ""}${text}` };
	const reference = formatSavedOutputReference(path, text);
	return { text: `${saveError}${reference.message}\n\n${text}`, path: reference.path };
}

export function retainTaskOutput(ownerId: string, taskId: string, text: string, path: string | undefined): void {
	const bytes = Buffer.from(text);
	const key = retentionKey(ownerId, taskId);
	retained.delete(key);
	retained.set(key, {
		...(path ? { path } : {}),
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
