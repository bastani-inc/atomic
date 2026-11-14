import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isBoundWorkspace, isWorkspace, resolveWorkspace } from "@bastani/atomic";
import type { DurableWorkflowBackend } from "../durable/backend.js";
import { sqlPoolStorage } from "../durable/journal/internal.js";
import { JournalDurableBackend } from "../durable/journal/journal-backend.js";
import { type RunJournalSettings, runJournalOrigin } from "../durable/journal/resolution.js";
import { isShardedRunJournal, rootRunJournal } from "../durable/journal/sharded-run-journal.js";
import type { RunJournal } from "../durable/journal/types.js";
import type { RunOpts } from "../runs/foreground/executor-types.js";
import { WorkflowAdmissionConfigError } from "./admission-errors.js";
import { admissionBootIdentity } from "./admission-host.js";
import type { SharedPoolCoordination } from "./coordinator-protocol.js";
import { definitionDigest, loadWorkerDefinition } from "./definitions.js";
import { hostWorkerBindings } from "./host-options.js";
import { LocalWorkerPool } from "./local-pool.js";
import {
	SharedPoolSetupError,
	type SharedPoolSetupProblem,
	selectionLocation,
	sharedPoolProblems,
	WorkerPlacementConfigError,
} from "./placement-errors.js";
import {
	coordinationDatabase,
	coordinationPath,
	isLocalPoolJournal,
	openCoordinationJournal,
	type PoolDurableJournal,
	poolDurableJournal,
	poolHostId,
	poolStateDirectory,
	registerPoolJournal,
	registerSharedPoolRoot,
} from "./pool-journal.js";
import {
	DEFAULT_PLACEMENT_CLAIM_WINDOW_MS,
	DEFAULT_POOLED_STAGE_START_MAX_LOAD_PER_CPU,
	type RecordedWorkerPlacement,
	type WorkflowExecutionResources,
	type WorkflowWorkerPlacementOptions,
} from "./public-options.js";
import { SqlResourceAdmission } from "./resource-admission.js";
import { bindingIdentity, isWorkspaceBinding, type WorkspaceBinding } from "./workspace-binding.js";

/**
 * Saved settings a resumed root may run with other values of: they size and pace its pool and bound its own sessions
 * and processes, and no recorded step or queued child depends on them, so a resume runs with the current ones and the
 * root records those (#4196). `startupTimeoutMs`, `leaseMs`, `heartbeatMs`, `maxLoadPerCpu` and `maxWorkerRssBytes` are
 * never saved.
 */
const RESUMABLE_SETTINGS: ReadonlySet<string> = new Set([
	"localWorkers.count",
	"admission.limits.session",
	"admission.limits.process",
	"admission.host.maxLoadPerCpu",
	"admission.host.minFreeMemoryBytes",
	"workers.claimWindowMs",
]);

function shown(value: unknown): string {
	return value === undefined ? "unset" : JSON.stringify(value);
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ResourceChange {
	/** The settings path that changed, for a setting. */
	readonly path?: string;
	readonly description: string;
	readonly resumable: boolean;
	/** The option that sets the changed setting: a coordinator is recorded for local workers. */
	readonly option: "localWorkers" | "admission" | "workers";
	/** An edited entry module of a worker definition, which a resume that accepts entry changes applies (#4200). */
	readonly entry?: true;
}

/** Each saved setting that differs from the current one, by its settings path, and whether a resume can apply it. */
function settingChanges(path: string, saved: unknown, current: unknown, changes: ResourceChange[]): void {
	if (isDeepStrictEqual(saved, current)) return;
	if ((saved === undefined || isPlainRecord(saved)) && (current === undefined || isPlainRecord(current))) {
		for (const key of new Set([...Object.keys(saved ?? {}), ...Object.keys(current ?? {})]))
			settingChanges(`${path}.${key}`, saved?.[key], current?.[key], changes);
		return;
	}
	changes.push({
		path,
		description: `${path} changed from ${shown(saved)} to ${shown(current)}`,
		resumable: RESUMABLE_SETTINGS.has(path),
		option: path.startsWith("admission") ? "admission" : path.startsWith("workers") ? "workers" : "localWorkers",
	});
}

/**
 * What changed between a root's saved local worker and admission settings and the ones it resumes with. A worker
 * definition is named by its module path and export; its digest covers only that entry module, not what it imports.
 */
function resourceChanges(saved: WorkflowExecutionResources, current: WorkflowExecutionResources): ResourceChange[] {
	const changes: ResourceChange[] = [];
	if ((saved.localWorkers === undefined) !== (current.localWorkers === undefined))
		changes.push({
			description: `local workers were turned ${current.localWorkers === undefined ? "off" : "on"}`,
			resumable: false,
			option: "localWorkers",
		});
	else {
		// Definitions are compared below, by name and entry module, so a reordered list is not a change.
		settingChanges(
			"localWorkers",
			saved.localWorkers && { ...saved.localWorkers, definitions: undefined },
			current.localWorkers && { ...current.localWorkers, definitions: undefined },
			changes,
		);
	}
	const named = (list: WorkflowExecutionResources["definitions"]) =>
		new Map((list ?? []).map((source) => [`${source.path}#${source.exportName}`, source.digest]));
	const before = named(saved.definitions);
	const after = named(current.definitions);
	for (const [name, digest] of before) {
		const now = after.get(name);
		if (now === undefined)
			changes.push({
				description: `worker definition ${name} is no longer listed`,
				resumable: false,
				option: "localWorkers",
			});
		else if (now !== digest)
			changes.push({
				description: `the entry module of worker definition ${name} was edited (sha256 ${digest.slice(0, 12)} to ${now.slice(0, 12)})`,
				resumable: false,
				option: "localWorkers",
				entry: true,
			});
	}
	for (const name of after.keys())
		if (!before.has(name))
			changes.push({ description: `worker definition ${name} was added`, resumable: false, option: "localWorkers" });
	settingChanges("admission", saved.admission, current.admission, changes);
	settingChanges("workers", saved.workers, current.workers, changes);
	settingChanges("coordinator", saved.coordinator, current.coordinator, changes);
	return changes;
}

/**
 * The changes from a root's saved resources that its resume refuses: every one but the pool size, the root's own limits
 * and, when `acceptEntryChanges` is set, an edited entry module.
 */
export function refusedResourceChanges(
	saved: WorkflowExecutionResources,
	current: WorkflowExecutionResources,
	acceptEntryChanges: boolean | undefined,
): ResourceChange[] {
	return resourceChanges(saved, current).filter(
		(change) => !change.resumable && !(change.entry && acceptEntryChanges === true),
	);
}

/**
 * The resources a root records for `options`: without the settings it never saves, with paths resolved against its
 * directory, user limits counted in `userDatabase()` when they name no database, and each definition's `digestOf` its
 * resolved path.
 */
export function workerResources(
	options: Pick<RunOpts, "localWorkers" | "admission" | "cwd">,
	context: {
		readonly userDatabase: () => string | undefined;
		readonly digestOf: (path: string) => string;
		readonly coordinator: WorkflowExecutionResources["coordinator"];
		/** The root's shared placement, which it records as it ran with it (#4310). */
		readonly workers?: WorkflowExecutionResources["workers"];
	},
): WorkflowExecutionResources {
	const cwd = options.cwd ?? process.cwd();
	const localWorkers = options.localWorkers && {
		...options.localWorkers,
		startupTimeoutMs: undefined,
		leaseMs: undefined,
		heartbeatMs: undefined,
		maxLoadPerCpu: undefined,
		maxWorkerRssBytes: undefined,
		definitions: options.localWorkers.definitions.map((source) => ({ ...source, path: resolve(cwd, source.path) })),
	};
	const admission = options.admission && {
		...options.admission,
		...(options.admission.userDatabase ? { userDatabase: resolve(cwd, options.admission.userDatabase) } : {}),
	};
	const userDatabase =
		admission?.userLimits && admission.userDatabase === undefined ? context.userDatabase() : undefined;
	return JSON.parse(
		JSON.stringify({
			...(localWorkers
				? {
						localWorkers,
						definitions: localWorkers.definitions.map((source) => ({
							...source,
							digest: context.digestOf(source.path),
						})),
					}
				: {}),
			...(admission ? { admission: userDatabase === undefined ? admission : { ...admission, userDatabase } } : {}),
			...(localWorkers && context.coordinator ? { coordinator: context.coordinator } : {}),
			...(context.workers === undefined ? {} : { workers: context.workers }),
		}),
	) as WorkflowExecutionResources;
}

/** The pool database a root in `journal` counts user limits in when they name none: unset for a local SQLite journal. */
export function poolUserDatabase(journal: RunJournal): string | undefined {
	return isLocalPoolJournal(journal) ? undefined : resolve(coordinationPath(poolDurableJournal(journal)));
}

/**
 * The run options with the host's `workflows.localWorkers`, `workflows.workers` and `workflows.admission` settings
 * where the options set none. Only a merge: a run or resume validates the worker settings it takes before it starts.
 */
export function withWorkerSettings(options: RunOpts, settings?: RunJournalSettings): RunOpts {
	const configured = settings?.workflows;
	if (!configured || Array.isArray(configured)) return options;
	return {
		...options,
		localWorkers: options.localWorkers ?? configured.localWorkers,
		workers: options.workers ?? configured.workers,
		admission: options.admission ?? configured.admission,
	};
}

export async function restoreWorkerOptions(backend: DurableWorkflowBackend, options: RunOpts): Promise<RunOpts> {
	const source = options.continuation?.source.id ?? options.runId;
	if (source !== undefined) await backend.hydrateWorkflow(source);
	const original = source === undefined ? undefined : backend.getWorkflow(source);
	const saved = original?.resources;
	if (original && !saved && (options.localWorkers || options.admission || options.workers)) {
		const set = [
			options.localWorkers && "localWorkers",
			options.admission && "admission",
			options.workers && "workers",
		]
			.filter(Boolean)
			.join(" and ");
		// Shared placement is a workers setting: its refusal is typed (#4310).
		if (options.workers)
			throw new WorkerPlacementConfigError(
				"sdk",
				"workers",
				"changed-on-resume",
				`root ${source} started without local workers or resource admission, and this resume sets ${set}`,
			);
		throw new Error(
			`Root ${source} started without local workers or resource admission, and this resume sets ${set}: immutable resource configuration cannot change on an existing root. Resume it without them, or start a new run.`,
		);
	}
	return {
		...options,
		localWorkers: options.localWorkers ?? saved?.localWorkers,
		admission: options.admission ?? saved?.admission,
		workers: options.workers ?? saved?.workers,
		effectiveResources: saved,
	};
}

/**
 * Whether pooled workers on this host can contain the processes their tools start: Linux or macOS, with Atomic's native
 * process identity and this machine's boot identity.
 */
export async function processContainmentAvailable(): Promise<boolean> {
	return (
		(process.platform === "linux" || process.platform === "darwin") &&
		(await hasNativeProcessIdentity()) &&
		Boolean(await admissionBootIdentity())
	);
}

async function hasNativeProcessIdentity(): Promise<boolean> {
	try {
		const native = await import("@bastani/atomic-natives");
		return (
			native.__napiBindingTarget === "native" &&
			typeof native.TaskSupervisor.prototype.taskProcessGroup === "function"
		);
	} catch {
		return false;
	}
}

/**
 * The root's shared placement, checked before anything starts (#4310): its own fields, and that the root pools its
 * children (`localWorkers`) and sets no user limits, which count only on one machine's journal file.
 */
function sharedPlacement(options: RunOpts): WorkflowWorkerPlacementOptions | undefined {
	const workers = options.workers;
	if (workers === undefined) return undefined;
	if (workers.placement !== "shared")
		throw new WorkerPlacementConfigError(
			"sdk",
			"workers.placement",
			"invalid-option",
			'the only placement is "shared"',
		);
	if (workers.workspace !== undefined && !isWorkspace(workers.workspace) && !isWorkspaceBinding(workers.workspace))
		throw new WorkerPlacementConfigError(
			"sdk",
			"workers.workspace",
			"invalid-option",
			"a binding with string remotes, head, tree and envHash, or a workspace({ … }) value",
		);
	if (
		workers.claimWindowMs !== undefined &&
		(!Number.isSafeInteger(workers.claimWindowMs) || workers.claimWindowMs < 1)
	)
		throw new WorkerPlacementConfigError(
			"sdk",
			"workers.claimWindowMs",
			"invalid-option",
			"must be a positive integer of milliseconds",
		);
	if (!options.localWorkers) throw new WorkerPlacementConfigError("sdk", "localWorkers", "requires-local-workers");
	if (options.admission?.userLimits !== undefined)
		throw new WorkerPlacementConfigError(
			"sdk",
			"admission.userLimits",
			"unsupported-option",
			"user limits count only on one machine's journal file",
		);
	return workers;
}

/**
 * `placement` as the root records it (#4310): a `workspace({ … })` value resolved through `resolveWorkspace`, and a
 * binding, or a bound workspace, reduced to its identity fields. `worktree` is the bound worktree on this host, which
 * the root captures when it starts (#4492); a binding alone has none.
 */
export async function recordedPlacement(
	placement: WorkflowWorkerPlacementOptions,
	signal?: AbortSignal,
): Promise<{ readonly placement: RecordedWorkerPlacement; readonly worktree?: string }> {
	const workspace = placement.workspace;
	if (workspace === undefined) return { placement: { ...placement, workspace: undefined } };
	const binding = isWorkspace(workspace)
		? await resolveWorkspace(workspace, signal === undefined ? {} : { signal })
		: workspace;
	return {
		placement: { ...placement, workspace: bindingIdentity(binding) },
		...(isBoundWorkspace(binding) ? { worktree: binding.worktree } : {}),
	};
}

/**
 * How a root's pool runs with shared placement on this host: its local state, host id, claim window and binding, and
 * the binding's `worktree` on this host when it has one.
 */
export function sharedPoolPlacement(
	shared: PoolDurableJournal,
	placement: RecordedWorkerPlacement,
	worktree?: string,
): {
	readonly shared: SharedPoolCoordination;
	readonly workspace?: WorkspaceBinding;
	readonly workspaceWorktree?: string;
} {
	return {
		shared: {
			stateDirectory: poolStateDirectory(shared.agentDir),
			host: poolHostId(shared.agentDir),
			claimWindowMs: placement.claimWindowMs ?? DEFAULT_PLACEMENT_CLAIM_WINDOW_MS,
		},
		...(placement.workspace === undefined ? {} : { workspace: placement.workspace }),
		...(worktree === undefined ? {} : { workspaceWorktree: worktree }),
	};
}

/**
 * The root's journal as shared placement needs it: a SQL journal every host opens through a storage adapter, on a
 * host that can contain its workers' processes. Every missing piece is reported in one typed error, before anything
 * opens.
 */
async function sharedJournal(journal: RunJournal | undefined): Promise<PoolDurableJournal> {
	const problems: SharedPoolSetupProblem[] = [];
	const origin = journal === undefined ? undefined : runJournalOrigin(journal);
	if (journal === undefined || origin?.selection.kind !== "adapter" || sqlPoolStorage(journal) === undefined) {
		const selection = origin?.selection;
		problems.push(
			sharedPoolProblems.sharedJournalRequired(
				journal === undefined
					? "a durable backend without a journal"
					: selection === undefined
						? "a journal object"
						: selection.kind === "adapter"
							? "an adapter journal that is not SQL"
							: `a ${selection.kind} journal`,
				selection === undefined ? undefined : selectionLocation(selection),
			),
		);
	}
	if (!(await processContainmentAvailable())) problems.push(sharedPoolProblems.processContainmentUnavailable());
	const [first, ...rest] = problems;
	if (first !== undefined) throw new SharedPoolSetupError("shared-placement", [first, ...rest]);
	return poolDurableJournal(journal!);
}

export async function activatePublicPool(
	backend: DurableWorkflowBackend,
	options: RunOpts,
): Promise<LocalWorkerPool | undefined> {
	if (!options.localWorkers && !options.admission && !options.workers) return;
	const placement = sharedPlacement(options);
	const admissionSource = options[hostWorkerBindings] ? "settings" : "sdk";
	// User limits count across the runs of one file, and each root of the journal store has a shard of its own. This
	// is refused before the root is placed on a shard, so nothing is written for it.
	if (
		options.admission?.userLimits &&
		backend instanceof JournalDurableBackend &&
		isShardedRunJournal(backend.journal)
	)
		throw new WorkflowAdmissionConfigError({ code: "user-limits-need-one-journal", source: admissionSource });
	// Shared placement needs a journal every host opens; that is checked before anything else starts.
	const shared =
		placement === undefined
			? undefined
			: await sharedJournal(backend instanceof JournalDurableBackend ? backend.journal : undefined);
	if (!(await processContainmentAvailable()))
		throw new SharedPoolSetupError("local-pool", [sharedPoolProblems.localContainmentUnavailable()]);
	if (!(backend instanceof JournalDurableBackend)) throw new Error("Local workers require a journal backend");
	const recorded = placement === undefined ? undefined : await recordedPlacement(placement, options.signal);
	// A journal that is a default-prefix SQLite file is shared with the pool as it is; in the journal store that is the
	// root's own shard, so the pool's processes open only that file. Any other journal, such as a libSQL database or
	// another storage adapter, stays the root's durable record, and the pool keeps its queue, leases, usage, admission
	// and pooled-stage sessions in a SQLite database on this machine. With shared placement (#4310) the pool keeps all
	// of them in the root's journal itself, which every host opens.
	const rootJournal = await rootRunJournal(backend.journal, options.runId!);
	const local = isLocalPoolJournal(rootJournal);
	const journalShard = isShardedRunJournal(backend.journal) ? backend.journal.shardOf(options.runId!)?.id : undefined;
	let durable: PoolDurableJournal | undefined = shared;
	let poolJournal: RunJournal = rootJournal;
	let poolPath = local ? rootJournal.path : "";
	if (shared !== undefined) registerSharedPoolRoot(backend.journal, options.runId!);
	else if (!local) {
		durable = poolDurableJournal(backend.journal);
		poolPath = coordinationPath(durable);
		poolJournal = await openCoordinationJournal(poolPath);
		registerPoolJournal(backend.journal, poolJournal);
	}
	const cwd = options.cwd ?? process.cwd();
	const userDatabase = options.admission?.userDatabase
		? resolve(cwd, options.admission.userDatabase)
		: options.admission?.userDatabase;
	// User limits count across the roots sharing one database; for a journal in another database that is this
	// machine's pool database, whose path is the only `userDatabase` that fits.
	if (
		durable !== undefined &&
		options.admission?.userLimits &&
		userDatabase !== undefined &&
		userDatabase !== resolve(poolPath)
	)
		throw new Error(
			`admission.userDatabase must be omitted, or ${resolve(poolPath)}, for a journal that is not a local SQLite file`,
		);
	const paths = (options.localWorkers?.definitions ?? []).map((source) => resolve(cwd, source.path));
	const digests = new Map(await Promise.all(paths.map(async (path) => [path, await definitionDigest(path)] as const)));
	const resources = workerResources(options, {
		userDatabase: () => (durable === undefined ? undefined : resolve(poolPath)),
		digestOf: (path) => digests.get(path)!,
		coordinator:
			shared !== undefined || durable === undefined || !options.localWorkers
				? undefined
				: { host: poolHostId(durable.agentDir), database: coordinationDatabase(durable) },
		...(recorded === undefined ? {} : { workers: recorded.placement }),
	});
	const localWorkers = resources.localWorkers;
	const saved = options.effectiveResources?.coordinator;
	if (saved !== undefined && resources.coordinator !== undefined && saved.host !== resources.coordinator.host)
		throw new SharedPoolSetupError("resume", [
			sharedPoolProblems.poolOnAnotherHost(saved.host, resources.coordinator.host, options.runId!),
		]);
	// The queue and leases are in the pool database the root started with. A selection that now names another one,
	// because the adapter, its options, its prefix or the agent directory changed, would find it empty and run the
	// root's children again beside whatever the old one still holds.
	if (
		saved !== undefined &&
		resources.coordinator !== undefined &&
		saved.host === resources.coordinator.host &&
		saved.database !== resources.coordinator.database
	)
		throw new Error(
			`This root's local workers keep their work queue and leases in the pool database ${saved.database} on this machine, but the journal is now selected in a way that uses ${resources.coordinator.database}: its adapter, options, prefix or the agent directory changed. Resume the root with the journal selected as it was when the root started.`,
		);
	// An edited entry module is applied only by a resume that accepts it: the root's queued children are then rebound to
	// the edited module, and replaying their recorded steps with it is the author's call (#4200).
	const refused =
		options.effectiveResources === undefined
			? []
			: refusedResourceChanges(options.effectiveResources, resources, options.acceptEntryChanges);
	// A workers setting that cannot change is refused typed, with every other refused change in its detail (#4310).
	const workersChange = refused.find((change) => change.path?.startsWith("workers.") === true);
	if (workersChange !== undefined)
		throw new WorkerPlacementConfigError(
			"sdk",
			workersChange.path!,
			"changed-on-resume",
			refused.map((change) => change.description).join("; "),
		);
	if (refused.length > 0)
		throw new Error(
			`Since root ${options.runId} started, ${refused.map((change) => change.description).join("; ")}. Its recorded steps and queued children depend on these, so restore them to resume it, or start a new run. The pool size (localWorkers.count) and the root's own limits (admission.limits and admission.host) can change between resumes.${
				refused.some((change) => change.entry)
					? ` An edited entry module can also be accepted: resume with /workflow resume ${options.runId} --accept-entry-changes, or acceptEntryChanges: true in the SDK, to replay the recorded steps and run the rest of each unfinished child with the edited module.`
					: ""
			}`,
		);
	// A resume runs with the current pool size, root limits and accepted entry modules, and the root records them.
	options.effectiveResources = resources;
	// The root's own limits are saved for its workers by the root itself, once it holds its lease: see
	// `admitWorkflowSessions`. This check comes before the root is admitted, so it leaves them alone.
	if (resources.admission)
		await SqlResourceAdmission.open(poolJournal, {
			...resources.admission,
			root: options.runId!,
			holder: "preflight",
			rootLimits: "unchanged",
			source: admissionSource,
		});
	if (!localWorkers) return;
	const definitions = await Promise.all(
		(resources.definitions ?? []).map(async (source) => ({
			...source,
			definition: await loadWorkerDefinition(source),
		})),
	);
	const pool = new LocalWorkerPool(backend, {
		rootId: options.runId!,
		journalPath: poolPath,
		...(journalShard === undefined ? {} : { journalShard }),
		...(durable === undefined ? {} : { durable }),
		...(shared === undefined || recorded === undefined
			? {}
			: { ...sharedPoolPlacement(shared, recorded.placement, recorded.worktree), snapshots: options.snapshots }),
		workers: localWorkers.count,
		definitions,
		admission: resources.admission ?? {},
		startupTimeoutMs: options.localWorkers?.startupTimeoutMs,
		leaseMs: options.localWorkers?.leaseMs,
		heartbeatMs: options.localWorkers?.heartbeatMs,
		maxLoadPerCpu: options.localWorkers?.maxLoadPerCpu ?? DEFAULT_POOLED_STAGE_START_MAX_LOAD_PER_CPU,
		...(options.localWorkers?.maxWorkerRssBytes === undefined
			? {}
			: { maxWorkerRssBytes: options.localWorkers.maxWorkerRssBytes }),
		...(options.acceptEntryChanges === true ? { acceptEntryChanges: true } : {}),
		// The host attaches through its own resolver; an SDK caller's registry gets pooled handles.
		...(options.stageControlRegistry === undefined || options[hostWorkerBindings]
			? {}
			: { stageControlRegistry: options.stageControlRegistry }),
	});
	try {
		pool.validateOptions(options);
		return pool;
	} catch (error) {
		await pool.close();
		throw error;
	}
}
