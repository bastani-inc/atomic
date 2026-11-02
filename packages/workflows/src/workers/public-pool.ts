import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { DurableWorkflowBackend } from "../durable/backend.js";
import { JournalDurableBackend } from "../durable/journal/journal-backend.js";
import type { RunJournalSettings } from "../durable/journal/resolution.js";
import type { RunJournal } from "../durable/journal/types.js";
import type { RunOpts } from "../runs/foreground/executor-types.js";
import { admissionBootIdentity } from "./admission-host.js";
import { definitionDigest, loadWorkerDefinition } from "./definitions.js";
import { hostWorkerBindings } from "./host-options.js";
import { LocalWorkerPool } from "./local-pool.js";
import {
	coordinationDatabase,
	coordinationPath,
	isLocalPoolJournal,
	openCoordinationJournal,
	type PoolDurableJournal,
	poolDurableJournal,
	poolHostId,
	registerPoolJournal,
} from "./pool-journal.js";
import { DEFAULT_POOLED_STAGE_START_MAX_LOAD_PER_CPU, type WorkflowExecutionResources } from "./public-options.js";
import { SqlResourceAdmission } from "./resource-admission.js";

/**
 * Saved settings a resumed root may run with other values of: they size and pace its pool and bound its own sessions
 * and processes, and no recorded step or queued child depends on them, so a resume runs with the current ones and the
 * root records those (#4196). `startupTimeoutMs`, `leaseMs`, `maxLoadPerCpu` and `maxWorkerRssBytes` are never saved.
 */
const RESUMABLE_SETTINGS: ReadonlySet<string> = new Set([
	"localWorkers.count",
	"admission.limits.session",
	"admission.limits.process",
	"admission.host.maxLoadPerCpu",
	"admission.host.minFreeMemoryBytes",
]);

function shown(value: unknown): string {
	return value === undefined ? "unset" : JSON.stringify(value);
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ResourceChange {
	readonly description: string;
	readonly resumable: boolean;
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
		description: `${path} changed from ${shown(saved)} to ${shown(current)}`,
		resumable: RESUMABLE_SETTINGS.has(path),
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
			changes.push({ description: `worker definition ${name} is no longer listed`, resumable: false });
		else if (now !== digest)
			changes.push({
				description: `the entry module of worker definition ${name} was edited (sha256 ${digest.slice(0, 12)} to ${now.slice(0, 12)})`,
				resumable: false,
				entry: true,
			});
	}
	for (const name of after.keys())
		if (!before.has(name)) changes.push({ description: `worker definition ${name} was added`, resumable: false });
	settingChanges("admission", saved.admission, current.admission, changes);
	settingChanges("coordinator", saved.coordinator, current.coordinator, changes);
	return changes;
}

export function withWorkerSettings(options: RunOpts, settings?: RunJournalSettings): RunOpts {
	const configured = settings?.workflows;
	if (!configured || Array.isArray(configured)) return options;
	return {
		...options,
		localWorkers: options.localWorkers ?? configured.localWorkers,
		admission: options.admission ?? configured.admission,
	};
}

export async function restoreWorkerOptions(backend: DurableWorkflowBackend, options: RunOpts): Promise<RunOpts> {
	const source = options.continuation?.source.id ?? options.runId;
	if (source !== undefined) await backend.hydrateWorkflow(source);
	const original = source === undefined ? undefined : backend.getWorkflow(source);
	const saved = original?.resources;
	if (original && !saved && (options.localWorkers || options.admission)) {
		const set = [options.localWorkers && "localWorkers", options.admission && "admission"]
			.filter(Boolean)
			.join(" and ");
		throw new Error(
			`Root ${source} started without local workers or resource admission, and this resume sets ${set}: immutable resource configuration cannot change on an existing root. Resume it without them, or start a new run.`,
		);
	}
	return {
		...options,
		localWorkers: options.localWorkers ?? saved?.localWorkers,
		admission: options.admission ?? saved?.admission,
		effectiveResources: saved,
	};
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

export async function activatePublicPool(
	backend: DurableWorkflowBackend,
	options: RunOpts,
): Promise<LocalWorkerPool | undefined> {
	if (!options.localWorkers && !options.admission) return;
	if (process.platform === "win32")
		throw new Error("Local worker containment is unavailable on Windows; pooled tool processes cannot be enabled");
	if (
		(process.platform !== "linux" && process.platform !== "darwin") ||
		!(await hasNativeProcessIdentity()) ||
		!(await admissionBootIdentity())
	)
		throw new Error("Local worker containment requires native process identity support");
	if (!(backend instanceof JournalDurableBackend)) throw new Error("Local workers require a journal backend");
	// A journal that is a default-prefix SQLite file is shared with the pool as it is. Any other journal, such as a
	// libSQL database or another storage adapter, stays the root's durable record, and the pool keeps its queue,
	// leases, usage, admission and pooled-stage sessions in a SQLite database on this machine.
	const local = isLocalPoolJournal(backend.journal);
	let durable: PoolDurableJournal | undefined;
	let poolJournal: RunJournal = backend.journal;
	let poolPath = local ? backend.journal.path : "";
	if (!local) {
		durable = poolDurableJournal(backend.journal);
		poolPath = coordinationPath(durable);
		poolJournal = await openCoordinationJournal(poolPath);
		registerPoolJournal(backend.journal, poolJournal);
	}
	const cwd = options.cwd ?? process.cwd();
	const localWorkers = options.localWorkers && {
		...options.localWorkers,
		startupTimeoutMs: undefined,
		leaseMs: undefined,
		maxLoadPerCpu: undefined,
		maxWorkerRssBytes: undefined,
		definitions: options.localWorkers.definitions.map((source) => ({ ...source, path: resolve(cwd, source.path) })),
	};
	const admission = options.admission && {
		...options.admission,
		...(options.admission.userDatabase ? { userDatabase: resolve(cwd, options.admission.userDatabase) } : {}),
	};
	if (durable !== undefined && admission?.userLimits) {
		// User limits count across the roots sharing one database; for a journal in another database that is this
		// machine's pool database, whose path is the only `userDatabase` that fits.
		if (admission.userDatabase !== undefined && admission.userDatabase !== resolve(poolPath))
			throw new Error(
				`admission.userDatabase must be omitted, or ${resolve(poolPath)}, for a journal that is not a local SQLite file`,
			);
		(admission as { userDatabase?: string }).userDatabase = resolve(poolPath);
	}
	const sources =
		localWorkers &&
		(await Promise.all(
			localWorkers.definitions.map(async (source) => ({ ...source, digest: await definitionDigest(source.path) })),
		));
	const resources = JSON.parse(
		JSON.stringify({
			...(localWorkers ? { localWorkers, definitions: sources } : {}),
			...(admission ? { admission } : {}),
			...(durable !== undefined && localWorkers
				? { coordinator: { host: poolHostId(durable.agentDir), database: coordinationDatabase(durable) } }
				: {}),
		}),
	) as WorkflowExecutionResources;
	const saved = options.effectiveResources?.coordinator;
	if (saved !== undefined && resources.coordinator !== undefined && saved.host !== resources.coordinator.host)
		throw new Error(
			`This root's local workers ran on another machine (${saved.host}). Their work queue and leases are in that machine's pool database, which this machine cannot see, and its workers may still be running children. Resume the root on that machine.`,
		);
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
			: resourceChanges(options.effectiveResources, resources).filter(
					(change) => !change.resumable && !(change.entry && options.acceptEntryChanges === true),
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
		});
	if (!localWorkers) return;
	const definitions = await Promise.all(
		(sources ?? []).map(async (source) => ({ ...source, definition: await loadWorkerDefinition(source) })),
	);
	const pool = new LocalWorkerPool(backend, {
		rootId: options.runId!,
		journalPath: poolPath,
		...(durable === undefined ? {} : { durable }),
		workers: localWorkers.count,
		definitions,
		admission: resources.admission ?? {},
		startupTimeoutMs: options.localWorkers?.startupTimeoutMs,
		leaseMs: options.localWorkers?.leaseMs,
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
