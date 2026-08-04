import type { DurableWorkflowBackend } from "../durable/backend.js";
import type { DurableChildInvocation } from "../durable/boundary-topology.js";
import { createDurableChildWorkflowPrimitive } from "../durable/child-primitive.js";
import { getDurableBackend } from "../durable/factory.js";
import { inheritedRunElapsedMs, recordRunTimingCheckpoint } from "../durable/run-timing.js";
import { ScopedDurableBackend } from "../durable/scoped-backend.js";
import {
	createDurableStagePrimitive,
	createDurableTaskPrimitive,
	createStageReplayKeyGenerator,
} from "../durable/stage-primitive.js";
import { createCheckpointIdGenerator } from "../durable/tool-primitive.js";
import {
	findWorkflowExitSignal,
	parentWorkflowExitAbortReason,
	unknownErrorMessage,
} from "../runs/foreground/executor-abort.js";
import {
	isWorkflowDefinition,
	workflowDefinitionRequirementMessage,
} from "../runs/foreground/executor-child-helpers.js";
import {
	createGitWorktreeSetupCacheOwner,
	workflowCwdWithInputWorktree,
	workflowInvocationMetadata,
} from "../runs/foreground/executor-direct-helpers.js";
import {
	resolveAndValidateInputs,
	resolveInputConcurrency,
	resolveInputRuntimeDefaults,
} from "../runs/foreground/executor-inputs.js";
import {
	appendRunEndWhenRecorded,
	assertWorkflowCreatedExecution,
	finalizeKilled,
	finalizeKilledByFailure,
	normalizeFailureWinnerMetadata,
	normalizeStageLessFailureMetadata,
	reconcileTerminalRunResult,
	recordActiveBlockedFailure,
	selectRunFailureDisposition,
} from "../runs/foreground/executor-lifecycle.js";
import { assertWorkflowRunOutputs, normalizeWorkflowRunOutput } from "../runs/foreground/executor-outputs.js";
import { buildPromptNodeUiAdapter } from "../runs/foreground/executor-prompt-nodes.js";
import { createRunFinalizers } from "../runs/foreground/executor-run-finalizers.js";
import { createStageScheduler } from "../runs/foreground/executor-scheduler.js";
import type { RunOpts, RunResult } from "../runs/foreground/executor-types.js";
import { stageControlRegistry as defaultStageControlRegistry } from "../runs/foreground/stage-control-registry.js";
import { createRunLimiter } from "../runs/shared/concurrency.js";
import { appendRunStart } from "../shared/persistence-session-entries.js";
import { store as defaultStore } from "../shared/store.js";
import type { RunSnapshot } from "../shared/store-types.js";
import type {
	WorkflowDefinition,
	WorkflowInputValues,
	WorkflowOutputValues,
	WorkflowRunContext,
} from "../shared/types.js";
import type { WorkflowFailure } from "../shared/workflow-failures.js";
import { classifyWorkflowFailure } from "../shared/workflow-failures.js";
import { GraphFrontierTracker } from "./graph-inference.js";
import type { EngineChildRunOptions, EngineStageRuntimeOptions, EngineWorkflowBoundaryOptions } from "./options.js";
import { createChainPrimitive } from "./primitives/chain.js";
import { createWorkflowExitManager } from "./primitives/exit.js";
import { createParallelPrimitive } from "./primitives/parallel.js";
import { createWorkflowTaskRunners } from "./primitives/task.js";
import { buildExitGatedUiContext } from "./primitives/ui.js";
import { createChildWorkflowRunner } from "./primitives/workflow.js";
import { createContinuationReplayIndex } from "./replay.js";
import { admitDurableRootRun, durableRootRegistrationForRun } from "./run-durable-admission.js";
import { finalizeDurableTerminalStatus } from "./run-durable-finalize.js";
import { createDurableStageSessionRecorder } from "./run-durable-stage-session.js";
import {
	createDurableCachedStageRecorder,
	createDurableStageDeps,
	createDurableStageEndRecorder,
	createDurableStageTopologyResolver,
	durableRunTopology,
	recordDurableActiveStage,
} from "./run-durable-topology.js";
import { classifyReturnedRunStatus } from "./run-returned-status.js";
import { createRunTerminalEventArbiter } from "./run-terminal-event.js";
import { finalizeTerminalFailure } from "./run-terminal-failure.js";
import { createToolAdmissionBoundary } from "./run-tool-admission-boundary.js";
import { toolControlRegistry as defaultToolControlRegistry } from "./run-tool-control-registry.js";
import { createTrackedToolPrimitive } from "./run-tool-node-lifecycle.js";
import { EngineRuntime } from "./runtime.js";
import { nextEventLoopTurn, runWorkflowDefinitionCallback } from "./workflow-activity.js";
import {
	findWorkflowGracefulQuit,
	WORKFLOW_GRACEFUL_QUIT_EXIT_REASON,
	type WorkflowGracefulQuitSignal,
} from "./workflow-tool-abort.js";

type WorkflowRunInputArgument = Parameters<typeof resolveAndValidateInputs>[1];
export function run<
	TInputs extends WorkflowInputValues,
	TOutputs extends WorkflowOutputValues,
	TRunInputs extends WorkflowInputValues = TInputs,
>(
	def: WorkflowDefinition<TInputs, TOutputs, TRunInputs>,
	inputs: WorkflowRunInputArgument,
	opts?: RunOpts,
): Promise<RunResult<TOutputs>>;
export async function run<TInputs extends WorkflowInputValues, TRunInputs extends WorkflowInputValues = TInputs>(
	def: WorkflowDefinition<TInputs, WorkflowOutputValues, TRunInputs>,
	inputs: WorkflowRunInputArgument,
	opts: RunOpts = {},
): Promise<RunResult> {
	if (!isWorkflowDefinition(def))
		throw new Error(workflowDefinitionRequirementMessage("run(definition, inputs)", def));
	const activeStore = opts.store ?? defaultStore;
	const adapters = opts.adapters ?? {};
	// Prompt-node UI is the graph-mode transport and intentionally takes precedence
	// over an injected RunOpts.ui adapter; warn because that adapter will be ignored.
	if (opts.usePromptNodesForUi === true && opts.ui !== undefined) {
		console.warn("atomic-workflows: usePromptNodesForUi ignores the provided RunOpts.ui adapter");
	}
	const depth = opts.depth ?? 0;
	const maxDepth = opts.config?.maxDepth ?? 4;
	if (depth >= maxDepth) {
		return {
			runId: opts.runId ?? crypto.randomUUID(),
			status: "failed",
			error: `atomic-workflows: maxDepth exceeded (max ${maxDepth})`,
			stages: [],
			toolNodes: [],
		};
	}

	const resolvedInputs = resolveAndValidateInputs(def.inputs, inputs, `workflow "${def.name}"`);
	const runId = opts.runId ?? crypto.randomUUID();
	const exitScope = Symbol(`workflow-exit:${runId}`);
	const ownController = new AbortController();
	const terminalEvents = createRunTerminalEventArbiter(runId);
	ownController.signal.addEventListener(
		"abort",
		() => {
			terminalEvents.selectCancellation(ownController.signal.reason);
		},
		{ once: true },
	);
	const callerSignal = opts.signal;
	if (callerSignal) {
		if (callerSignal.aborted) ownController.abort(callerSignal.reason);
		else
			callerSignal.addEventListener(
				"abort",
				() => {
					ownController.abort(callerSignal.reason);
				},
				{ once: true },
			);
	}
	const exit = createWorkflowExitManager({ runId, exitScope, controller: ownController });
	// Durable child operations stay on stacked scoped views, while cached graph
	// reconstruction keeps the physical root backend through arbitrary depth.
	// cross-ref: issue #1498 — DBOS-backed cross-session resumability.
	const backendView: DurableWorkflowBackend = opts.durableBackend ?? getDurableBackend();
	const rootBackend: DurableWorkflowBackend = opts.durableRootBackend ?? backendView;
	const durableBackend: DurableWorkflowBackend =
		opts.durableScope !== undefined ? new ScopedDurableBackend(backendView, opts.durableScope) : backendView;
	const inheritedElapsedMs =
		opts.parentRun === undefined
			? inheritedRunElapsedMs({ backend: durableBackend, runId, continuationSource: opts.continuation?.source })
			: undefined;
	const continuationOrigin = opts.continuation !== undefined ? opts.continuation.source.origin : opts.origin;
	const runSnapshot: RunSnapshot = {
		id: runId,
		name: def.name,
		inputs: Object.freeze(resolvedInputs),
		status: "running" as const,
		stages: [],
		toolNodes: [],
		startedAt: Date.now(),
		...(opts.parentRun !== undefined
			? {
					parentRunId: opts.parentRun.runId,
					parentStageId: opts.parentRun.stageId,
					rootRunId: opts.parentRun.rootRunId,
				}
			: {}),
		...(opts.continuation !== undefined
			? {
					resumedFromRunId: opts.continuation.source.id,
					resumeFromStageId: opts.continuation.resumeFromStageId,
				}
			: {}),
		// A continuation keeps the attribution of the run it continues rather than
		// recomputing it, so resuming an agent-started run still reads as one the
		// agent started. Only the resume itself is attributed to its requester.
		...(continuationOrigin !== undefined ? { origin: continuationOrigin } : {}),
		// A resumed run reports the resume that produced it, never a fresh start —
		// whether it continues under a new id or reclaims the original one.
		...(opts.resumeActor !== undefined
			? { resumeActor: opts.resumeActor, resumeSource: "run_control" as const }
			: {}),
		...(inheritedElapsedMs !== undefined ? { accumulatedDurationMs: inheritedElapsedMs } : {}),
	};
	const classifiedFailures = new Map<unknown, WorkflowFailure>();
	const classifyExecutorFailure = (error: unknown): WorkflowFailure => {
		const cached = classifiedFailures.get(error);
		if (cached !== undefined) return cached;
		let classified: WorkflowFailure;
		try {
			classified = classifyWorkflowFailure(error);
		} catch {
			classified = classifyWorkflowFailure(new Error(unknownErrorMessage(error)));
		}
		classifiedFailures.set(error, classified);
		return classified;
	};
	activeStore.recordRunStart(runSnapshot);
	// Only the registration's owner may remove it, and only while it is still the
	// registered controller: an abandoned executor finalizing late must not evict
	// the replacement run that now owns this id.
	const ownsCancellationRegistration = opts.signal === undefined && opts.cancellation !== undefined;
	if (ownsCancellationRegistration) opts.cancellation?.register(runId, ownController);
	opts.onRunStart?.(runSnapshot);
	if (opts.persistence) {
		appendRunStart(opts.persistence, {
			runId,
			name: def.name,
			inputs: resolvedInputs,
			...(runSnapshot.parentRunId !== undefined ? { parentRunId: runSnapshot.parentRunId } : {}),
			...(runSnapshot.parentStageId !== undefined ? { parentStageId: runSnapshot.parentStageId } : {}),
			...(runSnapshot.rootRunId !== undefined ? { rootRunId: runSnapshot.rootRunId } : {}),
			...(runSnapshot.resumedFromRunId !== undefined ? { resumedFromRunId: runSnapshot.resumedFromRunId } : {}),
			...(runSnapshot.origin !== undefined ? { origin: runSnapshot.origin } : {}),
			...(runSnapshot.resumeFromStageId !== undefined ? { resumeFromStageId: runSnapshot.resumeFromStageId } : {}),
			...(runSnapshot.accumulatedDurationMs !== undefined
				? { accumulatedDurationMs: runSnapshot.accumulatedDurationMs }
				: {}),
			ts: runSnapshot.startedAt,
		});
	}
	const tracker = new GraphFrontierTracker();
	const inputConcurrency = resolveInputConcurrency(def.inputs, resolvedInputs);
	const inputRuntimeDefaults = resolveInputRuntimeDefaults(def, resolvedInputs),
		gitWorktreeSetupCacheOwner = createGitWorktreeSetupCacheOwner(opts.gitWorktreeSetupCache);
	const gitWorktreeSetupCache = gitWorktreeSetupCacheOwner.cache;
	const workflowInvocationCwd = opts.cwd ?? process.cwd();
	let workflowCwd: string | undefined;
	const resolveWorkflowCwd = (): string => {
		workflowCwd ??= workflowCwdWithInputWorktree(inputRuntimeDefaults, workflowInvocationCwd, gitWorktreeSetupCache);
		return workflowCwd;
	};
	const limiter = createRunLimiter(inputConcurrency ?? opts.config?.defaultConcurrency);
	const stageRegistry = opts.stageControlRegistry ?? defaultStageControlRegistry;
	const replayIndex = createContinuationReplayIndex(opts.continuation);
	const scheduler = createStageScheduler({
		runId,
		runSnapshot,
		activeStore,
		tracker,
		stageRegistry: () => stageRegistry,
	});
	ownController.signal.addEventListener(
		"abort",
		() => scheduler.rejectReleaseBarriers(ownController.signal.reason ?? new Error("atomic-workflows: run aborted")),
		{ once: true },
	);
	const finalizers = createRunFinalizers({
		def,
		runId,
		runSnapshot,
		activeStore,
		opts,
		classifyExecutorFailure,
		drainWorkflowExitCleanups: exit.drainWorkflowExitCleanups,
	});
	const checkpointIdGenerator = createCheckpointIdGenerator();
	const stageReplayKeyGenerator = createStageReplayKeyGenerator(runId);
	const completedStageReplayKeys = new Map<string, string>();
	const sourceToReplayedNodeIds = new Map<string, string>();
	const durableStageDeps = createDurableStageDeps({
		backend: durableBackend,
		run: runSnapshot,
		nextCheckpointId: checkpointIdGenerator,
		nextReplayKey: stageReplayKeyGenerator,
		completedReplayKeys: completedStageReplayKeys,
	});
	const durableOnStageEnd = createDurableStageEndRecorder({
		rootRunId: runId,
		deps: durableStageDeps,
		user: opts.onStageEnd,
	});
	const durableOnPromptNodeEnd = createDurableStageEndRecorder({
		rootRunId: runId,
		deps: durableStageDeps,
		user: opts.onStageEnd,
		metadataOnly: true,
	});
	const durableOnStageSession = createDurableStageSessionRecorder({
		runId,
		deps: durableStageDeps,
		onStageSession: opts.onStageSession,
		...(opts.parentRun === undefined ? { runSnapshot } : {}),
	});
	const stageOptions: EngineStageRuntimeOptions = {
		continuation: opts.continuation,
		models: opts.models,
		executionMode: opts.executionMode,
		defaultSessionDir: opts.defaultSessionDir,
		persistence: opts.persistence,
		onStageStart: opts.onStageStart,
		onStageEnd: durableOnStageEnd,
		onStageSession: durableOnStageSession,
		confirmStageReadiness: opts.confirmStageReadiness,
		usePromptNodesForUi: opts.usePromptNodesForUi,
	};
	const workflowBoundaryOptions: EngineWorkflowBoundaryOptions = {
		persistence: opts.persistence,
		onStageStart: opts.onStageStart,
		onStageEnd: opts.onStageEnd,
	};
	const toolControls = opts.toolControlRegistry ?? defaultToolControlRegistry;
	// One admission boundary per workflow tree: the root creates it and every
	// nested run inherits the same instance, so a single `closeForQuit()` stops
	// admission everywhere below the quit boundary.
	const toolAdmission = opts.toolAdmissionBoundary ?? createToolAdmissionBoundary();
	const unregisterToolAdmission = toolControls.registerAdmissionBoundary(runId, toolAdmission);
	const childRunOptions: EngineChildRunOptions = {
		adapters: opts.adapters,
		ui: opts.ui,
		executionMode: opts.executionMode,
		defaultSessionDir: opts.defaultSessionDir,
		usePromptNodesForUi: opts.usePromptNodesForUi,
		confirmStageReadiness: opts.confirmStageReadiness,
		store: opts.store,
		persistence: opts.persistence,
		mcp: opts.mcp,
		cancellation: opts.cancellation,
		overlay: opts.overlay,
		config: opts.config,
		models: opts.models,
		registry: opts.registry,
		stageControlRegistry: opts.stageControlRegistry,
		toolControlRegistry: opts.toolControlRegistry,
		toolAdmissionBoundary: toolAdmission,
		onStageStart: opts.onStageStart,
		onStageEnd: opts.onStageEnd,
		onStageSession: opts.onStageSession,
		durableBackend,
		durableRootBackend: rootBackend,
	};
	const runtime = new EngineRuntime({
		runId,
		depth,
		runSnapshot,
		activeStore,
		stageOptions,
		workflowBoundaryOptions,
		childRunOptions,
		parentRootRunId: opts.parentRun?.rootRunId,
		adapters,
		signal: ownController.signal,
		tracker,
		scheduler,
		replayIndex,
		limiter,
		inputRuntimeDefaults,
		workflowInvocationCwd,
		stageRegistry,
		gitWorktreeSetupCache,
		worktreeSymlinkDirectories: opts.config?.worktree?.symlinkDirectories,
		exit,
		classifyExecutorFailure,
	});
	const workflowBoundaryReplayCounts = new Map<string, number>();
	const nextWorkflowBoundaryReplayKey = (name: string): string => {
		const durableScopePrefix = pendingChildDurableInvocation?.scope.scopePrefix;
		if (durableScopePrefix?.startsWith(`workflow:${name}:`)) return durableScopePrefix;
		const next = (workflowBoundaryReplayCounts.get(name) ?? 0) + 1;
		workflowBoundaryReplayCounts.set(name, next);
		return `workflow:${name}:${next}`;
	};
	// Durable scopes are keyed by definition+validated-input fingerprint. Only
	// truly identical invocations share an ordinal sequence, so reversed
	// parallel dispatch cannot exchange distinct cached child results.
	const durableChildReplayCounts = new Map<string, number>();
	const nextDurableChildReplayKey = (name: string, invocationFingerprint: string): string => {
		const identity = `${name}:${invocationFingerprint}`;
		const next = (durableChildReplayCounts.get(identity) ?? 0) + 1;
		durableChildReplayCounts.set(identity, next);
		return `workflow:${name}:${invocationFingerprint}:${next}`;
	};
	const taskRunners = createWorkflowTaskRunners({ runtime });
	// The outer primitive publishes one validated boundary/child identity; the
	// inner runner consumes it before dispatching child workflow code.
	let pendingChildDurableInvocation: DurableChildInvocation | undefined;
	const workflow = createChildWorkflowRunner({
		runtime,
		resolveWorkflowCwd,
		nextWorkflowBoundaryReplayKey,
		consumeDurableInvocation: () => {
			const invocation = pendingChildDurableInvocation;
			pendingChildDurableInvocation = undefined;
			return invocation;
		},
		runWorkflow: run,
	});
	const durableRootRegistration = durableRootRegistrationForRun({
		runId,
		name: def.name,
		inputs: resolvedInputs,
		createdAt: runSnapshot.startedAt,
		hasPersistence: opts.persistence !== undefined,
		isChildRun: opts.parentRun !== undefined,
		continuationSourceId: opts.continuation?.source.id,
	});
	const { tool, admittedTools, abandonInFlightAsCancelled, observedQuitCancellation } = createTrackedToolPrimitive({
		workflowId: runId,
		backend: durableBackend,
		nextCheckpointId: checkpointIdGenerator,
		controller: ownController,
		terminalEvents,
		store: activeStore,
		tracker,
		run: runSnapshot,
		sourceToReplayedNodeIds,
		toolControls,
		toolAdmission,
	});
	let selectedAdmittedToolFailure: ReturnType<typeof admittedTools.firstFailure>;
	/**
	 * Suspend the executor for a whole-run graceful quit.
	 *
	 * `quitRun()` owns the local and durable paused/resumable publication, so
	 * this deliberately records no run end, no terminal persistence, no durable
	 * terminal status, and no `endedAt`. Unsettled callbacks are abandoned rather
	 * than drained so the background job releases and resume can relaunch.
	 * Both the success and failure paths return through here so they cannot drift.
	 */
	const suspendForGracefulQuit = (reason: WorkflowGracefulQuitSignal): RunResult => {
		abandonInFlightAsCancelled(reason);
		return {
			runId,
			status: "paused",
			exitReason: WORKFLOW_GRACEFUL_QUIT_EXIT_REASON,
			stages: [...runSnapshot.stages],
			toolNodes: [...(runSnapshot.toolNodes ?? [])],
		};
	};
	// Prompt-node mode re-materializes metadata before returning a durable ctx.ui cache hit.
	const resolvePromptNodeTopology = createDurableStageTopologyResolver(durableBackend, runId);
	let promptNodeUi: ReturnType<typeof buildPromptNodeUiAdapter> | undefined;
	const getPromptNodeUi = (): ReturnType<typeof buildPromptNodeUiAdapter> => {
		promptNodeUi ??= buildPromptNodeUiAdapter({
			runId,
			activeStore,
			tracker,
			replayIndex,
			classifyExecutorFailure,
			opts: { ...opts, onStageEnd: durableOnPromptNodeEnd },
			stageControlRegistry: stageRegistry,
			signal: ownController.signal,
			throwIfWorkflowExitSelected: exit.throwIfWorkflowExitSelected,
			registerWorkflowExitCleanup: exit.registerWorkflowExitCleanup,
			workflowExitSkippedReason: exit.workflowExitSkippedReason,
			preserveWorkflowExitSkippedReason: exit.preserveWorkflowExitSkippedReason,
			durableTopologyForReplayKey: resolvePromptNodeTopology,
			onPendingStage: async (pendingRunId, snapshot) =>
				pendingRunId === runId ? void (await recordDurableActiveStage(durableStageDeps, snapshot)) : undefined,
		});
		return promptNodeUi;
	};
	const durableUiDeps = {
		workflowId: runId,
		backend: durableBackend,
		nextCheckpointId: checkpointIdGenerator,
		...(opts.usePromptNodesForUi === true
			? {
					onReplay: async (request: Parameters<ReturnType<typeof buildPromptNodeUiAdapter>["replayDurable"]>[0]) =>
						getPromptNodeUi().replayDurable(request),
				}
			: {}),
	};
	const cachedStage = createDurableCachedStageRecorder({
		store: activeStore,
		tracker,
		run: runSnapshot,
		backend: durableBackend,
		rootBackend,
		completedStageReplayKeys,
		sourceToReplayedNodeIds,
	});
	const durableTask = createDurableTaskPrimitive({
		workflowId: runId,
		backend: durableBackend,
		nextReplayKey: (stageName) => stageReplayKeyGenerator(stageName),
		task: taskRunners.task,
		recordCachedTask: cachedStage.record,
	});
	const durableWorkflow = createDurableChildWorkflowPrimitive({
		workflowId: runId,
		rootWorkflowId: opts.parentRun?.rootRunId ?? runId,
		backend: durableBackend,
		nextReplayKey: nextDurableChildReplayKey,
		setChildDurableInvocation: (invocation) => {
			pendingChildDurableInvocation = invocation;
		},
		recordCachedStage: cachedStage.record,
		runTopology: durableRunTopology(runSnapshot),
		workflow,
	});
	const ctx: WorkflowRunContext<TInputs> = {
		inputs: resolvedInputs as TInputs,
		runId,
		get cwd() {
			return resolveWorkflowCwd();
		},
		exit: exit.exit,
		ui: buildExitGatedUiContext({
			opts,
			throwIfWorkflowExitSelected: exit.throwIfWorkflowExitSelected,
			durableUi: durableUiDeps,
			baseFromPromptNodes: getPromptNodeUi,
		}),
		stage: createDurableStagePrimitive({
			workflowId: runId,
			backend: durableBackend,
			nextReplayKey: (stageName) => stageReplayKeyGenerator(stageName),
			recordCachedStage: cachedStage.record,
			stage: (name, options, replayKey) => {
				const stage = runtime.stage(name, options);
				const stageId = activeStore
					.runs()
					.find((r) => r.id === runId)
					?.stages.at(-1)?.id;
				if (stageId !== undefined) completedStageReplayKeys.set(stageId, replayKey);
				return stage;
			},
		}),
		task: durableTask,
		chain: createChainPrimitive({ runtime, task: durableTask }),
		parallel: createParallelPrimitive({ runtime, task: durableTask }),
		workflow: durableWorkflow,
		tool,
		...(opts.models !== undefined ? { models: opts.models } : {}),
	};
	terminalEvents.register();
	try {
		if (opts.deferWorkflowStart === true) {
			await nextEventLoopTurn();
			if (ownController.signal.aborted) {
				await admittedTools.closeAndDrain();
				const selectedExit = findWorkflowExitSignal(ownController.signal.reason, exitScope);
				if (selectedExit !== undefined) return await finalizers.finalizeWorkflowExit(selectedExit);
				const parentExit = parentWorkflowExitAbortReason(ownController.signal.reason);
				if (parentExit !== undefined) return await finalizers.finalizeParentWorkflowExitCancellation(parentExit);
				return finalizeKilled(runId, runSnapshot, activeStore, opts.persistence, opts.onRunEnd);
			}
		}
		await admitDurableRootRun({
			backend: durableBackend,
			runId,
			isChildRun: opts.parentRun !== undefined,
			registration:
				durableRootRegistration === undefined
					? undefined
					: {
							...durableRootRegistration,
							...workflowInvocationMetadata(
								inputRuntimeDefaults,
								workflowInvocationCwd,
								gitWorktreeSetupCache,
								runSnapshot.origin,
							),
						},
		});
		if (opts.deferWorkflowStart === true) opts.onWorkflowStartReady?.();
		const rawResult = await runWorkflowDefinitionCallback(def.name, runId, () => def.run(ctx));
		await admittedTools.closeAndDrain();
		const normalTerminalEvent = terminalEvents.winner();
		if (normalTerminalEvent?.kind === "cancellation") {
			const selectedExit = findWorkflowExitSignal(normalTerminalEvent.reason, exitScope);
			if (selectedExit !== undefined) return await finalizers.finalizeWorkflowExit(selectedExit);
			const parentExit = parentWorkflowExitAbortReason(normalTerminalEvent.reason);
			if (parentExit !== undefined) return await finalizers.finalizeParentWorkflowExitCancellation(parentExit);
			return finalizeKilled(runId, runSnapshot, activeStore, opts.persistence, opts.onRunEnd);
		}
		selectedAdmittedToolFailure = admittedTools.firstFailure();
		if (normalTerminalEvent?.kind === "failure") throw normalTerminalEvent.error;
		// Whole-run quit is authoritative even when author code caught the tool
		// rejection and returned normally: this executor observed its own call
		// aborted (or refused) by that quit, so the caught call's later return must
		// not become a terminal completion over quit's paused record. A catch may
		// clean up; it is not an opt-out. Targeted node abort (scope "node") never
		// closes admission, and a quit that only paused stages — which a later
		// resume legitimately releases — never reaches a tool, so neither suspends
		// a run here.
		const quitDuringSuccess = observedQuitCancellation();
		if (quitDuringSuccess !== undefined) return suspendForGracefulQuit(quitDuringSuccess);

		const result = normalizeWorkflowRunOutput(def.name, rawResult);
		assertWorkflowRunOutputs(def.name, result, def.outputs);
		assertWorkflowCreatedExecution(runSnapshot);
		await durableBackend.flush();
		const returned = classifyReturnedRunStatus(result, runSnapshot);
		const recorded = activeStore.recordRunEnd(runId, returned.status, result, returned.error, returned.metadata);
		appendRunEndWhenRecorded(opts.persistence, recorded, {
			runId,
			status: returned.status,
			result,
			...(returned.error !== undefined ? { error: returned.error } : {}),
			...(returned.metadata ?? {}),
			...(runSnapshot.endedAt !== undefined ? { endedAt: runSnapshot.endedAt } : {}),
			...(runSnapshot.durationMs !== undefined ? { durationMs: runSnapshot.durationMs } : {}),
			ts: Date.now(),
		});
		if (opts.parentRun === undefined) recordRunTimingCheckpoint(durableBackend, runSnapshot);
		durableBackend.setWorkflowStatus(runId, returned.status, undefined, returned.metadata?.resumable);
		await durableBackend.flush();
		return reconcileTerminalRunResult(
			runId,
			runSnapshot,
			activeStore,
			{ status: returned.status, result, error: returned.error },
			opts.onRunEnd,
		);
	} catch (err) {
		terminalEvents.selectFailure(err);
		// Graceful quit is a suspension, not a terminal outcome: `quitRun` owns the
		// paused/resumable record, so the executor must not write a terminal store
		// or durable status here. The admission reason comes first so author code
		// that catches the quit error and throws something else cannot erase it.
		const gracefulQuit =
			observedQuitCancellation() ??
			findWorkflowGracefulQuit(err) ??
			findWorkflowGracefulQuit(ownController.signal.reason);
		if (gracefulQuit !== undefined) return suspendForGracefulQuit(gracefulQuit);
		await admittedTools.closeAndDrain();
		const observedAdmittedToolFailure = selectedAdmittedToolFailure ?? admittedTools.uniqueFailureFor(err);
		const selectedExit =
			findWorkflowExitSignal(err, exitScope) ?? findWorkflowExitSignal(ownController.signal.reason, exitScope);
		if (selectedExit !== undefined) return await finalizers.finalizeWorkflowExit(selectedExit);
		const catchTerminalEvent = terminalEvents.winner();
		if (catchTerminalEvent?.kind === "cancellation") {
			const parentExit = parentWorkflowExitAbortReason(catchTerminalEvent.reason);
			if (parentExit !== undefined) return await finalizers.finalizeParentWorkflowExitCancellation(parentExit);
			return finalizeKilled(runId, runSnapshot, activeStore, opts.persistence, opts.onRunEnd);
		}
		const failure = classifyExecutorFailure(err);
		const selectedMetadata = normalizeFailureWinnerMetadata(
			normalizeStageLessFailureMetadata(
				selectRunFailureDisposition({
					outerFailure: failure,
					thrownError: err,
					stages: runSnapshot.stages,
					classifyFailure: classifyExecutorFailure,
				}),
				runSnapshot.stages.length,
			),
		);
		const failedToolNodeId =
			selectedMetadata.failedStageId === undefined &&
			selectedMetadata.failureKind !== "cancelled" &&
			selectedMetadata.failureDisposition !== "terminal_killed"
				? catchTerminalEvent?.kind === "failure" && Object.is(catchTerminalEvent.error, err)
					? (catchTerminalEvent.nodeId ?? observedAdmittedToolFailure?.nodeId)
					: observedAdmittedToolFailure?.nodeId
				: undefined;
		const metadata = failedToolNodeId === undefined ? selectedMetadata : { ...selectedMetadata, failedToolNodeId };

		if (metadata.failureDisposition === "terminal_killed") {
			for (const failedStageId of metadata.failedStageIds) scheduler.blockKnownNonTerminalDescendants(failedStageId);
			return finalizeKilledByFailure(runId, runSnapshot, activeStore, opts.persistence, opts.onRunEnd, {
				...metadata,
				resumable: false,
			});
		}

		if (
			metadata.failureDisposition === "active_blocked" &&
			metadata.failedStageId !== undefined &&
			metadata.failureRecoverability === "recoverable"
		) {
			for (const failedStageId of metadata.failedStageIds) scheduler.blockKnownNonTerminalDescendants(failedStageId);
			return recordActiveBlockedFailure(runId, runSnapshot, activeStore, opts.persistence, {
				...metadata,
				failureRecoverability: "recoverable",
				failedStageId: metadata.failedStageId,
				resumable: true,
			});
		}

		return finalizeTerminalFailure({
			runId,
			runSnapshot,
			store: activeStore,
			persistence: opts.persistence,
			metadata,
			onRunEnd: opts.onRunEnd,
		});
	} finally {
		try {
			await finalizeDurableTerminalStatus({
				runId,
				runSnapshot,
				isRoot: opts.parentRun === undefined,
				durableBackend,
			});
		} finally {
			try {
				gitWorktreeSetupCacheOwner.release(() => {
					if (ownsCancellationRegistration) opts.cancellation?.unregister(runId, ownController);
				});
			} finally {
				try {
					unregisterToolAdmission();
				} finally {
					terminalEvents.dispose();
				}
			}
		}
	}
}
