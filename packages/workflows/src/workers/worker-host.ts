import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	type GitProvisionError,
	getAgentDir,
	isGitProvisionError,
	resolveGit,
	resolveGitSync,
	restoreRunWorktree,
} from "@bastani/atomic";
import type { StorageSelection } from "@bastani/atomic/storage";
import { openSelectedRunJournal } from "../durable/journal/resolution.js";
import type { SharedPoolFleet } from "../durable/journal/shared-pool-types.js";
import { openSqlPoolQueue, type PoolWork } from "../durable/journal/sql-pool-queue.js";
import {
	readSharedPoolFleet,
	type SharedPoolRoot,
	SqlSharedPool,
	type WorkerHostGitSource,
} from "../durable/journal/sql-shared-pool.js";
import type { RunJournal } from "../durable/journal/types.js";
import type { CoordinatorEvent, CoordinatorInbound, CoordinatorPort } from "./coordinator-protocol.js";
import { definitionDigest, type WorkerDefinitionSource } from "./definitions.js";
import { HostPollBackoff } from "./host-poll-backoff.js";
import { defaultWorkerEntry } from "./local-pool.js";
import {
	SharedPoolSetupError,
	type SharedPoolSetupProblem,
	serializeWorkerPlacementError,
	sharedPoolProblems,
	WorkerPlacementConfigError,
	WorkerPlacementError,
} from "./placement-errors.js";
import { PoolCoordinator } from "./pool-coordinator.js";
import { poolDurableJournal, poolHostId, poolStateDirectory } from "./pool-journal.js";
import { processContainmentAvailable } from "./public-pool.js";
import { RestoreBackoff } from "./restore-backoff.js";
import { sharedJournalSelection, sharedSelectionProblems } from "./shared-setup.js";
import { snapshotRestore } from "./snapshot-restore.js";
import type {
	SharedJournalSelection,
	WorkerHostFailure,
	WorkerHostGit,
	WorkflowWorkerHost,
	WorkflowWorkerHostEvent,
	WorkflowWorkerHostOptions,
	WorkflowWorkerHostStats,
} from "./worker-host-types.js";
import type { RestoredWorkspace, WorkspaceRestore } from "./workspace-binding.js";

export type {
	SharedJournalSelection,
	WorkerHostFailure,
	WorkerHostGit,
	WorkflowWorkerHost,
	WorkflowWorkerHostEvent,
	WorkflowWorkerHostOptions,
	WorkflowWorkerHostStats,
} from "./worker-host-types.js";

/** How often a worker host looks for roots to serve. */
const HOST_POLL_MS = 1_000;
/**
 * How often a worker host reports itself while its worker count is unchanged: a report is a write, and every host of the
 * journal makes them. Well inside the time a host counts as live after its last report.
 */
const HOST_REPORT_MS = 5_000;
/**
 * How long a root's satellite keeps workers that have nothing to do before it gives them to a root that waits with ready
 * work, when this host has no workers left: long enough that roots without work do not trade workers on every poll.
 */
const IDLE_YIELD_MS = 5_000;
/** How long a worker host waits for its git probe. */
const GIT_PROBE_TIMEOUT_MS = 10_000;

/** A failure as stats report it: a placement error with its code and fields, any other error by name and message. */
function failure(error: Error): WorkerHostFailure {
	return error instanceof WorkerPlacementError
		? serializeWorkerPlacementError(error)
		: { name: error.name, message: error.message };
}

/** A held child, as `claimed` and `released` events name it. */
function heldEvent(
	root: string,
	work: PoolWork,
): { readonly root: string; readonly childRunId: string; readonly work: string; readonly generation: number } {
	return { root, childRunId: work.childRunId, work: work.id, generation: work.generation };
}

/** Whether a root's satellites keep serving it: while it runs, and while it is paused, its workers' sessions with it. */
function active(status: string | undefined): boolean {
	return status === "running" || status === "paused";
}

/** The host's options, checked before anything opens or starts. */
function validated(options: WorkflowWorkerHostOptions): void {
	if (!Number.isSafeInteger(options.maxWorkers) || options.maxWorkers < 1)
		throw new WorkerPlacementConfigError("sdk", "maxWorkers", "invalid-option", "must be a positive integer");
	for (const [key, value] of Object.entries(options.labels ?? {}))
		if (typeof value !== "string")
			throw new WorkerPlacementConfigError("sdk", `labels.${key}`, "invalid-option", "labels are strings");
	if (options.hostId !== undefined && (options.hostId === "" || options.hostId.includes("/")))
		throw new WorkerPlacementConfigError("sdk", "hostId", "invalid-option", "a non-empty id without '/'");
	if (options.restore !== undefined && options.restore !== false && typeof options.restore !== "function")
		throw new WorkerPlacementConfigError("sdk", "restore", "invalid-option", "a function, or false");
	if (options.placement?.prefer !== undefined && typeof options.placement.prefer !== "function")
		throw new WorkerPlacementConfigError("sdk", "placement.prefer", "invalid-option", "a function");
	if (options.git !== undefined && (typeof options.git.path !== "string" || options.git.path === ""))
		throw new WorkerPlacementConfigError("sdk", "git.path", "invalid-option", "a non-empty path");
	if (options.idleExitMs !== undefined && (!Number.isSafeInteger(options.idleExitMs) || options.idleExitMs < 1))
		throw new WorkerPlacementConfigError("sdk", "idleExitMs", "invalid-option", "must be a positive integer");
}

/** Where a host's git comes from and, for a host given a restore function but no git, the setup problem that says so. */
interface HostGit {
	readonly source: WorkerHostGitSource;
	/** The git the host runs, when it has one: given as `options.git`, or the one `@bastani/atomic` resolves. */
	readonly command?: WorkerHostGit;
	readonly problem?: SharedPoolSetupProblem;
	readonly cause?: GitProvisionError;
}

/**
 * The git a worker host runs: the one `options.git` names, probed, or else the git `@bastani/atomic` resolves, with
 * the environment it needs. Only a host given a restore function, which needs git, is provisioned a portable git
 * (`resolveGit()`); any other host takes the git this machine has (`resolveGitSync()`), never downloads one, and
 * restores by default only with it.
 */
async function hostGit(options: WorkflowWorkerHostOptions): Promise<HostGit> {
	if (options.git !== undefined) {
		const source = await probeGit(options.git);
		return source === "unavailable"
			? { source, problem: sharedPoolProblems.gitUnavailable(options.git.path) }
			: { source, command: options.git };
	}
	try {
		const resolved = typeof options.restore === "function" ? await resolveGit() : resolveGitSync();
		return { source: resolved.source, command: { path: resolved.path, env: gitVariables(resolved.env) } };
	} catch (error) {
		if (!isGitProvisionError(error)) throw error;
		if (typeof options.restore !== "function") return { source: "unavailable" };
		return { source: "unavailable", problem: sharedPoolProblems.gitNotProvided(error), cause: error };
	}
}

/** The variables a resolved git sets beyond this process's environment, such as a portable git's own. */
function gitVariables(env: NodeJS.ProcessEnv): Readonly<Record<string, string>> {
	return Object.fromEntries(
		Object.entries(env).flatMap(([key, value]) =>
			value === undefined || process.env[key] === value ? [] : [[key, value] as const],
		),
	);
}

/**
 * Checks, in one pass and before the journal is opened, everything a worker host needs that it cannot supply itself: a
 * journal selected through a storage adapter, that adapter loadable, its secrets present, git when a restore port is
 * configured, and process containment for its workers. Every missing piece is reported together, typed. Returns the
 * adapter selection and the git source.
 */
async function checkHostSetup(
	options: WorkflowWorkerHostOptions,
	agentDir: string,
): Promise<{
	readonly selection: Extract<StorageSelection, { kind: "adapter" }>;
	readonly git: WorkerHostGitSource;
	readonly gitCommand: WorkerHostGit | undefined;
}> {
	const selection = sharedJournalSelection(options.journal, { agentDir });
	const problems = await sharedSelectionProblems(selection, agentDir);
	const git = await hostGit(options);
	if (typeof options.restore === "function" && git.problem !== undefined) problems.push(git.problem);
	if (!(await processContainmentAvailable())) problems.push(sharedPoolProblems.processContainmentUnavailable());
	const [first, ...rest] = problems;
	if (first !== undefined)
		throw new SharedPoolSetupError(
			"worker-host",
			[first, ...rest],
			git.cause === undefined ? {} : { cause: git.cause },
		);
	return {
		selection: selection as Extract<StorageSelection, { kind: "adapter" }>,
		git: git.source,
		gitCommand: git.command,
	};
}

/** Whether git runs on this host through `git`: `system` when it does, `unavailable` when it does not. */
export function probeGit(git: WorkerHostGit): Promise<WorkerHostGitSource> {
	return new Promise((resolve) => {
		try {
			execFile(
				git.path,
				["--version"],
				{ env: { ...process.env, ...git.env }, timeout: GIT_PROBE_TIMEOUT_MS, windowsHide: true },
				(error) => resolve(error === null ? "system" : "unavailable"),
			);
		} catch {
			// A path the platform cannot execute at all (on Windows, a script) fails the spawn itself: no git there either.
			resolve("unavailable");
		}
	});
}

/** The root's definitions this host can run: the same module path, export and entry digest, here. */
async function runnableSources(root: SharedPoolRoot): Promise<readonly WorkerDefinitionSource[]> {
	const sources: WorkerDefinitionSource[] = [];
	for (const source of root.config.definitions) {
		// A definition this host does not have is the root's to run elsewhere.
		if (!existsSync(source.path)) continue;
		const digest = await definitionDigest(source.path);
		if (digest === source.digest)
			sources.push({ path: source.path, exportName: source.exportName, digest: source.digest });
	}
	return sources;
}

interface Satellite {
	readonly epoch: number;
	readonly coordinator: PoolCoordinator;
	readonly workers: number;
	readonly attached: Promise<void>;
	/** When it attached, by `performance.now()`. */
	readonly attachedAt: number;
	detached: boolean;
	/** It is draining to give up workers to a root this host does not serve yet, and attaches again after. */
	yielding: boolean;
}

/** A coordinator port that goes nowhere: a worker host has no root process to report to. */
function hostPort(health: (message: string) => void): CoordinatorPort<CoordinatorEvent, CoordinatorInbound> {
	return {
		send(event) {
			if (event.kind === "health") health(event.message);
		},
		onMessage() {},
		onClose() {},
		async close() {},
	};
}

class WorkerHost implements WorkflowWorkerHost {
	private readonly satellites = new Map<string, Satellite>();
	/** When each root last gave up its workers, by `performance.now()`: it waits behind the roots it gave them to. */
	private readonly yielded = new Map<string, number>();
	private readonly timer: NodeJS.Timeout;
	private polling?: Promise<void>;
	private stopping?: Promise<void>;
	private draining = false;
	/** A `stop()` was asked for, which a drain in progress gives way to. */
	private stoppingNow = false;
	private lastPlacementFailure?: WorkerHostFailure;
	private lastDetach?: WorkerHostFailure;
	private reported?: { readonly workers: number; readonly roots: string; readonly at: number };
	private lastHealth?: string;
	/** When this host restores each binding again whose restores failed, across every root it serves (#4416). */
	private readonly restoreBackoff = new RestoreBackoff();
	/** When this host polls the journal again after its polls failed (#4768). */
	private readonly pollBackoff = new HostPollBackoff();
	private degraded?: NonNullable<WorkflowWorkerHostStats["degraded"]>;
	/** The work this host's workers held at the last tick, by root and work id, to report what they claimed and released. */
	private held = new Map<string, { readonly root: string; readonly work: PoolWork }>();
	/** When a worker of this host last held a child, by `performance.now()`. */
	private busyAt = performance.now();
	private settleClosed!: () => void;
	readonly closed = new Promise<void>((resolve) => {
		this.settleClosed = resolve;
	});

	constructor(
		readonly hostId: string,
		private readonly journal: RunJournal,
		private readonly shared: SqlSharedPool,
		private readonly durable: ReturnType<typeof poolDurableJournal>,
		private readonly git: WorkerHostGitSource,
		private readonly gitCommand: WorkerHostGit | undefined,
		/** The restore port this host runs: given, the snapshot restore by default, or none. */
		private readonly restorePort: WorkspaceRestore | undefined,
		private readonly options: WorkflowWorkerHostOptions,
	) {
		this.timer = setInterval(() => this.tick(), HOST_POLL_MS);
	}

	private emit(event: WorkflowWorkerHostEvent): void {
		try {
			this.options.onEvent?.(event);
		} catch {
			// A listener's failure is its own: the host goes on.
		}
	}

	/** Reports claimed and released children, exits when idle for `idleExitMs`, and polls unless backing off. */
	private tick(): void {
		const claimed = this.noteHeldWork();
		if (this.stopping !== undefined) return;
		const now = performance.now();
		if (claimed || this.workerCount().busy > 0) this.busyAt = now;
		const idleExitMs = this.options.idleExitMs;
		if (idleExitMs !== undefined && now - this.busyAt >= idleExitMs) {
			this.emit({ kind: "idle-exit", idleMs: Math.round(now - this.busyAt) });
			void this.drain().catch((error: Error) => {
				this.lastDetach = failure(error);
			});
			return;
		}
		if (this.polling !== undefined || !this.pollBackoff.due()) return;
		this.polling = this.poll()
			.then(
				() => {
					const failures = this.pollBackoff.succeeded();
					if (failures === 0) return;
					this.degraded = undefined;
					this.emit({ kind: "recovered", failures });
				},
				(error: Error) => {
					// A pass that failed (the journal unreachable, say) is retried after a backoff; the host's running children
					// go on, and stats say why (#4768).
					this.lastDetach = failure(error);
					const { failures, retryInMs } = this.pollBackoff.failed();
					this.degraded = { failures, since: this.degraded?.since ?? Date.now(), error: failure(error) };
					this.emit({ kind: "degraded", failures, retryInMs, error: failure(error) });
				},
			)
			.finally(() => {
				this.polling = undefined;
			});
	}

	/**
	 * Emits `claimed` for each child a worker of this host took since the last tick, and `released` for each it let go,
	 * a child that came and went between two ticks included. Returns whether any was claimed.
	 */
	private noteHeldWork(): boolean {
		const key = (root: string, work: PoolWork) => `${root}\0${work.id}\0${work.generation}`;
		const current = new Map<string, { readonly root: string; readonly work: PoolWork }>();
		const claims: { readonly root: string; readonly work: PoolWork }[] = [];
		for (const [root, satellite] of this.satellites) {
			for (const work of satellite.coordinator.takeClaims()) claims.push({ root, work });
			for (const work of satellite.coordinator.heldWork()) current.set(key(root, work), { root, work });
		}
		for (const [held, { root, work }] of this.held)
			if (!current.has(held)) this.emit({ kind: "released", ...heldEvent(root, work) });
		for (const { root, work } of claims) {
			const claim = key(root, work);
			if (this.held.has(claim)) continue;
			this.emit({ kind: "claimed", ...heldEvent(root, work) });
			if (!current.has(claim)) this.emit({ kind: "released", ...heldEvent(root, work) });
		}
		for (const [held, { root, work }] of current)
			if (!this.held.has(held) && !claims.some((claim) => key(claim.root, claim.work) === held))
				this.emit({ kind: "claimed", ...heldEvent(root, work) });
		this.held = current;
		return claims.length > 0;
	}

	private get restores(): boolean {
		return this.restorePort !== undefined;
	}

	private workerCount(): { workers: number; busy: number } {
		let workers = 0;
		let busy = 0;
		for (const satellite of this.satellites.values()) {
			const counts = satellite.coordinator.workerCounts();
			workers += counts.workers;
			busy += counts.busy;
		}
		return { workers, busy };
	}

	/** Reports this host, lets go of roots it no longer serves, and attaches to roots it can serve. */
	private async poll(): Promise<void> {
		if (this.stopping !== undefined) return;
		const workers = this.workerCount().workers;
		const served = [...this.satellites.keys()].sort();
		const now = performance.now();
		if (
			this.reported === undefined ||
			this.reported.workers !== workers ||
			this.reported.roots !== JSON.stringify(served) ||
			now - this.reported.at >= HOST_REPORT_MS
		) {
			await this.shared.reportHost({
				host: this.hostId,
				labels: { ...this.options.labels },
				git: this.git,
				restore: this.restores,
				workers,
				maxWorkers: this.options.maxWorkers,
				roots: served,
			});
			this.reported = { workers, roots: JSON.stringify(served), at: now };
		}
		const roots = await this.shared.roots();
		const byRoot = new Map(roots.map((root) => [root.root, root]));
		for (const [root, satellite] of [...this.satellites]) {
			const current = byRoot.get(root);
			satellite.coordinator.followBudget(current?.budgetBlocked === true);
			if (!satellite.detached && active(current?.status) && current?.lease.epoch === satellite.epoch) continue;
			this.satellites.delete(root);
			await satellite.coordinator.stopSatellite().catch((error: Error) => {
				this.lastDetach = failure(error);
			});
			await satellite.coordinator.shutdown();
		}
		if (this.draining) return;
		const unserved: { readonly root: SharedPoolRoot; readonly sources: readonly WorkerDefinitionSource[] }[] = [];
		for (const root of roots) {
			if (!active(root.status) || !root.fresh || this.satellites.has(root.root)) continue;
			const sources = await runnableSources(root);
			if (sources.length > 0) unserved.push({ root, sources });
		}
		// Each running root this host can serve gets an even share of its workers, at least one while any is free.
		const share = Math.max(
			1,
			Math.floor(this.options.maxWorkers / Math.max(1, this.satellites.size + unserved.length)),
		);
		let capacity = this.options.maxWorkers - [...this.satellites.values()].reduce((n, s) => n + s.workers, 0);
		for (const [root, at] of this.yielded) if (now - at >= IDLE_YIELD_MS) this.yielded.delete(root);
		// A root that started after this host gave its workers to others takes their share from roots holding more, or
		// the idle workers of a root holding no more than its share once the waiting root has ready work.
		if (unserved.length > 0 && capacity < 1) await this.yieldWorkers(share, unserved, now);
		unserved.sort((a, b) => Number(this.yielded.has(a.root.root)) - Number(this.yielded.has(b.root.root)));
		for (const { root, sources } of unserved) {
			if (capacity < 1) return;
			const workers = Math.min(capacity, share);
			this.attach(root, sources, workers);
			capacity -= workers;
		}
	}

	/**
	 * Drains each satellite holding more than `share` workers, and each whose workers sat idle for {@link IDLE_YIELD_MS}
	 * while an `unserved` root has ready work: it finishes the children its workers hold and takes no more, then a later
	 * poll attaches it again, after the roots that had none.
	 */
	private async yieldWorkers(
		share: number,
		unserved: readonly { readonly root: SharedPoolRoot }[],
		now: number,
	): Promise<void> {
		let waiting: boolean | undefined;
		for (const [root, satellite] of this.satellites) {
			if (satellite.yielding) continue;
			if (satellite.workers <= share) {
				if (satellite.coordinator.workerCounts().busy > 0 || now - satellite.attachedAt < IDLE_YIELD_MS) continue;
				waiting ??= await this.readyWorkWaits(unserved);
				if (!waiting) continue;
			}
			satellite.yielding = true;
			this.yielded.set(root, now);
			void satellite.attached
				.then(() => satellite.coordinator.drain())
				.catch((error: Error) => {
					this.lastDetach = failure(error);
				})
				.finally(() => {
					satellite.detached = true;
				});
		}
	}

	/** Whether any of `unserved` has work ready for a worker. */
	private async readyWorkWaits(unserved: readonly { readonly root: SharedPoolRoot }[]): Promise<boolean> {
		for (const { root } of unserved) if ((await this.shared.stats(root.root)).ready > 0) return true;
		return false;
	}

	private attach(root: SharedPoolRoot, sources: readonly WorkerDefinitionSource[], workers: number): void {
		const coordinator = new PoolCoordinator(
			hostPort((message) => {
				this.lastHealth = message;
			}),
		);
		coordinator.followBudget(root.budgetBlocked);
		const satellite: Satellite = {
			epoch: root.lease.epoch,
			coordinator,
			workers,
			detached: false,
			yielding: false,
			attached: Promise.resolve(),
			attachedAt: performance.now(),
		};
		(satellite as { attached: Promise<void> }).attached = coordinator
			.attachSatellite({
				root: root.root,
				lease: root.lease,
				journal: this.journal,
				config: root.config,
				sources,
				workers,
				durable: this.durable,
				stateDirectory: poolStateDirectory(this.durable.agentDir),
				// This process is the SDK host, not a worker entry: workers fork the shipped worker module.
				workerEntry: this.options.workerEntry ?? defaultWorkerEntry(),
				placement: {
					host: this.hostId,
					...(this.options.placement?.prefer === undefined ? {} : { prefer: this.options.placement.prefer }),
					restore: this.restorePort,
					restoreBackoff: this.restoreBackoff,
					...(this.gitCommand === undefined ? {} : { git: this.gitCommand }),
					detached: (reason) => {
						satellite.detached = true;
						if (reason !== undefined) this.lastDetach = failure(reason);
					},
					placementFailed: (error) => {
						this.lastPlacementFailure = failure(error);
					},
				},
			})
			.catch((error: Error) => {
				satellite.detached = true;
				this.lastDetach = failure(error);
			});
		this.satellites.set(root.root, satellite);
	}

	async stats(): Promise<WorkflowWorkerHostStats> {
		const { workers, busy } = this.workerCount();
		// A root whose stats the journal cannot give now, while it is unreachable, is left out (#4768).
		const roots =
			this.stopping === undefined
				? (await Promise.allSettled([...this.satellites.keys()].map((root) => this.shared.stats(root)))).flatMap(
						(result) => (result.status === "fulfilled" ? [result.value] : []),
					)
				: [];
		return {
			hostId: this.hostId,
			labels: { ...this.options.labels },
			git: this.git,
			restore: this.restores,
			maxWorkers: this.options.maxWorkers,
			workers,
			busy,
			roots,
			...(this.lastPlacementFailure === undefined ? {} : { lastPlacementFailure: this.lastPlacementFailure }),
			...(this.lastDetach === undefined ? {} : { lastDetach: this.lastDetach }),
			...(this.lastHealth === undefined ? {} : { lastHealth: this.lastHealth }),
			...(this.degraded === undefined ? {} : { degraded: this.degraded }),
		};
	}

	drain(): Promise<void> {
		this.draining = true;
		this.stopping ??= this.windDown((coordinator) => coordinator.drain());
		return this.stopping;
	}

	stop(): Promise<void> {
		if (this.stopping === undefined) this.stopping = this.windDown((coordinator) => coordinator.stopSatellite());
		else if (this.draining && !this.stoppingNow)
			// A stop during a drain stops at once: each satellite stops, and the drain ends with it.
			for (const satellite of this.satellites.values())
				void satellite.coordinator.stopSatellite().catch((error: Error) => {
					this.lastDetach = failure(error);
				});
		this.stoppingNow = true;
		return this.stopping;
	}

	/**
	 * Stops polling, winds every satellite down with `each`, then always leaves the registry and closes the journal. The
	 * first failure is the one thrown; any later one is attached to it as its `cleanupCause`.
	 */
	private async windDown(each: (coordinator: PoolCoordinator) => Promise<void>): Promise<void> {
		try {
			await this.windDownOnce(each);
		} finally {
			// Ticks went on reporting the children the workers let go of while they wound down; polls ended at once.
			clearInterval(this.timer);
			this.settleClosed();
		}
	}

	private async windDownOnce(each: (coordinator: PoolCoordinator) => Promise<void>): Promise<void> {
		const failures: unknown[] = [];
		await this.polling;
		for (const result of await Promise.allSettled(
			// A satellite still attaching is wound down at once: its attach then starts nothing and settles.
			[...this.satellites.values()].map(async (satellite) => {
				await each(satellite.coordinator);
				await satellite.attached;
			}),
		))
			if (result.status === "rejected") failures.push(result.reason);
		const satellites = [...this.satellites.values()];
		this.satellites.clear();
		// Whatever the workers still held went back to the queue with them.
		this.noteHeldWork();
		for (const satellite of satellites) await satellite.coordinator.shutdown().catch((error) => failures.push(error));
		await this.shared.forgetHost(this.hostId).catch((error) => failures.push(error));
		await this.journal.close().catch((error) => failures.push(error));
		const [primary, ...cleanup] = failures;
		if (failures.length > 0) throw withCleanupFailures(primary, cleanup);
	}
}

/** `primary`, with the failures of the cleanup that followed it attached as its `cleanupCause`, never replacing it. */
function withCleanupFailures(primary: unknown, cleanup: readonly unknown[]): unknown {
	if (cleanup.length === 0 || !(primary instanceof Error)) return primary;
	Object.defineProperty(primary, "cleanupCause", {
		value: cleanup.length === 1 ? cleanup[0] : new AggregateError(cleanup, "Worker host cleanup failed"),
		configurable: true,
	});
	return primary;
}

/**
 * The restore port a worker host runs (#4416): the function it was given, or else #4245's worktree snapshot restore
 * from the snapshots recorded in `shared`'s journal, with the host's own `git`, into worktrees under this host's agent
 * directory, followed by the blueprint build of this host's agent directory in the restored worktree (#4329, #4588). None
 * for a host started with `restore: false` or without git: it takes bound work only when its tree is warm.
 */
export function hostRestorePort(
	options: WorkflowWorkerHostOptions,
	git: WorkerHostGit | undefined,
	shared: SqlSharedPool,
	journal: RunJournal,
	agentDir: string,
): WorkspaceRestore | undefined {
	if (options.restore === false || git === undefined) return undefined;
	if (options.restore !== undefined) return options.restore;
	const restore = snapshotRestore({
		recorded: (binding) => shared.recordedSnapshots(binding),
		blobs: journal.snapshotBlobs,
		storeDir: join(agentDir, "worktree-snapshots"),
		git,
	});
	return async (binding, hook) => {
		let result: string | RestoredWorkspace | undefined;
		const path = await restoreRunWorktree(
			hook.snapshot?.remotes,
			async () => {
				result = await restore(binding, hook);
				return typeof result === "string" ? result : result.path;
			},
			{
				signal: hook.signal,
				agentDir,
				onNotices: (notices) => {
					for (const notice of notices) console.warn(`atomic-workflows: ${notice.message}`);
				},
			},
		);
		if (typeof result !== "object" || result.partial === undefined) return path;
		// A worktree with less than the binding's tree: the child runs there, and its stages are told (#4738).
		console.warn(`atomic-workflows: ${result.partial.message}`);
		return { path, partial: result.partial };
	};
}

/**
 * Joins this host to the shared pools of every root whose pool runs on `journal` (#4310): roots started with
 * `workers: { placement: "shared" }` on a journal every host opens through a storage adapter. The host runs up to
 * `maxWorkers` workers for them, each claiming a root's children from the journal's queue under the root's current
 * lease, and keeps doing so across the root's resumes on any host. It runs a root's children only when it has the same
 * worker definitions (module path, export and entry digest) as the root.
 */
export async function startWorkflowWorkerHost(options: WorkflowWorkerHostOptions): Promise<WorkflowWorkerHost> {
	validated(options);
	const agentDir = options.agentDir ?? getAgentDir();
	const { selection, git, gitCommand } = await checkHostSetup(options, agentDir);
	const journal = await openSelectedRunJournal(selection, agentDir);
	try {
		// An adapter's journal is a SQL journal, whose database holds the pool's tables.
		const durable = poolDurableJournal(journal);
		const queue = await openSqlPoolQueue(journal);
		const shared = await SqlSharedPool.open(journal, queue);
		return new WorkerHost(
			options.hostId ?? poolHostId(durable.agentDir),
			journal,
			shared,
			durable,
			git,
			gitCommand,
			hostRestorePort(options, gitCommand, shared, journal, agentDir),
			options,
		);
	} catch (error) {
		const cleanup: unknown[] = [];
		await journal.close().catch((closing) => cleanup.push(closing));
		throw withCleanupFailures(error, cleanup);
	}
}

/**
 * The worker hosts registered in a shared journal, as each last reported itself, and the pool stats of the running or
 * paused roots they serve (#4768). The journal's setup is checked as {@link startWorkflowWorkerHost} checks it, every
 * problem reported together, except process containment, which reading needs none of.
 */
export async function readWorkflowWorkerFleet(
	options: { readonly journal?: SharedJournalSelection; readonly agentDir?: string } = {},
): Promise<SharedPoolFleet> {
	const agentDir = options.agentDir ?? getAgentDir();
	const selection = sharedJournalSelection(options.journal, { agentDir });
	const [first, ...rest] = await sharedSelectionProblems(selection, agentDir);
	if (first !== undefined) throw new SharedPoolSetupError("worker-host", [first, ...rest]);
	const journal = await openSelectedRunJournal(selection as Extract<StorageSelection, { kind: "adapter" }>, agentDir);
	try {
		return (await readSharedPoolFleet(journal)) ?? { hosts: [], roots: [] };
	} finally {
		await journal.close();
	}
}
