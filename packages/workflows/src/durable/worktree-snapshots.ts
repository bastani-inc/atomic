import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	type BestWorktreeRestore,
	canonicalizeWorktreePath,
	formatDegradedRestoreNotice,
	formatUnrestoredNotice,
	isGitUnavailableError,
	isHeadOnlyAdvance,
	isWorkspaceDriftError,
	isWorkspaceRestoreError,
	isWorkspaceSnapshotError,
	removeRestoredWorktree,
	restoreBestWorktree,
	unrestoredRecord,
	verifyWorktree,
	WorkspaceDriftError,
	type WorktreeRestoreWarning,
	type WorktreeRootMapping,
	type WorktreeSnapshot,
	type WorktreeSnapshotSettingsInput,
} from "@bastani/atomic";
import type { StageWorktreeSnapshot, WorkflowWorktreeRestoreOutcome } from "../shared/store-types.js";
import type { WorkflowSnapshotBoundary } from "../shared/worktree-snapshot-contract.js";

export type { WorkflowSnapshotBoundary } from "../shared/worktree-snapshot-contract.js";

import { RUN_EVENT_TYPES, type RunJournal } from "./journal/types.js";
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

/** A checkout a run's resume continued without, because nothing of its snapshot could be restored here (#4738). */
export interface WorkflowUnrestoredCheckout {
	/** The checkout's original recorded root. */
	readonly root: string;
	/** Where the run would have found it here: `root`, or the worktree an earlier resume restored it into. */
	readonly here: string;
	readonly snapshot: WorktreeSnapshot;
	/** Why: the restore error, or Git being unavailable. */
	readonly reason: Error;
}

/** The commits of `root`'s earlier snapshots, newest first, to restore when `snapshot`'s own is out of reach (#4738). */
function earlierBoundaryHeads(
	boundaries: readonly WorkflowSnapshotBoundary[],
	root: string,
	mappings: readonly WorktreeRootMapping[],
	snapshot: WorktreeSnapshot,
): string[] {
	const heads: string[] = [];
	for (const boundary of [...boundaries].reverse()) {
		if (originalRoot(boundary.root, mappings) !== root) continue;
		const head = boundary.snapshot.head;
		if (head !== snapshot.head && !heads.includes(head)) heads.push(head);
	}
	return heads;
}

/**
 * Checks the last recorded state of each worktree and restores drifted worktrees into fresh directories. A worktree
 * that cannot be restored exactly is restored as well as this host can (#4738), as a session's resume does (#4733):
 * its recorded `HEAD` with the change sets that apply, or the closest commit it can fetch; its mapping then carries
 * `degraded`. A checkout nothing of which can be restored, Git being unavailable included, is left as it is and
 * reported to `onUnrestored`. Only a record that fails the security checks (`invalid-snapshot`), a target that holds
 * other files (`unsafe-target`), or an untyped failure stops the pass, as a `restore-failed` drift error.
 */
export async function resolveWorkflowSnapshotFrontier(
	journal: RunJournal,
	runId: string,
	options: {
		readonly mappings?: readonly WorktreeRootMapping[];
		readonly settings?: WorktreeSnapshotSettingsInput;
		readonly storeDir?: string;
		readonly signal?: AbortSignal;
		readonly onRestore?: (mapping: WorktreeRootMapping) => void;
		readonly onWarning?: (warning: WorktreeRestoreWarning, mapping: WorktreeRootMapping) => void;
		/** Told each checkout the pass continued without, once every other checkout is restored (#4738). */
		readonly onUnrestored?: (checkout: WorkflowUnrestoredCheckout) => void;
	} = {},
): Promise<readonly WorktreeRootMapping[]> {
	const mappings = options.mappings ?? [];
	const boundaries = await listWorkflowSnapshotBoundaries(journal, runId);
	const latest = new Map<string, WorkflowSnapshotBoundary>();
	for (const boundary of boundaries) {
		latest.set(originalRoot(boundary.root, mappings), boundary);
	}
	const restored: WorktreeRootMapping[] = [];
	const unrestored: WorkflowUnrestoredCheckout[] = [];
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
				options.signal?.throwIfAborted();
				if (isGitUnavailableError(error)) {
					unrestored.push({ root, here: mapped, snapshot, reason: error });
					continue;
				}
				if (isWorkspaceDriftError(error) && (await isHeadOnlyAdvance(error, options.signal))) continue;
				if (isWorkspaceDriftError(error)) drift = error;
				// A record the checks refuse is refused again by the restore, which reports it as the run's drift.
				else if (isWorkspaceSnapshotError(error) || isWorkspaceRestoreError(error)) {
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
			let worktree: Extract<BestWorktreeRestore, { status: "restored" }>;
			try {
				const best = await restoreBestWorktree(snapshot, {
					blobs: journal.snapshotBlobs,
					storeDir: options.storeDir,
					signal: options.signal,
					candidates: earlierBoundaryHeads(boundaries, root, mappings, snapshot),
				});
				if (best.status === "unrestored") {
					unrestored.push({ root, here: mapped, snapshot, reason: best.reason });
					continue;
				}
				worktree = best;
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
				...(worktree.degraded === undefined ? {} : { degraded: worktree.degraded }),
			};
			restored.push(mapping);
			announcements.push({ mapping, warnings: worktree.warnings });
		}
	} catch (error) {
		const cleanupFailures: unknown[] = [];
		for (const mapping of restored.reverse()) {
			try {
				await removeRestoredWorktree(mapping.to, {
					storeDir: options.storeDir,
					onWarning: (warning) => options.onWarning?.(warning, mapping),
				});
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
		for (const warning of warnings) options.onWarning?.(warning, mapping);
	}
	for (const checkout of unrestored) options.onUnrestored?.(checkout);
	return restored;
}

/** Whether `path` is `root` or below it. */
function within(root: string, path: string): boolean {
	const suffix = relative(root, path);
	return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

/**
 * The outcomes of a run's resume to record and announce (#4738), one per worktree it restored with less than its
 * snapshot and per checkout it continued without, and where the run continues: `continuedIn` is `launchCwd` when the
 * checkout the run's directory `continuing` is in was not restored and that directory is not on this node; otherwise
 * the run continues in `continuing` and `continuedIn` is undefined.
 */
export function runWorktreeRestoreOutcomes(input: {
	readonly restored: readonly WorktreeRootMapping[];
	readonly unrestored: readonly WorkflowUnrestoredCheckout[];
	readonly snapshots: ReadonlyMap<string, WorktreeSnapshot>;
	readonly continuing: string | undefined;
	readonly launchCwd: string | undefined;
}): { readonly list: WorkflowWorktreeRestoreOutcome[]; readonly continuedIn?: string } {
	const list: WorkflowWorktreeRestoreOutcome[] = [];
	for (const mapping of input.restored) {
		if (mapping.degraded === undefined) continue;
		list.push({
			root: mapping.from,
			snapshotId: mapping.snapshotId,
			message: formatDegradedRestoreNotice(mapping, input.snapshots.get(mapping.snapshotId), [], "workflow run"),
			at: mapping.restoredAt,
			degraded: mapping.degraded,
		});
	}
	const { continuing, launchCwd } = input;
	const leftHere =
		continuing !== undefined &&
		input.unrestored.some((checkout) => within(resolve(checkout.here), resolve(continuing)));
	const launch = leftHere && launchCwd !== undefined && !existsSync(continuing);
	const continuedIn = launch ? resolve(launchCwd) : undefined;
	for (const checkout of input.unrestored) {
		const record = unrestoredRecord(
			checkout.snapshot,
			checkout.reason,
			continuedIn ?? continuing ?? checkout.here,
			launch ? "launch" : "recorded",
		);
		list.push({
			root: checkout.root,
			snapshotId: checkout.snapshot.id,
			message: formatUnrestoredNotice(checkout.root, record, "workflow run"),
			at: record.at,
			unrestored: record,
		});
	}
	return continuedIn === undefined ? { list } : { list, continuedIn };
}
