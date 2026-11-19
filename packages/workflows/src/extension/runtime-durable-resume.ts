import { getAgentDir, hasTrustRequiringProjectResourcesAsync, ProjectTrustStore } from "@bastani/atomic";
import type { CatalogReadOptions, DurableWorkflowBackend, DurableWorkflowCatalogEntries } from "../durable/backend.js";
import { listOpenableCompletedWorkflows } from "../durable/completed-catalog.js";
import {
	type OpenCompletedDurableResult,
	openCompletedDurableWorkflow as openCompletedSnapshot,
} from "../durable/completed-inspection.js";
import { type ForkConfigSource, type ForkError, isForkError } from "../durable/fork-errors.js";
import { type ForkCarryMessages, forkDurableRun } from "../durable/fork-run.js";
import { WorkflowProjectNotTrustedError } from "../durable/project-trust.js";
import {
	prepareRuntimeDurableResumable,
	prepareTargetedDurableResumable,
	purgeSuppressedWorkflowRuns,
	type ResumeDurableDeps,
	type ResumeDurableResult,
	resumeDurableWorkflow as resumeDurableWorkflowAdapter,
	selectedResumeEntry,
} from "../durable/resume-runtime.js";
import { hasActiveLiveRun } from "../durable/run-claims.js";
import { availableRunDurableBackend, durableRootRunIdForRun } from "../durable/run-owner-backend.js";
import { canonicalDirectoryAsync } from "../durable/sdk-recovery-scope.js";
import { bindStoreDurableBackend, DurableBackendNotInitializedError } from "../durable/store-backend.js";
import { inspectTargetedDurableWorkflow, type TargetedDurableInspection } from "../durable/targeted-inspection.js";
import type { DurableWorkflowHandle, ResumableWorkflowEntry, WorkflowForkedFrom } from "../durable/types.js";
import type { ToolControlRegistry } from "../engine/run-tool-control-registry.js";
import { currentJobTracker, type JobTracker } from "../runs/background/job-tracker.js";
import type { RunOpts } from "../runs/foreground/executor.js";
import type { StageControlRegistry } from "../runs/foreground/stage-control-registry.js";
import type { StageAdapters } from "../runs/foreground/stage-runner.js";
import type { WorkflowBudget } from "../shared/budget.js";
import { isFullRunId, resolveRunIdTarget } from "../shared/run-id.js";
import type { StageUiBroker } from "../shared/stage-ui-broker.js";
import type { Store } from "../shared/store.js";
import { workflowObservationRuntime } from "../shared/store-factory.js";
import type { RunSnapshot, WorkflowActor } from "../shared/store-types.js";
import type { WorkflowDefinition, WorkflowExecutionPolicy, WorkflowInputValues } from "../shared/types.js";
import type { WorkflowRegistry } from "../workflows/registry.js";
import { discoverWorkflows } from "./discovery.js";
import { withWorkflowResumeAdmission } from "./dormant-run-gate.js";
import { resumeFailureCode, type WorkflowControlFailureCode } from "./workflow-control-failure.js";
import { raceWorkflowRequestAbort } from "./workflow-request-abort.js";

/** Outcome of forking a durable run from this session and resuming the fork. */
export type ForkDurableWorkflowResult =
	| {
			readonly ok: true;
			readonly runId: string;
			readonly forkedFrom: WorkflowForkedFrom;
			/** False when the fork was created but did not start; `startFailure` then says why. */
			readonly started: boolean;
			/** Why a created fork did not start, as the code of a failed resume. */
			readonly startFailure?: WorkflowControlFailureCode;
			readonly message: string;
	  }
	| { readonly ok: false; readonly error: ForkError; readonly message: string; readonly runId?: string };

export interface ForkDurableWorkflowOptions {
	readonly source: ForkConfigSource;
	readonly fromStage?: string;
	readonly expectedStageId?: string;
	readonly inputs?: WorkflowInputValues;
	readonly carryMessages?: ForkCarryMessages;
	readonly policy?: WorkflowExecutionPolicy;
	readonly actor?: WorkflowActor;
	readonly modelOwner?: string;
	readonly signal?: AbortSignal;
	readonly onRunAccepted?: (runId: string) => void;
	readonly validateSource?: (handle: DurableWorkflowHandle) => void;
	/** Asks whether to trust the untrusted project folder the source run's workflow is defined in. */
	readonly confirmProjectTrust?: (projectDir: string) => Promise<boolean>;
}

export interface DurableResumeRuntime {
	durableBackend(): DurableWorkflowBackend;
	/**
	 * Fork a durable run into this session's directory with `forkRun` semantics and resume the fork in
	 * the background. A fork failure is reported as its typed `ForkError`; the source run is never written.
	 */
	forkDurableWorkflow(sourceRunId: string, options: ForkDurableWorkflowOptions): Promise<ForkDurableWorkflowResult>;
	resumeDurableWorkflow(
		workflowId: string,
		options?: {
			readonly policy?: WorkflowExecutionPolicy;
			readonly actor?: WorkflowActor;
			readonly modelOwner?: string;
			readonly budget?: WorkflowBudget;
			readonly signal?: AbortSignal;
			readonly onRunAccepted?: (runId: string) => void;
			readonly onBeforeResume?: (runId: string, forkedFrom?: string) => Promise<void>;
			readonly confirmCrossProjectFork?: (cwd: string) => Promise<boolean>;
			/** Asks whether to trust the untrusted project folder the run's workflow is defined in. */
			readonly confirmProjectTrust?: (projectDir: string) => Promise<boolean>;
			readonly forkModelOwner?: string;
			/** Resume a root whose worker entry modules were edited: see `RunOpts.acceptEntryChanges` (#4200). */
			readonly acceptEntryChanges?: boolean;
			/** Run this definition instead of resolving the run's name: a fork's, found where its source ran. */
			readonly definition?: WorkflowDefinition;
			readonly durableBackend?: DurableWorkflowBackend;
			/** The attempt selected before the caller loaded its workflow resources. */
			readonly selectedEntry?: ResumableWorkflowEntry;
			readonly expectedUpdatedAt?: number;
		},
	): Promise<ResumeDurableResult>;
	inspectDurableWorkflow(workflowId: string): Promise<TargetedDurableInspection>;
	listDurableResumable(): readonly ResumableWorkflowEntry[];
	prepareDurableResumable(workflowId?: string): Promise<readonly ResumableWorkflowEntry[]>;
	/** The stored resumable and completed runs; a caller whose `signal` aborts stops the read once nobody else waits. */
	prepareDurableCatalog?(options?: CatalogReadOptions): Promise<DurableWorkflowCatalogEntries>;
	/** Refresh a bounded set of known workflow ids. */
	prepareDurableResumableForIds?(workflowIds: readonly string[]): Promise<readonly ResumableWorkflowEntry[]>;
	prepareCompletedDurable?(): Promise<readonly ResumableWorkflowEntry[]>;
	openCompletedDurableWorkflow?(
		workflowId: string,
		catalog?: readonly ResumableWorkflowEntry[],
	): Promise<OpenCompletedDurableResult>;
}

export interface DurableResumeRuntimeDeps {
	readonly registry: WorkflowRegistry;
	readonly store: Store;
	readonly stageControlRegistry?: StageControlRegistry;
	readonly stageUiBroker?: StageUiBroker;
	readonly toolControlRegistry?: ToolControlRegistry;
	readonly adapters?: StageAdapters;
	readonly runtimeCwd: string;
	readonly ensureReady: () => Promise<DurableWorkflowBackend>;
	readonly backendRef?: { current: DurableWorkflowBackend | undefined };
	readonly resolveDefaultStageSessionDir?: () => string | undefined;
	readonly baseRunOpts: (policy?: WorkflowExecutionPolicy) => RunOpts;
	readonly beforeRestoreCompleted?: (snapshots: readonly RunSnapshot[]) => void;
	readonly jobs?: JobTracker;
	/** Reports a warning once; each shard of the journal store that cannot be opened is reported through it. */
	readonly reportWarning?: (message: string) => void;
	readonly getWorkflowHostModules?: import("./workflow-module-loader.js").WorkflowHostModuleProvider;
	/** The project trust decision; an untrusted project's workflow modules are not discovered. */
	readonly isProjectTrusted?: () => boolean;
}

export function createDurableResumeRuntime(deps: DurableResumeRuntimeDeps): DurableResumeRuntime {
	const backendRef = deps.backendRef ?? { current: undefined };
	const selectedBackend = (workflowId?: string): DurableWorkflowBackend => {
		const backend = workflowId === undefined ? undefined : availableRunDurableBackend(deps.store, workflowId);
		if (backend !== undefined) return backend;
		if (backendRef.current === undefined) throw new DurableBackendNotInitializedError();
		return backendRef.current;
	};
	const withRecovery = async <T>(operation: () => Promise<T>): Promise<T> => {
		const finish = workflowObservationRuntime(deps.store).beginRecovery();
		try {
			return await operation();
		} finally {
			finish();
		}
	};
	const ensureReady = async (): Promise<DurableWorkflowBackend> => {
		const backend = await deps.ensureReady();
		backendRef.current = backend;
		bindStoreDurableBackend(deps.store, backend);
		return backend;
	};
	const hydrateStoredWorkflowCandidates = async (
		backend: DurableWorkflowBackend,
		target?: string,
		known?: ReadonlySet<string>,
	): Promise<void> => {
		// Nested runs live in the root's journal row. Hydrating their IDs would mark a healthy child as deleted.
		const roots = new Set<string>();
		for (const run of deps.store.runs()) {
			if (target === undefined || run.id === target) roots.add(durableRootRunIdForRun(deps.store, run.id) ?? run.id);
		}
		for (const id of roots) {
			const owner = availableRunDurableBackend(deps.store, id) ?? backend;
			if (owner !== backend || !known?.has(id)) await owner.hydrateWorkflow(id, { checkHeader: true });
		}
	};
	let preparedCatalog: readonly ResumableWorkflowEntry[] = [];
	const discover = async (name: string, cwd: string, projectTrusted: boolean | undefined) =>
		(
			await discoverWorkflows({ cwd, getWorkflowHostModules: deps.getWorkflowHostModules, projectTrusted })
		).registry.get(name);
	/**
	 * This session decides for its own project. Another project's workflows load only once that project is trusted:
	 * by its saved decision, or by the answer to `confirmProjectTrust`. A workflow that is not found without them in a
	 * project that has project resources is refused with how to trust that project.
	 */
	const discoverDefinition = async (
		name: string,
		cwd: string | undefined,
		confirmProjectTrust: ((projectDir: string) => Promise<boolean>) | undefined,
	) => {
		const discoveryCwd = cwd ?? deps.runtimeCwd;
		if ((await canonicalDirectoryAsync(discoveryCwd)) === (await canonicalDirectoryAsync(deps.runtimeCwd)))
			return discover(name, discoveryCwd, deps.isProjectTrusted?.());
		if ((await new ProjectTrustStore(getAgentDir()).getAsync(discoveryCwd)) === true)
			return discover(name, discoveryCwd, true);
		const outsideProject = await discover(name, discoveryCwd, false);
		if (outsideProject !== undefined || !(await hasTrustRequiringProjectResourcesAsync(discoveryCwd)))
			return outsideProject;
		if (await confirmProjectTrust?.(discoveryCwd)) return discover(name, discoveryCwd, true);
		throw new WorkflowProjectNotTrustedError(name, discoveryCwd);
	};
	const definitionResolver =
		(confirmProjectTrust: ((projectDir: string) => Promise<boolean>) | undefined) =>
		async (name: string, cwd: string | undefined) =>
			deps.registry.get(name) ?? (await discoverDefinition(name, cwd, confirmProjectTrust));
	const runtime: DurableResumeRuntime = {
		durableBackend: selectedBackend,
		async forkDurableWorkflow(sourceRunId, options) {
			options.signal?.throwIfAborted();
			const backend = await withRecovery(
				async () => availableRunDurableBackend(deps.store, sourceRunId) ?? (await ensureReady()),
			);
			let fork: Awaited<ReturnType<typeof forkDurableRun>>;
			try {
				fork = await forkDurableRun(backend, {
					source: options.source,
					runId: sourceRunId,
					cwd: deps.runtimeCwd,
					carryMessages: options.carryMessages ?? "before",
					fromStage: options.fromStage,
					...(options.expectedStageId === undefined ? {} : { expectedStageId: options.expectedStageId }),
					inputs: options.inputs,
					resolveDefinition: definitionResolver(options.confirmProjectTrust),
					sessionStore: deps.adapters?.sessionStore,
					modelOwner: options.modelOwner,
					signal: options.signal,
					validateSource: options.validateSource,
					isLiveRun: (runId) => hasActiveLiveRun(deps.store, runId),
					rootRunOf: (runId) => deps.store.run(runId)?.rootRunId,
				});
			} catch (error) {
				if (!isForkError(error)) throw error;
				return { ok: false, error, message: error.message };
			}
			const resumed = await runtime.resumeDurableWorkflow(fork.runId, {
				policy: options.policy,
				actor: options.actor,
				modelOwner: options.modelOwner,
				signal: options.signal,
				onRunAccepted: options.onRunAccepted,
				definition: fork.definition,
				durableBackend: backend,
			});
			const from = `${fork.forkedFrom.runId}${fork.forkedFrom.stagePath === undefined ? "" : ` from stage "${fork.forkedFrom.stagePath}"`}`;
			if (!resumed.ok) {
				const next =
					(await definitionResolver(undefined)(fork.definition.name, deps.runtimeCwd)) === undefined
						? `Workflow "${fork.definition.name}" is not defined in this directory, so /resume cannot start the fork here; fork the source again from /workflows ${fork.forkedFrom.runId}.`
						: `Resume it with /resume ${fork.runId}.`;
				return {
					ok: true,
					runId: fork.runId,
					forkedFrom: fork.forkedFrom,
					started: false,
					startFailure: resumeFailureCode(resumed.reason),
					message: `Forked workflow ${from} into ${fork.runId}; it did not start: ${resumed.message} ${next}`,
				};
			}
			return {
				ok: true,
				runId: fork.runId,
				forkedFrom: fork.forkedFrom,
				started: true,
				message: `Forked workflow ${from} into ${fork.runId}. ${resumed.message}`,
			};
		},
		async inspectDurableWorkflow(workflowId) {
			return withRecovery(async () => {
				const backend = availableRunDurableBackend(deps.store, workflowId) ?? (await ensureReady());
				return inspectTargetedDurableWorkflow(backend, workflowId);
			});
		},
		async resumeDurableWorkflow(workflowId, options): Promise<ResumeDurableResult> {
			options?.signal?.throwIfAborted();
			const jobs = deps.jobs ?? currentJobTracker();
			const selected = selectedResumeEntry(
				workflowId,
				options?.selectedEntry === undefined ? preparedCatalog : [options.selectedEntry],
				deps.store,
				jobs,
			);
			return raceWorkflowRequestAbort(
				withWorkflowResumeAdmission(deps.store, async (dormantWrites) => {
					const { backend, catalog } = await withRecovery(async () => {
						const backend =
							options?.durableBackend ??
							availableRunDurableBackend(deps.store, workflowId) ??
							(await ensureReady());
						options?.signal?.throwIfAborted();
						// A message queued for an interrupted run before resume changed its journal, so a
						// catalog read before that write would make the resume claim stale (#3760).
						let catalog: readonly ResumableWorkflowEntry[] | undefined =
							dormantWrites.size === 0 && selected !== undefined ? [selected] : undefined;
						if (isFullRunId(workflowId) && backend.getWorkflow(workflowId) !== undefined) {
							if (catalog !== undefined) await backend.hydrateWorkflow(workflowId, { checkHeader: true });
							else catalog = await prepareTargetedDurableResumable(backend, [workflowId]);
						}
						options?.signal?.throwIfAborted();
						return { backend, catalog: catalog ?? [] };
					});
					const adapterDeps: ResumeDurableDeps = {
						registry: deps.registry,
						expectedUpdatedAt: options?.expectedUpdatedAt,
						signal: options?.signal,
						onRunAccepted: options?.onRunAccepted,
						onBeforeResume: options?.onBeforeResume,
						confirmCrossProjectFork: options?.confirmCrossProjectFork,
						forkModelOwner: options?.forkModelOwner,
						baseRunOpts: {
							...deps.baseRunOpts(options?.policy),
							...(options?.budget === undefined ? {} : { budget: options.budget }),
							...(options?.actor === undefined ? {} : { resumeActor: options.actor }),
							...(options?.modelOwner === undefined ? {} : { modelOwner: options.modelOwner }),
							...(options?.acceptEntryChanges === true ? { acceptEntryChanges: true } : {}),
						},
						durableBackend: backend,
						resolveDefinition:
							options?.definition === undefined
								? (name, cwd) => discoverDefinition(name, cwd, options?.confirmProjectTrust)
								: async () => options.definition,
						jobs,
					};
					return await resumeDurableWorkflowAdapter(workflowId, adapterDeps, catalog);
				}),
				options?.signal,
			);
		},
		listDurableResumable(): readonly ResumableWorkflowEntry[] {
			return selectedBackend().listResumableWorkflows();
		},
		async prepareDurableResumable(workflowId) {
			return withRecovery(async () => {
				const backend =
					(workflowId === undefined ? undefined : availableRunDurableBackend(deps.store, workflowId)) ??
					(await ensureReady());
				try {
					await hydrateStoredWorkflowCandidates(backend, workflowId);
					preparedCatalog = await prepareRuntimeDurableResumable(() => backend, workflowId);
					return preparedCatalog;
				} finally {
					purgeSuppressedWorkflowRuns(backend, deps.store, deps.toolControlRegistry);
				}
			});
		},
		async prepareDurableCatalog(options) {
			return withRecovery(async () => {
				const backend = await ensureReady();
				try {
					const catalog = await backend.prepareWorkflowCatalog(options);
					for (const unavailable of catalog.unavailableShards ?? [])
						deps.reportWarning?.(`${unavailable.message} ${unavailable.hint}`);
					const known = new Set(
						catalog.inspectableIds ??
							[...catalog.resumable, ...catalog.completed].map((entry) => entry.workflowId),
					);
					await hydrateStoredWorkflowCandidates(backend, undefined, known);
					preparedCatalog = catalog.resumable;
					return catalog;
				} finally {
					purgeSuppressedWorkflowRuns(backend, deps.store, deps.toolControlRegistry);
				}
			});
		},
		async prepareDurableResumableForIds(workflowIds) {
			return withRecovery(async () => {
				const backend = await ensureReady();
				try {
					preparedCatalog = (
						await Promise.all(
							workflowIds.map((id) =>
								prepareTargetedDurableResumable(availableRunDurableBackend(deps.store, id) ?? backend, [id]),
							),
						)
					).flat();
					return preparedCatalog;
				} finally {
					purgeSuppressedWorkflowRuns(backend, deps.store, deps.toolControlRegistry);
				}
			});
		},
		async prepareCompletedDurable() {
			return withRecovery(async () => {
				const backend = await ensureReady();
				try {
					await backend.hydrateResumableWorkflows();
					await hydrateStoredWorkflowCandidates(backend);
					// The catalog lists a run from its latest snapshot; checking that it opens reads its checkpoints (#3892).
					for (const entry of backend.listCompletedWorkflows())
						await backend.hydrateWorkflow(entry.workflowId, { checkHeader: true });
					return await listOpenableCompletedWorkflows(backend, deps.adapters?.sessionStore);
				} finally {
					purgeSuppressedWorkflowRuns(backend, deps.store, deps.toolControlRegistry);
				}
			});
		},
		async openCompletedDurableWorkflow(workflowId, catalog) {
			const finish = workflowObservationRuntime(deps.store).beginRecovery();
			try {
				const backend = selectedBackend(workflowId);
				const entry = resolveCatalogEntry(workflowId, catalog ?? backend.listCompletedWorkflows());
				const id = entry?.workflowId ?? workflowId;
				// The catalog lists a run from its latest snapshot; opening it reads its checkpoints (#3892).
				if (entry !== undefined || isFullRunId(workflowId))
					await backend.hydrateWorkflow(id, { checkHeader: true });
				const handle = backend.getWorkflow(id);
				return await openCompletedSnapshot(
					workflowId,
					{
						durableBackend: backend,
						store: deps.store,
						stageControlRegistry: deps.stageControlRegistry,
						stageUiBroker: deps.stageUiBroker,
						adapters: deps.adapters,
						sessionStore: deps.adapters?.sessionStore,
						cwd: handle?.workflowCwd ?? handle?.invocationCwd ?? deps.runtimeCwd,
						defaultSessionDir: deps.resolveDefaultStageSessionDir?.(),
						beforeRestore: deps.beforeRestoreCompleted,
					},
					catalog,
				);
			} finally {
				finish();
			}
		},
	};
	return runtime;
}

function resolveCatalogEntry(
	workflowId: string,
	catalog: readonly ResumableWorkflowEntry[],
): ResumableWorkflowEntry | undefined {
	const resolution = resolveRunIdTarget(
		workflowId,
		catalog.map((entry) => entry.workflowId),
	);
	if (resolution.kind !== "exact" && resolution.kind !== "unique_prefix") return undefined;
	return catalog.find((entry) => entry.workflowId === resolution.runId);
}
