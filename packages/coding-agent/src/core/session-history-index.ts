import { isAbsolute, relative, resolve, sep } from "node:path";
import { getLatestSessionName } from "./session-manager-entries.ts";
import { getBranchPath } from "./session-manager-history.ts";
import type { FileEntry, SessionEntry, SessionNameState } from "./session-manager-types.ts";
import type { PathContinuation, WorktreeRootMapping, WorktreeSnapshot } from "./worktree-snapshot/types.ts";

interface BranchView {
	readonly byId: ReadonlyMap<string, SessionEntry>;
	readonly links: ReadonlyMap<string, string> | undefined;
	leafId: string | null;
	readonly path: SessionEntry[];
	mappings: WorktreeRootMapping[] | undefined;
	continuations: PathContinuation[] | undefined;
	snapshots: RecordedSnapshot[] | undefined;
}

/** Whether `child` is `parent` or a path below it. */
function within(parent: string, child: string): boolean {
	const path = relative(resolve(parent), resolve(child));
	return !path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path);
}

interface EntryScan {
	readonly entries: readonly FileEntry[];
	scanned: number;
	readonly records: Map<string, WorktreeSnapshot>;
	name: SessionNameState;
}

export interface RecordedSnapshot {
	readonly root: string;
	readonly snapshotId: string;
}

/**
 * What a session manager reads again and again from its history, kept current as entries are appended, so a large
 * session is walked once rather than on every read (#4660): the active branch with its worktree restores and latest
 * snapshot per checkout, and, over all entries, the snapshot records and the session name. A read after any other
 * change (another leaf, or a rebuilt index) recomputes what it needs.
 */
export class SessionHistoryIndex {
	private view: BranchView | undefined;
	private scan: EntryScan | undefined;

	/** The branch from the root to `leafId`, which the caller must not change. */
	branch(
		leafId: string | null,
		byId: ReadonlyMap<string, SessionEntry>,
		links?: ReadonlyMap<string, string>,
	): readonly SessionEntry[] {
		return this.viewOf(leafId, byId, links).path;
	}

	/** Extends the cached branch when `entry` was appended at its leaf; anything else drops it. */
	appended(entry: SessionEntry, byId: ReadonlyMap<string, SessionEntry>): void {
		const view = this.view;
		if (view === undefined || view.byId !== byId || view.leafId !== entry.parentId) {
			this.view = undefined;
			return;
		}
		view.path.push(entry);
		view.leafId = entry.id;
		if (entry.type !== "worktree_snapshot") return;
		if (entry.restore) view.mappings?.push(entry.restore);
		view.continuations = undefined;
		view.snapshots?.push({ root: entry.root, snapshotId: entry.snapshotId });
	}

	/** The worktree restores recorded on the branch to `leafId`, oldest first. */
	worktreeRootMappings(
		leafId: string | null,
		byId: ReadonlyMap<string, SessionEntry>,
		links?: ReadonlyMap<string, string>,
	): WorktreeRootMapping[] {
		const view = this.viewOf(leafId, byId, links);
		view.mappings ??= view.path.flatMap((entry) =>
			entry.type === "worktree_snapshot" && entry.restore ? [entry.restore] : [],
		);
		return [...view.mappings];
	}

	/**
	 * Where the session continued instead of a checkout it worked in, on the branch to `leafId`: paths under the working
	 * directory it left there continue under the directory it went on in, until a later restore of that checkout.
	 */
	worktreePathContinuations(
		leafId: string | null,
		byId: ReadonlyMap<string, SessionEntry>,
		links?: ReadonlyMap<string, string>,
	): PathContinuation[] {
		const view = this.viewOf(leafId, byId, links);
		if (view.continuations === undefined) {
			let continuations: PathContinuation[] = [];
			for (const entry of view.path) {
				if (entry.type !== "worktree_snapshot") continue;
				const restored = entry.restore?.from;
				if (restored !== undefined)
					continuations = continuations.filter((continuation) => !within(restored, continuation.from));
				const from = entry.unrestored?.from;
				if (from !== undefined) {
					continuations = continuations.filter((continuation) => continuation.from !== from);
					continuations.push({ from, to: entry.unrestored!.continuedIn });
				}
			}
			view.continuations = continuations;
		}
		return [...view.continuations];
	}

	/** The snapshot entries on the branch to `leafId`, oldest first, which the caller must not change. */
	worktreeSnapshots(
		leafId: string | null,
		byId: ReadonlyMap<string, SessionEntry>,
		links?: ReadonlyMap<string, string>,
	): readonly RecordedSnapshot[] {
		const view = this.viewOf(leafId, byId, links);
		view.snapshots ??= view.path.flatMap((entry) =>
			entry.type === "worktree_snapshot" ? [{ root: entry.root, snapshotId: entry.snapshotId }] : [],
		);
		return view.snapshots;
	}

	/** Every snapshot record in `entries`, by id. */
	worktreeSnapshotRecords(entries: readonly FileEntry[]): Map<string, WorktreeSnapshot> {
		return new Map(this.scanOf(entries).records);
	}

	/** The name the latest `session_info` entry in `entries` gives the session. */
	sessionName(entries: readonly FileEntry[]): SessionNameState {
		return this.scanOf(entries).name;
	}

	private viewOf(
		leafId: string | null,
		byId: ReadonlyMap<string, SessionEntry>,
		links: ReadonlyMap<string, string> | undefined,
	): BranchView {
		if (this.view?.byId !== byId || this.view.leafId !== leafId || this.view.links !== links) {
			this.view = {
				byId,
				links,
				leafId,
				path: getBranchPath(leafId, byId, links),
				mappings: undefined,
				continuations: undefined,
				snapshots: undefined,
			};
		}
		return this.view;
	}

	private scanOf(entries: readonly FileEntry[]): EntryScan {
		if (this.scan?.entries !== entries || this.scan.scanned > entries.length) {
			this.scan = { entries, scanned: 0, records: new Map(), name: { hasName: false } };
		}
		const scan = this.scan;
		if (scan.scanned < entries.length) {
			const added = entries.slice(scan.scanned);
			for (const entry of added) {
				if (entry.type === "worktree_snapshot" && entry.snapshot)
					scan.records.set(entry.snapshotId, entry.snapshot);
			}
			const name = getLatestSessionName(added);
			if (name.hasName) scan.name = name;
			scan.scanned = entries.length;
		}
		return scan;
	}
}
