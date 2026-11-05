/**
 * SDK entry points for run time travel (#4321): `forkRun` forks a durable run from a stage into a new
 * run and executes it; `listForkPoints` lists the stages a run can be forked from.
 */
import type { AgentSessionEvent, SessionStore } from "@bastani/atomic";
import type { DurableWorkflowBackend } from "../../durable/backend.js";
import { initializeDurableBackend } from "../../durable/factory.js";
import type { ForkCarryMessages, ForkPoint } from "../../durable/fork-run.js";
import { durableForkPoints, forkDurableRun, validateForkOptions } from "../../durable/fork-run.js";
import type { RunJournalOption } from "../../durable/journal/resolution.js";
import { hasActiveLiveRun } from "../../durable/run-claims.js";
import { availableRunDurableBackend } from "../../durable/run-owner-backend.js";
import { availableStoreDurableBackendOverride } from "../../durable/store-backend.js";
import type { WorkflowForkedFrom } from "../../durable/types.js";
import type { Store } from "../../shared/store.js";
import { store as defaultStore } from "../../shared/store.js";
import { currentWorkflowStore } from "../../shared/store-factory.js";
import type { RunSnapshot, RunStatus, StageSnapshot } from "../../shared/store-types.js";
import type { WorkflowDefinition, WorkflowInputValues, WorkflowOutputValues } from "../../shared/types.js";
import type { RunOpts, RunResult } from "./executor-types.js";
import { run } from "./sdk-run.js";

export type { ForkCarryMessages, ForkPoint } from "../../durable/fork-run.js";

/** One notification of a run, as `run()` reports it through `onRunStart`, `onStageStart`, `onStageEnd`, `onStageSessionEvent` and `onRunEnd`. */
export type WorkflowRunEvent =
	| { readonly type: "run_start"; readonly run: RunSnapshot }
	| { readonly type: "stage_start"; readonly runId: string; readonly stage: StageSnapshot }
	| { readonly type: "stage_end"; readonly runId: string; readonly stage: StageSnapshot }
	| {
			readonly type: "stage_session_event";
			readonly runId: string;
			readonly stageId: string;
			readonly event: AgentSessionEvent;
	  }
	| {
			readonly type: "run_end";
			readonly runId: string;
			readonly status: RunStatus;
			readonly result?: WorkflowOutputValues;
			readonly error?: string;
			readonly exitReason?: string;
	  };

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

/** A forked run. `events` yields the run's notifications once, in order; `result` settles when the run ends. */
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
	/** Session store holding the run's stage sessions, read for each point's `entryId`. */
	readonly sessionStore?: SessionStore;
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

interface RunEventChannel {
	push(event: WorkflowRunEvent): void;
	end(error?: Error): void;
	readonly events: AsyncIterable<WorkflowRunEvent>;
}

function runEventChannel(): RunEventChannel {
	const buffered: WorkflowRunEvent[] = [];
	let wake: (() => void) | undefined;
	let ended = false;
	let failure: Error | undefined;
	return {
		push(event) {
			if (ended) return;
			buffered.push(event);
			wake?.();
		},
		end(error) {
			ended = true;
			failure = error;
			wake?.();
		},
		events: {
			async *[Symbol.asyncIterator]() {
				for (;;) {
					const next = buffered.shift();
					if (next !== undefined) {
						yield next;
						continue;
					}
					if (ended) {
						if (failure !== undefined) throw failure;
						return;
					}
					await new Promise<void>((resolve) => {
						wake = resolve;
					});
					wake = undefined;
				}
			},
		},
	};
}

/**
 * Fork a durable run from a stage into a new run and execute it. The source run is claimed while it is
 * read and is never written. Every precondition is checked before anything is copied, so a failure
 * leaves no fork behind; failures are `ForkError`s. An abort before the fork is written rejects with
 * the signal's reason; after that, it cancels the fork's execution like `run()`.
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
	validateForkOptions("sdk", runId, options);
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
		isLiveRun: (id) => hasActiveLiveRun(store, id),
	});
	const channel = runEventChannel();
	const result = run(forked.definition, forked.inputs, {
		...runOptions,
		runId: forked.runId,
		cwd: forked.cwd,
		store,
		durableBackend: backend,
		onRunStart: (snapshot) => {
			channel.push({ type: "run_start", run: snapshot });
			onRunStart?.(snapshot);
		},
		onStageStart: (id, stage) => {
			channel.push({ type: "stage_start", runId: id, stage });
			onStageStart?.(id, stage);
		},
		onStageEnd: (id, stage) => {
			channel.push({ type: "stage_end", runId: id, stage });
			return onStageEnd?.(id, stage);
		},
		onStageSessionEvent: (id, stageId, event) => {
			channel.push({ type: "stage_session_event", runId: id, stageId, event });
			onStageSessionEvent?.(id, stageId, event);
		},
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
	const { backend } = await sdkDurableBackend(runId, options);
	yield* durableForkPoints(backend, runId, { cwd: options.cwd, sourceSessionStore: options.sessionStore });
}
