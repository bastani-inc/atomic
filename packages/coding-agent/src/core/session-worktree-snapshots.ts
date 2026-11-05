import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AssistantMessage } from "@bastani/pi-ai/compat";
import type { SessionManager } from "./session-manager.ts";
import { getBranchPath } from "./session-manager-history.ts";
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
	isWorkspaceSnapshotError,
	unreadablePathError,
	WorkspaceDriftError,
	type WorkspaceError,
	WorkspaceRestoreError,
	WorkspaceSnapshotError,
} from "./worktree-snapshot/errors.ts";
import { gitText, runGit } from "./worktree-snapshot/git.ts";
import { isHeadOnlyAdvance } from "./worktree-snapshot/head-advance.ts";
import { canonicalizeWorktreePath } from "./worktree-snapshot/paths.ts";
import { loadSnapshotPathPolicy } from "./worktree-snapshot/policy.ts";
import {
	removeRestoredWorktree,
	restoreWorktree,
	snapshotRestoreWarnings,
	verifyWorktree,
} from "./worktree-snapshot/restore.ts";
import type {
	SnapshotBlob,
	SnapshotBlobStore,
	WorktreeRestoreWarning,
	WorktreeRootMapping,
	WorktreeSnapshot,
	WorktreeSnapshotSettings,
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

export type SessionWorktreeResume =
	| { readonly status: "none" }
	| { readonly status: "verified"; readonly snapshot: WorktreeSnapshot; readonly cwd: string }
	| {
			readonly status: "restored";
			readonly snapshot: WorktreeSnapshot;
			readonly mappings: readonly WorktreeRootMapping[];
			readonly cwd: string;
			readonly warnings: readonly WorktreeRestoreWarning[];
	  };

export interface ResumeSessionWorktreeOptions {
	readonly settings: WorktreeSnapshotSettings;
	/** Host directory for shared object stores and restored worktrees. Default ~/.atomic/agent/worktree-snapshots. */
	readonly storeDir?: string;
	readonly signal?: AbortSignal;
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
	const existing = sessionManager.getWorktreeRootMappings();
	const records = sessionManager.getWorktreeSnapshotRecords();
	const latestIds = latestSnapshotIdsByCheckout(sessionManager, existing);
	const latest = new Map<string, WorktreeSnapshot>();
	for (const [root, snapshotId] of latestIds) {
		const snapshot = records.get(snapshotId);
		if (!snapshot) throw new WorkspaceRestoreError("snapshot-not-found", { snapshotId, target: root });
		latest.set(root, snapshot);
	}
	if (latest.size === 0) return { status: "none" };
	const cwd = mapRestoredPath(sessionManager.getCwd(), existing);
	const mappings: WorktreeRootMapping[] = [];
	const warnings: WorktreeRestoreWarning[] = [];
	const hostWarnings = new Map<WorktreeRootMapping, WorktreeRestoreHostWarning[]>();
	const reportedLeftovers = new Set<string>();
	let selected: { root: string; snapshot: WorktreeSnapshot } | undefined;
	try {
		for (const [original, snapshot] of latest) {
			options.signal?.throwIfAborted();
			const root = mapRestoredPath(original, existing);
			if (isInside(root, cwd) && (!selected || root.length > selected.root.length)) selected = { root, snapshot };
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
			let restored: Awaited<ReturnType<typeof restoreWorktree>>;
			try {
				restored = await restoreWorktree(snapshot, {
					blobs: sessionSnapshotBlobs(sessionManager.getSessionStore().snapshotBlobs, sessionManager.getEntries()),
					storeDir: options.storeDir,
					signal: options.signal,
				});
			} catch (error) {
				options.signal?.throwIfAborted();
				if (!(error instanceof Error)) throw error;
				throw new WorkspaceDriftError(
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
			}
			const mapping: WorktreeRootMapping = {
				from: root,
				to: restored.path,
				snapshotId: snapshot.id,
				tree: snapshot.tree,
				restoredAt: new Date().toISOString(),
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
		for (const mapping of mappings) {
			options.signal?.throwIfAborted();
			await sessionManager.appendWorktreeSnapshot(
				mapping.to,
				mapping.snapshotId,
				undefined,
				mapping,
				hostWarnings.get(mapping),
			);
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
	const mappedCwd = mapRestoredPath(cwd, mappings);
	return mappings.length === 0
		? { status: "verified", snapshot, cwd: mappedCwd }
		: { status: "restored", snapshot, mappings, cwd: mappedCwd, warnings };
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

/**
 * One informational line per worktree restored since `since`, each followed by its snapshot's warnings and what the
 * restore itself reported.
 */
export function worktreeRestoreNotices(
	sessionManager: Pick<SessionManager, "getBranch" | "getWorktreeSnapshotRecords">,
	since: string,
): { readonly type: "info" | "warning"; readonly message: string }[] {
	const records = sessionManager.getWorktreeSnapshotRecords();
	return sessionManager.getBranch().flatMap((entry) => {
		if (entry.type !== "worktree_snapshot" || !entry.restore || entry.restore.restoredAt < since) return [];
		const snapshot = records.get(entry.snapshotId);
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
		async listBlobHashes() {
			return [...blobs.keys()];
		},
		async deleteBlobs() {
			throw new WorkspaceSnapshotError("blob-store-unsupported", "inline");
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
		listBlobHashes: () => primary.listBlobHashes(),
		deleteBlobs: (hashes, options) => primary.deleteBlobs(hashes, options),
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
	const startedAt = new Date().toISOString();
	const resume = await resumeSessionWorktree(sessionManager, options);
	const moved =
		(resume.status === "restored" || resume.status === "verified") && resume.cwd !== sessionManager.getCwd();
	const opened = moved
		? await sessionManager.openSessionById(sessionManager.getSessionId(), resume.cwd, options.sessionDirectory)
		: sessionManager;
	return { sessionManager: opened, notices: worktreeRestoreNotices(opened, startedAt) };
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

/**
 * The snapshots retention keeps for sessions: the latest snapshot of each checkout on the branch every session of
 * `store` reopens on, the one resume checks, internal workflow-stage sessions included. Pass them, with the snapshots
 * resumable workflow runs reference, to `collectSnapshotGarbage`.
 */
export async function listRetainedSessionSnapshots(
	store: SessionStore,
	signal?: AbortSignal,
): Promise<WorktreeSnapshot[]> {
	const retained: WorktreeSnapshot[] = [];
	for await (const summary of store.list({ includeInternal: true, signal })) {
		const { entries } = await store.load(summary.id);
		const branch = getBranchPath(entries.at(-1)?.id, new Map(entries.map((entry) => [entry.id, entry])));
		const records = new Map<string, WorktreeSnapshot>();
		for (const entry of entries) {
			if (entry.type === "worktree_snapshot" && entry.snapshot) records.set(entry.snapshotId, entry.snapshot);
		}
		const current = currentWorktreeSnapshots({
			getBranch: () => branch,
			getWorktreeRootMappings: () =>
				branch.flatMap((entry) => (entry.type === "worktree_snapshot" && entry.restore ? [entry.restore] : [])),
			getWorktreeSnapshotRecords: () => records,
		});
		retained.push(...new Set(current.values()));
	}
	return retained;
}
