import type { DurableWorkflowCatalogEntries } from "../durable/backend.js";
import { listOpenableCompletedWorkflows } from "../durable/completed-catalog.js";
import {
	type OpenCompletedDurableResult,
	openCompletedDurableWorkflow as openCompletedSnapshot,
} from "../durable/completed-inspection.js";
import { getDurableBackend } from "../durable/factory.js";
import {
	prepareRuntimeDurableResumable,
	prepareTargetedDurableResumable,
	purgeSuppressedWorkflowRuns,
	type ResumeDurableDeps,
	type ResumeDurableResult,
	resumeDurableWorkflow as resumeDurableWorkflowAdapter,
} from "../durable/resume-runtime.js";
import type { ResumableWorkflowEntry } from "../durable/types.js";
import type { JobTracker } from "../runs/background/job-tracker.js";
import type { RunOpts } from "../runs/foreground/executor.js";
import type { StageAdapters } from "../runs/foreground/stage-runner.js";
import type { Store } from "../shared/store.js";
import type { RunSnapshot } from "../shared/store-types.js";
import type { WorkflowExecutionPolicy } from "../shared/types.js";
import type { WorkflowRegistry } from "../workflows/registry.js";
import { discoverWorkflows } from "./discovery.js";

export interface DurableResumeRuntime {
	resumeDurableWorkflow(
		workflowId: string,
		options?: { readonly policy?: WorkflowExecutionPolicy },
	): Promise<ResumeDurableResult>;
	listDurableResumable(): readonly ResumableWorkflowEntry[];
	prepareDurableResumable(workflowId?: string): Promise<readonly ResumableWorkflowEntry[]>;
	prepareDurableCatalog?(): Promise<DurableWorkflowCatalogEntries>;
	/** Hydrate a bounded set of known DBOS workflow ids. */
	prepareDurableResumableForIds?(workflowIds: readonly string[]): Promise<readonly ResumableWorkflowEntry[]>;
	prepareCompletedDurable?(): Promise<readonly ResumableWorkflowEntry[]>;
	openCompletedDurableWorkflow?(
		workflowId: string,
		catalog?: readonly ResumableWorkflowEntry[],
	): OpenCompletedDurableResult;
}

export interface DurableResumeRuntimeDeps {
	readonly registry: WorkflowRegistry;
	readonly store: Store;
	readonly adapters?: StageAdapters;
	readonly runtimeCwd: string;
	readonly ensureReady: () => Promise<void>;
	readonly resolveDefaultStageSessionDir?: () => string | undefined;
	readonly baseRunOpts: (policy?: WorkflowExecutionPolicy) => RunOpts;
	readonly beforeRestoreCompleted?: (snapshots: readonly RunSnapshot[]) => void;
	readonly jobs?: JobTracker;
}

export function createDurableResumeRuntime(deps: DurableResumeRuntimeDeps): DurableResumeRuntime {
	const hydrateStoredWorkflowCandidates = async (
		backend: ReturnType<typeof getDurableBackend>,
		target?: string,
	): Promise<void> => {
		const ids = deps.store
			.runs()
			.map((run) => run.id)
			.filter((id) => target === undefined || id === target);
		for (const id of ids) await backend.hydrateWorkflow(id);
	};
	let preparedCatalog: readonly ResumableWorkflowEntry[] = [];
	return {
		async resumeDurableWorkflow(workflowId, options): Promise<ResumeDurableResult> {
			await deps.ensureReady();
			const backend = getDurableBackend();
			if (preparedCatalog.length === 0) {
				preparedCatalog = await prepareRuntimeDurableResumable(() => backend, workflowId);
			}
			const resolved = resolveCatalogEntry(workflowId, preparedCatalog);
			if (resolved !== undefined) await backend.hydrateWorkflow(resolved.workflowId);
			const adapterDeps: ResumeDurableDeps = {
				registry: deps.registry,
				baseRunOpts: deps.baseRunOpts(options?.policy),
				durableBackend: backend,
				resolveDefinition: async (name, cwd) =>
					(await discoverWorkflows({ cwd: cwd ?? deps.runtimeCwd })).registry.get(name),
				...(deps.jobs !== undefined ? { jobs: deps.jobs } : {}),
			};
			return await resumeDurableWorkflowAdapter(workflowId, adapterDeps, preparedCatalog);
		},
		listDurableResumable(): readonly ResumableWorkflowEntry[] {
			return getDurableBackend().listResumableWorkflows();
		},
		async prepareDurableResumable(workflowId) {
			await deps.ensureReady();
			const backend = getDurableBackend();
			try {
				await hydrateStoredWorkflowCandidates(backend, workflowId);
				preparedCatalog = await prepareRuntimeDurableResumable(() => backend, workflowId);
				return preparedCatalog;
			} finally {
				purgeSuppressedWorkflowRuns(backend, deps.store);
			}
		},
		async prepareDurableCatalog() {
			await deps.ensureReady();
			const backend = getDurableBackend();
			try {
				await backend.hydrateResumableWorkflows();
				await hydrateStoredWorkflowCandidates(backend);
				const catalog = await backend.prepareWorkflowCatalog();
				preparedCatalog = catalog.resumable;
				return catalog;
			} finally {
				purgeSuppressedWorkflowRuns(backend, deps.store);
			}
		},
		async prepareDurableResumableForIds(workflowIds) {
			await deps.ensureReady();
			const backend = getDurableBackend();
			try {
				preparedCatalog = await prepareTargetedDurableResumable(backend, workflowIds);
				return preparedCatalog;
			} finally {
				purgeSuppressedWorkflowRuns(backend, deps.store);
			}
		},
		async prepareCompletedDurable() {
			await deps.ensureReady();
			const backend = getDurableBackend();
			try {
				await backend.hydrateResumableWorkflows();
				await hydrateStoredWorkflowCandidates(backend);
				return listOpenableCompletedWorkflows(backend);
			} finally {
				purgeSuppressedWorkflowRuns(backend, deps.store);
			}
		},
		openCompletedDurableWorkflow(workflowId, catalog) {
			const backend = getDurableBackend();
			const entry = resolveCatalogEntry(workflowId, catalog ?? []);
			const handle = backend.getWorkflow(entry?.workflowId ?? workflowId);
			return openCompletedSnapshot(
				workflowId,
				{
					durableBackend: backend,
					store: deps.store,
					adapters: deps.adapters,
					cwd: handle?.workflowCwd ?? handle?.invocationCwd ?? deps.runtimeCwd,
					defaultSessionDir: deps.resolveDefaultStageSessionDir?.(),
					beforeRestore: deps.beforeRestoreCompleted,
				},
				catalog,
			);
		},
	};
}

function resolveCatalogEntry(
	workflowId: string,
	catalog: readonly ResumableWorkflowEntry[],
): ResumableWorkflowEntry | undefined {
	return catalog.find((entry) => entry.workflowId === workflowId);
}
