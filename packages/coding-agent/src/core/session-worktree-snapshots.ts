import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AssistantMessage } from "@bastani/pi-ai/compat";
import type { SessionManager } from "./session-manager.ts";
import type { SessionEntry } from "./session-manager-types.ts";
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
	isWorkspaceSnapshotError,
	WorkspaceDriftError,
	type WorkspaceError,
	WorkspaceRestoreError,
	WorkspaceSnapshotError,
} from "./worktree-snapshot/errors.ts";
import { gitText, runGit } from "./worktree-snapshot/git.ts";
import { loadSnapshotPathPolicy } from "./worktree-snapshot/policy.ts";
import { restoreWorktree, snapshotRestoreWarnings, verifyWorktree } from "./worktree-snapshot/restore.ts";
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
	const path = relative(parent, child);
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
				throw error;
		}
		if (resolve(current, "..") === current) return current;
	}
}

/** `path` rewritten through each restore in order: a path under `from` moves to the same place under `to`. */
export function mapRestoredPath(path: string, mappings: readonly WorktreeRootMapping[]): string {
	let mapped = resolve(path);
	for (const mapping of mappings) {
		if (isInside(mapping.from, mapped)) mapped = resolve(mapping.to, relative(mapping.from, mapped));
	}
	return mapped;
}

export type SessionWorktreeResume =
	| { readonly status: "none" }
	| { readonly status: "unavailable"; readonly reason: GitUnavailableError }
	| { readonly status: "verified"; readonly snapshot: WorktreeSnapshot; readonly cwd: string }
	| {
			readonly status: "restored";
			readonly snapshot: WorktreeSnapshot;
			readonly mapping: WorktreeRootMapping;
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
 * Checks the checkout a resumed session works in against the last snapshot it recorded. A match resumes in place.
 * A drifted or missing checkout is restored automatically into a fresh worktree under Atomic home, and the old→new
 * root mapping is recorded on the session; the returned `cwd` is where the session continues. Throws
 * {@link WorkspaceDriftError} (with the restore failure as `cause`) when the snapshot cannot be restored.
 */
export async function resumeSessionWorktree(
	sessionManager: SessionManager,
	options: ResumeSessionWorktreeOptions,
): Promise<SessionWorktreeResume> {
	if (!options.settings.enabled) return { status: "none" };
	const cwd = mapRestoredPath(sessionManager.getCwd(), sessionManager.getWorktreeRootMappings());
	let match: { root: string; snapshot: WorktreeSnapshot } | undefined;
	for (const [root, snapshot] of sessionManager.getLatestWorktreeSnapshots()) {
		if (isInside(root, cwd) && (!match || root.length > match.root.length)) match = { root, snapshot };
	}
	if (!match) return { status: "none" };
	const { root, snapshot } = match;
	let drift: WorkspaceDriftError;
	try {
		await verifyWorktree(snapshot, root, { settings: options.settings, signal: options.signal });
		return { status: "verified", snapshot, cwd };
	} catch (error) {
		if (isGitUnavailableError(error)) return { status: "unavailable", reason: error };
		if (isWorkspaceDriftError(error)) drift = error;
		else if (isWorkspaceSnapshotError(error) && error.code === "not-a-repository") {
			drift = new WorkspaceDriftError({
				root,
				expectedHead: snapshot.head,
				actualHead: null,
				expectedTree: snapshot.tree,
				actualTree: null,
				snapshotId: snapshot.id,
			});
		} else throw error;
	}
	let restored: Awaited<ReturnType<typeof restoreWorktree>>;
	try {
		restored = await restoreWorktree(snapshot, {
			blobs: sessionSnapshotBlobs(sessionManager.getSessionStore().snapshotBlobs, sessionManager.getEntries()),
			settings: options.settings,
			storeDir: options.storeDir,
			signal: options.signal,
		});
	} catch (error) {
		if (!isWorkspaceError(error)) throw error;
		throw new WorkspaceDriftError(
			{
				root: drift.root,
				expectedHead: drift.expectedHead,
				actualHead: drift.actualHead,
				expectedTree: drift.expectedTree,
				actualTree: drift.actualTree,
				snapshotId: drift.snapshotId,
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
	await sessionManager.appendWorktreeSnapshot(restored.path, snapshot.id, undefined, mapping);
	return {
		status: "restored",
		snapshot,
		mapping,
		cwd: resolve(restored.path, relative(root, cwd)),
		warnings: restored.warnings,
	};
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
	}
}

/**
 * The notices for a restore this resume performed: one informational line naming the new worktree, then a warning per
 * omission or conversion setting recorded on the restored snapshot. Empty when the latest restore predates `since`.
 */
export function worktreeRestoreNotices(
	sessionManager: Pick<SessionManager, "getWorktreeRootMappings" | "getWorktreeSnapshotRecords">,
	since: string,
): { readonly type: "info" | "warning"; readonly message: string }[] {
	const mapping = sessionManager.getWorktreeRootMappings().at(-1);
	if (!mapping || mapping.restoredAt < since) return [];
	const snapshot = sessionManager.getWorktreeSnapshotRecords().get(mapping.snapshotId);
	return [
		{ type: "info", message: formatWorktreeRestoreNotice(mapping) },
		...(snapshot ? snapshotRestoreWarnings(snapshot) : []).map((warning) => ({
			type: "warning" as const,
			message: formatWorktreeRestoreWarning(warning),
		})),
	];
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
		deleteBlobs: (hashes) => primary.deleteBlobs(hashes),
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
	| { readonly status: "match"; readonly tree: string }
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
	const policy = await loadSnapshotPathPolicy(checkout.root);
	const state = await withScratchDirectory((scratch) => writeWorkingTree(checkout, settings, policy, scratch, {}));
	if (checkout.head === snapshot.head && state.tree === snapshot.tree) return { status: "match", tree: state.tree };
	const present = await runGit(["cat-file", "-e", `${snapshot.tree}^{tree}`], {
		cwd: checkout.root,
		allowExitCodes: [1, 128],
	});
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
