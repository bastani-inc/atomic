import {
	cleanupWorktrees,
	recreateWorktree,
	type WorktreeInfo,
	type WorktreeSetup,
	type WorktreeSetupHookConfig,
	worktreeHasUnsavedWork,
} from "../shared/worktree.js";

/** Where a child's worktree came from, recorded with the child so resume can recreate it, also after a restart. */
export interface SubagentChildWorktree {
	readonly repo: string;
	readonly path: string;
	readonly branch: string;
	readonly baseCommit: string;
	readonly syntheticPaths: readonly string[];
}

interface RunWorktrees {
	readonly runId: string;
	readonly setup: WorktreeSetup;
	/** One hold per execution (a dispatch, or a resume being prepared); a released hold never affects another. */
	readonly holds: Set<symbol>;
	/** Children stopped resumably (paused, quit, owner closed, stage paused): their worktree is kept while it has unsaved work. */
	readonly stopped: Set<number>;
	readonly removed: Set<number>;
	/** The run returned: nothing more is launched by it, so worktrees go once no execution holds them. */
	returned: boolean;
	readonly onRemove?: (removing: WorktreeSetup) => void;
}

/** Runs whose worktrees still exist in this process, by run id. */
const runs = new Map<string, RunWorktrees>();

/**
 * Remove the run's worktrees once it returned and no execution holds them. A stopped child's worktree with unsaved work
 * is kept, so it can resume in it; a clean one is removed and resume recreates it.
 */
function sweep(run: RunWorktrees): void {
	if (!run.returned || run.holds.size > 0) return;
	const removing = run.setup.worktrees.filter(
		(worktree) =>
			!run.removed.has(worktree.index) &&
			!(run.stopped.has(worktree.index) && worktreeHasUnsavedWork(run.setup, worktree)),
	);
	if (removing.length > 0) {
		const subset: WorktreeSetup = { ...run.setup, worktrees: removing };
		try {
			run.onRemove?.(subset);
		} finally {
			cleanupWorktrees(subset);
			for (const worktree of removing) run.removed.add(worktree.index);
		}
	}
	if (run.setup.worktrees.every((worktree) => run.removed.has(worktree.index)) && runs.get(run.runId) === run)
		runs.delete(run.runId);
}

function hold(run: RunWorktrees): () => void {
	const token = Symbol("worktree hold");
	run.holds.add(token);
	return () => {
		if (run.holds.delete(token)) sweep(run);
	};
}
function track(runId: string, setup: WorktreeSetup, onRemove?: (removing: WorktreeSetup) => void): RunWorktrees {
	const run: RunWorktrees = {
		runId,
		setup: { ...setup, worktrees: [...setup.worktrees] },
		holds: new Set(),
		stopped: new Set(),
		removed: new Set(),
		returned: false,
		...(onRemove ? { onRemove } : {}),
	};
	runs.set(runId, run);
	return run;
}

/**
 * Track a parallel run's worktrees. `release` marks the run returned; `onRemove` runs before worktrees are removed,
 * with the ones about to go.
 */
export function registerRunWorktrees(
	runId: string,
	setup: WorktreeSetup,
	onRemove?: (removing: WorktreeSetup) => void,
): { readonly release: () => void } {
	const run = track(runId, setup, onRemove);
	return {
		release() {
			run.returned = true;
			sweep(run);
		},
	};
}

const noHold = () => {};

/** Hold the run's worktrees for one execution of a child; the returned release ends only this hold. */
export function holdRunWorktree(runId: string, index: number): () => void {
	const run = runs.get(runId);
	if (!run?.setup.worktrees.some((worktree) => worktree.index === index)) return noHold;
	return hold(run);
}

/** A child stopped resumably: its worktree is kept while it has unsaved work. */
export function parkRunWorktree(runId: string, index: number): void {
	runs.get(runId)?.stopped.add(index);
}

/** A stopped child can no longer resume, or was not stopped after all: its worktree goes with the others. */
export function unparkRunWorktree(runId: string, index: number): void {
	const run = runs.get(runId);
	if (!run?.stopped.delete(index)) return;
	sweep(run);
}

/**
 * An execution of the child started, a resumed one included: it owns the child's worktree now, so the worktree is no
 * longer kept for a stopped child and goes with the others once no execution holds them.
 */
export function claimRunWorktree(runId: string, index: number): void {
	runs.get(runId)?.stopped.delete(index);
}

/** The child's worktree, as recorded with the child. */
export function runWorktreeRecord(runId: string, index: number): SubagentChildWorktree | undefined {
	const run = runs.get(runId);
	const worktree = run?.setup.worktrees.find((candidate) => candidate.index === index);
	if (!run || !worktree) return undefined;
	return {
		repo: run.setup.cwd,
		path: worktree.path,
		branch: worktree.branch,
		baseCommit: run.setup.baseCommit,
		syntheticPaths: worktree.syntheticPaths,
	};
}

/**
 * A stopped child is resuming: hold its run's worktrees until its new execution holds them, and recreate its worktree
 * from the run's base when it was removed. A run this process no longer tracks, after a restart for one, is tracked
 * again from the child's record. The worktree stays kept for the stopped child until its new execution starts
 * ({@link claimRunWorktree}), so a resume that fails keeps its unsaved work. Returns the release of the resume hold.
 */
export function resumeRunWorktree(
	child: {
		readonly runId: string;
		readonly index: number;
		readonly cwd: string;
		readonly agent: string;
		readonly worktree?: SubagentChildWorktree;
	},
	setupHook?: WorktreeSetupHookConfig,
): () => void {
	let run = runs.get(child.runId);
	if (!run?.setup.worktrees.some((worktree) => worktree.index === child.index)) {
		if (!child.worktree) return noHold;
		const recorded: WorktreeInfo = {
			path: child.worktree.path,
			agentCwd: child.cwd,
			branch: child.worktree.branch,
			index: child.index,
			nodeModulesLinked: child.worktree.syntheticPaths.includes("node_modules"),
			syntheticPaths: [...child.worktree.syntheticPaths],
		};
		if (!run) {
			run = track(child.runId, { cwd: child.worktree.repo, baseCommit: child.worktree.baseCommit, worktrees: [] });
			run.returned = true;
		}
		run.setup.worktrees.push(recorded);
		run.removed.add(child.index);
	}
	const release = hold(run);
	run.stopped.add(child.index);
	const position = run.setup.worktrees.findIndex((worktree) => worktree.index === child.index);
	try {
		run.setup.worktrees[position] = recreateWorktree(run.setup, run.setup.worktrees[position]!, child.runId, {
			...(setupHook ? { setupHook } : {}),
			agent: child.agent,
		});
		run.removed.delete(child.index);
	} catch {
		// Left missing: resume then reports that the child's working directory no longer exists.
	}
	return release;
}
