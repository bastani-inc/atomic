import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AssistantMessage } from "@bastani/pi-ai/compat";
import type { SessionManager } from "./session-manager.ts";
import { getBranchPath, getSessionLeafId } from "./session-manager-history.ts";
import type { SessionEntry, WorktreeRestoreHostWarning } from "./session-manager-types.ts";
import type { SessionStore } from "./storage/session/types.js";
import { snapshotBlobHashes } from "./worktree-snapshot/blob-store.ts";
import {
	captureWorktreeSnapshot,
	locateCheckout,
	type WorktreeSnapshotUnavailableReason,
	withScratchDirectory,
	writeWorkingTree,
} from "./worktree-snapshot/capture.ts";
import { sha256Hex } from "./worktree-snapshot/env-hash.ts";
import {
	findWorkspaceError,
	type GitUnavailableError,
	isGitUnavailableError,
	isWorkspaceDriftError,
	isWorkspaceError,
	isWorkspaceRestoreError,
	isWorkspaceSnapshotError,
	unreadablePathError,
	WorkspaceDriftError,
	type WorkspaceError,
	WorkspaceRestoreError,
	WorkspaceSnapshotError,
} from "./worktree-snapshot/errors.ts";
import { scheduleSnapshotCollection } from "./worktree-snapshot/garbage.ts";
import { gitText, runGit } from "./worktree-snapshot/git.ts";
import { isHeadOnlyAdvance } from "./worktree-snapshot/head-advance.ts";
import { canonicalizeWorktreePath } from "./worktree-snapshot/paths.ts";
import { loadSnapshotPathPolicy } from "./worktree-snapshot/policy.ts";
import {
	isDegradableRestoreFailure,
	removeRestoredWorktree,
	restoreDegradedWorktree,
	restoreWorktree,
	snapshotRestoreWarnings,
	verifyWorktree,
} from "./worktree-snapshot/restore.ts";
import type {
	SnapshotBlob,
	SnapshotBlobStore,
	WorktreeDegradedRestore,
	WorktreeRestoreWarning,
	WorktreeRootMapping,
	WorktreeSnapshot,
	WorktreeSnapshotSettings,
	WorktreeUnrestored,
} from "./worktree-snapshot/types.ts";

/** Why a turn's snapshot could not be recorded: Git is unavailable, or a typed workspace failure. */
export type WorktreeSnapshotUnavailable = WorkspaceError | GitUnavailableError;

/** Built-in tools that can change files: a turn that called one records a snapshot. */
export const FILE_WRITING_TOOLS: ReadonlySet<string> = new Set(["bash", "edit", "write", "powershell"]);
const PATH_TOOLS: ReadonlySet<string> = new Set(["edit", "write"]);

export interface TurnSnapshotDependencies {
	readonly sessionManager: SessionManager;
	readonly cwd: () => string;
	readonly settings: () => WorktreeSnapshotSettings;
	/** Whether a registered tool declares `writesFiles`. */
	readonly declaresWrites: (toolName: string) => boolean;
	/** Called once per distinct reason a snapshot could not be recorded. */
	readonly onUnavailable: (reason: WorktreeSnapshotUnavailable) => void;
}

function isInside(parent: string, child: string): boolean {
	const path = relative(canonicalizeWorktreePath(parent), canonicalizeWorktreePath(child));
	return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

/**
 * Records a `worktree_snapshot` entry per checkout at the end of each turn that called a file-writing tool. In-memory
 * sessions, which cannot be resumed elsewhere, record nothing.
 */
export class SessionWorktreeSnapshotRecorder {
	private readonly deps: TurnSnapshotDependencies;
	private readonly reported = new Set<string>();

	constructor(deps: TurnSnapshotDependencies) {
		this.deps = deps;
	}

	private report(reason: WorktreeSnapshotUnavailable): void {
		const key = `${reason.code}\0${JSON.stringify(reason.fields)}`;
		if (this.reported.has(key)) return;
		this.reported.add(key);
		this.deps.onUnavailable(reason);
	}

	/** Directories whose checkouts a turn may have changed: the session cwd and the targets of path-taking tools. */
	private touchedDirectories(message: AssistantMessage): string[] | undefined {
		const cwd = this.deps.cwd();
		const directories = new Set<string>();
		for (const part of message.content) {
			if (part.type !== "toolCall") continue;
			if (!FILE_WRITING_TOOLS.has(part.name) && !this.deps.declaresWrites(part.name)) continue;
			directories.add(cwd);
			const path = PATH_TOOLS.has(part.name) ? part.arguments.path : undefined;
			if (typeof path === "string" && path.length > 0) directories.add(resolve(cwd, path, ".."));
		}
		return directories.size === 0 ? undefined : [...directories];
	}

	/** Whether the turn may record a snapshot when it ends: a persisted session called a tool that can change files. */
	callsFileWritingTool(message: AssistantMessage): boolean {
		return this.deps.sessionManager.isPersisted() && this.touchedDirectories(message) !== undefined;
	}

	async recordTurn(message: AssistantMessage): Promise<void> {
		const directories = this.touchedDirectories(message);
		if (!directories) return;
		let settings: WorktreeSnapshotSettings;
		try {
			settings = this.deps.settings();
		} catch (error) {
			this.reportFailure(error);
			return;
		}
		if (!settings.enabled || !this.deps.sessionManager.isPersisted()) return;
		const blobs = this.deps.sessionManager.getSessionStore().snapshotBlobs;
		if (!blobs) {
			this.report(
				new WorkspaceSnapshotError(
					"blob-store-unsupported",
					this.deps.sessionManager.getSessionStore().descriptor.adapter,
				),
			);
			return;
		}
		const roots = new Set<string>();
		for (const directory of directories) {
			try {
				const checkout = await locateCheckout(await nearestExisting(directory));
				if (checkout instanceof Error) this.report(checkout);
				else roots.add(checkout.root);
			} catch (error) {
				this.reportFailure(error);
			}
		}
		for (const root of roots) {
			const previous = this.deps.sessionManager.getLatestWorktreeSnapshots().get(root);
			try {
				const result = await captureWorktreeSnapshot(root, { settings, previous, blobs });
				if (result.status === "captured") {
					await this.deps.sessionManager.appendWorktreeSnapshot(root, result.snapshot.id, result.snapshot);
				} else if (result.status === "unchanged") {
					await this.deps.sessionManager.appendWorktreeSnapshot(root, result.snapshot.id);
				} else if (result.status === "unavailable") {
					this.report(result.reason);
				}
			} catch (error) {
				this.reportFailure(error);
			}
		}
	}

	/**
	 * Starts an automatic collection of the session store's unreferenced snapshot blobs when one is due, and returns
	 * without waiting for it. Called when the session closes.
	 */
	scheduleCollection(): void {
		let settings: WorktreeSnapshotSettings;
		try {
			settings = this.deps.settings();
		} catch (error) {
			this.reportFailure(error);
			return;
		}
		void scheduleSnapshotCollection(this.deps.sessionManager.getSessionStore().snapshotBlobs, settings);
	}

	private reportFailure(error: unknown): void {
		const reason = isGitUnavailableError(error) ? error : findWorkspaceError(error);
		if (!reason) throw error;
		this.report(reason);
	}
}

async function nearestExisting(directory: string): Promise<string> {
	for (let current = directory; ; current = resolve(current, "..")) {
		try {
			if ((await stat(current)).isDirectory()) return current;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR")
				throw unreadablePathError(current, error);
		}
		if (resolve(current, "..") === current) return current;
	}
}

/** `path` rewritten through each restore in order: a path under `from` moves to the same place under `to`. */
export function mapRestoredPath(path: string, mappings: readonly WorktreeRootMapping[]): string {
	let mapped = resolve(path);
	let next = 0;
	while (next < mappings.length) {
		const current = canonicalizeWorktreePath(mapped);
		let best: { index: number; source: string } | undefined;
		for (let index = next; index < mappings.length; index++) {
			const source = canonicalizeWorktreePath(mappings[index]!.from);
			if (isInside(source, current) && (best === undefined || source.length > best.source.length)) {
				best = { index, source };
			}
		}
		if (best === undefined) break;
		mapped = resolve(mappings[best.index]!.to, relative(best.source, current));
		next = best.index + 1;
	}
	return mapped;
}

/** Recover the original root of a sequence of restores, so a restored root supersedes its earlier location. */
function originalRoot(root: string, mappings: readonly WorktreeRootMapping[]): string {
	let current = canonicalizeWorktreePath(root);
	for (let index = mappings.length - 1; index >= 0; index--) {
		const mapping = mappings[index]!;
		if (canonicalizeWorktreePath(mapping.to) === current) current = canonicalizeWorktreePath(mapping.from);
	}
	return current;
}

/** The id of the latest snapshot of each checkout on the active branch, keyed by the root it was first recorded under. */
function latestSnapshotIdsByCheckout(
	sessionManager: Pick<SessionManager, "getBranch">,
	mappings: readonly WorktreeRootMapping[],
): Map<string, string> {
	const latestIds = new Map<string, string>();
	for (const entry of sessionManager.getBranch()) {
		if (entry.type === "worktree_snapshot") latestIds.set(originalRoot(entry.root, mappings), entry.snapshotId);
	}
	return latestIds;
}

/** The checkouts on the active branch whose latest snapshot the session holds no record of, where they are now (#4733). */
export function missingSnapshotRecords(
	sessionManager: Pick<SessionManager, "getBranch" | "getWorktreeRootMappings" | "getWorktreeSnapshotRecords">,
): MissingSnapshotRecord[] {
	const mappings = sessionManager.getWorktreeRootMappings();
	const records = sessionManager.getWorktreeSnapshotRecords();
	const missing: MissingSnapshotRecord[] = [];
	for (const [original, snapshotId] of latestSnapshotIdsByCheckout(sessionManager, mappings)) {
		if (!records.has(snapshotId)) missing.push({ root: mapRestoredPath(original, mappings), snapshotId });
	}
	return missing;
}

/**
 * The latest snapshot of each checkout on the active branch, keyed by where that checkout is now: a checkout restored
 * elsewhere appears once, under its newest location. A snapshot whose record is missing is left out.
 */
export function currentWorktreeSnapshots(
	sessionManager: Pick<SessionManager, "getBranch" | "getWorktreeRootMappings" | "getWorktreeSnapshotRecords">,
): Map<string, WorktreeSnapshot> {
	const mappings = sessionManager.getWorktreeRootMappings();
	const records = sessionManager.getWorktreeSnapshotRecords();
	const current = new Map<string, WorktreeSnapshot>();
	for (const [original, snapshotId] of latestSnapshotIdsByCheckout(sessionManager, mappings)) {
		const snapshot = records.get(snapshotId);
		if (snapshot) current.set(mapRestoredPath(original, mappings), snapshot);
	}
	return current;
}

/** A checkout a resume continued without, because nothing of its snapshot could be restored here (#4733). */
export interface UnrestoredWorktree {
	readonly root: string;
	readonly snapshot: WorktreeSnapshot;
	/** Why: the restore error, or Git being unavailable. */
	readonly reason: Error;
	/** The record the resume wrote for it in the session. */
	readonly record: WorktreeUnrestored;
}

/** A checkout whose latest snapshot the session refers to without holding its record (#4733). */
export interface MissingSnapshotRecord {
	readonly root: string;
	readonly snapshotId: string;
}

export type SessionWorktreeResume =
	| { readonly status: "none"; readonly missingRecords?: readonly MissingSnapshotRecord[] }
	| {
			readonly status: "verified";
			readonly snapshot: WorktreeSnapshot;
			readonly cwd: string;
			readonly unrestored: readonly UnrestoredWorktree[];
			readonly missingRecords?: readonly MissingSnapshotRecord[];
	  }
	| {
			readonly status: "restored";
			readonly snapshot: WorktreeSnapshot;
			readonly mappings: readonly WorktreeRootMapping[];
			readonly cwd: string;
			readonly warnings: readonly WorktreeRestoreWarning[];
			readonly unrestored: readonly UnrestoredWorktree[];
			readonly missingRecords?: readonly MissingSnapshotRecord[];
	  };

export interface ResumeSessionWorktreeOptions {
	readonly settings: WorktreeSnapshotSettings;
	/** Host directory for shared object stores and restored worktrees. Default ~/.atomic/agent/worktree-snapshots. */
	readonly storeDir?: string;
	readonly signal?: AbortSignal;
	/**
	 * Called with the new mappings, none when nothing needed restoring, once every checkout is restored and before any
	 * of them is recorded. When it throws, nothing is recorded and the restored worktrees are removed, as for a failed
	 * restore.
	 */
	readonly beforeRecord?: (mappings: readonly WorktreeRootMapping[]) => Promise<void>;
	/**
	 * Mappings to checkouts already here that the session continues in, applied as if recorded while deciding what to
	 * restore, and recorded first, with the restores, only once every checkout is restored and `beforeRecord` passed.
	 */
	readonly pendingMappings?: readonly WorktreeRootMapping[];
	/** Checkouts, by the root the session's restores put them at, to continue in as they are without verifying them. */
	readonly keepInPlace?: ReadonlySet<string>;
	/**
	 * Checkouts, by the same roots, that cannot be restored on this host, with the reason, such as Git being
	 * unavailable: the resume continues without them, as for a restore that gives nothing (#4733).
	 */
	readonly cannotRestore?: ReadonlyMap<string, Error>;
	/**
	 * Where the session continues when the checkout it works in is not restored and its working directory is not on
	 * this host: the directory the resume started from. Default: the recorded working directory.
	 */
	readonly fallbackCwd?: string;
	/**
	 * Continue without a checkout whose latest snapshot the session holds no record of, listing it in `missingRecords`,
	 * instead of failing with `snapshot-not-found` before anything is restored (#4733).
	 */
	readonly skipMissingRecords?: boolean;
}

/**
 * Whether a failed restore of one checkout leaves the resume able to continue without the exact state (#4733): any
 * typed workspace or Git failure, except a snapshot record that fails the security checks (`invalid-snapshot`) and a
 * target that holds other files (`unsafe-target`), which refuse the resume.
 */
export function isRecoverableRestoreFailure(error: unknown): error is Error {
	if (isWorkspaceRestoreError(error) && (error.code === "invalid-snapshot" || error.code === "unsafe-target")) {
		return false;
	}
	return (isWorkspaceError(error) && error.code !== "invalid-setting") || isGitUnavailableError(error);
}

/**
 * The commits of every earlier snapshot of the checkout on the branch, newest first and each once, to restore when its
 * own is out of reach (#4744). The restore stops at the first it holds or fetches, so a nearer one costs no more.
 */
function earlierSnapshotHeads(
	sessionManager: Pick<SessionManager, "getBranch" | "getWorktreeSnapshotRecords">,
	original: string,
	mappings: readonly WorktreeRootMapping[],
	snapshot: WorktreeSnapshot,
): string[] {
	const records = sessionManager.getWorktreeSnapshotRecords();
	const heads: string[] = [];
	for (const entry of [...sessionManager.getBranch()].reverse()) {
		if (entry.type !== "worktree_snapshot" || originalRoot(entry.root, mappings) !== original) continue;
		const head = records.get(entry.snapshotId)?.head;
		if (head !== undefined && head !== snapshot.head) heads.push(head);
	}
	return [...new Set(heads)];
}

/** What a resume tells about a checkout it continued without: why, as a clause, and what to do. */
function unrestoredReason(snapshot: WorktreeSnapshot, reason: Error): { detail: string; hint: string } {
	const head = snapshot.head.slice(0, 12);
	if (isGitUnavailableError(reason)) {
		return {
			detail: `Git is unavailable here (${reason.code}), which checking and restoring it need`,
			hint: reason.hint ?? "",
		};
	}
	if (isWorkspaceRestoreError(reason)) {
		switch (reason.code) {
			case "commits-unavailable":
				return {
					detail:
						reason.reason === "denied-history"
							? `its commit ${head} is not on its recorded remotes, and its unpushed commits touch files snapshots never copy`
							: reason.reason === "bundle-over-cap"
								? `its commit ${head} is not on its recorded remotes, and its unpushed commits were too large to record`
								: `its commit ${head} and the commits around it are not on its recorded remotes`,
					hint: reason.hint,
				};
			case "snapshot-not-found":
				return { detail: "the session holds no record of its snapshot", hint: reason.hint };
			case "blob-missing":
			case "blob-corrupt":
				return { detail: "part of its recorded content is not in this storage", hint: reason.hint };
			default:
				return { detail: reason.summary, hint: reason.hint };
		}
	}
	return {
		detail: isWorkspaceError(reason) ? reason.summary : reason.message,
		hint: isWorkspaceError(reason) ? reason.hint : "",
	};
}

/**
 * Checks the latest recorded snapshot of each checkout on the active session branch. Drifted or missing checkouts are
 * restored into fresh worktrees, and each old→new mapping is recorded only after all checkouts have been restored.
 * The returned cwd follows those mappings. A HEAD-only advance over identical content also resumes in place.
 */
export async function resumeSessionWorktree(
	sessionManager: SessionManager,
	options: ResumeSessionWorktreeOptions,
): Promise<SessionWorktreeResume> {
	if (!options.settings.enabled) return { status: "none" };
	const pending = options.pendingMappings ?? [];
	const existing = [...sessionManager.getWorktreeRootMappings(), ...pending];
	const records = sessionManager.getWorktreeSnapshotRecords();
	const latestIds = latestSnapshotIdsByCheckout(sessionManager, existing);
	const latest = new Map<string, WorktreeSnapshot>();
	const missingRecords: MissingSnapshotRecord[] = [];
	for (const [root, snapshotId] of latestIds) {
		const snapshot = records.get(snapshotId);
		if (!snapshot && options.skipMissingRecords) {
			missingRecords.push({ root: mapRestoredPath(root, existing), snapshotId });
			continue;
		}
		if (!snapshot) throw new WorkspaceRestoreError("snapshot-not-found", { snapshotId, target: root });
		latest.set(root, snapshot);
	}
	if (latest.size === 0) return missingRecords.length === 0 ? { status: "none" } : { status: "none", missingRecords };
	const cwd = mapRestoredPath(sessionManager.getCwd(), existing);
	const mappings: WorktreeRootMapping[] = [];
	const warnings: WorktreeRestoreWarning[] = [];
	const hostWarnings = new Map<WorktreeRootMapping, WorktreeRestoreHostWarning[]>();
	const reportedLeftovers = new Set<string>();
	const left: { root: string; snapshot: WorktreeSnapshot; reason: Error }[] = [];
	const unrestored: UnrestoredWorktree[] = [];
	let continuedIn: string;
	let selected: { root: string; snapshot: WorktreeSnapshot } | undefined;
	try {
		for (const [original, snapshot] of latest) {
			options.signal?.throwIfAborted();
			const root = mapRestoredPath(original, existing);
			if (isInside(root, cwd) && (!selected || root.length > selected.root.length)) selected = { root, snapshot };
			if (options.keepInPlace?.has(root)) continue;
			const cannot = options.cannotRestore?.get(root);
			if (cannot !== undefined) {
				left.push({ root, snapshot, reason: cannot });
				continue;
			}
			let drift: WorkspaceDriftError;
			try {
				await verifyWorktree(snapshot, root, { settings: options.settings, signal: options.signal });
				continue;
			} catch (error) {
				options.signal?.throwIfAborted();
				if (isWorkspaceDriftError(error)) {
					if (await isHeadOnlyAdvance(error, options.signal)) continue;
					drift = error;
				} else if (isWorkspaceSnapshotError(error)) {
					drift = new WorkspaceDriftError(
						{
							root,
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
			const refused = (error: Error) =>
				new WorkspaceDriftError(
					{
						root: drift.root,
						expectedHead: drift.expectedHead,
						actualHead: drift.actualHead,
						expectedTree: drift.expectedTree,
						actualTree: drift.actualTree,
						snapshotId: drift.snapshotId,
						reason: "restore-failed",
					},
					error,
				);
			const blobs = sessionSnapshotBlobs(
				sessionManager.getSessionStore().snapshotBlobs,
				sessionManager.getEntries(),
			);
			let restored: {
				path: string;
				warnings: readonly WorktreeRestoreWarning[];
				degraded?: WorktreeDegradedRestore;
			};
			try {
				restored = await restoreWorktree(snapshot, { blobs, storeDir: options.storeDir, signal: options.signal });
			} catch (error) {
				options.signal?.throwIfAborted();
				if (!(error instanceof Error)) throw error;
				if (!isRecoverableRestoreFailure(error)) throw refused(error);
				// The exact state is out of reach: restore the best this host can, else continue without the checkout.
				let degraded: Awaited<ReturnType<typeof restoreDegradedWorktree>> | undefined;
				if (isDegradableRestoreFailure(error)) {
					try {
						degraded = await restoreDegradedWorktree(snapshot, error, {
							blobs,
							storeDir: options.storeDir,
							signal: options.signal,
							candidates: earlierSnapshotHeads(sessionManager, original, existing, snapshot),
						});
					} catch (degradedError) {
						options.signal?.throwIfAborted();
						if (!(degradedError instanceof Error)) throw degradedError;
						if (!isRecoverableRestoreFailure(degradedError)) throw refused(degradedError);
					}
				}
				if (degraded === undefined) {
					left.push({ root, snapshot, reason: error });
					continue;
				}
				restored = degraded;
			}
			const mapping: WorktreeRootMapping = {
				from: root,
				to: restored.path,
				snapshotId: snapshot.id,
				tree: snapshot.tree,
				restoredAt: new Date().toISOString(),
				...(restored.degraded === undefined ? {} : { degraded: restored.degraded }),
			};
			mappings.push(mapping);
			warnings.push(...restored.warnings);
			hostWarnings.set(
				mapping,
				restored.warnings.filter((warning): warning is WorktreeRestoreHostWarning => {
					if (warning.code === "lfs-objects-unavailable") return true;
					if (warning.code !== "stale-restore-retained" || reportedLeftovers.has(warning.path)) return false;
					reportedLeftovers.add(warning.path);
					return true;
				}),
			);
		}
		await options.beforeRecord?.(mappings);
		for (const mapping of [...pending, ...mappings]) {
			options.signal?.throwIfAborted();
			await sessionManager.appendWorktreeSnapshot(
				mapping.to,
				mapping.snapshotId,
				undefined,
				mapping,
				hostWarnings.get(mapping),
			);
		}
		const continuing = mapRestoredPath(cwd, mappings);
		const recordedHere = selected !== undefined && left.some((checkout) => checkout.root === selected!.root);
		const launch = recordedHere && !existsSync(continuing) && options.fallbackCwd !== undefined;
		continuedIn = launch ? resolve(options.fallbackCwd!) : continuing;
		for (const checkout of left) {
			const at = new Date().toISOString();
			const record: WorktreeUnrestored = {
				snapshotId: checkout.snapshot.id,
				continuedIn,
				place: launch ? "launch" : "recorded",
				cause:
					isWorkspaceError(checkout.reason) || isGitUnavailableError(checkout.reason)
						? checkout.reason.code
						: "error",
				...(isWorkspaceRestoreError(checkout.reason) && checkout.reason.reason !== undefined
					? { causeReason: String(checkout.reason.reason) }
					: {}),
				...unrestoredReason(checkout.snapshot, checkout.reason),
				at,
			};
			await sessionManager.appendWorktreeSnapshot(
				checkout.root,
				checkout.snapshot.id,
				undefined,
				undefined,
				[],
				record,
			);
			unrestored.push({ ...checkout, record });
		}
	} catch (error) {
		const cleanupFailures: unknown[] = [];
		for (const mapping of [...mappings].reverse()) {
			try {
				await removeRestoredWorktree(mapping.to, { storeDir: options.storeDir });
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
	const snapshot = selected?.snapshot ?? [...latest.values()].at(-1)!;
	const missing = missingRecords.length === 0 ? {} : { missingRecords };
	return mappings.length === 0
		? { status: "verified", snapshot, cwd: continuedIn, unrestored, ...missing }
		: { status: "restored", snapshot, mappings, cwd: continuedIn, warnings, unrestored, ...missing };
}

/** The one-line notice shown when a session or run continues in a restored worktree. */
export function formatWorktreeRestoreNotice(mapping: WorktreeRootMapping): string {
	return `Restored worktree snapshot ${mapping.snapshotId.slice(0, 12)} of ${mapping.from} into ${mapping.to}`;
}

/** One line per restore warning, for the notices shown after a restore. */
export function formatWorktreeRestoreWarning(warning: WorktreeRestoreWarning): string {
	switch (warning.code) {
		case "omitted-content":
			return `The restored snapshot left out ${warning.omitted.length} item(s): ${warning.omitted
				.map((omission) => ("path" in omission ? `${omission.path} (${omission.reason})` : omission.reason))
				.join(", ")}`;
		case "filters":
			return `The source checkout used conversion settings (${[
				warning.filters.autocrlf === null ? undefined : `core.autocrlf=${warning.filters.autocrlf}`,
				warning.filters.eol === null ? undefined : `core.eol=${warning.filters.eol}`,
				...warning.filters.drivers.map((driver) => `filter=${driver}`),
			]
				.filter(Boolean)
				.join(", ")}); the restore holds Git's stored content with LF line endings`;
		case "lfs-objects-unavailable":
			return `Git LFS objects could not be fetched; these files hold LFS pointers: ${warning.paths.join(", ")}`;
		case "stale-restore-retained":
			switch (warning.kind) {
				case "worktree":
					return `A restore interrupted earlier left ${warning.path}; remove it with removeRestoredWorktree or delete the directory`;
				case "record":
					return `A restore interrupted earlier left the crash record ${warning.path}, which cannot be read; delete the file`;
				case "records-directory":
					return `The restore crash records in ${warning.path} cannot be read; make the directory readable or remove it`;
			}
	}
}

/** The first 12 characters of a commit or snapshot id, as notices show them. */
function short(id: string): string {
	return id.slice(0, 12);
}

/** What a degraded restore checked out, for its notice. */
function degradedBasis(degraded: WorktreeDegradedRestore, snapshot: WorktreeSnapshot | undefined): string {
	switch (degraded.basis) {
		case "pushed-base":
			return `the last pushed commit before it, ${short(degraded.head)}`;
		case "earlier-snapshot":
			return `${short(degraded.head)}, the commit of an earlier snapshot of this session`;
		default:
			return `${short(degraded.head)}, the tip of ${snapshot?.branch ? `branch ${snapshot.branch}` : "the default branch"} on its remote`;
	}
}

function listed(items: readonly string[], limit = 5): string {
	return items.length <= limit
		? items.join(", ")
		: `${items.slice(0, limit).join(", ")} and ${items.length - limit} more`;
}

/**
 * The one notice for a worktree restored with less than its snapshot (#4733): what it holds, what is missing and what
 * to do to get the rest.
 */
export function formatDegradedRestoreNotice(
	mapping: WorktreeRootMapping,
	snapshot: WorktreeSnapshot | undefined,
	warnings: readonly WorktreeRestoreHostWarning[] = [],
): string {
	const lfs = warnings
		.filter((warning) => warning.code === "lfs-objects-unavailable")
		.map((warning) => ` ${formatWorktreeRestoreWarning(warning)}.`)
		.join("");
	return `${degradedRestoreSummary(mapping, snapshot)}${lfs}`;
}

function degradedRestoreSummary(mapping: WorktreeRootMapping, snapshot: WorktreeSnapshot | undefined): string {
	const degraded = mapping.degraded!;
	const links = snapshot?.chain.length ?? 0;
	const restored = `Restored ${mapping.from} into ${mapping.to}`;
	const missingPaths = degraded.missingPaths.length > 0 ? `: ${listed(degraded.missingPaths)}` : "";
	if (degraded.stage === "partial-changes") {
		const missing =
			degraded.missingLinks.length > 0
				? `change set${degraded.missingLinks.length === 1 ? "" : "s"} ${degraded.missingLinks.join(", ")}${missingPaths}`
				: `the recorded content of ${listed(degraded.missingPaths)}, which differs on this machine`;
		return `${restored} at its recorded commit ${short(degraded.head)} with ${links - degraded.missingLinks.length} of the ${links} change sets of snapshot ${short(mapping.snapshotId)}. Not restored: ${missing}. ${degraded.hint}`;
	}
	const commits = degraded.missingCommits.length;
	const recorded = snapshot === undefined ? "" : ` instead of the recorded commit ${short(snapshot.head)}`;
	const changes = degraded.missingLinks.length > 0 ? " and the snapshot's uncommitted changes" : "";
	return `${restored} at ${degradedBasis(degraded, snapshot)}${recorded}, the closest commit available here. Not restored: ${commits} commit${commits === 1 ? "" : "s"} (${listed(degraded.missingCommits.map(short), 3)})${changes} of snapshot ${short(mapping.snapshotId)}. ${degraded.hint}`;
}

/** The notice for a checkout whose snapshot the session holds no record of, which a resume continued without. */
export function formatMissingRecordNotice(missing: MissingSnapshotRecord): string {
	return `Continuing without restoring ${missing.root}: the session holds no record of its snapshot ${short(missing.snapshotId)}. Resume on the machine that recorded it, or import (\`atomic --import <file>\`) a session saved there with \`/export <file>.jsonl\`, which carries its snapshots.`;
}

/** The one notice for a checkout a resume continued without (#4733). */
export function formatUnrestoredNotice(root: string, unrestored: WorktreeUnrestored): string {
	const place =
		unrestored.place === "launch" ? "the directory the resume started from" : "the session's own directory";
	return `Continuing in ${unrestored.continuedIn} (${place}) without restoring ${root} from snapshot ${short(unrestored.snapshotId)}: ${unrestored.detail}. ${unrestored.hint}`.trimEnd();
}

/**
 * One informational line per worktree restored since `since`, each followed by its snapshot's warnings and what the
 * restore itself reported; one notice per worktree restored with less than its snapshot, and per checkout a resume
 * continued without, since `since` (#4733).
 */
export function worktreeRestoreNotices(
	sessionManager: Pick<SessionManager, "getBranch" | "getWorktreeSnapshotRecords">,
	since: string,
): { readonly type: "info" | "warning"; readonly message: string }[] {
	return restoreNotices(sessionManager, (entry) =>
		entry.restore
			? entry.restore.restoredAt >= since
			: entry.unrestored !== undefined && entry.unrestored.at >= since,
	);
}

function restoreNotices(
	sessionManager: Pick<SessionManager, "getBranch" | "getWorktreeSnapshotRecords">,
	include: (entry: Extract<SessionEntry, { type: "worktree_snapshot" }>) => boolean,
): { readonly type: "info" | "warning"; readonly message: string }[] {
	const records = sessionManager.getWorktreeSnapshotRecords();
	return sessionManager.getBranch().flatMap((entry) => {
		if (entry.type !== "worktree_snapshot" || !include(entry)) return [];
		if (entry.unrestored) {
			return [{ type: "warning" as const, message: formatUnrestoredNotice(entry.root, entry.unrestored) }];
		}
		if (!entry.restore) return [];
		const snapshot = records.get(entry.snapshotId);
		if (entry.restore.degraded) {
			const message = formatDegradedRestoreNotice(entry.restore, snapshot, entry.restoreWarnings);
			return [{ type: "warning" as const, message }];
		}
		return [
			{ type: "info" as const, message: formatWorktreeRestoreNotice(entry.restore) },
			...[...(snapshot ? snapshotRestoreWarnings(snapshot) : []), ...(entry.restoreWarnings ?? [])].map(
				(warning) => ({ type: "warning" as const, message: formatWorktreeRestoreWarning(warning) }),
			),
		];
	});
}

/**
 * `entries` with each snapshot's record and blobs from `store` carried inline, each once, so the exported file
 * restores without the source storage. Without a store only the records are carried. A blob the store no longer has
 * is left out; restoring that snapshot then fails with `blob-missing`.
 */
export async function inlineSnapshotBlobs(
	entries: readonly SessionEntry[],
	records: ReadonlyMap<string, WorktreeSnapshot>,
	store: SnapshotBlobStore | undefined,
): Promise<SessionEntry[]> {
	const emittedRecords = new Set<string>();
	const emittedBlobs = new Set<string>();
	const result: SessionEntry[] = [];
	for (const entry of entries) {
		if (entry.type !== "worktree_snapshot") {
			result.push(entry);
			continue;
		}
		const record = entry.snapshot ?? records.get(entry.snapshotId);
		const { blobs: _carried, snapshot: _record, ...rest } = entry;
		const blobs: Record<string, string> = {};
		if (record && store) {
			for (const hash of snapshotBlobHashes(record)) {
				if (emittedBlobs.has(hash)) continue;
				const data = await store.getBlob(hash);
				if (data === undefined) continue;
				blobs[hash] = Buffer.from(data).toString("base64");
				emittedBlobs.add(hash);
			}
		}
		const carryRecord = record !== undefined && !emittedRecords.has(record.id);
		if (record) emittedRecords.add(record.id);
		result.push({
			...rest,
			...(carryRecord ? { snapshot: record } : {}),
			...(Object.keys(blobs).length > 0 ? { blobs } : {}),
		});
	}
	return result;
}

/**
 * Moves inline blobs into `store` after checking each against its hash, and returns the entries without them.
 * Without a store the entries keep their blobs, which restore reads directly. Throws `blob-corrupt` before writing
 * anything when a blob does not match its hash.
 */
export async function adoptInlineSnapshotBlobs(
	entries: readonly SessionEntry[],
	store: SnapshotBlobStore | undefined,
): Promise<SessionEntry[]> {
	const blobs: SnapshotBlob[] = [];
	for (const entry of entries) {
		if (entry.type !== "worktree_snapshot" || !entry.blobs) continue;
		for (const [hash, base64] of Object.entries(entry.blobs)) {
			const data = new Uint8Array(Buffer.from(base64, "base64"));
			if (sha256Hex(data) !== hash) {
				throw new WorkspaceRestoreError("blob-corrupt", { snapshotId: entry.snapshotId, blob: hash });
			}
			blobs.push({ hash, data });
		}
	}
	if (!store || blobs.length === 0) return [...entries];
	await store.putBlobs(blobs);
	return entries.map((entry) => {
		if (entry.type !== "worktree_snapshot" || !entry.blobs) return entry;
		const { blobs: _moved, ...rest } = entry;
		return rest;
	});
}

/** A read-only view of the blobs carried inline by `entries`. */
export function inlineBlobStore(entries: readonly SessionEntry[]): SnapshotBlobStore {
	const blobs = new Map<string, string>();
	for (const entry of entries) {
		if (entry.type === "worktree_snapshot" && entry.blobs) {
			for (const [hash, base64] of Object.entries(entry.blobs)) blobs.set(hash, base64);
		}
	}
	return {
		async putBlobs() {
			throw new WorkspaceSnapshotError("blob-store-unsupported", "inline");
		},
		async getBlob(hash) {
			const base64 = blobs.get(hash);
			return base64 === undefined ? undefined : new Uint8Array(Buffer.from(base64, "base64"));
		},
		async refreshBlobs(hashes) {
			return hashes.every((hash) => blobs.has(hash));
		},
		async listBlobHashes() {
			return [...blobs.keys()];
		},
	};
}

/** Reads `primary` first, then the blobs carried inline by `entries`. */
export function sessionSnapshotBlobs(
	primary: SnapshotBlobStore | undefined,
	entries: readonly SessionEntry[],
): SnapshotBlobStore {
	const inline = inlineBlobStore(entries);
	if (!primary) return inline;
	return {
		putBlobs: (blobs) => primary.putBlobs(blobs),
		getBlob: async (hash) => (await primary.getBlob(hash)) ?? (await inline.getBlob(hash)),
		refreshBlobs: (hashes) => primary.refreshBlobs(hashes),
		listBlobHashes: () => primary.listBlobHashes(),
	};
}

/** What an export of `entries` carries: checkouts, snapshots and the bytes of patch and bundle content. */
export function describeSnapshotExport(
	entries: readonly SessionEntry[],
	records: ReadonlyMap<string, WorktreeSnapshot>,
): string | undefined {
	const roots = new Set<string>();
	const snapshots = new Set<string>();
	const blobBytes = new Map<string, number>();
	let omitted = 0;
	for (const entry of entries) {
		if (entry.type !== "worktree_snapshot" || snapshots.has(entry.snapshotId)) continue;
		snapshots.add(entry.snapshotId);
		const record = entry.snapshot ?? records.get(entry.snapshotId);
		if (!record) continue;
		roots.add(record.root);
		omitted += record.omitted.length;
		for (const link of record.chain) if (link.patch) blobBytes.set(link.patch, link.bytes);
		if (record.bundle) blobBytes.set(record.bundle.blob, record.bundle.bytes);
	}
	if (snapshots.size === 0) return undefined;
	const bytes = [...blobBytes.values()].reduce((sum, size) => sum + size, 0);
	return `Includes ${snapshots.size} worktree snapshot(s) of ${[...roots].join(", ")}: ${bytes} bytes of patch and bundle content${omitted > 0 ? `, ${omitted} omitted item(s) not included` : ""}`;
}

export type WorktreeSnapshotComparison =
	| { readonly status: "match"; readonly tree: string; readonly head?: string }
	| { readonly status: "missing"; readonly reason: WorktreeSnapshotUnavailableReason }
	| {
			readonly status: "differs";
			readonly head: string;
			readonly tree: string;
			/** `git diff --stat` from the snapshot's tree to the current one, when the snapshot's tree is present locally. */
			readonly stat: string | undefined;
	  };

/** Compares the checkout at `dir` with `snapshot`, for `/session snapshot`. */
export async function compareWorktreeSnapshot(
	snapshot: WorktreeSnapshot,
	dir: string,
	settings: WorktreeSnapshotSettings,
): Promise<WorktreeSnapshotComparison> {
	const checkout = await locateCheckout(dir);
	if (checkout instanceof Error) return { status: "missing", reason: checkout };
	const present = await runGit(["cat-file", "-e", `${snapshot.tree}^{tree}`], {
		cwd: checkout.root,
		allowExitCodes: [1, 128],
	});
	const policy = await loadSnapshotPathPolicy(checkout.root);
	const state = await withScratchDirectory((scratch) =>
		writeWorkingTree(checkout, settings, policy, scratch, present.exitCode === 0 ? { seedTree: snapshot.tree } : {}),
	);
	if (state.tree === snapshot.tree) {
		if (checkout.head === snapshot.head) return { status: "match", tree: state.tree };
		const drift = new WorkspaceDriftError({
			root: checkout.root,
			expectedHead: snapshot.head,
			actualHead: checkout.head,
			expectedTree: snapshot.tree,
			actualTree: state.tree,
			snapshotId: snapshot.id,
		});
		if (await isHeadOnlyAdvance(drift)) return { status: "match", tree: state.tree, head: checkout.head };
	}
	const stat =
		present.exitCode === 0
			? await gitText(["diff-tree", "--stat", "--no-renames", "--no-ext-diff", "-r", snapshot.tree, state.tree], {
					cwd: checkout.root,
				})
			: undefined;
	return { status: "differs", head: checkout.head, tree: state.tree, stat };
}

/**
 * What the last resume did about the checkout now at `root`, for `/session snapshot`, when it restored less than the
 * snapshot or nothing of it (#4733): the notice that resume showed. Undefined after a complete restore, or none.
 */
export function describeWorktreeRestoreStatus(
	sessionManager: Pick<SessionManager, "getBranch" | "getWorktreeSnapshotRecords">,
	root: string,
): string | undefined {
	const records = sessionManager.getWorktreeSnapshotRecords();
	let status: { readonly snapshotId: string; readonly message: string } | undefined;
	for (const entry of sessionManager.getBranch()) {
		if (entry.type !== "worktree_snapshot") continue;
		if (entry.restore && resolve(entry.restore.to) === resolve(root)) {
			status = entry.restore.degraded
				? {
						snapshotId: entry.snapshotId,
						message: formatDegradedRestoreNotice(
							entry.restore,
							records.get(entry.snapshotId),
							entry.restoreWarnings,
						),
					}
				: undefined;
		} else if (entry.unrestored && resolve(entry.root) === resolve(root)) {
			status = { snapshotId: entry.snapshotId, message: formatUnrestoredNotice(entry.root, entry.unrestored) };
		} else if (status && resolve(entry.root) === resolve(root) && entry.snapshotId !== status.snapshotId) {
			// A later snapshot of the checkout records what it holds now, which replaces what the resume left out.
			status = undefined;
		}
	}
	return status?.message;
}

/** Lines describing `snapshot` for `/session snapshot`. */
export function describeWorktreeSnapshot(root: string, snapshot: WorktreeSnapshot): string[] {
	const omitted = snapshot.omitted.map((omission) =>
		"path" in omission
			? `${omission.path} (${omission.reason})`
			: `${omission.commits.length} commit(s) (${omission.reason})`,
	);
	return [
		`${root}`,
		`  snapshot ${snapshot.id} captured ${snapshot.capturedAt}`,
		`  ${snapshot.branch ?? "detached"} at ${snapshot.head.slice(0, 12)}, tree ${snapshot.tree.slice(0, 12)}`,
		`  delta chain ${snapshot.chain.length} link(s), ${snapshot.chain.reduce((sum, link) => sum + link.bytes, 0)} bytes; ${
			snapshot.bundle
				? `${snapshot.bundle.commits.length} unpushed commit(s) bundled`
				: "no unpushed commits bundled"
		}`,
		...(omitted.length > 0 ? [`  omitted: ${omitted.join(", ")}`] : []),
		...(snapshot.filters
			? snapshotRestoreWarnings({ ...snapshot, omitted: [] }).map(formatWorktreeRestoreWarning)
			: []),
	];
}

/**
 * Opens `sessionManager`'s session where it should continue: in place when its checkout matches the last snapshot,
 * in the restored worktree otherwise. Returns the notices to show for a restore it performed.
 */
export async function openSessionInWorktree(
	sessionManager: SessionManager,
	options: ResumeSessionWorktreeOptions & { readonly sessionDirectory?: string },
): Promise<{
	readonly sessionManager: SessionManager;
	readonly notices: { readonly type: "info" | "warning"; readonly message: string }[];
}> {
	const resume = await resumeSessionWorktree(sessionManager, options);
	return openResumedSession(
		sessionManager,
		resume.status === "none" ? sessionManager.getCwd() : resume.cwd,
		resume.status === "restored" ? resume.mappings : [],
		options.sessionDirectory,
		resume.status === "none" ? [] : resume.unrestored.map((checkout) => checkout.record),
	);
}

/**
 * Opens `sessionManager`'s session in `cwd`, where resuming it left its working directory, and returns the notices to
 * show for the worktrees that resuming `restored` it into.
 */
export async function openResumedSession(
	sessionManager: SessionManager,
	cwd: string,
	restored: readonly WorktreeRootMapping[],
	sessionDirectory?: string,
	unrestored: readonly WorktreeUnrestored[] = [],
): Promise<{
	readonly sessionManager: SessionManager;
	readonly notices: { readonly type: "info" | "warning"; readonly message: string }[];
}> {
	const opened =
		cwd !== sessionManager.getCwd()
			? await sessionManager.openSessionById(sessionManager.getSessionId(), cwd, sessionDirectory)
			: sessionManager;
	const restoredHere = new Set(restored.map((mapping) => mapping.to));
	const leftHere = new Set(unrestored.map((record) => `${record.snapshotId}\0${record.at}`));
	return {
		sessionManager: opened,
		notices: restoreNotices(opened, (entry) =>
			entry.restore
				? restoredHere.has(entry.restore.to)
				: entry.unrestored !== undefined && leftHere.has(`${entry.unrestored.snapshotId}\0${entry.unrestored.at}`),
		),
	};
}

/**
 * Whether a session recorded elsewhere continues in `cwd` because a restore moved its checkout there, so opening it
 * from `cwd` resumes it rather than forking it into another project.
 */
export async function sessionContinuesIn(store: SessionStore, sessionId: string, cwd: string): Promise<boolean> {
	const { header, entries } = await store.load(sessionId);
	const mappings = entries.flatMap((entry) =>
		entry.type === "worktree_snapshot" && entry.restore ? [entry.restore] : [],
	);
	if (mappings.length === 0) return false;
	const mapped = mapRestoredPath(header.cwd, mappings);
	return canonicalizeWorktreePath(mapped) === canonicalizeWorktreePath(cwd);
}

/** The restores recorded on `branch`, oldest first. */
function restoreMappings(branch: readonly SessionEntry[]): WorktreeRootMapping[] {
	return branch.flatMap((entry) => (entry.type === "worktree_snapshot" && entry.restore ? [entry.restore] : []));
}

/** The restores and current snapshots of the branch of stored `entries` that ends at `leafId`, as resume finds them. */
function storedBranchSnapshots(
	entries: readonly SessionEntry[],
	leafId: string | null,
): { readonly mappings: WorktreeRootMapping[]; readonly current: Map<string, WorktreeSnapshot> } {
	const branch = getBranchPath(leafId, new Map(entries.map((entry) => [entry.id, entry])));
	const records = new Map<string, WorktreeSnapshot>();
	for (const entry of entries) {
		if (entry.type === "worktree_snapshot" && entry.snapshot) records.set(entry.snapshotId, entry.snapshot);
	}
	const mappings = restoreMappings(branch);
	const current = currentWorktreeSnapshots({
		getBranch: () => branch,
		getWorktreeRootMappings: () => mappings,
		getWorktreeSnapshotRecords: () => records,
	});
	return { mappings, current };
}

/**
 * Whether a session runs in a checkout it recorded snapshots of: its working directory, followed through the restores
 * it recorded, lies inside a checkout the branch it reopens on recorded a snapshot of. Opening such a session from
 * another directory resumes it against that checkout, verified in place or restored into a fresh worktree, instead of
 * forking it into the other directory.
 */
export async function sessionRunsInRecordedCheckout(store: SessionStore, sessionId: string): Promise<boolean> {
	const { header, entries } = await store.load(sessionId);
	const { mappings, current } = storedBranchSnapshots(entries, getSessionLeafId(entries));
	const cwd = mapRestoredPath(header.cwd, mappings);
	return [...current.keys()].some((root) => isInside(root, cwd));
}
