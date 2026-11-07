import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { type GitUnavailableError, isGitUnavailableError } from "../../utils/git-errors.ts";
import type { SessionManager } from "../session-manager.ts";
import { currentWorktreeSnapshots, mapRestoredPath, openSessionInWorktree } from "../session-worktree-snapshots.ts";
import type { SettingsManager } from "../settings-manager.ts";
import { ProjectTrustStore } from "../trust-manager.ts";
import { locateCheckout, readRepositoryConfig } from "../worktree-snapshot/capture.ts";
import { isWorkspaceDriftError, isWorkspaceSnapshotError } from "../worktree-snapshot/errors.ts";
import { gitText, runGit } from "../worktree-snapshot/git.ts";
import { isHeadOnlyAdvance } from "../worktree-snapshot/head-advance.ts";
import {
	defaultWorktreeSnapshotStoreDir,
	type VerifyWorktreeOptions,
	verifyWorktree,
} from "../worktree-snapshot/restore.ts";
import type { WorktreeRootMapping, WorktreeSnapshot, WorktreeSnapshotSettings } from "../worktree-snapshot/types.ts";
import type { ResumeEntryPoint, ResumePreconditionProblem } from "./errors.ts";
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
 * Every other checkout the session recorded that is gone or changed here, except those in `keepInPlace`, is restored:
 * every precondition of those restores is checked in one pass first (Git, and a setup hook for each snapshot with
 * dependency inputs), then #4245's {@link openSessionInWorktree} restores them into fresh worktrees. A restored
 * worktree that turns out to have no setup hook it needs is removed again before its restore is recorded. Each
 * worktree Atomic restored gets its setup hook once per environment. The session's tools resolve paths under every
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
	const restoring = await checkoutsToRestore(withMapping(sessionManager, reused), options);
	if (restoring.length > 0) {
		git ??= { unavailable: await io.probeGit(options.signal) };
		await assertRestorePreconditions(sessionManager, restoring, storeDir, options, git.unavailable);
	}
	const snapshots = sessionManager.getWorktreeSnapshotRecords();
	const recordedBefore = sessionManager.getWorktreeRootMappings().length;
	const opened = await openSessionInWorktree(sessionManager, {
		settings: options.settings,
		storeDir,
		signal: options.signal,
		sessionDirectory: options.sessionDirectory,
		beforeRecord: (restored) => reserveRestoredSetup(restored, snapshots, storeDir, options),
		pendingMappings: reused === undefined ? [] : [reused],
		keepInPlace: options.keepInPlace,
	});
	const mappings = opened.sessionManager.getWorktreeRootMappings();
	notices.push(...opened.notices);
	const restoredNow = new Set(mappings.slice(recordedBefore).map((mapping) => resolve(mapping.to)));
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
	for (const root of currentWorktreeSnapshots(sessionManager).keys()) {
		if (!(await isDirectory(root))) {
			notices.push({
				type: "warning",
				message: `Continuing without restoring ${root}, which this session also recorded`,
			});
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

/**
 * The recorded checkouts that are gone or changed here, which #4245's resume restores into fresh worktrees, except
 * those the session continues in as they are.
 */
async function checkoutsToRestore(
	sessionManager: SessionCheckouts,
	options: PrepareSessionResumeOptions,
): Promise<RestoreTarget[]> {
	const targets: RestoreTarget[] = [];
	for (const [root, snapshot] of currentWorktreeSnapshots(sessionManager)) {
		if (!options.keepInPlace?.has(root) && (await worktreeNeedsRestore(snapshot, root, options))) {
			targets.push({ root, snapshot, absent: !(await isDirectory(root)) });
		}
	}
	return targets;
}

/**
 * Checks that each worktree #4245's resume just restored has the setup hook it needs, before that resume records any
 * of them, so a missing hook leaves no record of a worktree that is removed again, and enters each hook that will run
 * in the ledger as not run yet.
 */
async function reserveRestoredSetup(
	restored: readonly WorktreeRootMapping[],
	snapshots: ReadonlyMap<string, WorktreeSnapshot>,
	storeDir: string,
	options: PrepareSessionResumeOptions,
): Promise<void> {
	for (const mapping of restored) {
		await reserveResumeSetup({
			entryPoint: options.entryPoint,
			worktree: mapping.to,
			envHash: snapshots.get(mapping.snapshotId)!.envHash,
			storeDir,
			config: options.setup,
			signal: options.signal,
		});
	}
}

/**
 * Runs the setup hook of the worktrees Atomic restored for the session: once per environment in each worktree this
 * resume restored (`restoredNow`), and again in a worktree restored earlier only when its last hook failed. Later
 * changes to an earlier worktree's lockfiles are the session's own work.
 */
async function setUpRestoredCheckouts(
	sessionManager: SessionManager,
	restoredNow: ReadonlySet<string>,
	storeDir: string,
	options: PrepareSessionResumeOptions,
): Promise<ResumeNotice[]> {
	const notices: ResumeNotice[] = [];
	for (const [root, snapshot] of currentWorktreeSnapshots(sessionManager)) {
		if (!isInside(storeDir, root)) continue;
		if (!restoredNow.has(root)) {
			const last = await readResumeSetupLedger(storeDir, root);
			if (last === undefined || last.exitStatus === 0) continue;
		}
		const setup = await ensureResumeSetup({
			entryPoint: options.entryPoint,
			worktree: root,
			envHash: snapshot.envHash,
			storeDir,
			config: options.setup,
			signal: options.signal,
		});
		if (setup.status === "ran") {
			notices.push({ type: "info", message: `Ran setup hook ${setup.hook} in ${root} (output: ${setup.logPath})` });
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
 * Every precondition of restoring `targets` on this node, checked before anything is written: Git can be started or
 * provisioned (`git`, the probe's typed failure), and a setup hook can run in each restored worktree whose snapshot has
 * dependency inputs.
 */
async function assertRestorePreconditions(
	sessionManager: SessionManager,
	targets: readonly RestoreTarget[],
	storeDir: string,
	options: PrepareSessionResumeOptions,
	git: GitUnavailableError | undefined,
): Promise<void> {
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
		const setup = await predictedSetupProblem(target.snapshot.envHash, join(storeDir, "worktrees"), options.setup);
		if (setup) {
			problems.push(setup);
			break;
		}
	}
	assertResumePreconditions(options.entryPoint, problems, git);
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
