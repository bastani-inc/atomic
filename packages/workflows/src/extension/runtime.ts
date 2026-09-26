/**
 * ExtensionRuntime — facade that owns the WorkflowRegistry and delegates
 * tool/slash dispatch through the WorkflowDispatcher.
 *
 * Startup seam: callers supply a registry directly (from a discovery worker
 * or createBundledWorkflowRegistry if available) or a list of compiled
 * definitions.  The runtime itself is registry-agnostic.
 *
 * cross-ref: src/extension/dispatcher.ts
 *            src/workflows/registry.ts
 */

import { resumableEntryFromHandle } from "../durable/backend.js";
import { type DurabilityWarningSink, getDurableBackend, initializeDurableBackend } from "../durable/factory.js";
import { resolveResumeStage } from "../durable/resume-restart-point.js";
import { resumeDurableWorkflow } from "../durable/resume-runtime.js";
import { currentToolControlRegistry, type ToolControlRegistry } from "../engine/run-tool-control-registry.js";
import { type CancellationRegistry, currentCancellationRegistry } from "../runs/background/cancellation-registry.js";
import { currentJobTracker, type JobTracker } from "../runs/background/job-tracker.js";
import { type RunOpts, resolveAndValidateInputs } from "../runs/foreground/executor.js";
import { currentStageControlRegistry, type StageControlRegistry } from "../runs/foreground/stage-control-registry.js";
import type { StageAdapters } from "../runs/foreground/stage-runner.js";
import type { Store } from "../shared/store.js";
import { currentWorkflowStore } from "../shared/store-factory.js";
import type { RunSnapshot, WorkflowActor } from "../shared/store-types.js";
import type {
	WorkflowBudget,
	WorkflowDefinition,
	WorkflowExecutionPolicy,
	WorkflowMcpPort,
	WorkflowModelCatalogPort,
	WorkflowPersistencePort,
	WorkflowRuntimeConfig,
} from "../shared/types.js";
import type { WorkflowRegistry } from "../workflows/registry.js";
import { createRegistry } from "../workflows/registry.js";
import { dispatch } from "./dispatcher.js";
import type { WorkflowToolArgs } from "./index.js";
import type { WorkflowToolResult } from "./render-result.js";
import { createDurableResumeRuntime, type DurableResumeRuntime } from "./runtime-durable-resume.js";
import { raceWorkflowRequestAbort } from "./workflow-request-abort.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ExtensionRuntimeOpts {
	/**
	 * Pre-populated registry — takes precedence over `definitions`.
	 * Pass the output of a discovery worker / createBundledWorkflowRegistry here.
	 */
	registry?: WorkflowRegistry;
	/**
	 * Seed definitions used when no registry is provided.
	 * Typically populated by the discovery worker at startup.
	 */
	definitions?: WorkflowDefinition[];
	/** Stage adapters forwarded to the executor (prompt/complete). */
	adapters?: StageAdapters;

	/** Store override (defaults to the singleton store). */
	store?: Store;
	/** Cancellation registry forwarded to the executor. */
	cancellation?: CancellationRegistry;
	stageControlRegistry?: StageControlRegistry;
	toolControlRegistry?: ToolControlRegistry;
	/** Persistence port forwarded to the executor. */
	persistence?: WorkflowPersistencePort;
	/** MCP scope-gating port forwarded to the executor. */
	mcp?: WorkflowMcpPort;
	/**
	 * Resolved runtime configuration. Injected by the composition root after
	 * merging file config with defaults. Forwarded to dispatch → run/runDetached.
	 */
	config?: WorkflowRuntimeConfig;
	/** Optional model catalog forwarded to workflow runs for fallback resolution. */
	models?: WorkflowModelCatalogPort;
	/** Job tracker forwarded to named detached runs. */
	jobs?: JobTracker;
	/** Invocation cwd used for workflow execution. Defaults to process.cwd(). */
	cwd?: string;
	/** Display-only degradation warning reporter supplied by the host composition root. */
	durabilityWarningSink?: DurabilityWarningSink;
	/** Resolve the host's non-default session directory for workflow stage transcripts. */
	resolveDefaultStageSessionDir?: () => string | undefined;
	/**
	 * Resolves a workflow definition's source path for the D1 possible-stage
	 * scan at launch (discovery filePath, else the builtin source probe).
	 * When absent, launch skips the scan and the run simply has no set.
	 */
	resolvePossibleStageEntry?: (normalizedName: string) => string | undefined;
	/** Seed lifecycle state before historical completed snapshots are restored. */
	beforeRestoreCompleted?: (snapshots: readonly RunSnapshot[]) => void;
}
// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------
export type ResumeFailedRunResult =
	| {
			ok: true;
			runId: string;
			sourceRunId: string;
			resumeFromStageId?: string;
			resumeFromToolNodeId?: string;
			message: string;
	  }
	| {
			ok: false;
			reason: "run_not_found" | "not_resumable" | "workflow_not_found" | "insufficient_state";
			message: string;
	  };

export interface ExtensionRuntime extends DurableResumeRuntime {
	/**
	 * Live registry — read-only reference.
	 * Reflects all definitions registered at startup.
	 */
	readonly registry: WorkflowRegistry;

	/**
	 * Dispatch a `list`, `inputs`, or `run` action.
	 * Status and run-control actions use the dedicated control modules directly.
	 */
	dispatch(args: WorkflowToolArgs, options?: RuntimeDispatchOptions): Promise<WorkflowToolResult>;

	/** Resume a failed resumable named workflow under its existing execution identity. */
	resumeFailedRun(
		sourceRunId: string,
		stageId?: string,
		options?: RuntimeDispatchOptions,
	): Promise<ResumeFailedRunResult>;
}
export interface RuntimeDispatchOptions {
	/** Session identity that owns a model-tool launch and its lifecycle controls. */
	readonly modelOwner?: string;
	readonly policy?: WorkflowExecutionPolicy;
	/** Who launched this run. Only an attributable launcher supplies it. */
	readonly origin?: WorkflowActor;
	/** Who requested this resume. Only an attributable requester supplies it. */
	readonly actor?: WorkflowActor;
	/** Run-level budget override used when a continuation is launched. */
	readonly budget?: WorkflowBudget;
	/** Cancels initialization before acknowledgement; acknowledged execution stays detached. */
	readonly signal?: AbortSignal;
	/** Reports the exact detached identity before startup admission is awaited. */
	readonly onRunAccepted?: (runId: string) => void;
}
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an ExtensionRuntime.
 *
 * @example — discovery worker registry
 * ```ts
 * const runtime = createExtensionRuntime({ registry: createBundledWorkflowRegistry() });
 * ```
 *
 * @example — explicit definitions
 * ```ts
 * const runtime = createExtensionRuntime({ definitions: [myWorkflow] });
 * ```
 */
export function createExtensionRuntime(opts: ExtensionRuntimeOpts = {}): ExtensionRuntime {
	const registry = opts.registry ?? createRegistry(opts.definitions ?? []);
	const adapters = opts.adapters;
	const activeStore = opts.store ?? currentWorkflowStore();
	const cancellation = opts.cancellation ?? currentCancellationRegistry();
	const stageControlRegistry = opts.stageControlRegistry ?? currentStageControlRegistry();
	const toolControlRegistry = opts.toolControlRegistry ?? currentToolControlRegistry();
	const persistence = opts.persistence;
	const mcp = opts.mcp;
	const config = opts.config;
	const models = opts.models;
	const jobs = opts.jobs ?? currentJobTracker();
	const durabilityWarningSink = opts.durabilityWarningSink;
	const runtimeCwd = opts.cwd ?? process.cwd();
	const resolveDefaultStageSessionDir = opts.resolveDefaultStageSessionDir;
	const resolvePossibleStageEntry = opts.resolvePossibleStageEntry;
	const beforeRestoreCompleted = opts.beforeRestoreCompleted;
	const ensureDbosReady = async () => {
		// Deliberately not memoized: the factory revalidates its memoized backend
		// against the current DBOS lifecycle generation, so caching a permanently
		// resolved promise here could mask a backend stopped after a
		// host-session replacement (issue #1957).
		return await initializeDurableBackend(durabilityWarningSink);
	};

	function runOptions(policy?: WorkflowExecutionPolicy): RunOpts {
		const defaultSessionDir = resolveDefaultStageSessionDir?.();
		return {
			adapters,
			store: activeStore,
			cancellation,
			stageControlRegistry,
			toolControlRegistry,
			persistence,
			mcp,
			config,
			models,
			...(defaultSessionDir !== undefined ? { defaultSessionDir } : {}),
			...(policy !== undefined ? { executionMode: policy.mode } : {}),
			registry,
			cwd: runtimeCwd,
		};
	}

	async function resumeFailedRun(
		sourceRunId: string,
		stageId?: string,
		options?: RuntimeDispatchOptions,
	): Promise<ResumeFailedRunResult> {
		options?.signal?.throwIfAborted();
		const source = activeStore.runs().find((run) => run.id === sourceRunId);
		if (source === undefined) {
			return { ok: false, reason: "run_not_found", message: `run not found: ${sourceRunId}` };
		}
		const isTerminalFailedResumable =
			source.status === "failed" && source.endedAt !== undefined && source.resumable !== false;
		const isBudgetResumable =
			source.result?.status === "budget_exceeded" && source.budgetState?.systemOwnedStop === true;
		const isActiveBlockedResumable =
			(source.endedAt === undefined || source.status === "blocked" || isBudgetResumable) &&
			source.resumable === true &&
			source.failureRecoverability === "recoverable";
		if (
			source.exitReason === "quit" ||
			source.status === "killed" ||
			(!isTerminalFailedResumable && !isActiveBlockedResumable)
		) {
			return { ok: false, reason: "not_resumable", message: `run ${sourceRunId} is not a resumable workflow run` };
		}
		const def = registry.get(source.name);
		if (def === undefined) {
			return { ok: false, reason: "workflow_not_found", message: `workflow_not_found: ${source.name}` };
		}
		const resolvedStage = resolveResumeStage(source, getDurableBackend(), stageId);
		if (!resolvedStage.ok) {
			return { ok: false, reason: "insufficient_state", message: resolvedStage.message };
		}
		const sourceInputs = { ...source.inputs };
		try {
			resolveAndValidateInputs(def.inputs, sourceInputs, `workflow "${def.name}"`);
		} catch (err) {
			return {
				ok: false,
				reason: "insufficient_state",
				message: `insufficient_state: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
		const backend = getDurableBackend();
		const handle = backend.getWorkflow(source.id);
		if (handle === undefined)
			return { ok: false, reason: "insufficient_state", message: `No durable checkpoint state for ${source.id}.` };
		const resumed = await resumeDurableWorkflow(
			source.id,
			{
				registry,
				durableBackend: backend,
				jobs,
				signal: options?.signal,
				onRunAccepted: options?.onRunAccepted,
				baseRunOpts: {
					...runOptions(options?.policy),
					...(options?.actor === undefined ? {} : { resumeActor: options.actor }),
					...(options?.budget === undefined ? {} : { budget: options.budget }),
					continuation: {
						source,
						...(resolvedStage.stageId === undefined ? {} : { resumeFromStageId: resolvedStage.stageId }),
						...(resolvedStage.toolNodeId === undefined ? {} : { resumeFromToolNodeId: resolvedStage.toolNodeId }),
					},
				},
			},
			[resumableEntryFromHandle(handle)],
		);
		if (!resumed.ok)
			return {
				ok: false,
				reason:
					resumed.reason === "workflow_not_found"
						? "workflow_not_found"
						: resumed.reason === "not_resumable" || resumed.reason === "stale"
							? "not_resumable"
							: "insufficient_state",
				message: resumed.message,
			};
		return {
			ok: true,
			runId: source.id,
			sourceRunId: source.id,
			resumeFromStageId: resolvedStage.stageId,
			...(resolvedStage.toolNodeId === undefined ? {} : { resumeFromToolNodeId: resolvedStage.toolNodeId }),
			message: resumed.message,
		};
	}

	return {
		get registry(): WorkflowRegistry {
			return registry;
		},

		async dispatch(args: WorkflowToolArgs, options?: RuntimeDispatchOptions): Promise<WorkflowToolResult> {
			options?.signal?.throwIfAborted();
			await raceWorkflowRequestAbort(ensureDbosReady(), options?.signal);
			options?.signal?.throwIfAborted();
			const defaultSessionDir = resolveDefaultStageSessionDir?.();
			return dispatch(args, {
				registry,
				adapters,
				store: activeStore,
				cancellation,
				stageControlRegistry,
				toolControlRegistry,
				jobs,
				persistence,
				mcp,
				config,
				models,
				resolvePossibleStageEntry,
				policy: options?.policy,
				modelOwner: options?.modelOwner,
				...(options?.origin === undefined ? {} : { origin: options.origin }),
				...(options?.signal === undefined ? {} : { signal: options.signal }),
				...(options?.onRunAccepted === undefined ? {} : { onRunAccepted: options.onRunAccepted }),
				cwd: runtimeCwd,
				...(defaultSessionDir !== undefined ? { defaultSessionDir } : {}),
			});
		},

		resumeFailedRun: (sourceRunId, stageId, options) =>
			raceWorkflowRequestAbort(resumeFailedRun(sourceRunId, stageId, options), options?.signal),
		...createDurableResumeRuntime({
			registry,
			store: activeStore,
			adapters,
			runtimeCwd,
			ensureReady: ensureDbosReady,
			resolveDefaultStageSessionDir,
			baseRunOpts: (policy) => runOptions(policy),
			beforeRestoreCompleted,
			...(jobs !== undefined ? { jobs } : {}),
		}),
	};
}
