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
import type { WorkflowExecutionResources } from "./public-options.js";
import { SqlResourceAdmission } from "./resource-admission.js";

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
	if (original && !saved && (options.localWorkers || options.admission))
		throw new Error("Immutable resource configuration cannot change on an existing root");
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
	if (options.effectiveResources && !isDeepStrictEqual(options.effectiveResources, resources))
		throw new Error("Worker definition compatibility or immutable resource configuration changed");
	options.effectiveResources = resources;
	if (resources.admission)
		await SqlResourceAdmission.open(poolJournal, {
			...resources.admission,
			root: options.runId!,
			holder: "preflight",
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
