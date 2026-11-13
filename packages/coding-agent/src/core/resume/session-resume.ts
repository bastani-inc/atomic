import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { type GitUnavailableError, isGitUnavailableError } from "../../utils/git-errors.ts";
import { failureDebugFields, reportDebug } from "../debug.ts";
import type { SessionManager } from "../session-manager.ts";
import {
	currentWorktreeSnapshots,
	formatMissingRecordNotice,
	type MissingSnapshotRecord,
	mapRestoredPath,
	missingSnapshotRecords,
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
import type {
	WorktreeRootMapping,
	WorktreeSnapshot,
	WorktreeSnapshotSettings,
	WorktreeUnrestored,
} from "../worktree-snapshot/types.ts";
import type { BlueprintBuildConfig } from "./blueprint/build.ts";
import {
	type BlueprintCheckout,
	checkoutsNeedingRebuild,
	enclosingRepositoryRoot,
	inheritedRemotes,
	type ResumedBlueprints,
	recordBlueprintContext,
	setUpResumedBlueprints,
} from "./blueprint/resume.ts";
import { isResumePreconditionError, type ResumeEntryPoint } from "./errors.ts";
import { isResumeFailure } from "./failure.ts";
import { isInside } from "./path-mapping.ts";
import { defaultResumePreflightIo, type ResumePreflightIo } from "./preflight.ts";

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
	/** How the blueprints of worktrees this resume restores are built; the store directory is `storeDir`. */
	readonly blueprint: Omit<BlueprintBuildConfig, "storeDir">;
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
	/**
	 * `"skip"` restores checkouts but builds and describes no blueprint and records no blueprint context: for a process
	 * that serves a resume another process of the same user-level action already prepared and built, so one resume
	 * builds once. Default `"build"`.
	 */
	readonly blueprints?: "build" | "skip";
	/**
	 * Told the warnings of the blueprint builds a resume ran when its caller gets only a session back, as when a
	 * released session is woken ({@link continueSessionWhereItWorked}).
	 */
	readonly onNotices?: (notices: readonly ResumeNotice[]) => void;
	/** Told each slow step the resume starts (checking checkouts, restoring one, building blueprints), for a progress line. */
	readonly onProgress?: (message: string) => void;
}

export type PreparedSessionResume =
	| { readonly status: "cancelled" }
	| {
			readonly status: "ready";
			/** The session opened where it continues: the one passed in when its cwd did not change. */
			readonly sessionManager: SessionManager;
			readonly notices: readonly ResumeNotice[];
			/** The warnings of the blueprint builds this resume ran, also in `notices`. */
			readonly blueprintNotices: readonly ResumeNotice[];
			/** The blueprint context the session's next turn carries, already recorded in it; undefined when none. */
			readonly blueprintContext: string | undefined;
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

/**
 * Moves a session that a resume restored into a worktree, and that has not worked in it since, back to the checkout it
 * was restored from, when that checkout is on this node and its repository holds the snapshot's commit (#4660). The
 * session continues there as the checkout is now, even when it changed since the snapshot. Undefined keeps the session
 * in its worktree: the worktree is not one Atomic restored, it changed or recorded another snapshot since, or the
 * checkout it came from is gone or is another clone.
 */
async function returnToStartingCheckout(
	sessionManager: SessionManager,
	match: SessionSnapshotMatch,
	storeDir: string,
	options: PrepareSessionResumeOptions,
): Promise<Extract<CheckoutReuse, { kind: "reused" }> | undefined> {
	if (!isInside(storeDir, match.root)) return undefined;
	const restore = [...sessionManager.getWorktreeRootMappings()]
		.reverse()
		.find((mapping) => resolve(mapping.to) === resolve(match.root));
	if (restore === undefined || restore.snapshotId !== match.snapshot.id) return undefined;
	const checkout = resolve(restore.from);
	const cwd = resolve(checkout, relative(match.root, match.cwd));
	if (isInside(storeDir, checkout) || !existsSync(cwd)) return undefined;
	// When the checkout cannot be examined, the project the session started in is still where it goes back to.
	const examined = await orFallBack(options, "return-to-checkout-verify", undefined, async () => ({
		holdsCommit: await holdsSnapshotCommit(match.snapshot, checkout, options.signal),
		matches: !(await worktreeNeedsRestore(match.snapshot, checkout, options)),
	}));
	if (examined !== undefined && !examined.holdsCommit) return undefined;
	const matches = examined?.matches;
	const snapshotId = match.snapshot.id.slice(0, 12);
	return {
		kind: "reused",
		cwd,
		matches: matches ?? false,
		mapping: {
			from: match.root,
			to: checkout,
			snapshotId: match.snapshot.id,
			tree: match.snapshot.tree,
			restoredAt: new Date().toISOString(),
		},
		notice: {
			type: "info",
			message: `Resuming in ${checkout}, the checkout this session was restored from, instead of the worktree ${match.root}.${matches === undefined ? "" : matches ? ` It matches snapshot ${snapshotId}.` : ` It has changed since snapshot ${snapshotId}; that snapshot was not restored.`}`,
		},
	};
}

/**
 * Runs an optional improvement of where a resume continues. When it fails on a checkout, with a typed resume,
 * workspace or Git failure, the resume goes on with `fallback`, the behaviour it had without the improvement; the
 * reason goes to the debug log. A cancellation, and any failure that is not about a checkout, still end the resume.
 */
async function orFallBack<T>(
	options: Pick<PrepareSessionResumeOptions, "signal">,
	step: string,
	fallback: T,
	attempt: () => Promise<T>,
): Promise<T> {
	try {
		return await attempt();
	} catch (error) {
		if (options.signal?.aborted || !isCheckoutFailure(error)) throw error;
		reportDebug("storage", "resume-checkout-fallback", { step, ...failureDebugFields(error) });
		return fallback;
	}
}

/** Whether the checkout at `root` has uncommitted or untracked changes, which a resume must not overwrite unasked. */
async function hasLocalChanges(root: string, signal: AbortSignal | undefined): Promise<boolean> {
	return (await gitText(["status", "--porcelain"], { cwd: root, signal })).length > 0;
}

/**
 * Gets a resumed session's checkouts ready on this node before its runtime starts, and returns the session opened
 * where it continues. When the checkout the session works in changed here but is still the one it worked in (its
 * repository holds the snapshot's commit, or Atomic restored it here), the session continues in it as it is, silently
 * (#4660). A session a resume moved into a restored worktree, and that has not worked in it since, returns to
 * the checkout it was restored from when that checkout is here. When the checkout the session works in is missing or
 * belongs to another clone here, a checkout of the same
 * repository the resume started in is used as-is if it matches (and, if it differs, only when the user chooses it).
 * Resume always opens the session (#4733): a checkout whose snapshot cannot be restored exactly gets the best state
 * this node can reach, its recorded commit with the change sets that apply or the closest commit it can fetch, and one
 * notice saying what is missing; when nothing of it can be restored, Git being unavailable included, the session
 * continues in its recorded directory, or the directory the resume started from when that is not here, with the same
 * kind of notice. Only a snapshot record that fails the security checks, or a restore target that holds other files,
 * refuses the resume. Every other checkout the session recorded that is gone or changed here, except
 * those in `keepInPlace`, never blocks the resume: one the session worked in on this node, changed since, continues as
 * it is; the rest are restored into fresh worktrees one by one by #4245's {@link resumeSessionWorktree}, and one that
 * cannot be (Git is unavailable, or its restore fails) is left out with a warning that names its path and why. Each
 * worktree Atomic restored then gets its blueprints built (#4588): a failing step is a warning in `notices` and never
 * stops the resume. The agent gets the blueprints' maintenance and knowledge in the session's next turn. The session's
 * tools resolve paths under every root it recorded into the place that root was restored.
 */
export async function prepareSessionResume(
	sessionManager: SessionManager,
	options: PrepareSessionResumeOptions,
): Promise<PreparedSessionResume> {
	const io = options.io ?? defaultResumePreflightIo;
	const storeDir = resolve(options.storeDir ?? defaultWorktreeSnapshotStoreDir());
	if (!options.settings.enabled || sessionManager.getLatestWorktreeSnapshots().size === 0) {
		const missing = options.settings.enabled ? missingSnapshotRecords(sessionManager) : [];
		if (missing.length > 0) return continueWithoutRecords(sessionManager, missing, storeDir, options);
		const unchanged = await describeBlueprintsInPlace(sessionManager, storeDir, options);
		return { status: "ready", sessionManager, notices: [], blueprintNotices: [], blueprintContext: unchanged };
	}
	const notices: ResumeNotice[] = [];
	const checkoutCount = currentWorktreeSnapshots(sessionManager).size;
	options.onProgress?.(
		`Checking ${checkoutCount === 1 ? "1 checkout" : `${checkoutCount} checkouts`} against the session's snapshots`,
	);
	const verified = new Map<string, Promise<boolean>>();
	const verifyOnce = (snapshot: WorktreeSnapshot, root: string): Promise<boolean> => {
		const key = `${snapshot.id}\0${resolve(root)}`;
		let verification = verified.get(key);
		if (verification === undefined) {
			verification = worktreeNeedsRestore(snapshot, root, options);
			verified.set(key, verification);
		}
		return verification;
	};
	// Which partly restored worktrees are still as the restore left them, compared once per resume.
	let partialOnce: Promise<Set<string>> | undefined;
	const partial = (): Promise<Set<string>> => {
		partialOnce ??= partialRestores(sessionManager, options);
		return partialOnce;
	};
	const match = latestSessionSnapshot(sessionManager);
	let git: GitProbe | undefined;
	let reused: WorktreeRootMapping | undefined;
	let needsRestore: boolean;
	try {
		needsRestore =
			match !== undefined && !options.keepInPlace?.has(match.root) && (await verifyOnce(match.snapshot, match.root));
	} catch (error) {
		if (!isGitUnavailableError(error)) throw error;
		return continueWithoutGit(sessionManager, error, storeDir, options);
	}
	const project =
		match !== undefined && !needsRestore && !options.keepInPlace?.has(match.root)
			? await orFallBack(options, "return-to-checkout", undefined, () =>
					returnToStartingCheckout(sessionManager, match, storeDir, options),
				)
			: undefined;
	if (project !== undefined) {
		await recordReuse(sessionManager, project.mapping);
		notices.push(project.notice);
	}
	const keepsOwnCheckout =
		match !== undefined &&
		project === undefined &&
		needsRestore &&
		(await isDirectory(match.root)) &&
		(await orFallBack(options, "own-checkout", new Set([match.root]), async () =>
			checkoutsWorkedHere(new Map([[match.root, match.snapshot]]), match.cwd, options, await partial()),
		).then((worked) => worked.has(match.root)));
	// The checkout the session returned to stays as it is, whatever it changed since: only the others are restored.
	const kept = [...(keepsOwnCheckout && match !== undefined ? [match.root] : [])];
	if (project !== undefined && match !== undefined) kept.push(match.root, project.mapping.to);
	const resume: PrepareSessionResumeOptions =
		kept.length > 0 ? { ...options, keepInPlace: new Set([...(options.keepInPlace ?? []), ...kept]) } : options;
	if (match !== undefined && !keepsOwnCheckout && needsRestore) {
		git = { unavailable: await io.probeGit(options.signal) };
		const reuse = git.unavailable === undefined ? await reuseLaunchCheckout(match, options) : undefined;
		if (reuse?.kind === "cancelled") return { status: "cancelled" };
		if (reuse?.kind === "reused" && !reuse.matches) {
			await recordReuse(sessionManager, reuse.mapping);
			return continueInChosenCheckout(sessionManager, reuse, storeDir, options);
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
		resume,
		verifyOnce,
		partial,
	);
	if (candidates.targets.length > 0) git ??= { unavailable: await io.probeGit(options.signal) };
	const plan = planRestores(candidates, git?.unavailable);
	notices.push(...plan.left.values());
	const recordedBefore = sessionManager.getWorktreeRootMappings().length;
	const resumed = await restorePlanned(sessionManager, plan, reused, storeDir, resume);
	const cwd = resumed.cwd ?? mapRestoredPath(sessionManager.getCwd(), sessionManager.getWorktreeRootMappings());
	const opened = await openResumedSession(
		sessionManager,
		cwd,
		resumed.restored,
		options.sessionDirectory,
		resumed.unrestored,
	);
	notices.push(...opened.notices, ...resumed.failed);
	const restoredNow = new Set(
		opened.sessionManager
			.getWorktreeRootMappings()
			.slice(recordedBefore)
			.map((mapping) => resolve(mapping.to))
			.filter((root) => isInside(storeDir, root)),
	);
	if (restoredNow.size > 0 && options.blueprints !== "skip") {
		options.onProgress?.("Setting up the blueprints of restored worktrees");
	}
	const blueprints = await setUpCheckoutBlueprints(opened.sessionManager, restoredNow, storeDir, options);
	notices.push(...blueprints.notices);
	await recordBlueprintContext(opened.sessionManager, blueprints.context);
	return {
		status: "ready",
		sessionManager: opened.sessionManager,
		notices,
		blueprintNotices: blueprints.notices,
		blueprintContext: blueprints.context,
	};
}

/**
 * Opens a session whose checkouts cannot even be compared with their snapshots, because Git cannot run here (#4733):
 * it continues in its recorded directory as it is, or in the directory the resume started from when that is not
 * here, without restoring any checkout, and each is recorded as left out with a notice. Nothing is written to any
 * checkout.
 */
async function continueWithoutGit(
	sessionManager: SessionManager,
	git: GitUnavailableError,
	storeDir: string,
	options: PrepareSessionResumeOptions,
): Promise<PreparedSessionResume> {
	const roots = [...currentWorktreeSnapshots(sessionManager).keys()].filter((root) => !options.keepInPlace?.has(root));
	const resumed = await resumeSessionWorktree(sessionManager, {
		settings: options.settings,
		storeDir,
		signal: options.signal,
		keepInPlace: options.keepInPlace,
		cannotRestore: new Map(roots.map((root) => [root, git])),
		fallbackCwd: options.launchCwd,
		skipMissingRecords: true,
	});
	const cwd = resumed.status === "none" ? sessionManager.getCwd() : resumed.cwd;
	const opened = await openResumedSession(
		sessionManager,
		cwd,
		[],
		options.sessionDirectory,
		resumed.status === "none" ? [] : resumed.unrestored.map((checkout) => checkout.record),
	);
	const context = await describeBlueprintsInPlace(opened.sessionManager, storeDir, options);
	return {
		status: "ready",
		sessionManager: opened.sessionManager,
		notices: [
			...opened.notices,
			...(resumed.missingRecords ?? []).map((missing) => ({
				type: "warning" as const,
				message: formatMissingRecordNotice(missing),
			})),
		],
		blueprintNotices: [],
		blueprintContext: context,
	};
}

/**
 * Opens a session whose every recorded checkout refers to a snapshot the session holds no record of (#4733): nothing
 * can be restored, so it continues in its recorded directory, or the directory the resume started from when that is
 * not here, with one notice per checkout.
 */
async function continueWithoutRecords(
	sessionManager: SessionManager,
	missing: readonly MissingSnapshotRecord[],
	storeDir: string,
	options: PrepareSessionResumeOptions,
): Promise<PreparedSessionResume> {
	const recorded = mapRestoredPath(sessionManager.getCwd(), sessionManager.getWorktreeRootMappings());
	const cwd = existsSync(recorded) ? recorded : resolve(options.launchCwd);
	const opened = await openResumedSession(sessionManager, cwd, [], options.sessionDirectory);
	const context = await describeBlueprintsInPlace(opened.sessionManager, storeDir, options);
	return {
		status: "ready",
		sessionManager: opened.sessionManager,
		notices: missing.map((record) => ({ type: "warning" as const, message: formatMissingRecordNotice(record) })),
		blueprintNotices: [],
		blueprintContext: context,
	};
}

const SKIPPED_BLUEPRINTS: ResumedBlueprints = { outcome: undefined, notices: [], layers: [], context: undefined };

/**
 * The blueprint context of a session that has no worktree snapshots to restore: what its working directory's
 * repository and the global blueprint say, recorded in the session. No build runs and no Git command is started.
 */
async function describeBlueprintsInPlace(
	sessionManager: SessionManager,
	storeDir: string,
	options: PrepareSessionResumeOptions,
): Promise<string | undefined> {
	if (options.blueprints === "skip") return undefined;
	const root = enclosingRepositoryRoot(resolve(sessionManager.getCwd()));
	const blueprints = await setUpResumedBlueprints({
		restored: [],
		inPlace: root === undefined ? [] : [{ root, remotes: [] }],
		config: { ...options.blueprint, storeDir },
		signal: options.signal,
	});
	await recordBlueprintContext(sessionManager, blueprints.context);
	return blueprints.context;
}

/**
 * Continues in the launch checkout the user chose although it differs from the snapshot. #4245's resume would restore
 * a fresh worktree over that choice, so no other checkout is restored either; the notice names those left out.
 */
async function continueInChosenCheckout(
	sessionManager: SessionManager,
	reuse: Extract<CheckoutReuse, { kind: "reused" }>,
	storeDir: string,
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
	const blueprints =
		options.blueprints === "skip"
			? SKIPPED_BLUEPRINTS
			: await setUpResumedBlueprints({
					restored: [],
					inPlace: await existingCheckouts(reopened),
					config: { ...options.blueprint, storeDir },
					signal: options.signal,
				});
	await recordBlueprintContext(reopened, blueprints.context);
	return {
		status: "ready",
		sessionManager: reopened,
		notices,
		blueprintNotices: [],
		blueprintContext: blueprints.context,
	};
}

/** The session's current checkouts that exist on this node, with the remotes their snapshots recorded. */
async function existingCheckouts(sessionManager: SessionCheckouts): Promise<BlueprintCheckout[]> {
	const checkouts: BlueprintCheckout[] = [];
	for (const [root, snapshot] of currentWorktreeSnapshots(sessionManager)) {
		if (await isDirectory(root)) checkouts.push(checkoutOf(sessionManager, root, snapshot));
	}
	return checkouts;
}

/** The checkout at `root` for the blueprint build, identified by its repository's remotes as the session's restores trace them. */
function checkoutOf(sessionManager: SessionCheckouts, root: string, snapshot: WorktreeSnapshot): BlueprintCheckout {
	return {
		root,
		remotes: inheritedRemotes(
			root,
			snapshot.remotes,
			sessionManager.getWorktreeRootMappings(),
			sessionManager.getWorktreeSnapshotRecords(),
		),
	};
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
	/** Why Git cannot run here, when it cannot: the checkouts the session works in are then not restored (#4733). */
	readonly git: GitUnavailableError | undefined;
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
	needsRestore: (snapshot: WorktreeSnapshot, root: string) => Promise<boolean>,
	partial: () => Promise<ReadonlySet<string>>,
): Promise<{ readonly targets: RestoreTarget[]; readonly left: Map<string, ResumeNotice> }> {
	const targets: RestoreTarget[] = [];
	const left = new Map<string, ResumeNotice>();
	const checkouts = [...currentWorktreeSnapshots(sessionManager)].filter(([root]) => !options.keepInPlace?.has(root));
	const comparisons = await settleBounded(checkouts, VERIFY_CONCURRENCY, ([root, snapshot]) =>
		needsRestore(snapshot, root),
	);
	for (const [index, [root, snapshot]] of checkouts.entries()) {
		const runsHere = isInside(root, cwd);
		const comparison = comparisons[index]!;
		if (comparison.status === "rejected") {
			const error: unknown = comparison.reason;
			if (runsHere || options.signal?.aborted || !isCheckoutFailure(error)) throw error;
			left.set(root, notRestored(root, snapshot, `it could not be compared with the snapshot: ${error.message}`));
			continue;
		}
		if (!comparison.value) continue;
		const absent = !(await isDirectory(root));
		if (
			!runsHere &&
			!absent &&
			(await checkoutsWorkedHere(new Map([[root, snapshot]]), cwd, options, await partial())).has(root)
		) {
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

/** How many recorded checkouts a resume compares with their snapshots at once. */
const VERIFY_CONCURRENCY = 4;

/** `map` over `items`, at most `limit` at a time, each outcome settled in the order of `items`. */
async function settleBounded<T, R>(
	items: readonly T[],
	limit: number,
	map: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
	const outcomes: PromiseSettledResult<R>[] = [];
	let next = 0;
	const work = async (): Promise<void> => {
		while (next < items.length) {
			const index = next++;
			try {
				outcomes[index] = { status: "fulfilled", value: await map(items[index]!) };
			} catch (reason) {
				outcomes[index] = { status: "rejected", reason };
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, work));
	return outcomes;
}

/**
 * Restores what `plan` says into fresh worktrees with #4245's {@link resumeSessionWorktree}, recording each restore on
 * `sessionManager`, and returns the mappings it recorded. The checkouts the session works in are restored together,
 * with the mapping to the launch checkout `reused`; one that cannot be restored exactly is restored as far as it can be,
 * or recorded as left out, in `unrestored` (#4733), and only a failure that is not about a checkout refuses the resume.
 * Every other checkout is restored on its own the same way, and one whose restore is refused is reported in `failed`
 * and left out. `cwd` is where the session continues after the restore of the checkouts it works in.
 */
async function restorePlanned(
	sessionManager: SessionManager,
	plan: RestorePlan,
	reused: WorktreeRootMapping | undefined,
	storeDir: string,
	options: PrepareSessionResumeOptions,
): Promise<{
	restored: WorktreeRootMapping[];
	failed: ResumeNotice[];
	unrestored: WorktreeUnrestored[];
	cwd: string | undefined;
}> {
	const outcome = {
		restored: [] as WorktreeRootMapping[],
		failed: [] as ResumeNotice[],
		unrestored: [] as WorktreeUnrestored[],
		cwd: undefined as string | undefined,
		missing: new Set<string>(),
	};
	const restore = async (targets: readonly RestoreTarget[], pending: WorktreeRootMapping | undefined) => {
		const git = plan.git;
		for (const target of targets) {
			if (git === undefined) {
				options.onProgress?.(`Restoring ${target.root} from snapshot ${target.snapshot.id.slice(0, 12)}`);
			}
		}
		const restoring = new Set(targets.map((target) => target.root));
		const resumed = await resumeSessionWorktree(sessionManager, {
			settings: options.settings,
			storeDir,
			signal: options.signal,
			pendingMappings: pending === undefined ? [] : [pending],
			keepInPlace: new Set(
				[...currentWorktreeSnapshots(withMapping(sessionManager, pending)).keys()].filter(
					(root) => !restoring.has(root),
				),
			),
			...(git === undefined ? {} : { cannotRestore: new Map(targets.map((target) => [target.root, git])) }),
			fallbackCwd: options.launchCwd,
			skipMissingRecords: true,
		});
		for (const missing of resumed.missingRecords ?? []) {
			if (outcome.missing.has(missing.root)) continue;
			outcome.missing.add(missing.root);
			outcome.failed.push({ type: "warning", message: formatMissingRecordNotice(missing) });
		}
		if (resumed.status === "none") return undefined;
		if (resumed.status === "restored") outcome.restored.push(...resumed.mappings);
		outcome.unrestored.push(...resumed.unrestored.map((checkout) => checkout.record));
		return resumed.cwd;
	};
	if (plan.required.length > 0 || reused !== undefined) outcome.cwd = await restore(plan.required, reused);
	for (const target of plan.optional) {
		try {
			await restore([target], undefined);
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
 * Builds the blueprints of the worktrees Atomic restored for the session: each worktree this resume restored
 * (`restoredNow`), and again each worktree restored earlier whose last build failed or never finished. Later changes
 * to an earlier worktree's files are the session's own work. Every other checkout the session works in is only
 * described to the agent.
 */
async function setUpCheckoutBlueprints(
	sessionManager: SessionManager,
	restoredNow: ReadonlySet<string>,
	storeDir: string,
	options: PrepareSessionResumeOptions,
): Promise<ResumedBlueprints> {
	if (options.blueprints === "skip") return SKIPPED_BLUEPRINTS;
	const restoredHere: BlueprintCheckout[] = [];
	const earlier: BlueprintCheckout[] = [];
	const inPlace: BlueprintCheckout[] = [];
	for (const [root, snapshot] of currentWorktreeSnapshots(sessionManager)) {
		const checkout = checkoutOf(sessionManager, root, snapshot);
		if (restoredNow.has(root)) restoredHere.push(checkout);
		else if (isInside(storeDir, root)) earlier.push(checkout);
		else if (await isDirectory(root)) inPlace.push(checkout);
	}
	const retried = await checkoutsNeedingRebuild(earlier, storeDir);
	return setUpResumedBlueprints({
		restored: [...restoredHere, ...retried],
		inPlace,
		earlier: earlier.filter((checkout) => !retried.includes(checkout)),
		config: { ...options.blueprint, storeDir },
		signal: options.signal,
	});
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
 * done in it after the release belongs to the session, and a blueprint build that failed or did not finish in a worktree
 * this node restored for it runs again. Every other checkout, as when it is missing or another clone sits at its path on another
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
	const own = await checkoutsWorkedHere(checkouts, cwd, options, await partialRestores(opened, options));
	if (own.size < checkouts.size) {
		const prepared = await prepareSessionResume(opened, { ...options, keepInPlace: own });
		if (prepared.status !== "ready") return opened;
		if (prepared.blueprintNotices.length > 0) options.onNotices?.(prepared.blueprintNotices);
		return prepared.sessionManager;
	}
	const storeDir = resolveStoreDir(options);
	if (checkouts.size === 0) {
		await describeBlueprintsInPlace(opened, storeDir, options);
	} else {
		const blueprints = await setUpCheckoutBlueprints(opened, new Set(), storeDir, options);
		await recordBlueprintContext(opened, blueprints.context);
		if (blueprints.notices.length > 0) options.onNotices?.(blueprints.notices);
	}
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
	partial: ReadonlySet<string> = new Set(),
): Promise<Set<string>> {
	const storeDir = resolve(options.storeDir ?? defaultWorktreeSnapshotStoreDir());
	const own = new Set<string>();
	for (const [root, snapshot] of checkouts) {
		if (!existsSync(isInside(root, cwd) ? cwd : root)) continue;
		const restoredHere = isInside(storeDir, root) && !partial.has(resolve(root));
		if (restoredHere || (await holdsSnapshotCommit(snapshot, root, options.signal))) own.add(root);
	}
	return own;
}

/**
 * The worktrees a resume restored with less than their snapshot (#4733) that are still exactly as it left them: the
 * session recorded no snapshot there since, and their HEAD and files are what the restore put there. The next resume
 * tries the snapshot again instead of keeping them. A worktree changed since, even by hand, is the session's work and
 * stays; one that cannot be compared stays too.
 */
async function partialRestores(
	sessionManager: SessionCheckouts,
	options: Pick<PrepareSessionResumeOptions, "settings" | "signal">,
): Promise<Set<string>> {
	const current = currentWorktreeSnapshots(sessionManager);
	const partial = new Set<string>();
	for (const mapping of sessionManager.getWorktreeRootMappings()) {
		const degraded = mapping.degraded;
		const snapshot = current.get(mapping.to);
		if (degraded === undefined || snapshot?.id !== mapping.snapshotId || !existsSync(mapping.to)) continue;
		const restored = {
			remotes: [...snapshot.remotes],
			head: degraded.head,
			tree: degraded.tree,
			envHash: snapshot.envHash,
		};
		try {
			await verifyWorktree(restored, mapping.to, { settings: options.settings, signal: options.signal });
			partial.add(resolve(mapping.to));
		} catch (error) {
			if (options.signal?.aborted) throw error;
		}
	}
	return partial;
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
 * Decides what the resume does about the `candidates` that are gone or changed here, before anything is written. The
 * precondition of restoring them on this node is that Git can be started or provisioned (`git`, the probe's typed
 * failure). When it is unmet, the checkouts the session works in are not restored and the session continues without
 * them, with a notice and a record in the session (#4733); any other checkout is left out with a warning. A blueprint
 * is never a precondition.
 */
function planRestores(
	candidates: { readonly targets: readonly RestoreTarget[]; readonly left: ReadonlyMap<string, ResumeNotice> },
	git: GitUnavailableError | undefined,
): RestorePlan {
	const required = candidates.targets.filter((target) => target.runsHere);
	const others = candidates.targets.filter((target) => !target.runsHere);
	const left = new Map(candidates.left);
	const optional: RestoreTarget[] = [];
	for (const target of others) {
		if (git) {
			left.set(
				target.root,
				notRestored(
					target.root,
					target.snapshot,
					`${absentOrChanged(target)}, and Git is unavailable here (${git.code}), which restoring it needs`,
				),
			);
		} else {
			optional.push(target);
		}
	}
	return { required, optional, left, git };
}

/**
 * Whether a restored worktree is trusted to run its blueprints outside the CLI: the decision saved in `agentDir` for
 * that path, else the default trust setting.
 */
export function savedProjectTrust(
	agentDir: string,
	settings: Pick<SettingsManager, "getDefaultProjectTrust">,
): (worktree: string) => boolean {
	const trustStore = new ProjectTrustStore(agentDir);
	return (worktree) => trustStore.get(worktree) ?? settings.getDefaultProjectTrust() === "always";
}

/** Where restored worktrees, the blueprint build ledger and logs live for the agent directory `agentDir`. */
export function resumeStoreDir(agentDir: string): string {
	return join(agentDir, "worktree-snapshots");
}

function resolveStoreDir(options: Pick<PrepareSessionResumeOptions, "storeDir">): string {
	return resolve(options.storeDir ?? defaultWorktreeSnapshotStoreDir());
}

/**
 * The options a resume from `launchCwd` needs: snapshot settings and the blueprint build configuration from
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
		blueprint: { agentDir, setupCommand: settingsManager.getResumeSetupCommand(), trusted },
		storeDir: resumeStoreDir(agentDir),
	};
}
