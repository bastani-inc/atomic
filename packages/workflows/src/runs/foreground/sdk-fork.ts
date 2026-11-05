/**
 * SDK entry points for run time travel (#4321): `forkRun` forks a durable run from a stage into a new
 * run and executes it; `listForkPoints` lists the stages a run can be forked from.
 */
import { resolve } from "node:path";
import type { AgentSessionEvent, SessionStore } from "@bastani/atomic";
import type { DurableWorkflowBackend } from "../../durable/backend.js";
import { initializeDurableBackend } from "../../durable/factory.js";
import { ForkConfigError, type ForkConfigField, type ForkConfigIssue } from "../../durable/fork-errors.js";
import type { ForkCarryMessages, ForkPoint } from "../../durable/fork-run.js";
import { durableForkPoints, forkDurableRun, validateForkOptions } from "../../durable/fork-run.js";
import { JournalDurableBackend } from "../../durable/journal/journal-backend.js";
import type { RunJournalOption } from "../../durable/journal/resolution.js";
import { hasActiveLiveRun } from "../../durable/run-claims.js";
import { availableRunDurableBackend } from "../../durable/run-owner-backend.js";
import { availableStoreDurableBackendOverride } from "../../durable/store-backend.js";
import type { DurableWorkflowHandle, WorkflowForkedFrom } from "../../durable/types.js";
import type { Store } from "../../shared/store.js";
import { store as defaultStore } from "../../shared/store.js";
import { currentWorkflowStore } from "../../shared/store-factory.js";
import type { StageSnapshot } from "../../shared/store-types.js";
import type { WorkflowDefinition, WorkflowInputValues, WorkflowOutputValues } from "../../shared/types.js";
import { hostWorkerBindings, PROCESS_BOUND_RUN_OPTIONS } from "../../workers/host-options.js";
import { poolUserDatabase, refusedResourceChanges, workerResources } from "../../workers/public-pool.js";
import { resolveWorkerTiming } from "../../workers/worker-timing.js";
import type { RunOpts, RunResult } from "./executor-types.js";
import { runEventChannel, type WorkflowRunEvent } from "./run-event-channel.js";
import { run } from "./sdk-run.js";

export type { ForkCarryMessages, ForkPoint } from "../../durable/fork-run.js";
export type { WorkflowRunEvent } from "./run-event-channel.js";

export interface ForkRunOptions<TDefinition = WorkflowDefinition>
	extends Omit<RunOpts, "runId" | "continuation" | "parentRun" | "cwd"> {
	/** Dot path of the stage to re-run from (see `listForkPoints`). Omitted: the fork copies the whole run. */
	readonly fromStage?: string;
	/** Replacement inputs, validated against the definition. Omitted: the source run's inputs. */
	readonly inputs?: WorkflowInputValues;
	/** Directory the fork runs in. Omitted: the source run's directory. */
	readonly cwd?: string;
	/** Intercom messages and prompt answers to carry: those before the fork point (default) or all. */
	readonly carryMessages?: ForkCarryMessages;
	/** The workflow definition. Omitted: the registry option, then the workflows discovered for the source's directory. */
	readonly definition?: TDefinition;
	/** Session store holding the source run's stage sessions. Omitted: the source project's store. */
	readonly sourceSessionStore?: SessionStore;
}

/**
 * A forked run. `events` yields the run's notifications once, in order: lifecycle events are kept until it is
 * iterated, agent-session events only while it is. `result` settles when the run ends.
 */
export interface ForkedRun {
	readonly runId: string;
	readonly forkedFrom: WorkflowForkedFrom;
	readonly events: AsyncIterable<WorkflowRunEvent>;
	readonly result: Promise<RunResult>;
}

export interface ListForkPointsOptions {
	readonly journal?: RunJournalOption;
	readonly durableBackend?: DurableWorkflowBackend;
	readonly store?: Store;
	readonly cwd?: string;
	/** Session store holding the run's stage sessions, read for each point's `entryId`. Omitted: the run's project store. */
	readonly sourceSessionStore?: SessionStore;
}

/**
 * What `localWorkers` or `admission` must be for a source that saved neither: a fork keeps its source's worker
 * resources, and `run()` refuses to add them to an existing root.
 */
const SOURCE_WITHOUT_WORKER_RESOURCES =
	"omitted, because the source run started without local workers or resource admission and a fork keeps its source's worker resources; start a new run with run() to use them";

/**
 * Refuses `localWorkers` or `admission` for a source that saved no worker resources, before anything is copied.
 * `run()` would otherwise refuse them on the fork it just wrote (`restoreWorkerOptions`), leaving a fork that never starts.
 */
function refuseAddedWorkerResources(options: ForkRunOptions, saved: DurableWorkflowHandle["resources"]): void {
	if (saved) return;
	const added: ForkConfigField[] = [];
	if (options.localWorkers) added.push("localWorkers");
	if (options.admission) added.push("admission");
	const [first, ...rest] = added.map((field) => ({ field, expected: SOURCE_WITHOUT_WORKER_RESOURCES }));
	if (first !== undefined) throw new ForkConfigError({ source: "sdk", issues: [first, ...rest] });
}

/** What `localWorkers` or `admission` must be for a source that saved worker resources: what its resume accepts. */
const SAVED_WORKER_RESOURCES =
	"the source run's saved setting, or one changing only localWorkers.count, admission.limits or admission.host, because a fork resumes its source's worker resources";

/** What `admission` must be when user limits name no database and worker processes cannot reopen the journal. */
const USER_DATABASE_UNAVAILABLE =
	"settings for a fork whose journal is selected with workflows.journal, --storage or ATOMIC_WORKFLOWS_JOURNAL, as its source run's was, because user limits count in a pool database worker processes open by that selection";

/** The pool database user limits count in; a plain configuration failure finding it is a `ForkConfigError`. */
function forkUserDatabase(backend: DurableWorkflowBackend): string | undefined {
	if (!(backend instanceof JournalDurableBackend)) return undefined;
	try {
		return poolUserDatabase(backend.journal);
	} catch (error) {
		if (!(error instanceof Error) || error.constructor !== Error) throw error;
		throw new ForkConfigError(
			{ source: "sdk", field: "admission", expected: USER_DATABASE_UNAVAILABLE },
			{ cause: error },
		);
	}
}

/**
 * Refuses `localWorkers` or `admission` that the source's saved worker resources cannot resume with, before anything
 * is copied: `run()` would otherwise refuse them on the fork it just wrote (`activatePublicPool`), with the same check.
 * Entry modules are compared by the fork's run, which reads them.
 */
function refuseChangedWorkerResources(
	options: ForkRunOptions,
	handle: DurableWorkflowHandle,
	backend: DurableWorkflowBackend,
): void {
	const saved = handle.resources;
	if (!saved || (!options.localWorkers && !options.admission)) return;
	const digests = new Map((saved.definitions ?? []).map((source) => [source.path, source.digest]));
	const requested = workerResources(
		{
			localWorkers: options.localWorkers ?? saved.localWorkers,
			admission: options.admission ?? saved.admission,
			cwd: options.cwd === undefined ? (handle.invocationCwd ?? process.cwd()) : resolve(options.cwd),
		},
		{
			userDatabase: () => forkUserDatabase(backend),
			digestOf: (path) => digests.get(path) ?? "",
			coordinator: saved.coordinator,
		},
	);
	const refused = refusedResourceChanges(saved, requested, options.acceptEntryChanges);
	const issues = (["localWorkers", "admission"] as const).flatMap((field): ForkConfigIssue[] => {
		const changes = refused.filter((change) => change.option === field).map((change) => change.description);
		return changes.length === 0 ? [] : [{ field, expected: `${SAVED_WORKER_RESOURCES} (${changes.join("; ")})` }];
	});
	const [first, ...rest] = issues;
	if (first !== undefined) throw new ForkConfigError({ source: "sdk", issues: [first, ...rest] });
}

async function sdkDurableBackend(
	runId: string,
	options: {
		readonly journal?: RunJournalOption;
		readonly durableBackend?: DurableWorkflowBackend;
		readonly store?: Store;
		readonly cwd?: string;
	},
): Promise<{ readonly store: Store; readonly backend: DurableWorkflowBackend }> {
	const store = options.store === undefined || options.store === defaultStore ? currentWorkflowStore() : options.store;
	const preset =
		options.journal === undefined
			? (options.durableBackend ??
				availableRunDurableBackend(store, runId) ??
				availableStoreDurableBackendOverride(store))
			: undefined;
	return {
		store,
		backend: preset ?? (await initializeDurableBackend({ journal: options.journal, cwd: options.cwd })),
	};
}

/**
 * Fork a durable run from a stage into a new run and execute it. The source run is claimed while it is
 * read and is never written. Every precondition is checked before anything is copied, so a failure
 * leaves no fork behind except an unconfirmed shared write, which retains its copied sessions and names the fork
 * (`ForkJournalUnavailableError`, `commit`). Invalid worker timing raises `LocalWorkerOptionsError`; other fork
 * failures are `ForkError`s. A fork keeps its source's worker resources, so `localWorkers` or `admission` for a
 * source that saved none, or that its saved ones cannot resume with, is a `ForkConfigError`. An abort before the fork
 * is written rejects with the signal's reason; after that, it cancels the fork's execution like `run()`.
 */
export async function forkRun<
	TInputs extends WorkflowInputValues,
	TOutputs extends WorkflowOutputValues,
	TRunInputs extends WorkflowInputValues = TInputs,
>(
	runId: string,
	typedOptions: ForkRunOptions<WorkflowDefinition<TInputs, TOutputs, TRunInputs>> = {},
): Promise<ForkedRun> {
	const options = typedOptions as never as ForkRunOptions;
	const hostBinds = options[hostWorkerBindings] === true;
	const processBound = PROCESS_BOUND_RUN_OPTIONS.filter((key) => options[key] !== undefined);
	let pooled = options.localWorkers !== undefined && !hostBinds;
	validateForkOptions("sdk", runId, { ...options, processBound: pooled ? processBound : [] });
	if (options.localWorkers !== undefined) resolveWorkerTiming(options.localWorkers, "sdk");
	const {
		fromStage,
		inputs,
		cwd,
		carryMessages,
		definition,
		sourceSessionStore,
		onRunStart,
		onStageStart,
		onStageEnd,
		onStageSessionEvent,
		onRunEnd,
		...runOptions
	} = options;
	options.signal?.throwIfAborted();
	const { store, backend } = await sdkDurableBackend(runId, options);
	const forked = await forkDurableRun(backend, {
		source: "sdk",
		runId,
		fromStage,
		inputs,
		cwd,
		carryMessages: carryMessages ?? "before",
		definition,
		resolveDefinition: async (name, definitionCwd) => {
			const registered = options.registry?.get(name);
			if (registered !== undefined) return registered;
			const { discoverWorkflows } = await import("../../extension/discovery.js");
			return (await discoverWorkflows({ cwd: definitionCwd ?? process.cwd() })).registry.get(name);
		},
		sessionStore: options.adapters?.sessionStore,
		sourceSessionStore,
		modelOwner: options.modelOwner,
		signal: options.signal,
		validateSource: (handle) => {
			refuseAddedWorkerResources(options, handle.resources);
			refuseChangedWorkerResources(options, handle, backend);
			if (options.localWorkers === undefined && handle.resources?.localWorkers !== undefined)
				resolveWorkerTiming(handle.resources.localWorkers, "sdk");
			if (hostBinds || handle.resources?.localWorkers === undefined) return;
			pooled = true;
			validateForkOptions("sdk", runId, { processBound });
		},
		isLiveRun: (id) => hasActiveLiveRun(store, id),
		rootRunOf: (id) => store.run(id)?.rootRunId,
	});
	const channel = runEventChannel();
	const result = run(forked.definition, forked.inputs, {
		...runOptions,
		runId: forked.runId,
		cwd: forked.cwd,
		store,
		durableBackend: backend,
		onRunStart: (snapshot) => {
			channel.push({ type: "run_start", run: structuredClone(snapshot) });
			onRunStart?.(snapshot);
		},
		...(pooled
			? {}
			: {
					onStageStart: (id: string, stage: StageSnapshot) => {
						channel.push({ type: "stage_start", runId: id, stage: structuredClone(stage) });
						onStageStart?.(id, stage);
					},
					onStageEnd: (id: string, stage: StageSnapshot) => {
						channel.push({ type: "stage_end", runId: id, stage: structuredClone(stage) });
						return onStageEnd?.(id, stage);
					},
					onStageSessionEvent: (id: string, stageId: string, event: AgentSessionEvent) => {
						channel.push({ type: "stage_session_event", runId: id, stageId, event });
						onStageSessionEvent?.(id, stageId, event);
					},
				}),
		onRunEnd: (id, status, output, error, exitReason) => {
			channel.push({
				type: "run_end",
				runId: id,
				status,
				...(output === undefined ? {} : { result: output }),
				...(error === undefined ? {} : { error }),
				...(exitReason === undefined ? {} : { exitReason }),
			});
			onRunEnd?.(id, status, output, error, exitReason);
		},
	});
	void result.then(
		() => channel.end(),
		(error: Error) => channel.end(error),
	);
	return { runId: forked.runId, forkedFrom: forked.forkedFrom, events: channel.events, result };
}

/** The completed stages of a durable run, in completion order, that `forkRun` can fork from. Read-only. */
export async function* listForkPoints(
	runId: string,
	options: ListForkPointsOptions = {},
): AsyncGenerator<ForkPoint, void, undefined> {
	validateForkOptions("sdk", runId, {});
	const { store, backend } = await sdkDurableBackend(runId, options);
	yield* durableForkPoints(backend, runId, {
		cwd: options.cwd,
		sourceSessionStore: options.sourceSessionStore,
		rootRunOf: (id) => store.run(id)?.rootRunId,
	});
}
