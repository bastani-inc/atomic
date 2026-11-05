import { isAbsolute, relative, resolve, sep } from "node:path";
import {
	captureWorktreeSnapshot,
	isGitUnavailableError,
	isWorkspaceGitError,
	serializeWorkspaceError,
	WorkspaceSnapshotError,
	type WorktreeSnapshot,
	type WorktreeSnapshotSettingsInput,
} from "@bastani/atomic";
import type { RunJournal } from "@bastani/atomic/storage";
import type { RunSnapshot } from "../shared/store-types.js";
import type { DurableWorkflowBackend } from "./backend.js";
import type { DurableStageCheckpoint, DurableToolCheckpoint } from "./types.js";
import { listWorkflowSnapshotBoundaries } from "./worktree-snapshots.js";

export type WorkflowSnapshotCheckpoint = DurableStageCheckpoint | DurableToolCheckpoint;
export type WorkflowSnapshotRecord = (
	checkpoint: WorkflowSnapshotCheckpoint,
	signal?: AbortSignal,
	directories?: readonly string[],
) => Promise<readonly WorktreeSnapshot[]>;

const runQueues = new Map<string, Promise<void>>();
const ancestryByJournal = new WeakMap<RunJournal, Map<string, Map<string, WorktreeSnapshot>>>();

/** Releases the snapshot ancestry cache when a root execution has finished. */
export function releaseWorkflowSnapshotAncestry(journal: RunJournal, runId: string): void {
	ancestryByJournal.get(journal)?.delete(runId);
}

async function snapshotAncestry(journal: RunJournal, runId: string): Promise<Map<string, WorktreeSnapshot>> {
	let runs = ancestryByJournal.get(journal);
	if (runs === undefined) {
		runs = new Map();
		ancestryByJournal.set(journal, runs);
	}
	let latest = runs.get(runId);
	if (latest === undefined) {
		latest = new Map();
		for (const boundary of await listWorkflowSnapshotBoundaries(journal, runId)) {
			latest.set(boundary.root, boundary.snapshot);
		}
		runs.set(runId, latest);
	}
	return latest;
}

async function serializeRun<T>(runId: string, action: () => Promise<T>): Promise<T> {
	const previous = runQueues.get(runId) ?? Promise.resolve();
	let release!: () => void;
	const pending = new Promise<void>((done) => {
		release = done;
	});
	const queued = previous.then(() => pending);
	runQueues.set(runId, queued);
	await previous;
	try {
		return await action();
	} finally {
		release();
		if (runQueues.get(runId) === queued) runQueues.delete(runId);
	}
}

function containsDirectory(root: string, directory: string): boolean {
	const path = relative(root, directory);
	return !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
}

/** Captures live checkpoint workspaces and commits while holding the run's in-process snapshot queue. */
export function createWorkflowSnapshotRecorder(input: {
	readonly backend: DurableWorkflowBackend;
	readonly rootBackend: DurableWorkflowBackend;
	readonly rootRunId: string;
	readonly cwd: () => string;
	readonly settings?: WorktreeSnapshotSettingsInput;
	readonly run: RunSnapshot;
}): WorkflowSnapshotRecord {
	let gitUnavailable = false;
	const report = (error: Error) => {
		if (isGitUnavailableError(error)) gitUnavailable = true;
		input.run.snapshotUnavailable ??= serializeWorkspaceError(error);
	};
	return async (checkpoint, signal, directories = []) => {
		const journal = input.rootBackend.snapshotJournal;
		if (input.settings?.enabled === false || gitUnavailable || !journal?.snapshotBlobs) {
			if (input.settings?.enabled !== false && !journal?.snapshotBlobs) {
				report(new WorkspaceSnapshotError("blob-store-unsupported", "workflow journal"));
			}
			await input.backend.commitCheckpoint(checkpoint, signal === undefined ? undefined : { signal });
			return [];
		}
		return serializeRun(input.rootRunId, async () => {
			signal?.throwIfAborted();
			const latest = await snapshotAncestry(journal, input.rootRunId);
			const snapshots: WorktreeSnapshot[] = [];
			const workflowCwd = resolve(input.cwd());
			for (const directory of new Set([workflowCwd, ...directories.map((path) => resolve(workflowCwd, path))])) {
				const previous = [...latest.values()]
					.filter((snapshot) => containsDirectory(snapshot.root, directory))
					.sort((a, b) => b.root.length - a.root.length)[0];
				try {
					const capture = await captureWorktreeSnapshot(directory, {
						settings: input.settings,
						previous,
						blobs: journal.snapshotBlobs,
						signal,
					});
					if (capture.status === "captured" || capture.status === "unchanged") {
						if (!snapshots.some((entry) => entry.root === capture.snapshot.root))
							snapshots.push(capture.snapshot);
					} else if (capture.status === "unavailable") {
						report(capture.reason);
						if (gitUnavailable) break;
					}
				} catch (error) {
					signal?.throwIfAborted();
					if (!isWorkspaceGitError(error)) throw error;
					report(error);
				}
			}
			signal?.throwIfAborted();
			await input.backend.commitCheckpoint(
				snapshots.length === 0 ? checkpoint : { ...checkpoint, worktreeSnapshots: snapshots },
				signal === undefined ? undefined : { signal },
			);
			for (const snapshot of snapshots) latest.set(snapshot.root, snapshot);
			return snapshots;
		});
	};
}
