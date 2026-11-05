import { isAbsolute, join, relative, sep } from "node:path";
import {
	canonicalizeWorktreePath,
	isHeadOnlyAdvance,
	isWorkspaceDriftError,
	isWorkspaceSnapshotError,
	removeRestoredWorktree,
	restoreWorktree,
	verifyWorktree,
	WorkspaceDriftError,
	type WorktreeRestoreWarning,
	type WorktreeRootMapping,
	type WorktreeSnapshot,
	type WorktreeSnapshotSettingsInput,
} from "@bastani/atomic";
import type { StageWorktreeSnapshot } from "../shared/store-types.js";
import type { WorkflowSnapshotBoundary } from "../shared/worktree-snapshot-contract.js";

export type { WorkflowSnapshotBoundary } from "../shared/worktree-snapshot-contract.js";

import { RUN_EVENT_TYPES, type RunJournal } from "./journal/types.js";
import { type DurableResumeCandidate, isDurableWorkflowResumable } from "./resume-eligibility.js";
import type { DurableStageCheckpoint, DurableToolCheckpoint } from "./types.js";

export function stageWorktreeSnapshot(snapshot: WorktreeSnapshot): StageWorktreeSnapshot {
	const warnings = [];
	if (snapshot.omitted.length > 0) warnings.push(`${snapshot.omitted.length} omitted item(s)`);
	if (snapshot.filters !== null) warnings.push("Git conversion filters were used");
	return {
		id: snapshot.id,
		root: snapshot.root,
		head: snapshot.head,
		tree: snapshot.tree,
		omittedCount: snapshot.omitted.length,
		warnings,
	};
}

/** Reads every snapshot boundary from the root journal, including scoped and pooled child checkpoints. */
export async function listWorkflowSnapshotBoundaries(
	journal: RunJournal,
	runId: string,
): Promise<readonly WorkflowSnapshotBoundary[]> {
	const boundaries: WorkflowSnapshotBoundary[] = [];
	for await (const entry of journal.read(runId)) {
		if (entry.event.type !== RUN_EVENT_TYPES.checkpointRecorded) continue;
		const checkpoint = entry.event.payload as unknown as DurableToolCheckpoint | DurableStageCheckpoint;
		if (checkpoint.kind !== "tool" && checkpoint.kind !== "stage") continue;
		for (const snapshot of checkpoint.worktreeSnapshots ?? []) {
			boundaries.push({
				seq: entry.seq,
				kind: checkpoint.kind,
				checkpointId: checkpoint.checkpointId,
				root: snapshot.root,
				snapshot,
			});
		}
	}
	return boundaries;
}

/** Returns the last recorded boundary for each root, in increasing journal sequence. */
export function workflowSnapshotFrontier(
	boundaries: readonly WorkflowSnapshotBoundary[],
): readonly WorkflowSnapshotBoundary[] {
	const latest = new Map<string, WorkflowSnapshotBoundary>();
	for (const boundary of boundaries) {
		const previous = latest.get(boundary.root);
		if (previous === undefined || boundary.seq >= previous.seq) latest.set(boundary.root, boundary);
	}
	return [...latest.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * Maps an absolute path within a restored root while preserving its repository-relative suffix. Roots are Git's physical
 * top levels, so the path and both ends of every mapping are compared with their symbolic links resolved: a working
 * directory reached through a link maps like the directory it points at. The result lies under the mapping's `to`.
 */
export function mapWorkflowWorktreePath(path: string, mappings: readonly WorktreeRootMapping[]): string {
	if (!isAbsolute(path) || mappings.length === 0) return path;
	const physical = canonicalizeWorktreePath(path);
	let selected: { readonly source: string; readonly target: string } | undefined;
	for (const mapping of mappings) {
		const root = originalRoot(mapping.from, mappings);
		const target =
			mappings.findLast((candidate) => originalRoot(candidate.from, mappings) === root)?.to ?? mapping.to;
		for (const source of [mapping.from, mapping.to].map(canonicalizeWorktreePath)) {
			const suffix = relative(source, physical);
			if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) continue;
			if (selected === undefined || source.length >= selected.source.length) selected = { source, target };
		}
	}
	return selected === undefined ? path : join(selected.target, relative(selected.source, physical));
}

/** The root a restored root descends from, comparing physical paths so a link in a recorded spelling cannot break the chain. */
function originalRoot(root: string, mappings: readonly WorktreeRootMapping[]): string {
	const seen = new Set<string>();
	while (!seen.has(root)) {
		seen.add(root);
		const physical = canonicalizeWorktreePath(root);
		const prior = mappings.findLast((mapping) => canonicalizeWorktreePath(mapping.to) === physical);
		if (prior === undefined) break;
		root = prior.from;
	}
	return root;
}

/** Checks the last recorded state of each worktree and restores drifted worktrees into fresh directories. */
export async function resolveWorkflowSnapshotFrontier(
	journal: RunJournal,
	runId: string,
	options: {
		readonly mappings?: readonly WorktreeRootMapping[];
		readonly settings?: WorktreeSnapshotSettingsInput;
		readonly storeDir?: string;
		readonly signal?: AbortSignal;
		readonly onRestore?: (mapping: WorktreeRootMapping) => void;
		readonly onWarning?: (warning: WorktreeRestoreWarning) => void;
	} = {},
): Promise<readonly WorktreeRootMapping[]> {
	const mappings = options.mappings ?? [];
	const latest = new Map<string, WorkflowSnapshotBoundary>();
	for (const boundary of await listWorkflowSnapshotBoundaries(journal, runId)) {
		latest.set(originalRoot(boundary.root, mappings), boundary);
	}
	const restored: WorktreeRootMapping[] = [];
	const announcements: Array<{ mapping: WorktreeRootMapping; warnings: readonly WorktreeRestoreWarning[] }> = [];
	try {
		for (const [root, { snapshot }] of latest) {
			options.signal?.throwIfAborted();
			const mapped = mappings.findLast((mapping) => originalRoot(mapping.from, mappings) === root)?.to ?? root;
			let drift: WorkspaceDriftError;
			try {
				await verifyWorktree(snapshot, mapped, { settings: options.settings, signal: options.signal });
				continue;
			} catch (error) {
				if (isWorkspaceDriftError(error) && (await isHeadOnlyAdvance(error, options.signal))) continue;
				if (isWorkspaceDriftError(error)) drift = error;
				else if (isWorkspaceSnapshotError(error)) {
					drift = new WorkspaceDriftError(
						{
							root: mapped,
							expectedHead: snapshot.head,
							actualHead: null,
							expectedTree: snapshot.tree,
							actualTree: null,
							snapshotId: snapshot.id,
						},
						error,
					);
				} else throw error;
			}
			let worktree: Awaited<ReturnType<typeof restoreWorktree>>;
			try {
				worktree = await restoreWorktree(snapshot, {
					blobs: journal.snapshotBlobs,
					storeDir: options.storeDir,
					signal: options.signal,
				});
			} catch (cause) {
				options.signal?.throwIfAborted();
				throw new WorkspaceDriftError(
					{
						root: drift.root,
						expectedHead: drift.expectedHead,
						actualHead: drift.actualHead,
						expectedTree: drift.expectedTree,
						actualTree: drift.actualTree,
						snapshotId: snapshot.id,
						reason: "restore-failed",
					},
					cause instanceof Error ? cause : undefined,
				);
			}
			const mapping: WorktreeRootMapping = {
				from: root,
				to: worktree.path,
				snapshotId: snapshot.id,
				tree: snapshot.tree,
				restoredAt: new Date().toISOString(),
			};
			restored.push(mapping);
			announcements.push({ mapping, warnings: worktree.warnings });
		}
	} catch (error) {
		const cleanupFailures: unknown[] = [];
		for (const mapping of restored.reverse()) {
			try {
				await removeRestoredWorktree(mapping.to, { storeDir: options.storeDir, onWarning: options.onWarning });
			} catch (cleanupCause) {
				cleanupFailures.push(cleanupCause);
			}
		}
		if (cleanupFailures.length > 0 && error instanceof Error && Object.isExtensible(error)) {
			Object.defineProperty(error, "cleanupCause", {
				value: cleanupFailures.length === 1 ? cleanupFailures[0] : new AggregateError(cleanupFailures),
				configurable: true,
			});
		}
		throw error;
	}
	for (const { mapping, warnings } of announcements) {
		options.onRestore?.(mapping);
		for (const warning of warnings) options.onWarning?.(warning);
	}
	return restored;
}

/** Snapshots pinned by resumable root workflows, including every earlier explicit recovery boundary. */
export async function listResumableWorkflowSnapshots(journal: RunJournal): Promise<readonly WorktreeSnapshot[]> {
	const retained: WorktreeSnapshot[] = [];
	for (const run of await journal.listRuns()) {
		let candidate: DurableResumeCandidate | undefined;
		let checkpointCount = 0;
		const snapshots: WorktreeSnapshot[] = [];
		for await (const entry of journal.read(run.runId)) {
			if (entry.event.type === RUN_EVENT_TYPES.runStarted || entry.event.type === RUN_EVENT_TYPES.statusChanged) {
				const payload = entry.event.payload as unknown as Partial<DurableResumeCandidate>;
				if (
					typeof payload.workflowId === "string" &&
					typeof payload.status === "string" &&
					typeof payload.completedCheckpoints === "number" &&
					typeof payload.pendingPrompts === "number"
				) {
					candidate = payload as DurableResumeCandidate;
				}
			}
			if (entry.event.type !== RUN_EVENT_TYPES.checkpointRecorded) continue;
			checkpointCount++;
			const checkpoint = entry.event.payload as unknown as DurableToolCheckpoint | DurableStageCheckpoint;
			if (checkpoint.kind === "tool" || checkpoint.kind === "stage") {
				snapshots.push(...(checkpoint.worktreeSnapshots ?? []));
			}
		}
		if (
			candidate !== undefined
				? isDurableWorkflowResumable({
						...candidate,
						completedCheckpoints: Math.max(candidate.completedCheckpoints, checkpointCount),
					})
				: run.status !== "completed" && run.status !== "cancelled"
		)
			retained.push(...snapshots);
	}
	return retained;
}
