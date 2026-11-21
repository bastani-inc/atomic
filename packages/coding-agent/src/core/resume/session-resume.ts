import { stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { type GitUnavailableError, isGitUnavailableError } from "../../utils/git-errors.ts";
import { failureDebugFields, reportDebugAsync as reportDebug } from "../debug.ts";
import type { SessionManager } from "../session-manager.ts";
import {
	adoptSubagentCaptures,
	currentWorktreeSnapshots,
	formatLapsedPinNotice,
	formatMissingRecordNotice,
	holdSessionWorktrees,
	lapsedDegradedRestores,
	latestRestoreTargets,
	type MissingSnapshotRecord,
	mapRestoredPath,
	mapRestoredPathAsync,
	missingSnapshotRecords,
	openResumedSession,
	pooledWorktreeOwnedElsewhere,
	recordPendingCarriedWork,
	releaseSessionWorktrees,
	resumeSessionWorktree,
} from "../session-worktree-snapshots.ts";
import type { SettingsManager } from "../settings-manager.ts";
import { recordTimingLines } from "../timings.ts";
import { pathExists } from "../tools/path-utils.ts";
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
	DEFAULT_MAX_IDLE_PER_REPOSITORY,
	pooledWorktreeHolder,
	setAsideWorktree,
	type WorktreePoolSettings,
	worktreeSetAside,
} from "../worktree-snapshot/pool.ts";
import { sameRemote } from "../worktree-snapshot/repository-identity.ts";
import {
	defaultWorktreeSnapshotStoreDir,
	pendingLfsDownload,
	type VerifyWorktreeOptions,
	verifyWorktree,
} from "../worktree-snapshot/restore.ts";
import { holdsSessionSnapshotRef } from "../worktree-snapshot/session-refs.ts";
import type {
	WorktreeRootMapping,
	WorktreeSnapshot,
	WorktreeSnapshotSettings,
	WorktreeUnrestored,
} from "../worktree-snapshot/types.ts";
import {
	announceBlueprintBuildWaiting,
	type BlueprintBuildResult,
	blueprintBuildShared,
	handOverBuildTimings,
	holdToolsUntilBuilt,
} from "./blueprint/barrier.ts";
import type { BlueprintBuildConfig } from "./blueprint/build.ts";
import { type CancelledBuild, cancelledBuilds, settleOtherBuilds, withBuildLocks } from "./blueprint/build-lock.ts";
import {
	BLUEPRINT_BUILDING_CONTEXT,
	type BlueprintCheckout,
	blueprintBuildReport,
	checkoutsNeedingRebuild,
	enclosingRepositoryRoot,
	inheritedRemotes,
	type ResumedBlueprints,
	recordBlueprintContext,
	setUpResumedBlueprints,
} from "./blueprint/resume.ts";
import { isResumePreconditionError, type ResumeEntryPoint } from "./errors.ts";
import { isResumeFailure } from "./failure.ts";
import { LfsDownloads } from "./lfs-downloads.ts";
import { isInside } from "./path-mapping.ts";
import { defaultResumePreflightIo, type ResumePreflightIo } from "./preflight.ts";
import { formatResumeTimings, type ResumeTimings, ResumeTimingsRecorder, recordResumeTimings } from "./timings.ts";

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

/** A fork into a different store does not publish an address or credentials for its source. */
export function parentHistoryNotices(manager: Pick<SessionManager, "getHeader">): ResumeNotice[] {
	return manager.getHeader()?.parentInOtherStore
		? [{ type: "info", message: "Parent history is in its original store or is no longer available." }]
		: [];
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
	/**
	 * The worktree pool (#4748): restores go to stable slots that the session holds while it is open, keeping at most
	 * `maxIdlePerRepository` idle slots per repository. Default: `snapshots.pool` defaults.
	 */
	readonly pool?: WorktreePoolSettings;
	/**
	 * `"prompt"` (default): the resume returns once the blueprints of the worktrees it restored are built. `"tools"`: it
	 * returns once they are restored and the build goes on behind the session's first turn; every tool call of the
	 * session waits for it (`awaitBlueprintReady`), and the first of them reports how it went. The build's warnings then
	 * reach the agent and the user with that tool's result, not `notices`.
	 */
	readonly waitForBlueprint?: "prompt" | "tools";
	/**
	 * Restored worktrees whose trust the session decides only after it starts (#5693): when the resume restores one, it
	 * returns once restored, as with `waitForBlueprint: "tools"`, and the build starts when `decided` settles, so no
	 * project build step runs before the decision. `blueprint.trusted` answers for them after that.
	 */
	readonly trustDecidedLater?: {
		readonly applies: (root: string) => Promise<boolean>;
		readonly decided: Promise<void>;
	};
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
			/**
			 * The notices of checkouts whose snapshot record the session does not hold, also in `notices` (#4744). The
			 * session records nothing for them, so a caller that shows the notices its entries carry shows these too.
			 */
			readonly missingRecordNotices?: readonly ResumeNotice[];
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

function matchSessionSnapshot(
	cwd: string,
	snapshots: ReadonlyMap<string, WorktreeSnapshot>,
): SessionSnapshotMatch | undefined {
	let match: SessionSnapshotMatch | undefined;
	for (const [root, snapshot] of snapshots) {
		if (isInside(root, cwd) && (!match || root.length > match.root.length)) match = { root, snapshot, cwd };
	}
	return match;
}

/** The latest snapshot of the checkout the session works in, the same one #4245's resume verifies. */
export function latestSessionSnapshot(
	sessionManager: Pick<SessionManager, "getCwd" | "getWorktreeRootMappings" | "getLatestWorktreeSnapshots">,
	snapshots: ReadonlyMap<string, WorktreeSnapshot> = sessionManager.getLatestWorktreeSnapshots(),
): SessionSnapshotMatch | undefined {
	const cwd = mapRestoredPath(sessionManager.getCwd(), sessionManager.getWorktreeRootMappings());
	return matchSessionSnapshot(cwd, snapshots);
}

export async function latestSessionSnapshotAsync(
	sessionManager: Pick<SessionManager, "getCwd" | "getWorktreeRootMappings" | "getLatestWorktreeSnapshots">,
	snapshots: ReadonlyMap<string, WorktreeSnapshot> = sessionManager.getLatestWorktreeSnapshots(),
): Promise<SessionSnapshotMatch | undefined> {
	const cwd = await mapRestoredPathAsync(sessionManager.getCwd(), sessionManager.getWorktreeRootMappings());
	return matchSessionSnapshot(cwd, snapshots);
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
	sessionId: string,
	options: PrepareSessionResumeOptions,
): Promise<CheckoutReuse> {
	const checkout = await locateCheckout(options.launchCwd, options.signal).catch((error: unknown) => {
		if (isWorkspaceSnapshotError(error)) return error;
		throw error;
	});
	if (checkout instanceof Error) return undefined;
	const root = resolve(checkout.root);
	// A pooled worktree another session owns holds that session's work, even when it matches (#4748).
	if (await pooledWorktreeOwnedElsewhere(resolveStoreDir(options), root, sessionId)) return undefined;
	const { remotes } = await readRepositoryConfig(root, options.signal);
	// The same repository spelled another way, SSH or HTTPS, with or without `.git`, is still the session's (#4913).
	if (!remotes.some((remote) => match.snapshot.remotes.some((recorded) => sameRemote(remote, recorded)))) {
		return undefined;
	}
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
 * was restored from, when that checkout is on this node and its repository holds the snapshot's commit (#4660), or the
 * session's snapshot ref for it (#4923). The
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
	if (isInside(storeDir, checkout) || !(await pathExists(cwd))) return undefined;
	// When the checkout cannot be examined, the project the session started in is still where it goes back to.
	const examined = await orFallBack(options, "return-to-checkout-verify", undefined, async () => ({
		holdsCommit: await workedInCheckout(match.snapshot, checkout, sessionManager.getSessionId(), options.signal),
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
 * tools resolve paths under every root it recorded into the place that root was restored. A resume that restored a
 * checkout or ran a blueprint step records where its time went in the session it returns (#4748); a failure to record
 * that never stops the resume.
 */
export async function prepareSessionResume(
	sessionManager: SessionManager,
	options: PrepareSessionResumeOptions,
): Promise<PreparedSessionResume> {
	const storeDir = resolveStoreDir(options);
	// The session holds the pooled worktrees it owns before anything is restored, so evicting idle slots never removes
	// one it continues in, and until it closes (#4748).
	await holdSessionWorktrees(sessionManager, sessionManager, storeDir, options.signal);
	// `atomic --session` counts from the launch of the process, which is 0 on the clock the recorder uses.
	const timings = new ResumeTimingsRecorder(options.entryPoint === "cli" ? 0 : undefined);
	let firstRecorded!: (recorded: ResumeTimings | undefined) => void;
	const recordedAtReady = new Promise<ResumeTimings | undefined>((resolve) => {
		firstRecorded = resolve;
	});
	// A build behind the first turn (`waitForBlueprint: "tools"`) adds its steps to the timings once it settles.
	const buildSettled = async (session: SessionManager): Promise<void> => {
		const atReady = await recordedAtReady;
		if (atReady === undefined) return;
		// The restores too: an LFS download behind the first turn ends after it (#5099).
		const { restores, blueprint, blueprintReadyMs } = timings.finish();
		const recorded = { ...atReady, restores, blueprint, blueprintReadyMs };
		recordTimingLines(formatResumeTimings(recorded), "resume");
		// The isolated engine has the session open by now, so it records them.
		if (blueprintBuildShared(session.getSessionId())) handOverBuildTimings(session.getSessionId(), recorded);
		else await recordResumeTimings(session, recorded);
	};
	let prepared: PreparedSessionResume;
	try {
		options.signal?.throwIfAborted();
		prepared = await timings.run(() => prepareResume(sessionManager, options, buildSettled));
	} catch (error) {
		await releaseSessionWorktrees(sessionManager);
		throw error;
	}
	if (prepared.status === "ready") await holdSessionWorktrees(sessionManager, prepared.sessionManager, storeDir);
	else await releaseSessionWorktrees(sessionManager);
	if (prepared.status === "ready" && timings.recordedWork) {
		const recorded = timings.finish();
		await recordResumeTimings(prepared.sessionManager, recorded);
		recordTimingLines(formatResumeTimings(recorded), "resume");
		firstRecorded(recorded);
	} else {
		firstRecorded(undefined);
	}
	return prepared;
}

async function prepareResume(
	sessionManager: SessionManager,
	options: PrepareSessionResumeOptions,
	buildSettled: (session: SessionManager) => Promise<void>,
): Promise<PreparedSessionResume> {
	const io = options.io ?? defaultResumePreflightIo;
	const storeDir = resolve(options.storeDir ?? defaultWorktreeSnapshotStoreDir());
	// A checkout the session's finished subagents captured after it last did is restored as they left it.
	if (options.settings.enabled) await adoptSubagentCaptures(sessionManager, options.signal);
	if (!options.settings.enabled || sessionManager.getLatestWorktreeSnapshots().size === 0) {
		const missing = options.settings.enabled ? await missingSnapshotRecords(sessionManager) : [];
		if (missing.length > 0) return continueWithoutRecords(sessionManager, missing, storeDir, options);
		const unchanged = await describeBlueprintsInPlace(sessionManager, storeDir, options);
		return { status: "ready", sessionManager, notices: [], blueprintNotices: [], blueprintContext: unchanged };
	}
	// Work a full restore carried over but could not record is recorded now, where its worktree is here (#5009).
	await recordPendingCarriedWork(sessionManager, { settings: options.settings, storeDir, signal: options.signal });
	// A partial restore pinned for longer than its retention no longer holds its snapshot (#4922).
	const notices: ResumeNotice[] = (await lapsedDegradedRestores(sessionManager)).map((lapsed) => ({
		type: "warning",
		message: formatLapsedPinNotice(lapsed),
	}));
	notices.push(...(await setAsideCancelledBuilds(sessionManager, storeDir, options)));
	const checkoutCount = (await currentWorktreeSnapshots(sessionManager)).size;
	options.onProgress?.(
		`Checking ${checkoutCount === 1 ? "1 checkout" : `${checkoutCount} checkouts`} against the session's snapshots`,
	);
	const verified = new Map<string, Promise<boolean>>();
	const verifyOnce = (snapshot: WorktreeSnapshot, root: string): Promise<boolean> => {
		const key = `${snapshot.id}\0${resolve(root)}`;
		let verification = verified.get(key);
		if (verification === undefined) {
			// A pooled worktree another session owns is restored fresh, as if it were gone (#4748).
			verification = pooledWorktreeOwnedElsewhere(storeDir, root, sessionManager.getSessionId()).then(
				(elsewhere) => elsewhere || worktreeNeedsRestore(snapshot, root, options),
			);
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
	// A checkout restored only partly is compared with the snapshot it lacks, which stays its restore target (#4922).
	const match = await latestSessionSnapshotAsync(sessionManager, await latestRestoreTargets(sessionManager));
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
			checkoutsWorkedHere(
				new Map([[match.root, match.snapshot]]),
				match.cwd,
				sessionManager.getSessionId(),
				options,
				await partial(),
			),
		).then((worked) => worked.has(match.root)));
	// The checkout the session returned to stays as it is, whatever it changed since: only the others are restored.
	const kept = [...(keepsOwnCheckout && match !== undefined ? [match.root] : [])];
	if (project !== undefined && match !== undefined) kept.push(match.root, project.mapping.to);
	const resume: PrepareSessionResumeOptions =
		kept.length > 0 ? { ...options, keepInPlace: new Set([...(options.keepInPlace ?? []), ...kept]) } : options;
	if (match !== undefined && !keepsOwnCheckout && needsRestore) {
		git = { unavailable: await io.probeGit(options.signal) };
		const reuse =
			git.unavailable === undefined
				? await reuseLaunchCheckout(match, sessionManager.getSessionId(), options)
				: undefined;
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
		await mapRestoredPathAsync(sessionManager.getCwd(), checkouts.getWorktreeRootMappings()),
		resume,
		verifyOnce,
		partial,
	);
	if (candidates.targets.length > 0) git ??= { unavailable: await io.probeGit(options.signal) };
	const plan = planRestores(candidates, git?.unavailable);
	notices.push(...plan.left.values());
	const recordedBefore = sessionManager.getWorktreeRootMappings().length;
	// Each fresh worktree's LFS download runs behind the other restores and the builds; its own build waits (#5099).
	const lfs = new LfsDownloads();
	const resumed = await restorePlanned(sessionManager, plan, reused, storeDir, resume, lfs);
	const cwd =
		resumed.cwd ?? (await mapRestoredPathAsync(sessionManager.getCwd(), sessionManager.getWorktreeRootMappings()));
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
	// A resume that only joins a build this process already runs in its worktree, as a switch back to the session that
	// started it, waits for nothing: that build holds the session's tools, and tells the user when it ends (#4748).
	if (
		restoredNow.size === 0 &&
		options.blueprints !== "skip" &&
		options.waitForBlueprint === "tools" &&
		(await joinsBuildInProgress(opened.sessionManager))
	) {
		await recordBlueprintContext(opened.sessionManager, BLUEPRINT_BUILDING_CONTEXT);
		return {
			status: "ready",
			sessionManager: opened.sessionManager,
			notices,
			blueprintNotices: [],
			missingRecordNotices: resumed.missingNotices,
			blueprintContext: BLUEPRINT_BUILDING_CONTEXT,
		};
	}
	const trustLater = options.trustDecidedLater;
	let decided: Promise<void> | undefined;
	if (trustLater !== undefined && options.blueprints !== "skip") {
		for (const root of restoredNow) if (await trustLater.applies(root)) decided = trustLater.decided;
	}
	const awaitsTrust = decided !== undefined;
	if (restoredNow.size > 0 && options.blueprints !== "skip" && (options.waitForBlueprint === "tools" || awaitsTrust)) {
		// The build can be stopped when the process ends before it does (#4748): its steps' process trees end with it,
		// what ran is recorded, and the ledger keeps the worktrees unbuilt for the next resume.
		const stopping = new AbortController();
		const signal =
			options.signal === undefined ? stopping.signal : AbortSignal.any([options.signal, stopping.signal]);
		// A build that waits for the session's trust decision claims and locks nothing while it waits.
		const building = (decided ? untilSettled(decided, signal) : Promise.resolve()).then(() =>
			setUpCheckoutBlueprints(opened.sessionManager, restoredNow, storeDir, { ...options, signal }, lfs),
		);
		const result = building.then(
			async (blueprints): Promise<BlueprintBuildResult> => {
				await buildSettled(opened.sessionManager);
				return { report: blueprintBuildReport(blueprints), notices: blueprints.notices };
			},
			async (error: unknown): Promise<BlueprintBuildResult> => {
				await buildSettled(opened.sessionManager).catch(() => undefined);
				const message = `Blueprint build stopped before it finished (${error instanceof Error ? error.message : String(error)}); the next resume builds the restored worktree again.`;
				return { report: message, notices: [{ type: "warning", message }] };
			},
		);
		holdToolsUntilBuilt(opened.sessionManager.getSessionId(), result, {
			roots: restoredNow,
			stop: (reason) => stopping.abort(reason),
		});
		await recordBlueprintContext(opened.sessionManager, BLUEPRINT_BUILDING_CONTEXT);
		return {
			status: "ready",
			sessionManager: opened.sessionManager,
			notices,
			blueprintNotices: [],
			missingRecordNotices: resumed.missingNotices,
			blueprintContext: BLUEPRINT_BUILDING_CONTEXT,
		};
	}
	if (restoredNow.size > 0 && options.blueprints !== "skip") {
		options.onProgress?.("Setting up the blueprints of restored worktrees");
	}
	const blueprints = await setUpCheckoutBlueprints(opened.sessionManager, restoredNow, storeDir, options, lfs);
	notices.push(...blueprints.notices);
	await recordBlueprintContext(opened.sessionManager, blueprints.context);
	return {
		status: "ready",
		sessionManager: opened.sessionManager,
		notices,
		blueprintNotices: blueprints.notices,
		missingRecordNotices: resumed.missingNotices,
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
	const roots = [...(await currentWorktreeSnapshots(sessionManager)).keys()].filter(
		(root) => !options.keepInPlace?.has(root),
	);
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
	const missingRecordNotices = (resumed.missingRecords ?? []).map((missing) => ({
		type: "warning" as const,
		message: formatMissingRecordNotice(missing),
	}));
	return {
		status: "ready",
		sessionManager: opened.sessionManager,
		notices: [...opened.notices, ...missingRecordNotices],
		blueprintNotices: [],
		missingRecordNotices,
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
	const recorded = await mapRestoredPathAsync(sessionManager.getCwd(), sessionManager.getWorktreeRootMappings());
	const cwd = (await pathExists(recorded)) ? recorded : resolve(options.launchCwd);
	const opened = await openResumedSession(sessionManager, cwd, [], options.sessionDirectory);
	const context = await describeBlueprintsInPlace(opened.sessionManager, storeDir, options);
	const notices = missing.map((record) => ({ type: "warning" as const, message: formatMissingRecordNotice(record) }));
	return {
		status: "ready",
		sessionManager: opened.sessionManager,
		notices,
		blueprintNotices: [],
		missingRecordNotices: notices,
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
	const root = await enclosingRepositoryRoot(resolve(sessionManager.getCwd()));
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
	for (const [root, snapshot] of await currentWorktreeSnapshots(sessionManager)) {
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
		{ history: "tail" },
	);
	// A session manager of an earlier Atomic version has none to hand over.
	if (typeof sessionManager.handOverStartedSession === "function")
		await sessionManager.handOverStartedSession(reopened);
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
	for (const [root, snapshot] of await currentWorktreeSnapshots(sessionManager)) {
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

type SessionCheckouts = Pick<
	SessionManager,
	| "getBranch"
	| "getWorktreeRootMappings"
	| "getWorktreeSnapshotRecords"
	| "getSessionId"
	| "loadWorktreeSnapshotRecords"
>;

/** The session's checkouts as they are once `mapping`, not yet recorded, is. */
function withMapping(sessionManager: SessionManager, mapping: WorktreeRootMapping | undefined): SessionCheckouts {
	if (mapping === undefined) return sessionManager;
	return {
		getBranch: () => sessionManager.getBranch(),
		getSessionId: () => sessionManager.getSessionId(),
		getWorktreeSnapshotRecords: () => sessionManager.getWorktreeSnapshotRecords(),
		loadWorktreeSnapshotRecords: (ids, options) => sessionManager.loadWorktreeSnapshotRecords(ids, options),
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
	const checkouts = [...(await currentWorktreeSnapshots(sessionManager))].filter(
		([root]) => !options.keepInPlace?.has(root),
	);
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
			(
				await checkoutsWorkedHere(
					new Map([[root, snapshot]]),
					cwd,
					sessionManager.getSessionId(),
					options,
					await partial(),
				)
			).has(root)
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
	lfs: LfsDownloads,
): Promise<{
	restored: WorktreeRootMapping[];
	failed: ResumeNotice[];
	/** The notices in `failed` of checkouts whose snapshot record the session lacks (#4744). */
	missingNotices: ResumeNotice[];
	unrestored: WorktreeUnrestored[];
	cwd: string | undefined;
}> {
	const outcome = {
		restored: [] as WorktreeRootMapping[],
		failed: [] as ResumeNotice[],
		unrestored: [] as WorktreeUnrestored[],
		cwd: undefined as string | undefined,
		missing: new Set<string>(),
		missingNotices: [] as ResumeNotice[],
	};
	let restored = false;
	const restore = async (
		targets: readonly RestoreTarget[],
		pending: WorktreeRootMapping | undefined,
		beforeRecord?: () => Promise<void>,
	) => {
		restored = true;
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
				[...(await currentWorktreeSnapshots(withMapping(sessionManager, pending))).keys()].filter(
					(root) => !restoring.has(root),
				),
			),
			...(git === undefined ? {} : { cannotRestore: new Map(targets.map((target) => [target.root, git])) }),
			fallbackCwd: options.launchCwd,
			skipMissingRecords: true,
			pool: options.pool ?? { maxIdlePerRepository: DEFAULT_MAX_IDLE_PER_REPOSITORY },
			deferLfs: lfs.start,
			beforeRecord,
		});
		for (const missing of resumed.missingRecords ?? []) {
			if (outcome.missing.has(missing.root)) continue;
			outcome.missing.add(missing.root);
			const notice: ResumeNotice = { type: "warning", message: formatMissingRecordNotice(missing) };
			outcome.failed.push(notice);
			outcome.missingNotices.push(notice);
		}
		if (resumed.status === "none") return undefined;
		if (resumed.status === "restored") outcome.restored.push(...resumed.mappings);
		outcome.unrestored.push(...resumed.unrestored.map((checkout) => checkout.record));
		return resumed.cwd;
	};
	if (plan.required.length > 0 || reused !== undefined) outcome.cwd = await restore(plan.required, reused);
	// Optional checkouts restore at once, as many as verification compares (#4748); each records its outcome only after
	// the one before it has, so the session lists them, and their notices, in the order a serial resume would.
	let previous = Promise.resolve();
	const turns = plan.optional.map((target) => {
		const before = previous;
		let done!: () => void;
		previous = new Promise<void>((resolveTurn) => {
			done = resolveTurn;
		});
		return { target, before, done };
	});
	const outcomes = await settleBounded(turns, VERIFY_CONCURRENCY, async ({ target, before, done }) => {
		try {
			await restore([target], undefined, () => before);
		} catch (error) {
			await before;
			if (options.signal?.aborted || !isCheckoutFailure(error)) throw error;
			outcome.failed.push(
				notRestored(
					target.root,
					target.snapshot,
					`${absentOrChanged(target)}, and restoring it failed: ${describeFailure(error)}`,
				),
			);
		} finally {
			await before;
			done();
		}
	});
	for (const result of outcomes) if (result.status === "rejected") throw result.reason;
	// With nothing to restore, no restore listed the checkouts whose snapshot record is missing (#4744).
	if (!restored) {
		for (const missing of await missingSnapshotRecords(sessionManager)) {
			const notice: ResumeNotice = { type: "warning", message: formatMissingRecordNotice(missing) };
			outcome.failed.push(notice);
			outcome.missingNotices.push(notice);
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
	lfs = new LfsDownloads(),
): Promise<ResumedBlueprints> {
	// The warnings of LFS downloads that end after their restores were recorded come with the build's (#5099).
	if (options.blueprints === "skip") return { ...SKIPPED_BLUEPRINTS, notices: await lfs.notices(restoredNow) };
	const restoredHere: BlueprintCheckout[] = [];
	const earlier: BlueprintCheckout[] = [];
	const inPlace: BlueprintCheckout[] = [];
	for (const [root, snapshot] of await currentWorktreeSnapshots(sessionManager)) {
		const checkout = checkoutOf(sessionManager, root, snapshot);
		if (restoredNow.has(root)) restoredHere.push({ ...checkout, ready: lfs.ready(root) });
		else if (isInside(storeDir, root)) {
			if (!(await pooledWorktreeOwnedElsewhere(storeDir, root, sessionManager.getSessionId())))
				earlier.push({ ...checkout, ready: finishPendingLfs(lfs, root, options.signal) });
		} else if (await isDirectory(root)) inPlace.push(checkout);
	}
	// A worktree this process is building already is joined, not built again (#4748): its tools wait for that build.
	const joined = [...restoredHere, ...earlier].filter((checkout) => buildInProgress(checkout.root) !== undefined);
	const toBuild = restoredHere.filter((checkout) => !joined.includes(checkout));
	const candidates = earlier.filter((checkout) => !joined.includes(checkout));
	// Claimed before anything is awaited, so a resume that starts meanwhile in this process joins this one.
	const { promise: settled, resolve: settle } = Promise.withResolvers<undefined>();
	const claimed = [...toBuild, ...candidates].map((checkout) => resolve(checkout.root));
	for (const root of claimed) buildsInProgress.set(root, settled);
	try {
		await Promise.all(joined.map((checkout) => buildInProgress(checkout.root)));
		// Another process's build of one of them is waited for, or the steps of one whose process died are stopped,
		// before the ledger says which need building.
		// Settling another build never fails the resume: a failure to read or clean up its lock is a warning.
		const settled = await settleOtherBuilds(storeDir, claimed, {
			signal: options.signal,
			onWait: (root, message) => {
				options.onProgress?.(message);
				announceBlueprintBuildWaiting(root, message);
			},
		}).catch((error: unknown) => {
			if (options.signal?.aborted) throw error;
			return {
				warnings: [
					`Could not check for an earlier blueprint build of these worktrees (${error instanceof Error ? describeFailure(error) : String(error)}); building them anyway.`,
				],
				cancelled: new Set<string>(),
				release: async () => {},
			};
		});
		// No other process builds them until this build settled, and then the ledger says whether they still need it.
		let built: ResumedBlueprints;
		const unlocked: string[] = [];
		try {
			const retried = await checkoutsNeedingRebuild(candidates, storeDir);
			const restored = [...toBuild, ...retried];
			built = await withBuildLocks(
				storeDir,
				restored.map((checkout) => checkout.root),
				() =>
					setUpResumedBlueprints({
						restored,
						inPlace,
						earlier: [...joined, ...candidates.filter((checkout) => !retried.includes(checkout))],
						config: { ...options.blueprint, storeDir },
						signal: options.signal,
					}),
				(message) => unlocked.push(message),
			);
		} finally {
			await settled.release();
		}
		// The warnings of LFS downloads that end after their restores were recorded come with the build's (#5099).
		const downloads = await lfs.notices([...restoredHere, ...earlier].map((checkout) => checkout.root));
		const warnings = [...settled.warnings, ...unlocked].map((message) => ({ type: "warning" as const, message }));
		return { ...built, notices: [...warnings, ...downloads, ...built.notices] };
	} finally {
		for (const root of claimed) if (buildsInProgress.get(root) === settled) buildsInProgress.delete(root);
		settle(undefined);
	}
}

/** `promise`, or `signal`'s reason once it aborts first. */
function untilSettled(promise: Promise<void>, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<void>((resolvePromise, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		promise.then(
			() => {
				signal.removeEventListener("abort", abort);
				resolvePromise();
			},
			(error: unknown) => {
				signal.removeEventListener("abort", abort);
				reject(error);
			},
		);
	});
}

/** The blueprint builds this process runs, by the restored worktree they build, each settling once its build has. */
const buildsInProgress = new Map<string, Promise<undefined>>();

async function setAsideCancelledBuilds(
	sessionManager: SessionCheckouts,
	storeDir: string,
	options: PrepareSessionResumeOptions,
): Promise<ResumeNotice[]> {
	if (process.platform === "win32" || options.blueprints === "skip" || !options.settings.enabled) return [];
	const roots: string[] = [];
	for (const root of (await currentWorktreeSnapshots(sessionManager)).keys()) {
		if (!isInside(storeDir, root) || options.keepInPlace?.has(root) || buildInProgress(root) !== undefined) continue;
		if (!(await pooledWorktreeOwnedElsewhere(storeDir, root, sessionManager.getSessionId()))) roots.push(root);
	}
	if (roots.length === 0) return [];
	const notices: ResumeNotice[] = [];
	const setAside = async (build: CancelledBuild): Promise<boolean> => {
		const running = `A step of the cancelled build may still be running in ${build.root}; its log is ${build.logs}.`;
		try {
			await setAsideWorktree(storeDir, build.root, { startedAt: build.startedAt, logs: build.logs });
			notices.push({
				type: "warning",
				message: `The blueprint build of ${build.root} did not finish, so it was cancelled and the worktree set aside; a fresh worktree is restored and built instead. ${running}`,
			});
			return true;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			notices.push({
				type: "warning",
				message: `The blueprint build of ${build.root} did not finish, so it was cancelled; a fresh worktree is restored and built instead, but the worktree could not be set aside (${reason.slice(0, 200)}), so another Atomic process may still use it. ${running}`,
			});
			return false;
		}
	};
	const warnings = await cancelledBuilds(
		storeDir,
		roots,
		{
			signal: options.signal,
			onWait: (root, message) => {
				options.onProgress?.(message);
				announceBlueprintBuildWaiting(root, message);
			},
		},
		setAside,
	);
	return [...warnings.map((message) => ({ type: "warning" as const, message })), ...notices];
}

/** The build this process runs of the worktree at `root`, if one runs. */
function buildInProgress(root: string): Promise<undefined> | undefined {
	return buildsInProgress.get(resolve(root));
}

/** Whether a resume of `sessionManager` joins a blueprint build this process already runs in one of its worktrees. */
async function joinsBuildInProgress(sessionManager: SessionManager): Promise<boolean> {
	return [...(await currentWorktreeSnapshots(sessionManager)).keys()].some(
		(root) => buildInProgress(root) !== undefined,
	);
}

/**
 * Finishes the LFS download a resume interrupted, or another process still runs, in the restored worktree at `root`,
 * if one is pending (#5099), so its blueprint runs on the files' content; settles once that is done.
 */
function finishPendingLfs(lfs: LfsDownloads, root: string, signal: AbortSignal | undefined): Promise<void> {
	lfs.start(root, async () => (await (await pendingLfsDownload(root, { signal }))?.()) ?? []);
	return lfs.ready(root);
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
 * Whether session `sessionId` worked in the checkout at `root`: its repository holds the commit of `snapshot`, or,
 * once `git gc` pruned that commit, keeps the session's snapshot ref for the checkout (#4923).
 */
async function workedInCheckout(
	snapshot: WorktreeSnapshot,
	root: string,
	sessionId: string,
	signal: AbortSignal | undefined,
): Promise<boolean> {
	return (
		(await holdsSnapshotCommit(snapshot, root, signal)) ||
		(await holdsSessionSnapshotRef(sessionId, snapshot, root, signal))
	);
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
	reopen: (cwd: string) => Promise<SessionManager> = (cwd) =>
		opened.openSessionById(opened.getSessionId(), cwd, undefined, { history: "tail" }),
): Promise<SessionManager> {
	const storeDir = resolveStoreDir(options);
	// The session holds the pooled worktrees it owns before anything else, so no eviction removes one while its
	// blueprints are set up again, and until it closes (#4748).
	await holdSessionWorktrees(opened, opened, storeDir, options.signal);
	try {
		options.signal?.throwIfAborted();
		const cwd = await mapRestoredPathAsync(opened.getCwd(), opened.getWorktreeRootMappings());
		const checkouts = await currentWorktreeSnapshots(opened);
		const cancelled = await setAsideCancelledBuilds(opened, storeDir, options);
		if (cancelled.length > 0) options.onNotices?.(cancelled);
		const own = await checkoutsWorkedHere(
			checkouts,
			cwd,
			opened.getSessionId(),
			options,
			await partialRestores(opened, options),
		);
		if (own.size < checkouts.size) {
			const prepared = await prepareSessionResume(opened, { ...options, keepInPlace: own });
			if (prepared.status !== "ready") {
				await holdSessionWorktrees(opened, opened, storeDir);
				return opened;
			}
			if (prepared.blueprintNotices.length > 0) options.onNotices?.(prepared.blueprintNotices);
			return prepared.sessionManager;
		}
		if (checkouts.size === 0) {
			await describeBlueprintsInPlace(opened, storeDir, options);
		} else {
			const blueprints = await setUpCheckoutBlueprints(opened, new Set(), storeDir, options);
			await recordBlueprintContext(opened, blueprints.context);
			if (blueprints.notices.length > 0) options.onNotices?.(blueprints.notices);
		}
		const continuing = cwd === resolve(opened.getCwd()) ? opened : await reopen(cwd);
		await holdSessionWorktrees(opened, continuing, storeDir);
		return continuing;
	} catch (error) {
		await releaseSessionWorktrees(opened);
		throw error;
	}
}

/**
 * The roots of the `checkouts` a session recorded that are here as checkouts it worked in on this node, as it left them
 * or changed since: a worktree this node restored for it, or a checkout whose repository holds the commit of its latest
 * snapshot or the session's snapshot ref for it (#4923). A pooled worktree counts only while session `sessionId` owns it: another session that took the slot works
 * in it now (#4748). The checkout the session works in counts only while its working directory `cwd` is here too.
 */
async function checkoutsWorkedHere(
	checkouts: ReadonlyMap<string, WorktreeSnapshot>,
	cwd: string,
	sessionId: string,
	options: PrepareSessionResumeOptions,
	partial: ReadonlySet<string> = new Set(),
): Promise<Set<string>> {
	const storeDir = resolve(options.storeDir ?? defaultWorktreeSnapshotStoreDir());
	const own = new Set<string>();
	for (const [root, snapshot] of checkouts) {
		if (!(await pathExists(isInside(root, cwd) ? cwd : root))) continue;
		if (await worktreeSetAside(storeDir, root)) continue;
		const holder = await pooledWorktreeHolder(storeDir, root);
		if (holder !== "unpooled") {
			// Slots share their repository's object store, so only the pool record tells whose work a slot holds, and a
			// slot the session could not hold, or lost while stalled, is not its to continue in (#4830).
			const owned = !(await pooledWorktreeOwnedElsewhere(storeDir, root, sessionId));
			if (owned && !partial.has(resolve(root))) own.add(root);
			continue;
		}
		const restoredHere = isInside(storeDir, root) && !partial.has(resolve(root));
		if (restoredHere || (await workedInCheckout(snapshot, root, sessionId, options.signal))) own.add(root);
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
	const current = await currentWorktreeSnapshots(sessionManager);
	const partial = new Set<string>();
	for (const mapping of sessionManager.getWorktreeRootMappings()) {
		const degraded = mapping.degraded;
		const snapshot = current.get(mapping.to);
		if (degraded === undefined || snapshot?.id !== mapping.snapshotId || !(await pathExists(mapping.to))) continue;
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

export function savedProjectTrustAsync(
	agentDir: string,
	settings: Pick<SettingsManager, "getDefaultProjectTrust">,
): (worktree: string) => Promise<boolean> {
	const trustStore = new ProjectTrustStore(agentDir);
	return async (worktree) => (await trustStore.getAsync(worktree)) ?? settings.getDefaultProjectTrust() === "always";
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
 * `settingsManager`, and the worktree store of `agentDir`. A session without a UI (`interactive` false; default true)
 * starts its first turn while the build runs unless `resume.waitForBlueprint` says otherwise.
 */
export function sessionResumeOptions(
	entryPoint: ResumeEntryPoint,
	launchCwd: string,
	agentDir: string,
	settingsManager: Pick<
		SettingsManager,
		"getWorktreeSnapshotSettings" | "getWorktreePoolSettings" | "getResumeSetupCommand" | "getResumeWaitForBlueprint"
	>,
	trusted: (worktree: string) => boolean | Promise<boolean>,
	interactive = true,
): PrepareSessionResumeOptions {
	return {
		entryPoint,
		launchCwd,
		settings: settingsManager.getWorktreeSnapshotSettings(),
		pool: settingsManager.getWorktreePoolSettings(),
		blueprint: { agentDir, setupCommand: settingsManager.getResumeSetupCommand(), trusted },
		storeDir: resumeStoreDir(agentDir),
		waitForBlueprint: settingsManager.getResumeWaitForBlueprint(interactive),
	};
}
