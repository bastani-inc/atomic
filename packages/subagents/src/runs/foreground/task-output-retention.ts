import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SingleResult } from "../../shared/types.js";

/** Bytes of settled agent output inlined into a wait, status, or launch result. */
export const INLINE_TASK_OUTPUT_MAX_BYTES = 16 * 1024;

/** Settled agent outputs kept per process; evicting an entry deletes its private copy. */
const MAX_RETAINED_TASK_OUTPUTS = 256;

export type RetainedTaskOutput = {
	/** Private file holding the full output, when it could be written. */
	readonly path?: string;
	/** The caller's requested `output` file, when it was written. */
	readonly requestedPath?: string;
	/** Why the requested `output` file could not be written. */
	readonly saveError?: string;
	/** Leading bytes of the output, bounded by INLINE_TASK_OUTPUT_MAX_BYTES. */
	readonly head: string;
	readonly totalBytes: number;
};

const retained = new Map<string, RetainedTaskOutput>();
let copyRoot: string | undefined;

function retentionKey(ownerId: string, taskId: string): string {
	return `${ownerId}\u0000${taskId}`;
}

function fileSafe(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function privateCopyRoot(): string {
	if (copyRoot) return copyRoot;
	const root = mkdtempSync(join(tmpdir(), "atomic-subagent-output-"));
	copyRoot = root;
	process.once("exit", () => rmSync(root, { recursive: true, force: true }));
	return root;
}

function removeCopy(entry: RetainedTaskOutput | undefined): void {
	if (entry?.path) rmSync(entry.path, { force: true });
}

/**
 * The full text a parent should be able to read. With `outputMode: "file-only"`
 * the child's reported text is only a pointer, so copy the saved file instead.
 */
function fullOutputText(child: SingleResult, text: string): string {
	if (child.outputMode !== "file-only" || !child.outputReference) return text;
	try {
		return readFileSync(child.outputReference.path, "utf-8");
	} catch {
		return text;
	}
}

function writePrivateCopy(ownerId: string, taskId: string, text: string): string | undefined {
	try {
		const path = join(privateCopyRoot(), `${fileSafe(ownerId)}-${fileSafe(taskId)}.md`);
		writeFileSync(path, text, { encoding: "utf-8", mode: 0o600 });
		return path;
	} catch {
		return undefined;
	}
}

/**
 * Keep a bounded head of a settled child's output and a private copy of the
 * full text, so a parent observing only the task can reach the whole result
 * even after a worktree holding the requested `output` file is removed (#3294).
 */
export function retainTaskOutput(
	child: SingleResult,
	text: string,
	ref: { readonly ownerId: string; readonly taskId: string },
): void {
	const bytes = Buffer.from(text);
	const path = writePrivateCopy(ref.ownerId, ref.taskId, fullOutputText(child, text));
	const key = retentionKey(ref.ownerId, ref.taskId);
	removeCopy(retained.get(key));
	retained.delete(key);
	retained.set(key, {
		...(path ? { path } : {}),
		...(child.outputReference ? { requestedPath: child.outputReference.path } : {}),
		...(child.outputSaveError ? { saveError: child.outputSaveError } : {}),
		head: new TextDecoder().decode(bytes.subarray(0, INLINE_TASK_OUTPUT_MAX_BYTES)),
		totalBytes: bytes.byteLength,
	});
	while (retained.size > MAX_RETAINED_TASK_OUTPUTS) {
		const oldest = retained.keys().next().value;
		if (oldest === undefined) break;
		removeCopy(retained.get(oldest));
		retained.delete(oldest);
	}
}

export function retainedTaskOutput(ownerId: string, taskId: string): RetainedTaskOutput | undefined {
	return retained.get(retentionKey(ownerId, taskId));
}
