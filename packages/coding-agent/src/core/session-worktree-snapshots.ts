import { access, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AssistantMessage } from "@bastani/atomic-ai/compat";
import { failureDebugFields, reportDebugAsync as reportDebug } from "./debug.ts";
import { timeCheckoutRestore } from "./resume/timings.ts";
import type { SessionManager } from "./session-manager.ts";
import type { SessionEntry, WorktreeRestoreHostWarning } from "./session-manager-types.ts";
import { isStorageError } from "./storage/errors.js";
import { readSessionTail } from "./storage/session/session-resume.js";
import type { SessionRecordHeader, SessionStore } from "./storage/session/types.js";
import {
	type BestWorktreeRestore,
	isRecoverableRestoreFailure,
	type RestoreBestWorktreeOptions,
	restoreBestWorktree,
	unrestoredRecord,
} from "./worktree-snapshot/best-restore.ts";
import { DEGRADED_RESTORE_RETENTION_DAYS, snapshotBlobHashes } from "./worktree-snapshot/blob-store.ts";
import {
	type Checkout,
	captureLocatedCheckout,
	captureWorktreeSnapshot,
	locateCheckout,
	recordWorktreeCapture,
	type WorktreeSnapshotUnavailableReason,
	withScratchDirectory,
	writeWorkingTree,
} from "./worktree-snapshot/capture.ts";
import { carryOverDegradedWork } from "./worktree-snapshot/degraded-work.ts";
import { sha256Hex } from "./worktree-snapshot/env-hash.ts";
import {
	findWorkspaceError,
	type GitUnavailableError,
	isGitUnavailableError,
	isWorkspaceDriftError,
	isWorkspaceError,
	isWorkspaceSnapshotError,
	unreadablePathError,
	WorkspaceDriftError,
	type WorkspaceError,
	WorkspaceRestoreError,
	WorkspaceSnapshotError,
} from "./worktree-snapshot/errors.ts";
import { SNAPSHOT_COLLECTION_SESSION_DELAY_MS, scheduleSnapshotCollection } from "./worktree-snapshot/garbage.ts";
import { gitText, runGit } from "./worktree-snapshot/git.ts";
import { isHeadOnlyAdvance } from "./worktree-snapshot/head-advance.ts";
import {
	type CanonicalSteps,
	canonicalizeWorktreePathAsync,
	canonicalPaths,
	runCanonicalSteps,
	runCanonicalStepsAsync,
} from "./worktree-snapshot/paths.ts";
import { loadSnapshotPathPolicy } from "./worktree-snapshot/policy.ts";
import {
	admitPooledWorktree,
	claimIdleWorktree,
	confirmPooledWorktreeLease,
	discardPooledWorktree,
	evictIdleWorktrees,
	holdRestoredWorktree,
	type PoolOwner,
	pooledWorktreeHolder,
	type RepositoryId,
	recordPooledWorktreeState,
	releaseRestoredWorktree,
	type WorktreeLease,
	worktreeSetAside,
} from "./worktree-snapshot/pool.ts";
import {
	defaultWorktreeSnapshotStoreDir,
	type RestoreWorktreeSnapshotOptions,
	removeRestoredWorktree,
	restoreDegradedWorktreeAt,
	restoreWorktree,
	restoreWorktreeAt,
	snapshotRestoreWarnings,
	verifyWorktree,
} from "./worktree-snapshot/restore.ts";
import { adoptPrebuiltSeed } from "./worktree-snapshot/seeds.ts";
import { keepSessionSnapshotCommit, releaseSessionSnapshotRefs } from "./worktree-snapshot/session-refs.ts";
import type {
	SnapshotBlob,
	SnapshotBlobStore,
	WorktreeDegradedRestore,
	WorktreeDegradedWork,
	WorktreeRestoreWarning,
	WorktreeRootMapping,
	WorktreeSnapshot,
	WorktreeSnapshotSettings,
	WorktreeUnrestored,
} from "./worktree-snapshot/types.ts";

export { isRecoverableRestoreFailure };

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

function* isInside(parent: string, child: string): CanonicalSteps<boolean> {
	const path = relative(yield parent, yield child);
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
		const checkouts = new Map<string, Checkout>();
		for (const directory of directories) {
			try {
				const checkout = await locateCheckout(await nearestExisting(directory));
				if (checkout instanceof Error) this.report(checkout);
				else if (!checkouts.has(checkout.root)) checkouts.set(checkout.root, checkout);
			} catch (error) {
				this.reportFailure(error);
			}
		}
		for (const [root, checkout] of checkouts) {
			// A pooled worktree this session no longer holds may be another session's work: never recorded as its (#4830).
			if (!(await holdsSessionWorktree(this.deps.sessionManager, root))) {
				this.report(new WorkspaceSnapshotError("pooled-worktree-lost", root));
				continue;
			}
			const previous = this.deps.sessionManager.getLatestWorktreeSnapshots().get(root);
			// A capture in a partly restored worktree records it as derived from the snapshot it lacks (#4922); one of a
			// full restore that carried work over records the merged worktree, or keeps naming the work it kept (#5009).
			const pin = await degradedRestorePinAsync(this.deps.sessionManager, root);
			try {
				let captureMs = 0;
				// The first capture uses the lookup above; one that a collection makes run again looks the checkout up anew.
				let located: Checkout | undefined = checkout;
				await recordWorktreeCapture(
					blobs,
					async () => {
						const started = performance.now();
						const result =
							located === undefined
								? await captureWorktreeSnapshot(root, { settings, previous, blobs })
								: await captureLocatedCheckout(located, { settings, previous, blobs });
						located = undefined;
						captureMs = Math.floor(performance.now() - started);
						return result;
					},
					async (result) => {
						if (result.status === "captured" || result.status === "unchanged") {
							await this.deps.sessionManager.appendWorktreeSnapshot(
								root,
								result.snapshot.id,
								result.status === "captured" ? result.snapshot : undefined,
								undefined,
								[],
								undefined,
								captureMs,
								captureDegradedFrom(pin, result.snapshot.id),
							);
							await keepLatestSnapshotCommit(this.deps.sessionManager, root, result.snapshot);
						} else if (result.status === "unavailable") {
							this.report(result.reason);
						}
					},
				);
			} catch (error) {
				this.reportFailure(error);
			}
		}
	}

	/**
	 * Schedules an automatic collection of the session store's unreferenced snapshot blobs when one is due, and returns
	 * without waiting for it. The collection starts {@link SNAPSHOT_COLLECTION_SESSION_DELAY_MS} later, so it competes
	 * neither with the start of an interactive session nor with opening the next session after this one closes (#5530).
	 * Called once an interactive session has started, and when a session closes.
	 */
	scheduleCollection(): void {
		let settings: WorktreeSnapshotSettings;
		try {
			settings = this.deps.settings();
		} catch (error) {
			this.reportFailure(error);
			return;
		}
		void scheduleSnapshotCollection(this.deps.sessionManager.getSessionStore().snapshotBlobs, settings, {
			delayMs: SNAPSHOT_COLLECTION_SESSION_DELAY_MS,
		});
	}

	/**
	 * Releases the pooled worktrees this session holds (#4748), each with the latest snapshot the session recorded of
	 * it as its known state. Called when the session closes; never throws.
	 */
	async releaseWorktrees(): Promise<void> {
		await releaseSessionWorktrees(this.deps.sessionManager);
	}

	/**
	 * Reports a typed reason once. A storage failure, such as a store that is unreachable or refuses a payload, is a
	 * `blob-store-failed` reason: recording a snapshot never fails the turn (#4954). Any other error is a defect.
	 */
	private reportFailure(error: unknown): void {
		const reason = isGitUnavailableError(error) ? error : findWorkspaceError(error);
		if (reason) {
			this.report(reason);
			return;
		}
		if (!isStorageFailure(error)) throw error;
		this.report(
			new WorkspaceSnapshotError(
				"blob-store-failed",
				this.deps.sessionManager.getSessionStore().descriptor.adapter,
				error as Error,
			),
		);
	}
}

/** Whether `error`, or a cause of it, is a failure of the storage: a storage error, or a session store's. */
function isStorageFailure(error: unknown): boolean {
	let current = error;
	for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
		if (isStorageError(current) || current.name.startsWith("Storage") || current.name === "StoreClosedError")
			return true;
		current = current.cause;
	}
	return false;
}

/**
 * Keeps the commit of `snapshot`, the session's latest of the checkout at `root`, reachable from the session's ref in
 * that repository, so `git gc` does not prune it and resume still recognises the checkout (#4923). The ref of each
 * checkout the session's work in `root` came from through restores is released, as retention releases its snapshot.
 */
async function keepLatestSnapshotCommit(
	sessionManager: SessionManager,
	root: string,
	snapshot: WorktreeSnapshot,
): Promise<void> {
	const sessionId = sessionManager.getSessionId();
	await keepSessionSnapshotCommit(sessionId, root, snapshot.snapshot);
	await releaseSessionSnapshotRefs(sessionId, restoredLineage(root, sessionManager.getWorktreeRootMappings()));
}

/**
 * The other checkouts that restores connect `root` to: walking the mappings newest first, each one the work in a
 * connected checkout was restored from or moved to.
 */
function restoredLineage(root: string, mappings: readonly WorktreeRootMapping[]): string[] {
	const connected = new Set([resolve(root)]);
	for (const mapping of [...mappings].reverse()) {
		const from = resolve(mapping.from);
		const to = resolve(mapping.to);
		if (connected.has(from) || connected.has(to)) connected.add(from).add(to);
	}
	connected.delete(resolve(root));
	return [...connected];
}

/**
 * Deletes session `sessionId` from `store`, then the refs that kept its snapshot commits in the repositories of the
 * checkouts it recorded on this node (#4923). Rejects as `store.delete` does; releasing the refs never fails it.
 */
export async function deleteSessionWithSnapshotRefs(
	store: Pick<SessionStore, "load" | "delete">,
	sessionId: string,
): Promise<void> {
	const roots = await store.load(sessionId).then(
		({ entries }) => entries.flatMap((entry) => (entry.type === "worktree_snapshot" ? [entry.root] : [])),
		() => [],
	);
	await store.delete(sessionId);
	await releaseSessionSnapshotRefs(sessionId, new Set(roots));
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

/** The pooled worktrees each open session holds, released when it closes (#4748). */
const sessionLeases = new WeakMap<SessionManager, WorktreeLease[]>();

function sessionOwner(sessionManager: Pick<SessionManager, "getSessionId">): PoolOwner {
	return { kind: "session", id: sessionManager.getSessionId() };
}

function holdFor(sessionManager: SessionManager, lease: WorktreeLease): void {
	const leases = sessionLeases.get(sessionManager) ?? [];
	leases.push(lease);
	sessionLeases.set(sessionManager, leases);
}

/**
 * The pooled worktrees, by canonical root, each session of this process holds no lease of though its record may still
 * name it (#4830): its lease was lost to another holder, or holding it failed. The session no longer works in them.
 */
const forfeitedWorktrees = new Map<string, Set<string>>();

async function worktreeKey(root: string): Promise<string> {
	try {
		return await canonicalizeWorktreePathAsync(root);
	} catch {
		return resolve(root);
	}
}

async function forfeit(sessionId: string, root: string): Promise<void> {
	const key = await worktreeKey(root);
	const roots = forfeitedWorktrees.get(sessionId) ?? new Set();
	roots.add(key);
	forfeitedWorktrees.set(sessionId, roots);
}

async function forfeited(sessionId: string, root: string): Promise<boolean> {
	return forfeitedWorktrees.get(sessionId)?.has(await worktreeKey(root)) === true;
}

/**
 * Whether `lease`, held by `sessionManager`, still holds its slot (#4830). A lease whose slot another holder took is
 * dropped, and its worktree forfeited: the session must not continue in it.
 */
async function keepsLease(sessionManager: SessionManager, lease: WorktreeLease): Promise<boolean> {
	if (await confirmPooledWorktreeLease(lease)) return true;
	const leases = sessionLeases.get(sessionManager) ?? [];
	leases.splice(leases.indexOf(lease), 1);
	await forfeit(sessionManager.getSessionId(), lease.path);
	reportDebug("storage", "worktree-pool-lease-lost", { path: lease.path });
	return false;
}

/**
 * Whether `sessionManager` may still work in the checkout at `root` (#4830): false for a pooled worktree whose lease it
 * lost to another holder, or could not take, checked against the slot's record. True for any other checkout.
 */
async function holdsSessionWorktree(sessionManager: SessionManager, root: string): Promise<boolean> {
	if (await forfeited(sessionManager.getSessionId(), root)) return false;
	const key = await worktreeKey(root);
	const held = sessionLeases.get(sessionManager) ?? [];
	const keys = await Promise.all(held.map((lease) => worktreeKey(lease.path)));
	const lease = held.find((_, index) => keys[index] === key);
	return lease === undefined || (await keepsLease(sessionManager, lease));
}

/**
 * Whether the worktree at `root` is a pooled slot that another session owns (#4748), or that session `sessionId`
 * could not hold or lost while it was stalled (#4830): this session must not continue in it, and restores its checkout
 * fresh as if the worktree were gone. Reads only; false for any unpooled path.
 */
export async function pooledWorktreeOwnedElsewhere(
	storeDir: string,
	root: string,
	sessionId: string,
): Promise<boolean> {
	if (await worktreeSetAside(storeDir, root)) return true;
	const holder = await pooledWorktreeHolder(storeDir, root);
	if (holder === "unpooled") return false;
	return holder.owner?.kind !== "session" || holder.owner.id !== sessionId || (await forfeited(sessionId, root));
}

/**
 * Makes `to`, the session a resume opened, hold every pooled worktree of its checkouts that it owns, then releases what
 * `from`, the session the resume restored on, held, when it is another object (#4748). A slot leased by a live process
 * of the same session stays with that process. A lease `to` already holds is checked first: one whose slot another
 * holder took is dropped (#4830). Never throws: a resume continues without a lease, and then treats each pooled
 * worktree it could not hold as another session's, restoring it fresh instead of working in it unleased (#4830).
 */
export async function holdSessionWorktrees(
	from: SessionManager,
	to: SessionManager,
	storeDir: string = defaultWorktreeSnapshotStoreDir(),
	signal?: AbortSignal,
): Promise<void> {
	try {
		const owner = sessionOwner(to);
		const held = new Set<string>();
		for (const lease of [...(sessionLeases.get(to) ?? [])]) {
			signal?.throwIfAborted();
			if (await keepsLease(to, lease)) held.add(lease.path);
		}
		for (const root of (await currentWorktreeSnapshots(to)).keys()) {
			signal?.throwIfAborted();
			if (held.has(root)) continue;
			try {
				const lease = await holdRestoredWorktree(storeDir, root, owner, signal);
				if (lease !== undefined) {
					holdFor(to, lease);
					const key = await worktreeKey(root);
					forfeitedWorktrees.get(owner.id)?.delete(key);
				}
			} catch (error) {
				if (signal?.aborted) break;
				reportDebug("storage", "worktree-pool-hold-failed", { root, ...failureDebugFields(error) });
				await forfeit(owner.id, root);
			}
		}
	} catch (error) {
		reportDebug("storage", "worktree-pool-hold-failed", failureDebugFields(error));
	}
	if (from !== to) await releaseSessionWorktrees(from);
}

/** Releases every pooled worktree `sessionManager` holds, with the latest snapshot it recorded of each. Never throws. */
export async function releaseSessionWorktrees(sessionManager: SessionManager): Promise<void> {
	const leases = sessionLeases.get(sessionManager) ?? [];
	sessionLeases.delete(sessionManager);
	if (leases.length === 0) return;
	const latest = [...sessionManager.getLatestWorktreeSnapshots()];
	for (const lease of leases) {
		try {
			const canonical = canonicalPaths();
			const path = await canonical(lease.path);
			let snapshot: WorktreeSnapshot | undefined;
			for (const [root, candidate] of latest) {
				if ((await canonical(root)) !== path) continue;
				snapshot = candidate;
				break;
			}
			await releaseRestoredWorktree(
				lease,
				snapshot && { snapshotId: snapshot.id, head: snapshot.head, tree: snapshot.tree },
			);
		} catch (error) {
			reportDebug("storage", "worktree-pool-release-failed", failureDebugFields(error));
		}
	}
}

/** `path` rewritten through each restore in order: a path under `from` moves to the same place under `to`. */
export function mapRestoredPath(path: string, mappings: readonly Pick<WorktreeRootMapping, "from" | "to">[]): string {
	return runCanonicalSteps(restoredPath(path, mappings));
}

export function mapRestoredPathAsync(
	path: string,
	mappings: readonly Pick<WorktreeRootMapping, "from" | "to">[],
): Promise<string> {
	return runCanonicalStepsAsync(restoredPath(path, mappings));
}

function* restoredPath(
	path: string,
	mappings: readonly Pick<WorktreeRootMapping, "from" | "to">[],
): CanonicalSteps<string> {
	let mapped = resolve(path);
	let next = 0;
	while (next < mappings.length) {
		const current = yield mapped;
		let best: { index: number; source: string } | undefined;
		for (let index = next; index < mappings.length; index++) {
			const source = yield mappings[index]!.from;
			if ((yield* isInside(source, current)) && (best === undefined || source.length > best.source.length)) {
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
function* originalRoot(root: string, mappings: readonly WorktreeRootMapping[]): CanonicalSteps<string> {
	let current = yield root;
	for (let index = mappings.length - 1; index >= 0; index--) {
		const mapping = mappings[index]!;
		if ((yield mapping.to) === current) current = yield mapping.from;
	}
	return current;
}

export { DEGRADED_RESTORE_RETENTION_DAYS };

const DEGRADED_RESTORE_RETENTION_MS = DEGRADED_RESTORE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * A checkout a resume restored with less than its snapshot (#4922): the snapshot stays the checkout's restore target
 * while the session records the partly restored worktree as it is.
 */
export interface DegradedRestorePin {
	/** The snapshot restored only partly. */
	readonly snapshotId: string;
	/** When the partial restore happened. */
	readonly since: string;
	/** What the partial restore put into the worktree, when the session recorded it: the base of the work done there. */
	readonly base?: { readonly head: string; readonly tree: string };
	/** Whether {@link DEGRADED_RESTORE_RETENTION_DAYS} have passed since the partial restore, which ends the pin. */
	readonly lapsed: boolean;
	/**
	 * After a full restore of `snapshotId` carried the work of the partly restored worktree over (#5009): the snapshot
	 * of that work, which stays kept until the merged worktree is recorded, so a resume elsewhere carries it over again.
	 */
	readonly work?: string;
	/**
	 * Whether that work conflicted with the full restore and was kept apart (#5009): it stays kept, and the checkout
	 * continues from its latest snapshot, until `discardDegradedRestore` releases it.
	 */
	readonly kept?: boolean;
}

/** What the active branch records of one checkout: its latest snapshot, and the pin of a partial restore, if any. */
interface CheckoutRecord {
	/** The latest snapshot recorded of the checkout: what its worktree holds. */
	readonly latest: string;
	readonly pin?: DegradedRestorePin;
}

function isLapsed(since: string, now: number): boolean {
	const started = Date.parse(since);
	// A time that cannot be read never ends the pin: keeping the snapshot is the safe side.
	return Number.isFinite(started) && now - started > DEGRADED_RESTORE_RETENTION_MS;
}

/**
 * What the active branch records of each checkout, keyed by the root it was first recorded under. A restore with less
 * than its snapshot pins the snapshot (#4922); entries naming it in `degradedFrom` keep the pin, and any other entry
 * of the checkout ends it.
 */
function* checkoutRecords(
	sessionManager: Pick<SessionManager, "getBranch">,
	mappings: readonly WorktreeRootMapping[],
	now = Date.now(),
): CanonicalSteps<Map<string, CheckoutRecord>> {
	const checkouts = new Map<string, CheckoutRecord>();
	const originals = new Map<string, string>();
	for (const entry of sessionManager.getBranch()) {
		if (entry.type !== "worktree_snapshot") continue;
		const original = originals.get(entry.root) ?? (yield* originalRoot(entry.root, mappings));
		originals.set(entry.root, original);
		const previous = checkouts.get(original)?.pin;
		let pin: DegradedRestorePin | undefined;
		const carried = entry.restore?.degradedWork;
		if (
			entry.degradedFrom !== undefined &&
			carried?.snapshotId === entry.degradedFrom &&
			carried.outcome !== "unavailable"
		) {
			// A full restore that carried the work over keeps that work until the merged worktree is recorded (#5009).
			pin = {
				snapshotId: entry.snapshotId,
				since: entry.timestamp,
				base: previous?.base,
				lapsed: isLapsed(entry.timestamp, now),
				work: entry.degradedFrom,
				...(carried.outcome === "kept" ? { kept: true } : {}),
			};
		} else if (entry.degradedFrom !== undefined) {
			pin =
				previous?.snapshotId === entry.degradedFrom || (previous?.kept && previous.work === entry.degradedFrom)
					? previous
					: { snapshotId: entry.degradedFrom, since: entry.timestamp, lapsed: isLapsed(entry.timestamp, now) };
		} else if (entry.restore?.degraded) {
			const { degraded, restoredAt } = entry.restore;
			pin = {
				snapshotId: entry.snapshotId,
				since: restoredAt,
				base: { head: degraded.head, tree: degraded.tree },
				lapsed: isLapsed(restoredAt, now),
			};
		}
		checkouts.set(original, { latest: entry.snapshotId, ...(pin === undefined ? {} : { pin }) });
	}
	return checkouts;
}

/** The snapshot a resume restores for `checkout`: the pinned one while its pin stands, else the latest (#4922). */
function restoreTargetId(checkout: CheckoutRecord): string {
	return checkout.pin !== undefined && !checkout.pin.lapsed && !checkout.pin.kept
		? checkout.pin.snapshotId
		: checkout.latest;
}

/**
 * The snapshot a capture of the checkout pinned by `pin` names in `degradedFrom`, given that it records `snapshotId`:
 * the snapshot a partial restore lacks, or kept conflicting work (#5009); none once a capture records the merged
 * worktree of a full restore that carried the work over, which ends the pin.
 */
function captureDegradedFrom(pin: DegradedRestorePin | undefined, snapshotId: string): string | undefined {
	const named =
		pin === undefined ? undefined : pin.work === undefined ? pin.snapshotId : pin.kept ? pin.work : undefined;
	return named === snapshotId ? undefined : named;
}

/**
 * Records again the checkouts whose full restore carried the work of a partly restored worktree over but whose merged
 * worktree a capture has not recorded yet (#5009), where that worktree is still here holding the restored snapshot's
 * commit; a worktree that is not here fails its capture, which changes nothing. Recording it ends the pin. A checkout that cannot be recorded keeps its pin; the reason goes to the debug log.
 */
export async function recordPendingCarriedWork(
	sessionManager: SessionManager,
	options: { readonly settings: WorktreeSnapshotSettings; readonly storeDir: string; readonly signal?: AbortSignal },
): Promise<void> {
	const mappings = sessionManager.getWorktreeRootMappings();
	const records = sessionManager.getWorktreeSnapshotRecords();
	for (const [original, checkout] of await runCanonicalStepsAsync(checkoutRecords(sessionManager, mappings))) {
		const pin = checkout.pin;
		if (pin?.work === undefined || pin.kept || pin.lapsed) continue;
		const root = await mapRestoredPathAsync(original, mappings);
		if (await pooledWorktreeOwnedElsewhere(options.storeDir, root, sessionManager.getSessionId())) continue;
		await recordCarriedWork(sessionManager, root, records.get(pin.snapshotId)?.head, options);
	}
}

/**
 * The pin of the checkout recorded at `root` while it stands (#4922): the snapshot a resume restored only partly, which
 * stays the checkout's restore target. Undefined when the checkout holds what its latest snapshot records.
 */
export function degradedRestorePin(
	sessionManager: Pick<SessionManager, "getBranch" | "getWorktreeRootMappings">,
	root: string,
): DegradedRestorePin | undefined {
	return runCanonicalSteps(pinOf(sessionManager, root));
}

function degradedRestorePinAsync(
	sessionManager: Pick<SessionManager, "getBranch" | "getWorktreeRootMappings">,
	root: string,
): Promise<DegradedRestorePin | undefined> {
	return runCanonicalStepsAsync(pinOf(sessionManager, root));
}

function* pinOf(
	sessionManager: Pick<SessionManager, "getBranch" | "getWorktreeRootMappings">,
	root: string,
): CanonicalSteps<DegradedRestorePin | undefined> {
	const mappings = sessionManager.getWorktreeRootMappings();
	const checkouts = yield* checkoutRecords(sessionManager, mappings);
	const pin = checkouts.get(yield* originalRoot(root, mappings))?.pin;
	return pin !== undefined && !pin.lapsed ? pin : undefined;
}

/**
 * The id of the snapshot a resume restores for each checkout on the active branch, keyed by the root it was first
 * recorded under: its latest, or the snapshot a resume restored only partly while that pin stands (#4922).
 */
function* latestSnapshotIdsByCheckout(
	sessionManager: Pick<SessionManager, "getBranch">,
	mappings: readonly WorktreeRootMapping[],
): CanonicalSteps<Map<string, string>> {
	const latestIds = new Map<string, string>();
	for (const [original, checkout] of yield* checkoutRecords(sessionManager, mappings)) {
		latestIds.set(original, restoreTargetId(checkout));
	}
	return latestIds;
}

/**
 * The snapshot a resume restores for each root the active branch last recorded a snapshot under, keyed as
 * `getLatestWorktreeSnapshots` keys them: the latest, or the snapshot a resume restored only partly while that pin
 * stands (#4922). A pinned snapshot whose record is missing leaves the latest in its place.
 */
export function latestRestoreTargets(
	sessionManager: Pick<
		SessionManager,
		"getBranch" | "getWorktreeRootMappings" | "getWorktreeSnapshotRecords" | "getLatestWorktreeSnapshots"
	>,
): Promise<Map<string, WorktreeSnapshot>> {
	return runCanonicalStepsAsync(restoreTargets(sessionManager));
}

function* restoreTargets(
	sessionManager: Pick<
		SessionManager,
		"getBranch" | "getWorktreeRootMappings" | "getWorktreeSnapshotRecords" | "getLatestWorktreeSnapshots"
	>,
): CanonicalSteps<Map<string, WorktreeSnapshot>> {
	const mappings = sessionManager.getWorktreeRootMappings();
	const records = sessionManager.getWorktreeSnapshotRecords();
	const checkouts = yield* checkoutRecords(sessionManager, mappings);
	const targets = new Map<string, WorktreeSnapshot>();
	for (const [root, snapshot] of sessionManager.getLatestWorktreeSnapshots()) {
		const checkout = checkouts.get(yield* originalRoot(root, mappings));
		const target = checkout === undefined ? undefined : records.get(restoreTargetId(checkout));
		targets.set(root, target ?? snapshot);
	}
	return targets;
}

export interface DiscardDegradedRestoreOptions {
	readonly settings: WorktreeSnapshotSettings;
	/** The partly restored worktree to release, where the session works in it now. Default: every one the session has. */
	readonly root?: string;
	readonly signal?: AbortSignal;
}

/**
 * Gives up on the snapshots a resume could restore only partly (#4922): records each partly restored worktree as it is
 * now, as a turn's capture would, without naming the snapshot it lacks, so that worktree's state becomes the
 * checkout's restore target and collection releases the snapshot it lacked. Resolves with the roots it recorded.
 * Rejects with `blob-store-unsupported` when the session's storage holds no snapshot content, and with the reason a
 * worktree could not be captured.
 */
export async function discardDegradedRestore(
	sessionManager: SessionManager,
	options: DiscardDegradedRestoreOptions,
): Promise<string[]> {
	const mappings = sessionManager.getWorktreeRootMappings();
	const released: string[] = [];
	for (const [original, checkout] of await runCanonicalStepsAsync(checkoutRecords(sessionManager, mappings))) {
		if (checkout.pin === undefined) continue;
		const root = await mapRestoredPathAsync(original, mappings);
		if (
			options.root !== undefined &&
			(await canonicalizeWorktreePathAsync(root)) !== (await canonicalizeWorktreePathAsync(options.root))
		)
			continue;
		const store = sessionManager.getSessionStore();
		if (store.snapshotBlobs === undefined)
			throw new WorkspaceSnapshotError("blob-store-unsupported", store.descriptor.adapter);
		const blobs = store.snapshotBlobs;
		const previous = sessionManager.getLatestWorktreeSnapshots().get(root);
		let recorded = false;
		await recordWorktreeCapture(
			blobs,
			() => captureWorktreeSnapshot(root, { settings: options.settings, previous, blobs, signal: options.signal }),
			async (result) => {
				if (result.status === "unavailable") throw result.reason;
				if (result.status === "disabled") return;
				await sessionManager.appendWorktreeSnapshot(
					root,
					result.snapshot.id,
					result.status === "captured" ? result.snapshot : undefined,
				);
				recorded = true;
			},
		);
		if (recorded) released.push(root);
	}
	return released;
}

/**
 * The checkouts whose partial restore has been pinned for longer than {@link DEGRADED_RESTORE_RETENTION_DAYS} and
 * that the session has not recorded since (#4922), where they are now: their pinned snapshot is no longer the restore
 * target, and collection no longer keeps it.
 */
export function lapsedDegradedRestores(
	sessionManager: Pick<SessionManager, "getBranch" | "getWorktreeRootMappings">,
): Promise<{ readonly root: string; readonly pin: DegradedRestorePin; readonly latest: string }[]> {
	return runCanonicalStepsAsync(lapsedRestores(sessionManager));
}

function* lapsedRestores(
	sessionManager: Pick<SessionManager, "getBranch" | "getWorktreeRootMappings">,
): CanonicalSteps<{ readonly root: string; readonly pin: DegradedRestorePin; readonly latest: string }[]> {
	const mappings = sessionManager.getWorktreeRootMappings();
	const lapsed: { readonly root: string; readonly pin: DegradedRestorePin; readonly latest: string }[] = [];
	for (const [original, checkout] of yield* checkoutRecords(sessionManager, mappings)) {
		if (checkout.pin?.lapsed && checkout.pin.work === undefined && checkout.pin.snapshotId !== checkout.latest)
			lapsed.push({ root: yield* restoredPath(original, mappings), pin: checkout.pin, latest: checkout.latest });
	}
	return lapsed;
}

/** The checkouts on the active branch whose latest snapshot the session holds no record of, where they are now (#4733). */
export function missingSnapshotRecords(
	sessionManager: Pick<SessionManager, "getBranch" | "getWorktreeRootMappings" | "getWorktreeSnapshotRecords">,
): Promise<MissingSnapshotRecord[]> {
	return runCanonicalStepsAsync(missingRecordsOf(sessionManager));
}

function* missingRecordsOf(
	sessionManager: Pick<SessionManager, "getBranch" | "getWorktreeRootMappings" | "getWorktreeSnapshotRecords">,
): CanonicalSteps<MissingSnapshotRecord[]> {
	const mappings = sessionManager.getWorktreeRootMappings();
	const records = sessionManager.getWorktreeSnapshotRecords();
	const missing: MissingSnapshotRecord[] = [];
	for (const [original, snapshotId] of yield* latestSnapshotIdsByCheckout(sessionManager, mappings)) {
		if (!records.has(snapshotId)) missing.push({ root: yield* restoredPath(original, mappings), snapshotId });
	}
	return missing;
}

/**
 * The latest snapshot of each checkout on the active branch, keyed by where that checkout is now: a checkout restored
 * elsewhere appears once, under its newest location. A snapshot whose record is missing is left out.
 */
export function currentWorktreeSnapshots(
	sessionManager: Pick<SessionManager, "getBranch" | "getWorktreeRootMappings" | "getWorktreeSnapshotRecords">,
): Promise<Map<string, WorktreeSnapshot>> {
	return runCanonicalStepsAsync(currentSnapshots(sessionManager));
}

function* currentSnapshots(
	sessionManager: Pick<SessionManager, "getBranch" | "getWorktreeRootMappings" | "getWorktreeSnapshotRecords">,
): CanonicalSteps<Map<string, WorktreeSnapshot>> {
	const mappings = sessionManager.getWorktreeRootMappings();
	const records = sessionManager.getWorktreeSnapshotRecords();
	const current = new Map<string, WorktreeSnapshot>();
	for (const [original, snapshotId] of yield* latestSnapshotIdsByCheckout(sessionManager, mappings)) {
		const snapshot = records.get(snapshotId);
		if (snapshot) current.set(yield* restoredPath(original, mappings), snapshot);
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
	 * Where the exact fresh restore of a checkout hands its Git LFS download instead of running it (#5099); see
	 * `RestoreWorktreeSnapshotOptions.deferLfs`. Its `lfs-objects-unavailable` warning is then not recorded with the
	 * restore. A claimed or degraded restore, and one that carries over work, still downloads before it returns.
	 */
	readonly deferLfs?: RestoreWorktreeSnapshotOptions["deferLfs"];
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
	/**
	 * Restore into pooled slots at stable paths, leased by this session until it closes (#4748), keeping at most
	 * `maxIdlePerRepository` idle slots of each repository restored into. A restore first claims an idle slot of the
	 * repository that holds only its recorded state, reset to the snapshot with its ignored files kept, and restores
	 * into a new slot when none can be claimed. A recorded checkout in a slot another session owns is restored the same
	 * way. The session holds the pooled worktrees it owns, compared or restored, until it closes. Without it, restores go
	 * to new paths outside the pool, as for workflow runs.
	 */
	readonly pool?: { readonly maxIdlePerRepository: number };
}

/**
 * The commits of every earlier snapshot of the checkout on the branch, newest first and each once, to restore when its
 * own is out of reach (#4744). The restore stops at the first it holds or fetches, so a nearer one costs no more.
 */
function* earlierSnapshotHeads(
	sessionManager: Pick<SessionManager, "getBranch" | "getWorktreeSnapshotRecords">,
	original: string,
	mappings: readonly WorktreeRootMapping[],
	snapshot: WorktreeSnapshot,
): CanonicalSteps<string[]> {
	const records = sessionManager.getWorktreeSnapshotRecords();
	const heads: string[] = [];
	for (const entry of [...sessionManager.getBranch()].reverse()) {
		if (entry.type !== "worktree_snapshot" || (yield* originalRoot(entry.root, mappings)) !== original) continue;
		const head = records.get(entry.snapshotId)?.head;
		if (head !== undefined && head !== snapshot.head) heads.push(head);
	}
	return [...new Set(heads)];
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
	const storeDir = resolve(options.storeDir ?? defaultWorktreeSnapshotStoreDir());
	// The session holds the pooled slots it owns before comparing them, so no claim resets one it continues in (#4748).
	if (options.pool) await holdSessionWorktrees(sessionManager, sessionManager, storeDir, options.signal);
	const pending = options.pendingMappings ?? [];
	const existing = [...sessionManager.getWorktreeRootMappings(), ...pending];
	const records = sessionManager.getWorktreeSnapshotRecords();
	const checkouts = await runCanonicalStepsAsync(checkoutRecords(sessionManager, existing));
	const latestIds = await runCanonicalStepsAsync(latestSnapshotIdsByCheckout(sessionManager, existing));
	const latest = new Map<string, WorktreeSnapshot>();
	// The work done in a partly restored worktree of the pinned snapshot `snapshot`, which this resume restores when
	// `snapshot` cannot be, and puts on top of it when it can (#4922).
	const pinnedWork = (original: string, snapshot: WorktreeSnapshot) => {
		const checkout = checkouts.get(original)!;
		const pin = checkout.pin;
		if (pin === undefined || pin.lapsed || pin.snapshotId !== snapshot.id) return undefined;
		// After a full restore whose merged worktree is not recorded yet, the work it carried over (#5009).
		const workId = pin.work ?? checkout.latest;
		if (workId === snapshot.id) return undefined;
		const work = records.get(workId);
		return work === undefined ? undefined : { pin, work };
	};
	const missingRecords: MissingSnapshotRecord[] = [];
	for (const [root, snapshotId] of latestIds) {
		const snapshot = records.get(snapshotId);
		if (!snapshot && options.skipMissingRecords) {
			missingRecords.push({ root: await mapRestoredPathAsync(root, existing), snapshotId });
			continue;
		}
		if (!snapshot) throw new WorkspaceRestoreError("snapshot-not-found", { snapshotId, target: root });
		latest.set(root, snapshot);
	}
	if (latest.size === 0) return missingRecords.length === 0 ? { status: "none" } : { status: "none", missingRecords };
	const cwd = await mapRestoredPathAsync(sessionManager.getCwd(), existing);
	const mappings: WorktreeRootMapping[] = [];
	const warnings: WorktreeRestoreWarning[] = [];
	const hostWarnings = new Map<WorktreeRootMapping, WorktreeRestoreHostWarning[]>();
	const reportedLeftovers = new Set<string>();
	const left: { root: string; snapshot: WorktreeSnapshot; reason: Error; degradedFrom?: string }[] = [];
	const pinnedTo = new Map<WorktreeRootMapping, string | undefined>();
	const unrestored: UnrestoredWorktree[] = [];
	let continuedIn: string;
	let selected: { root: string; snapshot: WorktreeSnapshot } | undefined;
	const owner = sessionOwner(sessionManager);
	const leases = new Map<WorktreeRootMapping, WorktreeLease>();
	const admitted = new Set<RepositoryId>();
	try {
		for (const [original, snapshot] of latest) {
			options.signal?.throwIfAborted();
			const root = await mapRestoredPathAsync(original, existing);
			if ((await runCanonicalStepsAsync(isInside(root, cwd))) && (!selected || root.length > selected.root.length))
				selected = { root, snapshot };
			if (options.keepInPlace?.has(root)) continue;
			const pinned = pinnedWork(original, snapshot);
			// Conflicting work a full restore kept apart stays kept, whatever the checkout is restored from (#5009).
			const pin = checkouts.get(original)!.pin;
			const keptWork = pin?.kept && !pin.lapsed && pin.work !== snapshot.id ? pin.work : undefined;
			// A pinned checkout left unrestored keeps its pin and the work done in its partly restored worktree (#4922).
			const leave = (reason: Error) =>
				left.push(
					pinned === undefined
						? { root, snapshot, reason, ...(keptWork === undefined ? {} : { degradedFrom: keptWork }) }
						: { root, snapshot: pinned.work, reason, degradedFrom: snapshot.id },
				);
			const cannot = options.cannotRestore?.get(root);
			if (cannot !== undefined) {
				leave(cannot);
				continue;
			}
			const gone = (cause?: Error) =>
				new WorkspaceDriftError(
					{
						root,
						expectedHead: snapshot.head,
						actualHead: null,
						expectedTree: snapshot.tree,
						actualTree: null,
						snapshotId: snapshot.id,
					},
					cause,
				);
			let drift: WorkspaceDriftError;
			// A slot another session owns holds its work, not this one's: restore fresh, as if it were gone (#4748).
			if (options.pool && (await pooledWorktreeOwnedElsewhere(storeDir, root, owner.id))) drift = gone();
			else {
				try {
					await verifyWorktree(snapshot, root, { settings: options.settings, signal: options.signal });
					continue;
				} catch (error) {
					options.signal?.throwIfAborted();
					if (isWorkspaceDriftError(error)) {
						if (await isHeadOnlyAdvance(error, options.signal)) continue;
						drift = error;
					} else if (isWorkspaceSnapshotError(error)) drift = gone(error);
					else throw error;
				}
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
			let restored: Extract<BestWorktreeRestore, { status: "restored" }>;
			let lease: WorktreeLease | undefined;
			let claimed = false;
			let seeded = false;
			// The snapshot the worktree holds: the one restored, or the work done since its partial restore (#4922).
			let restoredFrom = snapshot;
			// The exact state, else the best this host can restore, else continue without the checkout.
			const restoreFresh = async (slot: WorktreeLease | undefined) => {
				const ladder: RestoreBestWorktreeOptions = {
					blobs,
					storeDir: options.storeDir,
					signal: options.signal,
					candidates: await runCanonicalStepsAsync(
						earlierSnapshotHeads(sessionManager, original, existing, snapshot),
					),
					// Carrying work over writes into the worktree, so a pinned restore downloads first.
					...(pinned === undefined ? { deferLfs: options.deferLfs } : {}),
					...(slot === undefined
						? {}
						: {
								restore: (target, restoreOptions) => restoreWorktreeAt(target, slot.path, restoreOptions),
								restoreDegraded: (degraded, failure, restoreOptions) =>
									restoreDegradedWorktreeAt(degraded, failure, slot.path, restoreOptions),
							}),
				};
				if (pinned === undefined) return restoreBestWorktree(snapshot, ladder);
				return restorePinnedWorktree(snapshot, pinned.work, ladder, (work) => {
					restoredFrom = work;
				});
			};
			try {
				const best = await timeCheckoutRestore(
					root,
					async (): Promise<BestWorktreeRestore> => {
						if (!options.pool) return restoreFresh(undefined);
						// An idle slot of the repository keeps its dependencies and build output; else a new slot (#4748).
						const claimOptions = { storeDir, owner, settings: options.settings, blobs, signal: options.signal };
						let claim = await claimIdleWorktree(snapshot, claimOptions);
						// Without one, prebuilt build output parked as a seed becomes an idle slot to claim (#4748).
						if (
							!claim.claimed &&
							(await adoptPrebuiltSeed(snapshot, { storeDir, signal: options.signal })).adopted
						) {
							claim = await claimIdleWorktree(snapshot, claimOptions);
							seeded = claim.claimed;
						}
						if (claim.claimed) {
							lease = claim.lease;
							claimed = true;
							return { status: "restored", path: claim.lease.path, warnings: claim.warnings };
						}
						lease = await admitSlot(storeDir, snapshot, owner, options.signal);
						return restoreFresh(lease);
					},
					(outcome) =>
						outcome.status === "unrestored"
							? undefined
							: seeded
								? "seeded"
								: claimed
									? "claimed"
									: outcome.degraded === undefined
										? "fresh"
										: "degraded",
				);
				if (best.status === "unrestored") {
					if (lease) await discardPooledWorktree(lease);
					leave(best.reason);
					continue;
				}
				restored = best;
			} catch (error) {
				if (lease) await discardPooledWorktree(lease).catch(() => {});
				options.signal?.throwIfAborted();
				if (!(error instanceof Error)) throw error;
				throw refused(error);
			}
			// A full restore of a pinned snapshot carries the work done in its partly restored worktree over (#4922).
			const degradedWork =
				pinned !== undefined &&
				restoredFrom === snapshot &&
				restored.degraded === undefined &&
				pinned.work.tree !== pinned.pin.base?.tree
					? await carryOverDegradedWork({
							worktree: restored.path,
							work: pinned.work,
							base: pinned.pin.base?.tree,
							blobs,
							storeDir,
							signal: options.signal,
						})
					: undefined;
			const mapping: WorktreeRootMapping = {
				from: root,
				to: restored.path,
				snapshotId: restoredFrom.id,
				tree: restoredFrom.tree,
				restoredAt: new Date().toISOString(),
				...(restored.degraded === undefined ? {} : { degraded: restored.degraded }),
				...(degradedWork === undefined ? {} : { degradedWork }),
			};
			mappings.push(mapping);
			pinnedTo.set(mapping, restoredFrom !== snapshot ? snapshot.id : keptWork);
			if (lease) {
				leases.set(mapping, lease);
				admitted.add(lease.repository);
				if (restored.degraded !== undefined || restoredFrom !== snapshot) {
					await recordPooledWorktreeState(lease, {
						snapshotId: restoredFrom.id,
						head: restored.degraded?.head ?? restoredFrom.head,
						tree: restored.degraded?.tree ?? restoredFrom.tree,
					}).catch((error: unknown) =>
						reportDebug("storage", "worktree-pool-state-failed", failureDebugFields(error)),
					);
				}
			}
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
				undefined,
				undefined,
				// Work carried over stays kept until the merged worktree is recorded, or released when it conflicted (#5009).
				pinnedTo.get(mapping) ??
					(mapping.degradedWork === undefined || mapping.degradedWork.outcome === "unavailable"
						? undefined
						: mapping.degradedWork.snapshotId),
			);
			if (mapping.degradedWork?.outcome === "applied") {
				await recordCarriedWork(sessionManager, mapping.to, records.get(mapping.snapshotId)!.head, options);
			}
		}
		const continuing = await mapRestoredPathAsync(cwd, mappings);
		const recordedHere = selected !== undefined && left.some((checkout) => checkout.root === selected!.root);
		const launch =
			recordedHere &&
			options.fallbackCwd !== undefined &&
			(!(await access(continuing).then(
				() => true,
				() => false,
			)) ||
				(await pooledWorktreeOwnedElsewhere(storeDir, selected!.root, owner.id)));
		continuedIn = launch ? resolve(options.fallbackCwd!) : continuing;
		for (const checkout of left) {
			const record = unrestoredRecord(
				checkout.snapshot,
				checkout.reason,
				continuedIn,
				launch ? "launch" : "recorded",
				undefined,
				launch && checkout.root === selected?.root ? continuing : undefined,
			);
			await sessionManager.appendWorktreeSnapshot(
				checkout.root,
				checkout.snapshot.id,
				undefined,
				undefined,
				[],
				record,
				undefined,
				checkout.degradedFrom,
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
			const lease = leases.get(mapping);
			if (lease) await discardPooledWorktree(lease).catch(() => {});
		}
		if (cleanupFailures.length > 0 && error instanceof Error && Object.isExtensible(error)) {
			Object.defineProperty(error, "cleanupCause", {
				value: cleanupFailures.length === 1 ? cleanupFailures[0] : new AggregateError(cleanupFailures),
				configurable: true,
			});
		}
		throw error;
	}
	for (const lease of leases.values()) holdFor(sessionManager, lease);
	if (options.pool) {
		for (const repository of admitted) {
			await evictIdleWorktrees(storeDir, repository, {
				maxIdle: options.pool.maxIdlePerRepository,
				settings: options.settings,
				signal: options.signal,
			});
		}
	}
	const snapshot = selected?.snapshot ?? [...latest.values()].at(-1)!;
	const missing = missingRecords.length === 0 ? {} : { missingRecords };
	return mappings.length === 0
		? { status: "verified", snapshot, cwd: continuedIn, unrestored, ...missing }
		: { status: "restored", snapshot, mappings, cwd: continuedIn, warnings, unrestored, ...missing };
}

/**
 * Restores a pinned `snapshot` (#4922): exactly, else `work`, the latest snapshot of its partly restored worktree, as
 * well as this host can, calling `restoredWork` when it does; else nothing, resolving `unrestored` with the exact
 * restore's failure. `work` shares `snapshot`'s remotes, so a commit a degraded restore of `snapshot` could fall back to
 * is one a degraded restore of `work` falls back to as well.
 */
async function restorePinnedWorktree(
	snapshot: WorktreeSnapshot,
	work: WorktreeSnapshot,
	options: RestoreBestWorktreeOptions,
	restoredWork: (work: WorktreeSnapshot) => void,
): Promise<BestWorktreeRestore> {
	const { restore = restoreWorktree, restoreDegraded: _degraded, candidates: _candidates, ...shared } = options;
	try {
		const exact = await restore(snapshot, shared);
		return { status: "restored", path: exact.path, warnings: exact.warnings ?? [] };
	} catch (error) {
		if (options.signal?.aborted || !isRecoverableRestoreFailure(error)) throw error;
		const best = await restoreBestWorktree(work, options);
		if (best.status === "unrestored") return { status: "unrestored", reason: error };
		restoredWork(work);
		return best;
	}
}

/**
 * Records the restored worktree at `root` as it is once a restore carried the work of a partly restored worktree over
 * (#4922), so the session holds that work without waiting for a turn, which ends the pin. A worktree whose HEAD is no
 * longer `head` is left alone. A capture that fails keeps the pin, and with it the carried work, for the next turn's
 * capture or resume to record (#5009); the reason goes to the debug log.
 */
async function recordCarriedWork(
	sessionManager: SessionManager,
	root: string,
	head: string | undefined,
	options: Pick<ResumeSessionWorktreeOptions, "settings" | "signal">,
): Promise<void> {
	const blobs = sessionManager.getSessionStore().snapshotBlobs;
	if (blobs === undefined) return;
	try {
		await recordWorktreeCapture(
			blobs,
			() => captureWorktreeSnapshot(root, { settings: options.settings, blobs, signal: options.signal }),
			async (result) => {
				// Without a previous snapshot to compare with, a capture never resolves unchanged.
				if (result.status === "captured" && result.snapshot.head === head) {
					await sessionManager.appendWorktreeSnapshot(root, result.snapshot.id, result.snapshot);
				} else if (result.status === "unavailable") {
					reportDebug("storage", "degraded-work-capture-failed", failureDebugFields(result.reason));
				}
			},
		);
	} catch (error) {
		options.signal?.throwIfAborted();
		if (!isWorkspaceError(error) && !isGitUnavailableError(error)) throw error;
		reportDebug("storage", "degraded-work-capture-failed", failureDebugFields(error));
	}
}

/**
 * Takes a new pooled slot for a restore of `snapshot` (#4748). When the pool cannot be used, the restore goes to a new
 * path outside it, as before the pool: undefined, with the reason in the debug log.
 */
async function admitSlot(
	storeDir: string,
	snapshot: WorktreeSnapshot,
	owner: PoolOwner,
	signal?: AbortSignal,
): Promise<WorktreeLease | undefined> {
	try {
		return await admitPooledWorktree(
			{
				storeDir,
				remotes: snapshot.remotes,
				root: snapshot.root,
				lastState: { snapshotId: snapshot.id, head: snapshot.head, tree: snapshot.tree },
				envHash: snapshot.envHash,
				signal,
			},
			owner,
		);
	} catch (error) {
		signal?.throwIfAborted();
		reportDebug("storage", "worktree-pool-admit-failed", failureDebugFields(error));
		return undefined;
	}
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
					return `A restore interrupted earlier left ${warning.path}, which may hold your files; check them, then delete the directory yourself`;
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

/** Whose checkout a restore notice is about: a session's, or a workflow run's (#4738). */
export type WorktreeRestoreOwner = "session" | "workflow run";

/** What a degraded restore checked out, for its notice. */
function degradedBasis(
	degraded: WorktreeDegradedRestore,
	snapshot: WorktreeSnapshot | undefined,
	owner: WorktreeRestoreOwner,
): string {
	switch (degraded.basis) {
		case "pushed-base":
			return `the last pushed commit before it, ${short(degraded.head)}`;
		case "earlier-snapshot":
			return `${short(degraded.head)}, the commit of an earlier snapshot of this ${owner}`;
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
	owner: WorktreeRestoreOwner = "session",
): string {
	const lfs = warnings
		.filter((warning) => warning.code === "lfs-objects-unavailable")
		.map((warning) => ` ${formatWorktreeRestoreWarning(warning)}.`)
		.join("");
	return `${degradedRestoreSummary(mapping, snapshot, owner)}${lfs}`;
}

function degradedRestoreSummary(
	mapping: WorktreeRootMapping,
	snapshot: WorktreeSnapshot | undefined,
	owner: WorktreeRestoreOwner,
): string {
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
	return `${restored} at ${degradedBasis(degraded, snapshot, owner)}${recorded}, the closest commit available here. Not restored: ${commits} commit${commits === 1 ? "" : "s"} (${listed(degraded.missingCommits.map(short), 3)})${changes} of snapshot ${short(mapping.snapshotId)}. ${degraded.hint}`;
}

/** The notice for a checkout whose snapshot the session holds no record of, which a resume continued without. */
export function formatMissingRecordNotice(missing: MissingSnapshotRecord): string {
	return `Continuing without restoring ${missing.root}: the session holds no record of its snapshot ${short(missing.snapshotId)}. Resume on the machine that recorded it, or import (\`atomic --import <file>\`) a session saved there with \`/export <file>.jsonl\`, which carries its snapshots.`;
}

/** The one notice for a checkout a resume continued without (#4733). */
export function formatUnrestoredNotice(
	root: string,
	unrestored: WorktreeUnrestored,
	owner: WorktreeRestoreOwner = "session",
): string {
	const place =
		unrestored.place === "launch"
			? "the directory the resume started from"
			: owner === "session"
				? "the session's own directory"
				: "the run's own directory";
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
	const branch = sessionManager.getBranch();
	// The snapshots of conflicting work a full restore kept apart, which later entries go on naming, and the last entry
	// of each root, after which nothing recorded the worktree (#5009).
	const keptWork = new Set<string>();
	const last = new Map<string, SessionEntry>();
	for (const entry of branch) {
		if (entry.type !== "worktree_snapshot") continue;
		if (entry.restore?.degradedWork?.outcome === "kept") keptWork.add(entry.restore.degradedWork.snapshotId);
		last.set(entry.root, entry);
	}
	return branch.flatMap((entry) => {
		if (entry.type !== "worktree_snapshot" || !include(entry)) return [];
		if (entry.unrestored) {
			return [{ type: "warning" as const, message: formatUnrestoredNotice(entry.root, entry.unrestored) }];
		}
		if (!entry.restore) return [];
		const snapshot = records.get(entry.snapshotId);
		const work = entry.restore.degradedWork;
		const pinned =
			entry.degradedFrom === undefined || entry.degradedFrom === work?.snapshotId || keptWork.has(entry.degradedFrom)
				? []
				: [{ type: "warning" as const, message: formatPinnedRestoreNotice(entry.restore, entry.degradedFrom) }];
		if (entry.restore.degraded) {
			const message = formatDegradedRestoreNotice(entry.restore, snapshot, entry.restoreWarnings);
			return [{ type: "warning" as const, message }, ...pinned];
		}
		// Applied work no capture recorded since, whose pin stands until one does (#5009).
		const unrecorded = work?.outcome === "applied" && last.get(entry.root) === entry ? work : undefined;
		return [
			{ type: "info" as const, message: formatWorktreeRestoreNotice(entry.restore) },
			...pinned,
			...(work === undefined
				? []
				: [
						{
							type: work.outcome === "applied" ? ("info" as const) : ("warning" as const),
							message: formatDegradedWorkNotice(entry.restore, work),
						},
					]),
			...(unrecorded === undefined
				? []
				: [{ type: "warning" as const, message: formatUnrecordedWorkNotice(entry.restore, unrecorded) }]),
			...[...(snapshot ? snapshotRestoreWarnings(snapshot) : []), ...(entry.restoreWarnings ?? [])].map(
				(warning) => ({ type: "warning" as const, message: formatWorktreeRestoreWarning(warning) }),
			),
		];
	});
}

/**
 * The notice for a checkout restored from the work done in a partly restored worktree, because the snapshot that
 * worktree lacks still cannot be restored here (#4922).
 */
export function formatPinnedRestoreNotice(mapping: WorktreeRootMapping, pinnedSnapshotId: string): string {
	return `${mapping.to} holds snapshot ${short(mapping.snapshotId)}, the work recorded since snapshot ${short(pinnedSnapshotId)} of ${mapping.from} was restored only partly; snapshot ${short(pinnedSnapshotId)} itself still cannot be restored here. It stays this checkout's restore target and is kept for ${DEGRADED_RESTORE_RETENTION_DAYS} days after its partial restore, until a resume restores it fully or discardDegradedRestore releases it.`;
}

/** The notice for the work of a partly restored worktree that a full restore of its snapshot found (#4922). */
export function formatDegradedWorkNotice(mapping: WorktreeRootMapping, work: WorktreeDegradedWork): string {
	const files = work.paths.length === 0 ? "" : ` (${listed(work.paths)})`;
	const done = `the work done in the partly restored worktree ${work.root}, snapshot ${short(work.snapshotId)}${files}`;
	switch (work.outcome) {
		case "applied":
			return `Also applied ${done}, on top of snapshot ${short(mapping.snapshotId)} in ${mapping.to}.`;
		case "kept":
			return `Did not apply ${done}: it conflicts with snapshot ${short(mapping.snapshotId)}. Commit ${short(work.commit ?? "")} (ref ${work.ref}) holds it; run \`git diff ${work.base} ${work.commit} | git apply --3way\` in ${mapping.to} to apply it. Snapshot ${short(work.snapshotId)} stays in the session's storage, so a resume on another machine keeps it as such a commit too, until discardDegradedRestore releases it.`;
		case "unavailable":
			return `Could not read ${done} here (${work.reason}), so it is not in ${mapping.to}; it is still in that worktree on the machine where it was done.`;
	}
}

/**
 * The notice for work a full restore carried over whose merged worktree could not be recorded yet (#5009): the restored
 * snapshot stays the restore target and the work stays kept until the next turn or resume records it.
 */
export function formatUnrecordedWorkNotice(mapping: WorktreeRootMapping, work: WorktreeDegradedWork): string {
	return `The work applied in ${mapping.to} is not recorded yet: snapshot ${short(work.snapshotId)} stays kept, and a resume elsewhere applies it on top of snapshot ${short(mapping.snapshotId)} again, until the next turn or resume records the worktree.`;
}

/**
 * The notice for a checkout whose partial restore was pinned for longer than {@link DEGRADED_RESTORE_RETENTION_DAYS}
 * (#4922): the snapshot it lacked is no longer its restore target, and collection no longer keeps it.
 */
export function formatLapsedPinNotice(lapsed: {
	readonly root: string;
	readonly pin: DegradedRestorePin;
	readonly latest: string;
}): string {
	return `Snapshot ${short(lapsed.pin.snapshotId)} of ${lapsed.root}, restored only partly on ${lapsed.pin.since.slice(0, 10)}, is no longer kept: ${DEGRADED_RESTORE_RETENTION_DAYS} days have passed. The checkout continues from snapshot ${short(lapsed.latest)}, the work recorded in its partly restored worktree.`;
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
		} else if (
			status &&
			resolve(entry.root) === resolve(root) &&
			entry.snapshotId !== status.snapshotId &&
			entry.degradedFrom !== status.snapshotId
		) {
			// A later snapshot of the checkout records what it holds now, which replaces what the resume left out, unless
			// it records the partly restored worktree, whose snapshot stays its restore target (#4922).
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
 * How long the latest turn's capture of the checkout now at `root` took, as a line, also when that capture was of the
 * checkout before a restore moved it to `root`; undefined when no capture recorded it.
 */
export async function describeLastCapture(
	sessionManager: Pick<SessionManager, "getBranch" | "getWorktreeRootMappings">,
	root: string,
): Promise<string | undefined> {
	const branch = sessionManager.getBranch();
	const mappings = sessionManager.getWorktreeRootMappings();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (
			entry.type === "worktree_snapshot" &&
			typeof entry.captureMs === "number" &&
			(await mapRestoredPathAsync(entry.root, mappings)) === resolve(root)
		) {
			return `last capture took ${(entry.captureMs / 1000).toFixed(1)} s`;
		}
	}
	return undefined;
}

/**
 * Opens `sessionManager`'s session where it should continue: in place when its checkout matches the last snapshot,
 * in the restored worktree otherwise. With `pool`, the opened session holds its pooled worktrees until it closes.
 * Returns the notices to show for a restore it performed.
 */
export async function openSessionInWorktree(
	sessionManager: SessionManager,
	options: ResumeSessionWorktreeOptions & { readonly sessionDirectory?: string },
): Promise<{
	readonly sessionManager: SessionManager;
	readonly notices: { readonly type: "info" | "warning"; readonly message: string }[];
}> {
	const resume = await resumeSessionWorktree(sessionManager, options);
	const opened = await openResumedSession(
		sessionManager,
		resume.status === "none" ? sessionManager.getCwd() : resume.cwd,
		resume.status === "restored" ? resume.mappings : [],
		options.sessionDirectory,
		resume.status === "none" ? [] : resume.unrestored.map((checkout) => checkout.record),
	);
	// The opened session takes over the pooled slots, held until it closes (#4748).
	if (options.pool) {
		await holdSessionWorktrees(
			sessionManager,
			opened.sessionManager,
			options.storeDir ?? defaultWorktreeSnapshotStoreDir(),
		);
	}
	return opened;
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
			? await sessionManager.openSessionById(sessionManager.getSessionId(), cwd, sessionDirectory, {
					history: "tail",
				})
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
	const stored = await storedSnapshotEntries(store, sessionId);
	return runCanonicalStepsAsync(snapshotsContinueIn(stored.header.cwd, stored.entries, cwd));
}

export function sessionManagerContinuesIn(
	sessionManager: Pick<SessionManager, "getHeader" | "getEntries">,
	cwd: string,
): boolean {
	const header = sessionManager.getHeader();
	return header !== null && runCanonicalSteps(snapshotsContinueIn(header.cwd, sessionManager.getEntries(), cwd));
}

function* snapshotsContinueIn(
	recordedCwd: string,
	entries: readonly SessionEntry[],
	cwd: string,
): CanonicalSteps<boolean> {
	const mappings = entries.flatMap((entry) =>
		entry.type === "worktree_snapshot" && entry.restore ? [entry.restore] : [],
	);
	if (mappings.length === 0) return false;
	const mapped = yield* restoredPath(recordedCwd, mappings);
	return (yield mapped) === (yield cwd);
}

async function storedSnapshotEntries(
	store: SessionStore,
	sessionId: string,
): Promise<{
	readonly header: SessionRecordHeader;
	readonly entries: SessionEntry[];
	readonly branch: SessionEntry[];
}> {
	const { header, state } = await readSessionTail(store, sessionId, Number.MAX_SAFE_INTEGER);
	const snapshots = state.filter(({ entry }) => entry.type === "worktree_snapshot");
	return {
		header,
		entries: snapshots.map(({ entry }) => entry),
		branch: snapshots.filter(({ onBranch }) => onBranch).map(({ entry }) => entry),
	};
}

/** The restores recorded on `branch`, oldest first. */
function restoreMappings(branch: readonly SessionEntry[]): WorktreeRootMapping[] {
	return branch.flatMap((entry) => (entry.type === "worktree_snapshot" && entry.restore ? [entry.restore] : []));
}

function* storedBranchSnapshots(
	entries: readonly SessionEntry[],
	branch: readonly SessionEntry[],
): CanonicalSteps<{ readonly mappings: WorktreeRootMapping[]; readonly current: Map<string, WorktreeSnapshot> }> {
	const records = new Map<string, WorktreeSnapshot>();
	for (const entry of entries) {
		if (entry.type === "worktree_snapshot" && entry.snapshot) records.set(entry.snapshotId, entry.snapshot);
	}
	const mappings = restoreMappings(branch);
	const current = yield* currentSnapshots({
		getBranch: () => [...branch],
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
	const { header, entries, branch } = await storedSnapshotEntries(store, sessionId);
	return runCanonicalStepsAsync(snapshotsRunInRecordedCheckout(header.cwd, entries, branch));
}

export function sessionManagerRunsInRecordedCheckout(
	sessionManager: Pick<SessionManager, "getHeader" | "getEntries" | "getBranch">,
): boolean {
	const header = sessionManager.getHeader();
	return (
		header !== null &&
		runCanonicalSteps(
			snapshotsRunInRecordedCheckout(header.cwd, sessionManager.getEntries(), sessionManager.getBranch()),
		)
	);
}

function* snapshotsRunInRecordedCheckout(
	recordedCwd: string,
	entries: readonly SessionEntry[],
	branch: readonly SessionEntry[],
): CanonicalSteps<boolean> {
	const { mappings, current } = yield* storedBranchSnapshots(entries, branch);
	const cwd = yield* restoredPath(recordedCwd, mappings);
	for (const root of current.keys()) if (yield* isInside(root, cwd)) return true;
	return false;
}
