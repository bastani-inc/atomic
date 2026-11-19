import { pathExists } from "../../shared/path-exists.js";
import { type IntercomEventBus, SUBAGENT_FINISHING_EVENT } from "../../shared/types.js";
import { ensureNamedWorktree, type NamedWorktree, type NamedWorktreeOptions } from "../shared/named-worktree.js";
import {
	cleanupWorktrees,
	diffWorktrees,
	nextWorktreePatchPath,
	recreateWorktree,
	restoreWorktreePatch,
	savedWorktreePatches,
	type WorktreeInfo,
	type WorktreeSetup,
	type WorktreeSetupHookConfig,
	withFinishingWorktree,
	worktreeHasUnsavedWork,
} from "../shared/worktree.js";

/** Where a child's worktree came from, recorded with the child so resume can recreate it, also after a restart. */
export interface SubagentChildWorktree {
	readonly repo: string;
	readonly path: string;
	readonly branch: string;
	readonly baseCommit: string;
	readonly syntheticPaths: readonly string[];
	/** Where the run saves the worktree's edits as a patch before removing it. */
	readonly diffsDir?: string;
	/** A worktree the launch named (#5202): the caller's, so it and its branch are never removed. */
	readonly named?: true;
}

/** Where a run saves each worktree's edits as a patch before removing it, and the agent of each child by index. */
export interface RunWorktreeDiffs {
	readonly diffsDir: string;
	readonly agents: readonly string[];
	/** The SDK batch reply uses the sweep's diffs, not another git command after its children have settled. */
	readonly onCaptured?: (diffs: Awaited<ReturnType<typeof diffWorktrees>>) => void;
}

interface RunWorktrees {
	readonly runId: string;
	readonly setup: WorktreeSetup;
	/** One hold per execution (a dispatch, or a resume being prepared); a released hold never affects another. */
	readonly holds: Set<symbol>;
	/** Initial launches not yet handed to their execution. Protects slow and queued siblings. */
	readonly launching: Set<number>;
	readonly finishing: Map<number, Promise<void>>;
	/** The execution is done with its session and output; only the batch's Git work can hold up publication. */
	readonly beforeSweep: Map<
		number,
		{ taskId: () => string | undefined; ready: Promise<string | undefined>; signal: AbortSignal; status?: string }
	>;
	/** Children stopped resumably (paused, quit, owner closed, stage paused): their worktree is kept while it has unsaved work. */
	readonly stopped: Set<number>;
	readonly removed: Set<number>;
	/** The run returned: nothing more is launched by it, so worktrees go once no execution holds them. */
	returned: boolean;
	sweeping?: Promise<void>;
	sweepNote?: string;
	/** Edits are saved as a patch before a worktree is removed, also for a run tracked again after a restart. */
	readonly diffs?: {
		readonly diffsDir: string;
		readonly agents: string[];
		onCaptured?: RunWorktreeDiffs["onCaptured"];
		/** Where a resumed child saves its edits, past the patches its earlier executions saved. */
		readonly patchPaths: Map<number, string>;
	};
}

/** Runs whose worktrees still exist in this process, by run id. */
const registryKey = Symbol.for("@bastani/subagents/managed-worktree-publication@1");
const processRegistry = globalThis as { [registryKey]?: { runs: Map<string, RunWorktrees>; revision: number } };
processRegistry[registryKey] ??= { runs: new Map(), revision: 0 };
const registry = processRegistry[registryKey];
const { runs } = registry;

/** A cached child view expires when its original durable record becomes visible. */
export const worktreePublicationRevision = () => registry.revision;

interface WorktreeMember {
	runId: string;
	index: number;
	taskId?: string;
}

export function finishingWorktreeStatus(record: WorktreeMember): string | undefined {
	const execution = runs.get(record.runId)?.beforeSweep.get(record.index);
	return execution && execution.taskId() === record.taskId ? execution.status : undefined;
}

/** Keep main's crash-recovery record unchanged, without displaying it as terminal during cleanup. */
export function visibleWorktreeRecord<
	T extends WorktreeMember & { state: "running" | "terminal"; terminalStatus?: string },
>(record: T): T {
	if (record.state !== "terminal" || !finishingWorktreeStatus(record)) return record;
	const { terminalStatus: _terminal, ...rest } = record;
	return { ...rest, state: "running" } as T;
}

/** The named worktree of each child of a run still in progress, by run id and child index (#5202). */
const namedWorktrees = new Map<string, Map<number, SubagentChildWorktree>>();

/**
 * Record the named worktree each child of a run runs in, by child index, so its record names it. Nothing removes a
 * named worktree; `release` only forgets them once the run returned, as its children's records already hold them.
 */
export function registerNamedRunWorktrees(
	runId: string,
	worktrees: ReadonlyMap<number, NamedWorktree>,
): { readonly release: () => void } {
	const records = new Map<number, SubagentChildWorktree>();
	for (const [index, worktree] of worktrees)
		records.set(index, {
			repo: worktree.repo,
			path: worktree.path,
			branch: worktree.branch,
			baseCommit: worktree.baseCommit,
			syntheticPaths: [],
			named: true,
		});
	namedWorktrees.set(runId, records);
	return {
		release() {
			namedWorktrees.delete(runId);
		},
	};
}

/**
 * Remove the run's worktrees once it returned and no execution holds them. A stopped child's worktree with unsaved work
 * is kept, so it can resume in it; a clean one is removed and resume recreates it. A worktree whose edits could not be
 * saved as a patch is kept too, and a later sweep tries again (#4876). Every git command runs to completion, except
 * the check of the child whose resume failed (`failedResume`): a stalled one is stopped and its worktree kept.
 */
async function sweepIdle(run: RunWorktrees, failedResume?: number): Promise<void> {
	if (!run.returned || run.holds.size || run.launching.size) return;
	run.sweepNote = undefined;
	const onStall = () => {
		run.sweepNote = "Worktree cleanup timed out. Check the worktree before removing it.";
	};
	const removing: WorktreeInfo[] = [];
	for (const worktree of run.setup.worktrees) {
		if (run.removed.has(worktree.index)) continue;
		if (
			run.stopped.has(worktree.index) &&
			(await worktreeHasUnsavedWork(run.setup, worktree, worktree.index === failedResume ? onStall : undefined))
		)
			continue;
		removing.push(worktree);
	}
	if (run.holds.size || run.launching.size) return;
	if (removing.length || run.diffs?.onCaptured) {
		const subset: WorktreeSetup = { ...run.setup, worktrees: removing };
		const uncaptured = new Set<number>();
		try {
			if (run.diffs) {
				const captured = await diffWorktrees(subset, run.diffs.agents, run.diffs.diffsDir, run.diffs.patchPaths);
				run.diffs.onCaptured?.(captured);
				run.diffs.onCaptured = undefined;
				for (const diff of captured) if (diff.captureError !== undefined) uncaptured.add(diff.index);
			}
		} finally {
			// cleanupWorktrees keeps a worktree whose capture failed.
			await cleanupWorktrees(subset);
			for (const worktree of removing) if (!uncaptured.has(worktree.index)) run.removed.add(worktree.index);
		}
	}
	if (
		run.holds.size === 0 &&
		run.setup.worktrees.every((worktree) => run.removed.has(worktree.index)) &&
		runs.get(run.runId) === run
	)
		runs.delete(run.runId);
}

function sweep(run: RunWorktrees, failedResume?: number): Promise<void> {
	const next = (run.sweeping ?? Promise.resolve()).then(() => sweepIdle(run, failedResume));
	const observed = next
		.catch(() => {
			run.sweepNote = "Worktree cleanup failed. Check the worktree before removing it.";
		})
		.finally(() => {
			if (run.sweeping === observed) run.sweeping = undefined;
		});
	run.sweeping = observed;
	return next;
}

function hold(run: RunWorktrees): (failedResume?: number) => Promise<void> {
	const token = Symbol("worktree hold");
	run.holds.add(token);
	return (failedResume) => {
		if (run.holds.delete(token)) return sweep(run, failedResume);
		return run.sweeping ?? Promise.resolve();
	};
}
function track(runId: string, setup: WorktreeSetup, diffs?: RunWorktreeDiffs): RunWorktrees {
	const run: RunWorktrees = {
		runId,
		setup: { ...setup, worktrees: [...setup.worktrees] },
		holds: new Set(),
		launching: new Set(),
		finishing: new Map(),
		beforeSweep: new Map(),
		stopped: new Set(),
		removed: new Set(),
		returned: false,
		...(diffs ? { diffs: { ...diffs, agents: [...diffs.agents], patchPaths: new Map() } } : {}),
	};
	runs.set(runId, run);
	return run;
}

/**
 * Track a parallel run's worktrees. `release` marks the run returned; with `diffs`, each worktree's edits are saved as
 * a patch before it is removed.
 */
export function registerRunWorktrees(runId: string, setup: WorktreeSetup, diffs?: RunWorktreeDiffs) {
	const run = track(runId, setup, diffs);
	return {
		/** Transfer batch ownership before observing any child, including a foreground wait on its result. */
		beginLaunches() {
			for (const tree of setup.worktrees) run.launching.add(tree.index);
			run.returned = true;
		},
		abandonLaunch(index: number) {
			return run.launching.delete(index) ? sweep(run) : undefined;
		},
		release() {
			if (run.returned) return Promise.resolve();
			run.returned = true;
			return sweep(run);
		},
	};
}

const noHold = (): Promise<void> => Promise.resolve();

/** Hold the run's worktrees for one execution of a child; the returned release ends only this hold. */
export function holdRunWorktree(runId: string, index: number): () => Promise<void> {
	const run = runs.get(runId);
	if (!run?.setup.worktrees.some((worktree) => worktree.index === index)) return noHold;
	return hold(run);
}

export const CLEANUP_IN_BACKGROUND = "Worktree cleanup continues in the background; wait before removing the worktree.";
const BATCH_KEPT = "Worktree kept until the other children in this batch finish.";
export const WORKTREE_REPLY_WAIT_MS = 10_000;

function idleWorktreeNote(run: RunWorktrees): string | undefined {
	return run.holds.size || run.launching.size ? BATCH_KEPT : run.sweepNote;
}

/** Sample a child's current sweep or hold for a reply or card without starting or waiting for work. */
export function currentChildWorktreeNote(runId: string, index: number): string | undefined {
	const run = runs.get(runId);
	if (!run || run.removed.has(index) || !run.setup.worktrees.some((tree) => tree.index === index)) return undefined;
	return run.finishing.has(index) || run.sweeping ? CLEANUP_IN_BACKGROUND : idleWorktreeNote(run);
}

/** Bound the observation, not the cleanup: it must still release its hold and save the child's changes. */
export async function boundedWorktreeReply(
	runId: string,
	work: Promise<void> = Promise.resolve(),
	deadline = Date.now() + WORKTREE_REPLY_WAIT_MS,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const run = runs.get(runId);
	if (!run) return undefined;
	const finished = async () => {
		await work.catch(() => {});
		while (run.sweeping) await run.sweeping;
		return idleWorktreeNote(run);
	};
	const interrupted = Promise.withResolvers<string>();
	const endWait = () => interrupted.resolve(CLEANUP_IN_BACKGROUND);
	const timer = setTimeout(endWait, Math.max(0, deadline - Date.now()));
	timer.unref?.();
	if (signal?.aborted) endWait();
	else signal?.addEventListener("abort", endWait, { once: true });
	try {
		return await Promise.race([finished(), interrupted.promise]);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", endWait);
	}
}

export async function observeChildWorktreeAtReply(
	runId: string,
	index: number,
	deadline?: number,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const run = runs.get(runId);
	if (!run || run.removed.has(index) || !run.setup.worktrees.some((tree) => tree.index === index)) return undefined;
	await boundedWorktreeReply(runId, run.finishing.get(index), deadline, signal);
	// The sweep may have removed this child's worktree while a sibling kept the run registered.
	return currentChildWorktreeNote(runId, index);
}

/** Arm only an observer's deadline, and only from finishing, not from task admission. */
export function worktreeWaitDeadline(record: WorktreeMember) {
	const execution = runs.get(record.runId)?.beforeSweep.get(record.index);
	if (!execution || execution.taskId() !== record.taskId) return undefined;
	const deadline = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const arm = () => {
		timer = setTimeout(() => deadline.abort(), WORKTREE_REPLY_WAIT_MS);
		timer.unref?.();
	};
	if (execution.signal.aborted) arm();
	else execution.signal.addEventListener("abort", arm, { once: true });
	return {
		signal: deadline.signal,
		dispose() {
			clearTimeout(timer);
			execution.signal.removeEventListener("abort", arm);
		},
	};
}

/** Directory work alone, independent of observer deadlines. */
export function pendingChildWorktreeRelease(record: WorktreeMember) {
	return finishingWorktreeStatus(record) ? runs.get(record.runId)?.finishing.get(record.index) : undefined;
}

/** Stop-all may visit the next target during Git, but not during the preceding child's native stop. */
export function childWorktreeFinishing(record: { runId: string; index: number; taskId?: string }) {
	const execution = runs.get(record.runId)?.beforeSweep.get(record.index);
	return execution && execution.taskId() === record.taskId ? execution.ready : undefined;
}

/** The execution's hold ends after session cleanup, even when the reply's deadline expires first. */
export function beginWorktreeExecution(
	runId: string,
	index: number,
	cwd: string,
	taskId: () => string | undefined,
	events: IntercomEventBus | undefined,
) {
	const run = runs.get(runId);
	if (!run?.setup.worktrees.some((tree) => tree.index === index)) return undefined;
	run.launching.delete(index);
	const held = hold(run);
	// An ordinary execution's release: nothing of its sweep is stopped, whatever `closed` settles with.
	const start = Promise.withResolvers<string | undefined>();
	const phase = new AbortController();
	const execution = { taskId, ready: start.promise, signal: phase.signal, status: undefined as string | undefined };
	run.beforeSweep.set(index, execution);
	let swept: Promise<void> | undefined;
	return (status?: string, closed?: Promise<unknown>) => {
		if (swept) return swept;
		execution.status = status;
		registry.revision++;
		const release = () => {
			phase.abort();
			start.resolve(status);
			if (status !== undefined) {
				try {
					events?.emit(SUBAGENT_FINISHING_EVENT, { runId, index, taskId: taskId(), cwd, status });
				} catch {
					// An observer cannot veto cleanup or replace the child's result.
				}
			}
			return withFinishingWorktree(held);
		};
		swept = (closed ?? Promise.resolve())
			.then(release, release)
			.catch(() => {})
			.finally(() => {
				if (run.finishing.get(index) === swept) run.finishing.delete(index);
				if (run.beforeSweep.get(index) === execution) {
					run.beforeSweep.delete(index);
					registry.revision++;
				}
			});
		run.finishing.set(index, swept);
		return swept;
	};
}

/** A child stopped resumably: its worktree is kept while it has unsaved work. */
export function parkRunWorktree(runId: string, index: number): void {
	runs.get(runId)?.stopped.add(index);
}

/** A stopped child can no longer resume, or was not stopped after all: its worktree goes with the others. */
export function unparkRunWorktree(runId: string, index: number): Promise<void> {
	const run = runs.get(runId);
	if (!run?.stopped.delete(index)) return Promise.resolve();
	return sweep(run);
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
	const named = namedWorktrees.get(runId)?.get(index);
	if (named) return named;
	const run = runs.get(runId);
	const worktree = run?.setup.worktrees.find((candidate) => candidate.index === index);
	if (!run || !worktree) return undefined;
	return {
		repo: run.setup.cwd,
		path: worktree.path,
		branch: worktree.branch,
		baseCommit: run.setup.baseCommit,
		syntheticPaths: worktree.syntheticPaths,
		...(run.diffs ? { diffsDir: run.diffs.diffsDir } : {}),
	};
}

/**
 * A stopped child is resuming: hold its run's worktrees until its new execution holds them, and recreate its worktree
 * from the run's base when it was removed, with the edits its earlier executions saved as a patch put back. A run this
 * process no longer tracks, after a restart for one, is tracked again from the child's record. Its new execution saves
 * its edits as a patch of its own, so no earlier patch is overwritten. The worktree stays kept for the stopped child
 * until its new execution starts ({@link claimRunWorktree}), so a resume that fails keeps its unsaved work. Returns the
 * release of the resume hold, which settles once the run's worktrees are swept: until then git may still be running in
 * the child's worktree, which on Windows keeps anyone from removing it (#5589). A resume that failed releases with
 * `failed`, so a stalled git command checking the child's worktree is stopped rather than left running.
 */
export async function resumeRunWorktree(
	child: {
		readonly runId: string;
		readonly index: number;
		readonly cwd: string;
		readonly agent: string;
		readonly worktree?: SubagentChildWorktree;
	},
	setupHook?: WorktreeSetupHookConfig,
	namedOptions: NamedWorktreeOptions = {},
): Promise<(failed?: boolean) => Promise<void>> {
	// A named worktree is the caller's: put back where it was if it was removed, and never tracked for removal.
	if (child.worktree?.named) {
		try {
			await ensureNamedWorktree(
				child.worktree.repo,
				{ branch: child.worktree.branch, path: child.worktree.path },
				namedOptions,
			);
		} catch {
			// Left as it is: resume then reports a working directory that no longer exists.
		}
		return noHold;
	}
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
			run = track(
				child.runId,
				{ cwd: child.worktree.repo, baseCommit: child.worktree.baseCommit, worktrees: [] },
				child.worktree.diffsDir ? { diffsDir: child.worktree.diffsDir, agents: [] } : undefined,
			);
			run.returned = true;
		}
		// Its edits are saved as a patch before its worktree is removed, as the run that created it would.
		if (run.diffs) run.diffs.agents[child.index] = child.agent;
		run.setup.worktrees.push(recorded);
		run.removed.add(child.index);
	}
	const release = hold(run);
	run.stopped.add(child.index);
	await run.sweeping;
	const position = run.setup.worktrees.findIndex((worktree) => worktree.index === child.index);
	const removed = !(await pathExists(run.setup.worktrees[position]!.path));
	try {
		const worktree = await recreateWorktree(run.setup, run.setup.worktrees[position]!, child.runId, {
			...(setupHook ? { setupHook } : {}),
			agent: child.agent,
		});
		run.setup.worktrees[position] = worktree;
		if (run.diffs) {
			const agent = run.diffs.agents[child.index] ?? child.agent;
			const saved = (await savedWorktreePatches(run.diffs.diffsDir, child.index, agent)).at(-1);
			if (removed && saved) await restoreWorktreePatch(run.setup, worktree, saved);
			run.diffs.patchPaths.set(child.index, await nextWorktreePatchPath(run.diffs.diffsDir, child.index, agent));
		}
		run.removed.delete(child.index);
	} catch {
		// Left missing: resume then reports that the child's working directory no longer exists.
	}
	return (failed = false) => release(failed ? child.index : undefined);
}

/** Runs whose worktrees this process still tracks; counted by tests and the benchmark. */
export function trackedRunWorktreeCount(): number {
	return runs.size + namedWorktrees.size;
}
