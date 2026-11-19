import { rmSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskLease } from "../../../../coding-agent/src/core/tasks/supervisor.js";
import type { SingleResult } from "../../shared/types.js";
import { utf8Head } from "../../shared/types-output.js";

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
	readonly worktree?: { readonly runId: string; readonly index: number };
};

// Neither a private copy nor its eviction record should keep the task alive.
const retained = new Map<string, { output: RetainedTaskOutput; lease?: WeakRef<TaskLease> }>();
const evictedCopies = new WeakSet<TaskLease>();
let copyRoot: Promise<string> | undefined;

function retentionKey(ownerId: string, taskId: string): string {
	return `${ownerId}\u0000${taskId}`;
}

function fileSafe(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function privateCopyRoot(): Promise<string> {
	copyRoot ??= mkdtemp(join(tmpdir(), "atomic-subagent-output-")).then(
		(root) => {
			process.once("exit", () => rmSync(root, { recursive: true, force: true }));
			return root;
		},
		(error: unknown) => {
			copyRoot = undefined;
			throw error;
		},
	);
	return copyRoot;
}

async function removeCopy(entry: RetainedTaskOutput | undefined): Promise<void> {
	if (entry?.path) await rm(entry.path, { force: true });
}

/**
 * The full text a parent should be able to read. With `outputMode: "file-only"`
 * the child's reported text is only a pointer, so copy the saved file instead.
 */
async function fullOutputText(child: SingleResult, text: string): Promise<string> {
	if (child.outputMode !== "file-only" || !child.outputReference) return text;
	try {
		return await readFile(child.outputReference.path, "utf-8");
	} catch {
		return text;
	}
}

async function writePrivateCopy(ownerId: string, taskId: string, text: string): Promise<string | undefined> {
	try {
		const path = join(await privateCopyRoot(), `${fileSafe(ownerId)}-${fileSafe(taskId)}.md`);
		await writeFile(path, text, { encoding: "utf-8", mode: 0o600 });
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
export async function retainTaskOutput(
	child: SingleResult,
	text: string,
	ref: { readonly ownerId: string; readonly taskId: string },
	lease?: WeakRef<TaskLease>,
	worktree?: RetainedTaskOutput["worktree"],
): Promise<void> {
	const path = await writePrivateCopy(ref.ownerId, ref.taskId, await fullOutputText(child, text));
	const key = retentionKey(ref.ownerId, ref.taskId);
	await removeCopy(retained.get(key)?.output);
	retained.delete(key);
	retained.set(key, {
		lease: path ? lease : undefined,
		output: {
			...(path ? { path } : {}),
			...(child.outputReference ? { requestedPath: child.outputReference.path } : {}),
			...(child.outputSaveError ? { saveError: child.outputSaveError } : {}),
			...(worktree ? { worktree } : {}),
			head: utf8Head(text, INLINE_TASK_OUTPUT_MAX_BYTES),
			totalBytes: Buffer.byteLength(text, "utf-8"),
		},
	});
	while (retained.size > MAX_RETAINED_TASK_OUTPUTS) {
		const oldest = retained.keys().next().value;
		if (oldest === undefined) break;
		const evicted = retained.get(oldest);
		retained.delete(oldest);
		const task = evicted?.lease?.deref();
		if (task) evictedCopies.add(task);
		await removeCopy(evicted?.output);
	}
}

export function wasTaskOutputEvicted(lease: TaskLease): boolean {
	return evictedCopies.has(lease);
}

export function retainedTaskOutput(ownerId: string, taskId: string): RetainedTaskOutput | undefined {
	return retained.get(retentionKey(ownerId, taskId))?.output;
}

/** Task outputs retained now; counted by tests and the benchmark. */
export function retainedTaskOutputCount(): number {
	return retained.size;
}
