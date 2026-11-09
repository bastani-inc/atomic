import { stat } from "node:fs/promises";
import { getAgentDir } from "../../config.js";
import { SettingsManager } from "../settings-manager.ts";
import { removeRestoredWorktree } from "../worktree-snapshot/restore.ts";
import type { WorktreeRootMapping, WorktreeSnapshot } from "../worktree-snapshot/types.ts";
import type { BlueprintBuildConfig } from "./blueprint/build.ts";
import type { BlueprintNotice } from "./blueprint/notices.ts";
import {
	checkoutsNeedingRebuild,
	inheritedRemotes,
	type ResumedBlueprints,
	setUpResumedBlueprints,
} from "./blueprint/resume.ts";
import { ResumePreconditionError, type ResumePreconditionProblem } from "./errors.ts";
import { isInside } from "./path-mapping.ts";
import { defaultResumePreflightIo, gitUnavailableProblem, type ResumePreflightIo } from "./preflight.ts";
import { resumeStoreDir, savedProjectTrust } from "./session-resume.ts";

/** A checkout a workflow run's resume restores, with the remotes its snapshot recorded. */
export interface RunWorktreeTarget {
	readonly root: string;
	/** The repository's remotes; the same repository on this machine builds its blueprints incrementally. */
	readonly remotes: readonly string[];
}

export interface RunResumeSetupOptions {
	readonly signal?: AbortSignal;
	readonly io?: ResumePreflightIo;
	/** The agent directory whose worktree store, blueprint ledger and global settings apply; defaults to Atomic's. */
	readonly agentDir?: string;
	/** Told what a build warns about, once per restored set of worktrees. */
	readonly onNotices?: (notices: readonly BlueprintNotice[]) => void;
}

/**
 * The blueprint build configuration of an agent directory. `resume.setupCommand` and the default project trust are
 * global settings, so no project's settings are read.
 */
function runBlueprintConfig(agentDir = getAgentDir()): BlueprintBuildConfig {
	const settings = SettingsManager.create(agentDir, agentDir, { projectTrusted: false });
	return {
		agentDir,
		storeDir: resumeStoreDir(agentDir),
		setupCommand: settings.getResumeSetupCommand(),
		trusted: savedProjectTrust(agentDir, settings),
	};
}

/**
 * The unmet preconditions of restoring a workflow run's `missing` checkouts on this node, checked before the resume
 * claims the run: Git can be started. A blueprint is never a precondition. Returns one `ResumePreconditionError` (entry
 * point `workflow-resume`) listing every unmet piece, or undefined.
 */
export async function runRestorePreconditionError(
	runId: string,
	missing: readonly RunWorktreeTarget[],
	options: RunResumeSetupOptions = {},
): Promise<ResumePreconditionError | undefined> {
	if (missing.length === 0) return undefined;
	const io = options.io ?? defaultResumePreflightIo;
	const problems: ResumePreconditionProblem[] = [];
	const git = await io.probeGit(options.signal);
	if (git) {
		problems.push(
			gitUnavailableProblem(
				git,
				`workflow run ${runId} must restore ${missing.map((target) => target.root).join(", ")}, which this node does not have`,
			),
		);
	}
	return problems.length === 0
		? undefined
		: new ResumePreconditionError({ entryPoint: "workflow-resume", problems }, git);
}

/**
 * Builds the blueprints of the worktrees a workflow run's resume restored (#4588). A blueprint that fails or cannot
 * run never fails the resume and never removes a worktree: the outcome says what failed, and `options.onNotices` is
 * told the warnings. Only `options.signal` aborting rejects, with its reason; the worktrees in `restored` are then
 * removed again (a removal failure is kept as the error's `cleanupCause`), so the next resume restores from scratch.
 */
export async function setUpRestoredRunWorktrees(
	restored: readonly RunWorktreeTarget[],
	options: RunResumeSetupOptions = {},
): Promise<ResumedBlueprints> {
	return buildRunWorktrees(restored, restored, options);
}

/** What a workflow run's resume knows about the worktrees it restored now and those earlier resumes restored. */
export interface RunRestoreHistory {
	/** The restores this resume just made. */
	readonly restored: readonly WorktreeRootMapping[];
	/** Every restore earlier resumes of the run recorded, oldest first. */
	readonly mappings: readonly WorktreeRootMapping[];
	/** The run's snapshots by id; their remotes identify each repository for the build ledger. */
	readonly snapshots: ReadonlyMap<string, WorktreeSnapshot>;
}

async function directoryExists(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return false;
		throw error;
	}
}

/**
 * Builds the blueprints of a workflow run's worktrees on resume (#4588): each worktree this resume restored, and again
 * each worktree an earlier resume restored here whose last build failed, never finished or left no record, so fixing a
 * blueprint and resuming the run builds it again. A repository is identified by the remotes its restores trace back
 * to, so an unchanged workspace is inherited across resumes. Never fails for a blueprint; see
 * {@link setUpRestoredRunWorktrees}.
 */
export async function setUpResumedRunWorktrees(
	history: RunRestoreHistory,
	options: RunResumeSetupOptions = {},
): Promise<ResumedBlueprints> {
	const storeDir = resumeStoreDir(options.agentDir ?? getAgentDir());
	const links = [...history.mappings, ...history.restored];
	const targetOf = (mapping: WorktreeRootMapping): RunWorktreeTarget => ({
		root: mapping.to,
		remotes: inheritedRemotes(
			mapping.to,
			history.snapshots.get(mapping.snapshotId)?.remotes ?? [],
			links,
			history.snapshots,
		),
	});
	const restored = history.restored.map(targetOf);
	const current = new Map<string, WorktreeRootMapping>();
	for (const mapping of links) current.set(mapping.from, mapping);
	const restoredRoots = new Set(restored.map((target) => target.root));
	const earlier: RunWorktreeTarget[] = [];
	for (const mapping of current.values()) {
		if (restoredRoots.has(mapping.to) || !isInside(storeDir, mapping.to) || !(await directoryExists(mapping.to)))
			continue;
		earlier.push(targetOf(mapping));
	}
	const retried = await checkoutsNeedingRebuild(earlier, storeDir);
	return buildRunWorktrees([...restored, ...retried], restored, options);
}

async function buildRunWorktrees(
	targets: readonly RunWorktreeTarget[],
	removableOnCancel: readonly RunWorktreeTarget[],
	options: RunResumeSetupOptions,
): Promise<ResumedBlueprints> {
	const config = runBlueprintConfig(options.agentDir);
	try {
		const blueprints = await setUpResumedBlueprints({ restored: targets, config, signal: options.signal });
		if (blueprints.notices.length > 0) options.onNotices?.(blueprints.notices);
		return blueprints;
	} catch (error) {
		if (options.signal?.aborted) throw await removedAfter(error, removableOnCancel, config.storeDir);
		throw error;
	}
}

/**
 * `error`, after every worktree in `restored` is removed again, with any removal failure kept as its `cleanupCause`.
 */
async function removedAfter(error: unknown, restored: readonly { readonly root: string }[], storeDir: string) {
	const failures: unknown[] = [];
	for (const target of restored) {
		await removeRestoredWorktree(target.root, { storeDir }).catch((cleanup: unknown) => {
			failures.push(cleanup);
		});
	}
	if (failures.length > 0 && error instanceof Error) {
		Object.defineProperty(error, "cleanupCause", {
			value: failures.length === 1 ? failures[0] : new AggregateError(failures, "worktree cleanup failed"),
			enumerable: false,
		});
	}
	return error;
}

/**
 * Restores a workflow worktree with `restore` and builds its blueprints, as a run's own resume does for the checkouts
 * it restores. `remotes` are the restored snapshot's, when known. Resolves the restored worktree's path.
 */
export async function restoreRunWorktree(
	remotes: readonly string[] | undefined,
	restore: () => Promise<string>,
	options: RunResumeSetupOptions = {},
): Promise<string> {
	const root = await restore();
	await setUpRestoredRunWorktrees([{ root, remotes: remotes ?? [] }], options);
	return root;
}
