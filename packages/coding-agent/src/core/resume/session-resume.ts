import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { type GitUnavailableError, isGitUnavailableError } from "../../utils/git-errors.ts";
import type { SessionManager } from "../session-manager.ts";
import {
	currentWorktreeSnapshots,
	mapRestoredPath,
	openResumedSession,
	resumeSessionWorktree,
} from "../session-worktree-snapshots.ts";
import type { SettingsManager } from "../settings-manager.ts";
import { ProjectTrustStore } from "../trust-manager.ts";
import { locateCheckout, readRepositoryConfig } from "../worktree-snapshot/capture.ts";
import {
	isWorkspaceConfigError,
	isWorkspaceDriftError,
	isWorkspaceSnapshotError,
} from "../worktree-snapshot/errors.ts";
import { gitText, runGit } from "../worktree-snapshot/git.ts";
import { isHeadOnlyAdvance } from "../worktree-snapshot/head-advance.ts";
import {
	defaultWorktreeSnapshotStoreDir,
	type VerifyWorktreeOptions,
	verifyWorktree,
} from "../worktree-snapshot/restore.ts";
import type { WorktreeRootMapping, WorktreeSnapshot, WorktreeSnapshotSettings } from "../worktree-snapshot/types.ts";
import {
	isResumePreconditionError,
	isResumeSetupHookError,
	type ResumeEntryPoint,
	ResumePreconditionError,
	type ResumePreconditionProblem,
} from "./errors.ts";
import { isResumeFailure } from "./failure.ts";
import { isInside } from "./path-mapping.ts";
import {
	assertResumePreconditions,
	defaultResumePreflightIo,
	gitUnavailableProblem,
	type ResumePreflightIo,
} from "./preflight.ts";
import {
	ensureResumeSetup,
	predictedSetupProblem,
	type ResumeSetupConfig,
	readResumeSetupLedger,
	reserveResumeSetup,
} from "./setup-hook.ts";

/** What to do when the checkout a resume was started in belongs to the session's repository but differs from it. */
export type DirtyCheckoutChoice = "restore" | "use" | "cancel";

export interface DirtyCheckoutPrompt {
	/** Root of the user's checkout the resume was started in. */
	readonly checkout: string;
	/** Root the session recorded, on the node that recorded it. */
	readonly recordedRoot: string;
	readonly snapshotId: string;
}

export interface ResumeNotice {
	readonly type: "info" | "warning";
	readonly message: string;
}

export interface PrepareSessionResumeOptions {
	readonly entryPoint: ResumeEntryPoint;
	/** Where the resume was started: the requested target when it is a checkout of the session's repository. */
	readonly launchCwd: string;
	readonly settings: WorktreeSnapshotSettings;
	readonly setup: ResumeSetupConfig;
	/** Host directory for restored worktrees. Default ~/.atomic/agent/worktree-snapshots. */
	readonly storeDir?: string;
	/** Asks the user about a dirty checkout. Without it a fresh worktree is restored, which overwrites nothing. */
	readonly chooseDirtyCheckout?: (prompt: DirtyCheckoutPrompt) => Promise<DirtyCheckoutChoice>;
	readonly io?: ResumePreflightIo;
	/** Session directory to reopen a moved session in, for stores that keep sessions per directory. */
	readonly sessionDirectory?: string;
	readonly signal?: AbortSignal;
	/**
	 * Checkouts the session continues in as they are, by the root its recorded restores put them at: never verified and
	 * never restored, as for checkouts it worked in on this node and changed since.
	 */
	readonly keepInPlace?: ReadonlySet<string>;
}

export type PreparedSessionResume =
	| { readonly status: "cancelled" }
	| {
			readonly status: "ready";
			/** The session opened where it continues: the one passed in when its cwd did not change. */
			readonly sessionManager: SessionManager;
			readonly notices: readonly ResumeNotice[];
	  };

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return false;
		throw error;
	}
}

export interface SessionSnapshotMatch {
	readonly root: string;
	readonly snapshot: WorktreeSnapshot;
	/** The session cwd after the session's recorded restores. */
	readonly cwd: string;
}

/** The latest snapshot of the checkout the session works in, the same one #4245's resume verifies. */
export function latestSessionSnapshot(
	sessionManager: Pick<SessionManager, "getCwd" | "getWorktreeRootMappings" | "getLatestWorktreeSnapshots">,
): SessionSnapshotMatch | undefined {
	const cwd = mapRestoredPath(sessionManager.getCwd(), sessionManager.getWorktreeRootMappings());
	let match: SessionSnapshotMatch | undefined;
	for (const [root, snapshot] of sessionManager.getLatestWorktreeSnapshots()) {
		if (isInside(root, cwd) && (!match || root.length > match.root.length)) match = { root, snapshot, cwd };
	}
	return match;
}

/** Continue in the launch checkout, or stop because the user cancelled; undefined restores a fresh worktree. */
type CheckoutReuse =
	| {
			readonly kind: "reused";
			readonly cwd: string;
			/** Whether the checkout matched the snapshot, rather than being used as it is by the user's choice. */
			readonly matches: boolean;
			readonly notice: ResumeNotice;
			/** The recorded root mapped onto the checkout, recorded once nothing else stops the resume. */
			readonly mapping: WorktreeRootMapping;
	  }
	| { readonly kind: "cancelled" }
	| undefined;

/**
 * Continues in the checkout the resume started in when it is a checkout of the session's repository: as-is when its
 * tree matches the snapshot (or only its HEAD moved forward over it); when it differs and has local changes, only if
 * the user says so. A clean checkout that differs is left alone and a fresh worktree is restored instead. Returns the
 * mapping that makes paths follow, for the caller to record.
 */
async function reuseLaunchCheckout(
	match: SessionSnapshotMatch,
	options: PrepareSessionResumeOptions,
): Promise<CheckoutReuse> {
	const checkout = await locateCheckout(options.launchCwd, options.signal).catch((error: unknown) => {
		if (isWorkspaceSnapshotError(error)) return error;
		throw error;
	});
	if (checkout instanceof Error) return undefined;
	const root = resolve(checkout.root);
	const { remotes } = await readRepositoryConfig(root, options.signal);
	if (!remotes.some((remote) => match.snapshot.remotes.includes(remote))) return undefined;
	let matches = true;
	try {
		await verifyWorktree(match.snapshot, root, { settings: options.settings, signal: options.signal });
	} catch (error) {
		if (!isWorkspaceDriftError(error)) throw error;
		matches = await isHeadOnlyAdvance(error, options.signal);
	}
	if (!matches) {
		if (!(await hasLocalChanges(root, options.signal))) return undefined;
		const choice = options.chooseDirtyCheckout
			? await options.chooseDirtyCheckout({
					checkout: root,
					recordedRoot: match.root,
					snapshotId: match.snapshot.id,
				})
			: "restore";
		if (choice === "cancel") return { kind: "cancelled" };
		if (choice === "restore") return undefined;
	}
	const mapping: WorktreeRootMapping = {
		from: match.root,
		to: root,
		snapshotId: match.snapshot.id,
		tree: match.snapshot.tree,
		restoredAt: new Date().toISOString(),
	};
	return {
		kind: "reused",
		cwd: resolve(root, relative(match.root, match.cwd)),
		matches,
		mapping,
		notice: matches
			? {
					type: "info",
					message: `Resuming in ${root}, which matches snapshot ${match.snapshot.id.slice(0, 12)} of ${match.root}`,
				}
			: {
					type: "warning",
					message: `Resuming in ${root}, which differs from snapshot ${match.snapshot.id.slice(0, 12)} of ${match.root}`,
				},
	};
}

/** Whether the checkout at `root` has uncommitted or untracked changes, which a resume must not overwrite unasked. */
async function hasLocalChanges(root: string, signal: AbortSignal | undefined): Promise<boolean> {
	return (await gitText(["status", "--porcelain"], { cwd: root, signal })).length > 0;
}

/**
 * Gets a resumed session's checkouts ready on this node before its runtime starts, and returns the session opened
 * where it continues. When the checkout the session works in is missing or changed here, a checkout of the same
 * repository the resume started in is used as-is if it matches (and, if it differs, only when the user chooses it).
 * The checkout the session works in is the only one the resume cannot go without: when it must be restored, every
 * precondition of restoring the recorded checkouts is checked in one pass first (Git, and a setup hook for each snapshot
 * with dependency inputs), and an unmet one refuses the resume before anything is written, naming the checkout it
 * belongs to. Every other checkout the session recorded that is gone or changed here, except those in `keepInPlace`,
 * never blocks the resume: one the session worked in on this node, changed since, continues as it is; the rest are
 * restored into fresh worktrees one by one by #4245's {@link resumeSessionWorktree}, and one that cannot be (a
 * precondition is unmet, its restore or its setup hook fails) is left out with a warning that names its path and why.
 * A restored worktree that turns out to have no setup hook it needs is removed again before its restore is recorded.
 * Each worktree Atomic restored gets its setup hook once per environment. The session's tools resolve paths under every
 * root it recorded into the place that root was restored.
 */
export async function prepareSessionResume(
	sessionManager: SessionManager,
	options: PrepareSessionResumeOptions,
): Promise<PreparedSessionResume> {
	const io = options.io ?? defaultResumePreflightIo;
	const storeDir = resolve(options.storeDir ?? defaultWorktreeSnapshotStoreDir());
	if (!options.settings.enabled || sessionManager.getLatestWorktreeSnapshots().size === 0) {
		return { status: "ready", sessionManager, notices: [] };
	}
	const notices: ResumeNotice[] = [];
	const match = latestSessionSnapshot(sessionManager);
	let git: GitProbe | undefined;
	let reused: WorktreeRootMapping | undefined;
	if (
		match !== undefined &&
		!options.keepInPlace?.has(match.root) &&
		(await worktreeNeedsRestore(match.snapshot, match.root, options))
	) {
		git = { unavailable: await io.probeGit(options.signal) };
		const reuse = git.unavailable === undefined ? await reuseLaunchCheckout(match, options) : undefined;
		if (reuse?.kind === "cancelled") return { status: "cancelled" };
		if (reuse?.kind === "reused" && !reuse.matches) {
			await recordReuse(sessionManager, reuse.mapping);
			return continueInChosenCheckout(sessionManager, reuse, options);
		}
		if (reuse?.kind === "reused") {
			reused = reuse.mapping;
			notices.push(reuse.notice);
		}
	}
	const checkouts = withMapping(sessionManager, reused);
	const candidates = await restoreCandidates(
		checkouts,
		mapRestoredPath(sessionManager.getCwd(), checkouts.getWorktreeRootMappings()),
		options,
	);
	if (candidates.targets.length > 0) git ??= { unavailable: await io.probeGit(options.signal) };
	const plan = await planRestores(sessionManager, candidates, storeDir, options, git?.unavailable);
	notices.push(...plan.left.values());
	const recordedBefore = sessionManager.getWorktreeRootMappings().length;
	const resumed = await restorePlanned(sessionManager, plan, reused, storeDir, options);
	const cwd = mapRestoredPath(sessionManager.getCwd(), sessionManager.getWorktreeRootMappings());
	const opened = await openResumedSession(sessionManager, cwd, resumed.restored, options.sessionDirectory);
	notices.push(...opened.notices, ...resumed.failed);
	const restoredNow = new Set(
		opened.sessionManager
			.getWorktreeRootMappings()
			.slice(recordedBefore)
			.map((mapping) => resolve(mapping.to)),
	);
	notices.push(...(await setUpRestoredCheckouts(opened.sessionManager, restoredNow, storeDir, options)));
	return { status: "ready", sessionManager: opened.sessionManager, notices };
}

/**
 * Continues in the launch checkout the user chose although it differs from the snapshot. #4245's resume would restore
 * a fresh worktree over that choice, so no other checkout is restored either; the notice names those left out.
 */
async function continueInChosenCheckout(
	sessionManager: SessionManager,
	reuse: Extract<CheckoutReuse, { kind: "reused" }>,
	options: PrepareSessionResumeOptions,
): Promise<PreparedSessionResume> {
	const notices: ResumeNotice[] = [reuse.notice];
	for (const [root, snapshot] of currentWorktreeSnapshots(sessionManager)) {
		if (!(await isDirectory(root))) {
			notices.push(
				notRestored(
					root,
					snapshot,
					"it does not exist on this node, and the session continues in the checkout you chose, which restores nothing else",
				),
			);
		}
	}
	const reopened = await sessionManager.openSessionById(
		sessionManager.getSessionId(),
		reuse.cwd,
		options.sessionDirectory,
	);
	return { status: "ready", sessionManager: reopened, notices };
}

/** A recorded checkout a resume restores, and whether it is missing here or only changed. */
interface RestoreTarget {
	readonly root: string;
	readonly snapshot: WorktreeSnapshot;
	readonly absent: boolean;
	/** Whether the session's working directory is inside it, so the session cannot continue without it. */
	readonly runsHere: boolean;
}

/** What a resume does about the recorded checkouts that are gone or changed here. */
interface RestorePlan {
	/** Checkouts the session works in, which the resume restores together or not at all. */
	readonly required: readonly RestoreTarget[];
	/** Every other checkout the resume restores, each on its own, so that one that cannot be restored is left out. */
	readonly optional: readonly RestoreTarget[];
	/** The warning for each other checkout the resume continues without restoring, by its root. */
	readonly left: ReadonlyMap<string, ResumeNotice>;
}

/** Records that the session continues in a checkout already here, so paths follow it. */
async function recordReuse(sessionManager: SessionManager, mapping: WorktreeRootMapping): Promise<void> {
	await sessionManager.appendWorktreeSnapshot(mapping.to, mapping.snapshotId, undefined, mapping);
}

type SessionCheckouts = Pick<SessionManager, "getBranch" | "getWorktreeRootMappings" | "getWorktreeSnapshotRecords">;

/** The session's checkouts as they are once `mapping`, not yet recorded, is. */
function withMapping(sessionManager: SessionManager, mapping: WorktreeRootMapping | undefined): SessionCheckouts {
	if (mapping === undefined) return sessionManager;
	return {
		getBranch: () => sessionManager.getBranch(),
		getWorktreeSnapshotRecords: () => sessionManager.getWorktreeSnapshotRecords(),
		getWorktreeRootMappings: () => [...sessionManager.getWorktreeRootMappings(), mapping],
	};
}

/** The warning that the resume continues without restoring the checkout recorded at `root`, with the reason. */
function notRestored(root: string, snapshot: WorktreeSnapshot, reason: string): ResumeNotice {
	return {
		type: "warning",
		message: `Continuing without restoring ${root} (snapshot ${snapshot.id.slice(0, 12)}): ${reason}`,
	};
}

function absentOrChanged(target: Pick<RestoreTarget, "absent">): string {
	return target.absent ? "it does not exist on this node" : "it no longer matches the snapshot";
}

/**
 * A failure of one checkout alone, which leaves the session's other checkouts restorable: a typed resume, workspace or
 * Git failure, but not a setting that is wrong for every checkout.
 */
function isCheckoutFailure(error: unknown): error is Error {
	return isResumeFailure(error) && !isWorkspaceConfigError(error);
}

/** What went wrong in `error`, for a warning: the unmet preconditions' reasons, or its own message, and any failed cleanup. */
function describeFailure(error: Error): string {
	const detail = isResumePreconditionError(error)
		? error.problems.map((problem) => problem.why).join("; ")
		: error.message;
	const cleanup = (error as Error & { readonly cleanupCause?: unknown }).cleanupCause;
	return cleanup instanceof Error ? `${detail}; removing what it restored also failed: ${cleanup.message}` : detail;
}

/** `problem` as it applies to the checkout recorded at `root`, which it names. */
function forCheckout(problem: ResumePreconditionProblem, root: string, runsHere: boolean): ResumePreconditionProblem {
	return {
		...problem,
		subject: `${problem.subject} for ${root}${runsHere ? " (the checkout the session runs in)" : ""}`,
		checkout: root,
	};
}

/**
 * The recorded checkouts that are gone or changed here, which #4245's resume restores into fresh worktrees, except
 * those the session continues in as they are. Another checkout than the one the session works in is also left alone,
 * with a warning, when it cannot be compared with its snapshot, or when it is here and the session worked in it on this
 * node, so it continues as it is.
 */
async function restoreCandidates(
	sessionManager: SessionCheckouts,
	cwd: string,
	options: PrepareSessionResumeOptions,
): Promise<{ readonly targets: RestoreTarget[]; readonly left: Map<string, ResumeNotice> }> {
	const targets: RestoreTarget[] = [];
	const left = new Map<string, ResumeNotice>();
	for (const [root, snapshot] of currentWorktreeSnapshots(sessionManager)) {
		if (options.keepInPlace?.has(root)) continue;
		const runsHere = isInside(root, cwd);
		try {
			if (!(await worktreeNeedsRestore(snapshot, root, options))) continue;
		} catch (error) {
			if (runsHere || options.signal?.aborted || !isCheckoutFailure(error)) throw error;
			left.set(root, notRestored(root, snapshot, `it could not be compared with the snapshot: ${error.message}`));
			continue;
		}
		const absent = !(await isDirectory(root));
		if (!runsHere && !absent && (await checkoutsWorkedHere(new Map([[root, snapshot]]), cwd, options)).has(root)) {
			left.set(
				root,
				notRestored(
					root,
					snapshot,
					"it changed since the snapshot, and the session worked in it on this node, so it stays as it is",
				),
			);
			continue;
		}
		targets.push({ root, snapshot, absent, runsHere });
	}
	return { targets, left };
}

/**
 * Restores what `plan` says into fresh worktrees with #4245's {@link resumeSessionWorktree}, recording each restore on
 * `sessionManager`, and returns the mappings it recorded. The checkouts the session works in are restored together,
 * with the mapping to the launch checkout `reused`, and any failure refuses the resume. Every other checkout is
 * restored on its own, and one whose restore fails is reported in `failed` and left out.
 */
async function restorePlanned(
	sessionManager: SessionManager,
	plan: RestorePlan,
	reused: WorktreeRootMapping | undefined,
	storeDir: string,
	options: PrepareSessionResumeOptions,
): Promise<{ restored: WorktreeRootMapping[]; failed: ResumeNotice[] }> {
	const snapshots = sessionManager.getWorktreeSnapshotRecords();
	const outcome = { restored: [] as WorktreeRootMapping[], failed: [] as ResumeNotice[] };
	const restore = async (
		targets: readonly RestoreTarget[],
		runsHere: boolean,
		pending: WorktreeRootMapping | undefined,
	) => {
		const restoring = new Set(targets.map((target) => target.root));
		const resumed = await resumeSessionWorktree(sessionManager, {
			settings: options.settings,
			storeDir,
			signal: options.signal,
			beforeRecord: (mappings) => reserveRestoredSetup(mappings, runsHere, snapshots, storeDir, options),
			pendingMappings: pending === undefined ? [] : [pending],
			keepInPlace: new Set(
				[...currentWorktreeSnapshots(withMapping(sessionManager, pending)).keys()].filter(
					(root) => !restoring.has(root),
				),
			),
		});
		if (resumed.status === "restored") outcome.restored.push(...resumed.mappings);
	};
	await restore(plan.required, true, reused);
	for (const target of plan.optional) {
		try {
			await restore([target], false, undefined);
		} catch (error) {
			if (options.signal?.aborted || !isCheckoutFailure(error)) throw error;
			outcome.failed.push(
				notRestored(
					target.root,
					target.snapshot,
					`${absentOrChanged(target)}, and restoring it failed: ${describeFailure(error)}`,
				),
			);
		}
	}
	return outcome;
}

/**
 * Checks that each worktree #4245's resume just restored has the setup hook it needs, before that resume records any
 * of them, so a missing hook leaves no record of a worktree that is removed again, and enters each hook that will run
 * in the ledger as not run yet. Every worktree that lacks its hook is reported together, by the checkout it restores.
 */
async function reserveRestoredSetup(
	restored: readonly WorktreeRootMapping[],
	runsHere: boolean,
	snapshots: ReadonlyMap<string, WorktreeSnapshot>,
	storeDir: string,
	options: PrepareSessionResumeOptions,
): Promise<void> {
	const problems: ResumePreconditionProblem[] = [];
	for (const mapping of restored) {
		try {
			await reserveResumeSetup({
				entryPoint: options.entryPoint,
				worktree: mapping.to,
				envHash: snapshots.get(mapping.snapshotId)!.envHash,
				storeDir,
				config: options.setup,
				signal: options.signal,
			});
		} catch (error) {
			if (!isResumePreconditionError(error)) throw error;
			problems.push(...error.problems.map((problem) => forCheckout(problem, mapping.from, runsHere)));
		}
	}
	assertResumePreconditions(options.entryPoint, problems);
}

/**
 * Runs the setup hook of the worktrees Atomic restored for the session: once per environment in each worktree this
 * resume restored (`restoredNow`), and again in a worktree restored earlier only when its last hook failed. Later
 * changes to an earlier worktree's lockfiles are the session's own work. A hook that cannot run or fails in the
 * worktree the session works in stops the resume; in any other worktree it is a warning, and the next resume runs it
 * again.
 */
async function setUpRestoredCheckouts(
	sessionManager: SessionManager,
	restoredNow: ReadonlySet<string>,
	storeDir: string,
	options: PrepareSessionResumeOptions,
): Promise<ResumeNotice[]> {
	const notices: ResumeNotice[] = [];
	const mappings = sessionManager.getWorktreeRootMappings();
	const cwd = mapRestoredPath(sessionManager.getCwd(), mappings);
	for (const [root, snapshot] of currentWorktreeSnapshots(sessionManager)) {
		if (!isInside(storeDir, root)) continue;
		if (!restoredNow.has(root)) {
			const last = await readResumeSetupLedger(storeDir, root);
			if (last === undefined || last.exitStatus === 0) continue;
		}
		try {
			const setup = await ensureResumeSetup({
				entryPoint: options.entryPoint,
				worktree: root,
				envHash: snapshot.envHash,
				storeDir,
				config: options.setup,
				signal: options.signal,
			});
			if (setup.status === "ran") {
				notices.push({
					type: "info",
					message: `Ran setup hook ${setup.hook} in ${root} (output: ${setup.logPath})`,
				});
			}
		} catch (error) {
			if (
				isInside(root, cwd) ||
				options.signal?.aborted ||
				!(isResumeSetupHookError(error) || isResumePreconditionError(error))
			) {
				throw error;
			}
			const recorded = mappings.filter((mapping) => resolve(mapping.to) === root).at(-1)?.from;
			notices.push({
				type: "warning",
				message: `Continuing without the setup hook in ${root}${recorded === undefined ? "" : `, restored for ${recorded}`} (snapshot ${snapshot.id.slice(0, 12)}): ${describeFailure(error)}`,
			});
		}
	}
	return notices;
}

/**
 * Whether the repository of the checkout at `root` holds the commit that records `snapshot`. That commit is
 * content-addressed and written only where Atomic captured exactly that state, so it tells the checkout a session
 * worked in, even after it changed, from another checkout of the same repository at the same path on another node,
 * unless Atomic captured the same state there too. A checkout that is not a repository, or a node without Git, does
 * not hold it.
 */
export async function holdsSnapshotCommit(
	snapshot: WorktreeSnapshot,
	root: string,
	signal?: AbortSignal,
): Promise<boolean> {
	try {
		const { exitCode } = await runGit(["cat-file", "-e", `${snapshot.snapshot}^{commit}`], {
			cwd: root,
			signal,
			allowExitCodes: [1, 128],
		});
		return exitCode === 0;
	} catch (error) {
		if (isGitUnavailableError(error)) return false;
		throw error;
	}
}

/**
 * Where a woken session continues. Each checkout it recorded that it worked in on this node stays as it is, since work
 * done in it after the release belongs to the session, and a setup hook that did not finish in a worktree this node
 * restored for it runs again. Every other checkout, as when it is missing or another clone sits at its path on another
 * node, is prepared as `/resume` prepares it. When every checkout stays, it continues in the directory it last worked
 * in, after the restores it recorded, which `reopen` opens it in.
 */
export async function continueSessionWhereItWorked(
	opened: SessionManager,
	options: PrepareSessionResumeOptions,
	reopen: (cwd: string) => Promise<SessionManager> = (cwd) => opened.openSessionById(opened.getSessionId(), cwd),
): Promise<SessionManager> {
	const cwd = mapRestoredPath(opened.getCwd(), opened.getWorktreeRootMappings());
	const checkouts = currentWorktreeSnapshots(opened);
	const own = await checkoutsWorkedHere(checkouts, cwd, options);
	if (own.size < checkouts.size) {
		const prepared = await prepareSessionResume(opened, { ...options, keepInPlace: own });
		return prepared.status === "ready" ? prepared.sessionManager : opened;
	}
	await retryFailedSessionSetup(opened, options);
	return cwd === resolve(opened.getCwd()) ? opened : reopen(cwd);
}

/**
 * The roots of the `checkouts` a session recorded that are here as checkouts it worked in on this node, as it left them
 * or changed since: a worktree this node restored for it, or a checkout whose repository holds the commit of its latest
 * snapshot. The checkout the session works in counts only while its working directory `cwd` is here too.
 */
async function checkoutsWorkedHere(
	checkouts: ReadonlyMap<string, WorktreeSnapshot>,
	cwd: string,
	options: PrepareSessionResumeOptions,
): Promise<Set<string>> {
	const storeDir = resolve(options.storeDir ?? defaultWorktreeSnapshotStoreDir());
	const own = new Set<string>();
	for (const [root, snapshot] of checkouts) {
		if (!existsSync(isInside(root, cwd) ? cwd : root)) continue;
		if (isInside(storeDir, root) || (await holdsSnapshotCommit(snapshot, root, options.signal))) own.add(root);
	}
	return own;
}

/**
 * Runs the setup hook again in each worktree Atomic restored for the session whose last hook there failed, as a resume
 * that restores nothing does.
 */
export async function retryFailedSessionSetup(
	sessionManager: SessionManager,
	options: PrepareSessionResumeOptions,
): Promise<ResumeNotice[]> {
	const storeDir = resolve(options.storeDir ?? defaultWorktreeSnapshotStoreDir());
	return setUpRestoredCheckouts(sessionManager, new Set(), storeDir, options);
}

/**
 * Whether resuming in `root` restores `snapshot` into a fresh worktree: the checkout is gone, is not a repository of
 * the recorded tree, or no longer matches it. A path that cannot be read fails with its typed `unreadable-path` error
 * instead, since restoring would hide it. A checkout whose HEAD only moved forward over the recorded tree, as after
 * committing the recorded edits, continues in place, as #4245's resume decides. Read-only.
 */
export async function worktreeNeedsRestore(
	snapshot: WorktreeSnapshot,
	root: string,
	options: VerifyWorktreeOptions,
): Promise<boolean> {
	try {
		await verifyWorktree(snapshot, root, options);
		return false;
	} catch (error) {
		if (isWorkspaceDriftError(error)) return !(await isHeadOnlyAdvance(error, options.signal));
		if (isWorkspaceSnapshotError(error) && error.code !== "unreadable-path") return true;
		throw error;
	}
}

/** The outcome of starting or provisioning Git once for a resume: the typed reason it cannot run, or undefined. */
interface GitProbe {
	readonly unavailable: GitUnavailableError | undefined;
}

/**
 * Decides what the resume does about the `candidates` that are gone or changed here, before anything is written.
 * Every precondition of restoring them on this node is checked in one pass: Git can be started or provisioned (`git`,
 * the probe's typed failure), and a setup hook can run in each restored worktree whose snapshot has dependency inputs.
 * An unmet one for a checkout the session works in refuses the resume with every unmet precondition, each naming its
 * checkout; for any other checkout it leaves that checkout out, with a warning.
 */
async function planRestores(
	sessionManager: SessionManager,
	candidates: { readonly targets: readonly RestoreTarget[]; readonly left: ReadonlyMap<string, ResumeNotice> },
	storeDir: string,
	options: PrepareSessionResumeOptions,
	git: GitUnavailableError | undefined,
): Promise<RestorePlan> {
	const required = candidates.targets.filter((target) => target.runsHere);
	const others = candidates.targets.filter((target) => !target.runsHere);
	const setupProblems = new Map<RestoreTarget, ResumePreconditionProblem>();
	for (const target of candidates.targets) {
		const problem = await predictedSetupProblem(target.snapshot.envHash, join(storeDir, "worktrees"), options.setup);
		if (problem) setupProblems.set(target, problem);
	}
	if (required.length > 0 && (git !== undefined || required.some((target) => setupProblems.has(target)))) {
		throw preconditionFailure(sessionManager, [...required, ...others], setupProblems, options, git);
	}
	const left = new Map(candidates.left);
	const optional: RestoreTarget[] = [];
	for (const target of others) {
		const setupProblem = setupProblems.get(target);
		if (git) {
			left.set(
				target.root,
				notRestored(
					target.root,
					target.snapshot,
					`${absentOrChanged(target)}, and Git is unavailable here (${git.code}), which restoring it needs`,
				),
			);
		} else if (setupProblem) {
			left.set(
				target.root,
				notRestored(target.root, target.snapshot, `${absentOrChanged(target)}, and ${setupProblem.why}`),
			);
		} else {
			optional.push(target);
		}
	}
	return { required, optional, left };
}

/** The refusal to resume because `targets` cannot be restored here: the unmet Git precondition and each setup problem. */
function preconditionFailure(
	sessionManager: SessionManager,
	targets: readonly RestoreTarget[],
	setupProblems: ReadonlyMap<RestoreTarget, ResumePreconditionProblem>,
	options: PrepareSessionResumeOptions,
	git: GitUnavailableError | undefined,
): ResumePreconditionError {
	const problems: ResumePreconditionProblem[] = [];
	if (git) {
		const reasons = targets.map(
			(target) =>
				`snapshot ${target.snapshot.id.slice(0, 12)} because ${target.root} ${target.absent ? "does not exist on this node" : "no longer matches it"}`,
		);
		problems.push(
			gitUnavailableProblem(
				git,
				`session ${sessionManager.getSessionId()} must be restored from ${reasons.join(", and from ")}`,
			),
		);
	}
	for (const target of targets) {
		const problem = setupProblems.get(target);
		if (problem) problems.push(forCheckout(problem, target.root, target.runsHere));
	}
	return new ResumePreconditionError({ entryPoint: options.entryPoint, problems }, git);
}

/**
 * Whether a restored worktree is trusted to run its repository's `.atomic/setup` outside the CLI: the decision saved
 * in `agentDir` for that path, else the default trust setting.
 */
export function savedProjectTrust(
	agentDir: string,
	settings: Pick<SettingsManager, "getDefaultProjectTrust">,
): (worktree: string) => boolean {
	const trustStore = new ProjectTrustStore(agentDir);
	return (worktree) => trustStore.get(worktree) ?? settings.getDefaultProjectTrust() === "always";
}

/** Where restored worktrees, the setup ledger and setup logs live for the agent directory `agentDir`. */
export function resumeStoreDir(agentDir: string): string {
	return join(agentDir, "worktree-snapshots");
}

/**
 * The options a resume from `launchCwd` needs: snapshot settings and the setup hook configuration from
 * `settingsManager`, and the worktree store of `agentDir`.
 */
export function sessionResumeOptions(
	entryPoint: ResumeEntryPoint,
	launchCwd: string,
	agentDir: string,
	settingsManager: Pick<SettingsManager, "getWorktreeSnapshotSettings" | "getResumeSetupCommand">,
	trusted: (worktree: string) => boolean,
): PrepareSessionResumeOptions {
	return {
		entryPoint,
		launchCwd,
		settings: settingsManager.getWorktreeSnapshotSettings(),
		setup: { command: settingsManager.getResumeSetupCommand(), trusted },
		storeDir: resumeStoreDir(agentDir),
	};
}
