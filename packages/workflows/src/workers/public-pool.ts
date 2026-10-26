import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { DurableWorkflowBackend } from "../durable/backend.js";
import { sqlPoolStorage } from "../durable/journal/internal.js";
import { JournalDurableBackend } from "../durable/journal/journal-backend.js";
import type { RunJournalSettings } from "../durable/journal/resolution.js";
import { SqlRunJournal } from "../durable/journal/sql-run-journal.js";
import type { RunOpts } from "../runs/foreground/executor-types.js";
import { admissionBootIdentity } from "./admission-host.js";
import { definitionDigest, loadWorkerDefinition } from "./definitions.js";
import { hostWorkerBindings } from "./host-options.js";
import { LocalWorkerPool } from "./local-pool.js";
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
	if (
		!(backend instanceof JournalDurableBackend) ||
		!(backend.journal instanceof SqlRunJournal) ||
		backend.journal.path === ":memory:" ||
		sqlPoolStorage(backend.journal)?.tables.runs !== "wf_runs"
	)
		throw new Error("Local workers require a default-prefix local SQLite journal");
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
	const sources =
		localWorkers &&
		(await Promise.all(
			localWorkers.definitions.map(async (source) => ({ ...source, digest: await definitionDigest(source.path) })),
		));
	const resources = JSON.parse(
		JSON.stringify({
			...(localWorkers ? { localWorkers, definitions: sources } : {}),
			...(admission ? { admission } : {}),
		}),
	) as WorkflowExecutionResources;
	if (options.effectiveResources && !isDeepStrictEqual(options.effectiveResources, resources))
		throw new Error("Worker definition compatibility or immutable resource configuration changed");
	options.effectiveResources = resources;
	if (resources.admission)
		await SqlResourceAdmission.open(backend.journal, {
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
		journalPath: backend.journal.path,
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
