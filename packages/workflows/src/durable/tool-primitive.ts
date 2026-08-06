/**
 * `ctx.tool` primitive — durable cached execution of arbitrary TypeScript code.
 *
 * Runs a user-supplied async function and caches the result durably via the
 * {@link DurableWorkflowBackend}. On resume, if the tool already completed
 * (matched by content hash of name + args), the cached result is returned
 * without re-executing the function — ensuring completed side effects are not
 * repeated.
 *
 * Only `ctx.*` blocks produce durable checkpoints. Anything outside `ctx.*`
 * (including bare `await someFunction()`) is never saved, matching the issue's
 * requirement: "checkpoints are effectively only `ctx.*` blocks."
 *
 * cross-ref: issue #1498 — "Introduce ctx.tool which allows you to run any
 * typescript code and cache the result for DBOS."
 */

import { runCallback } from "@bastani/atomic";
import { sleepOrAbort } from "../runs/shared/retry.js";
import { flattenTruncatedString } from "../shared/flat-string.js";
import type { ToolNodeSnapshot } from "../shared/store-types.js";
import type {
	WorkflowSerializableValue,
	WorkflowToolContext,
	WorkflowToolOptions,
	WorkflowToolOutcome,
	WorkflowToolPrimitive,
} from "../shared/types.js";
import { field, hasProcessFailureEvidence, normalizeCode } from "../shared/workflow-failures-signals.js";

export { sleepOrAbort } from "../runs/shared/retry.js";

import type { DurableWorkflowBackend } from "./backend.js";
import { durableHash } from "./backend.js";
import { recordThrowingToolFailure } from "./tool-failure-checkpoint.js";
import {
	replayedWorkflowToolOutcome,
	workflowToolFailure,
	workflowToolOutcomeFromValue,
	workflowToolSuccess,
} from "./tool-outcome.js";
import {
	DURABLE_TOOL_TOPOLOGY_VERSION,
	type DurableCheckpoint,
	type DurableStageRunTopology,
	type DurableToolCheckpoint,
} from "./types.js";

export type { WorkflowToolContext, WorkflowToolOptions, WorkflowToolPrimitive } from "../shared/types.js";

type WorkflowToolInvocationResult<TValue extends WorkflowSerializableValue> = TValue | WorkflowToolOutcome<TValue>;

export type WorkflowToolExecutionAdmission =
	| { readonly accepted?: true; bindNode(nodeId: string): void; noteCancelled?(): void }
	| { readonly accepted: false; readonly error: Error; bindNode(nodeId: string): void; noteCancelled?(): void };

/** Per-node abort control published while one logical tool call is in flight. */
export interface ToolNodeControlRegistration {
	readonly nodeId: string;
	readonly name: string;
	readonly controller: AbortController;
	readonly settled: Promise<void>;
}

interface ToolInvocationAdmissionControl {
	bindNode(nodeId: string): void;
	noteCancelled(): void;
	/**
	 * End this call's admission registration section. Called as soon as the live
	 * node controller is published, or as soon as the call resolves without a
	 * live callback, so a quit closing admission waits microseconds.
	 */
	releaseAdmission(): void;
}

/**
 * Result of entering the root-shared admission boundary. Structural on purpose:
 * the boundary itself lives in the engine, and `durable/` must not depend on it.
 */
export type ToolCallAdmission =
	| { readonly accepted: true; readonly lease: { release(): void } }
	| { readonly accepted: false; readonly error: Error };

export interface CreateToolPrimitiveInput {
	readonly workflowId: string;
	readonly backend: DurableWorkflowBackend;
	/** Monotonic checkpoint id counter source. */
	readonly nextCheckpointId: () => string;
	/** Abort check; throws if the workflow has been cancelled. */
	readonly throwIfCancelled: () => void;
	/** Optional run-level signal; combined with the per-node signal handed to `fn`. */
	readonly signal?: AbortSignal;
	/**
	 * Publish the per-node abort control so `/workflow quit|interrupt` can abort
	 * one in-flight node. The returned disposer runs when the node settles.
	 */
	readonly registerNodeControl?: (registration: ToolNodeControlRegistration) => (() => void) | undefined;
	/**
	 * Enter the root-shared tool-admission boundary. A refusal means graceful
	 * quit already closed admission for this workflow tree; the call never runs.
	 */
	readonly admitToolCall?: () => ToolCallAdmission;
	/** Track the final logical execution promise and bind it to its graph node. */
	readonly trackExecution?: <T>(execution: Promise<T>) => WorkflowToolExecutionAdmission | undefined;
	/** Observe a logical throwing-mode failure before graph publication or promise rejection. */
	readonly onFailureObserved?: (error: unknown, nodeId: string) => void;
	/** Admit/update a first-class graph node around the durable call. */
	readonly onNodeStart?: (node: ToolNodeSnapshot) => void;
	readonly onNodeRunning?: (nodeId: string, startedAt: number) => void;
	readonly onNodeEnd?: (
		nodeId: string,
		update: Pick<ToolNodeSnapshot, "status"> & Partial<Pick<ToolNodeSnapshot, "endedAt" | "resultSummary" | "error">>,
	) => void;
	readonly onNodeSettle?: (nodeId: string) => void;
	readonly runTopology?: DurableStageRunTopology;
}

/**
 * Create the `ctx.tool` primitive wired to a durable backend.
 */
export function createToolPrimitive(input: CreateToolPrimitiveInput): WorkflowToolPrimitive {
	const ordinals = new Map<string, number>();
	return (<T extends WorkflowSerializableValue>(
		name: string,
		args: Readonly<Record<string, WorkflowSerializableValue>>,
		fn: (toolCtx: WorkflowToolContext) => Promise<T>,
		options?: WorkflowToolOptions,
	): Promise<WorkflowToolInvocationResult<T>> => {
		let resolveExecution!: (
			value: WorkflowToolInvocationResult<T> | PromiseLike<WorkflowToolInvocationResult<T>>,
		) => void;
		let rejectExecution!: (reason?: unknown) => void;
		const execution = new Promise<WorkflowToolInvocationResult<T>>((resolve, reject) => {
			resolveExecution = resolve;
			rejectExecution = reject;
		});
		// The admission boundary is checked before tracker admission so a refused
		// post-quit call is a suspension, never an observed run failure.
		const boundaryAdmission = input.admitToolCall?.();
		if (boundaryAdmission?.accepted === false) {
			void execution.catch(() => undefined);
			rejectExecution(boundaryAdmission.error);
			return execution;
		}
		const lease = boundaryAdmission?.accepted === true ? boundaryAdmission.lease : undefined;
		const admission = input.trackExecution?.(execution);
		if (admission?.accepted === false) {
			lease?.release();
			void execution.catch(() => undefined);
			rejectExecution(admission.error);
			return execution;
		}
		const control: ToolInvocationAdmissionControl = {
			bindNode: (nodeId) => admission?.bindNode(nodeId),
			noteCancelled: () => admission?.noteCancelled?.(),
			releaseAdmission: () => lease?.release(),
		};
		void executeToolInvocation(input, ordinals, name, args, fn, options, control)
			// Backstop for a throw before either explicit release point; the lease
			// release itself is idempotent.
			.finally(() => lease?.release())
			.then(resolveExecution, rejectExecution);
		return execution;
	}) as WorkflowToolPrimitive;
}

async function executeToolInvocation<T extends WorkflowSerializableValue>(
	input: CreateToolPrimitiveInput,
	ordinals: Map<string, number>,
	name: string,
	args: Readonly<Record<string, WorkflowSerializableValue>>,
	fn: (toolCtx: WorkflowToolContext) => Promise<T>,
	options: WorkflowToolOptions | undefined,
	control: ToolInvocationAdmissionControl,
): Promise<WorkflowToolInvocationResult<T>> {
	input.throwIfCancelled();
	if (
		options?.retriesAllowed === true &&
		options.maxAttempts !== undefined &&
		(!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1)
	) {
		throw new RangeError("atomic-workflows: ctx.tool maxAttempts must be a positive integer");
	}
	const returnFailure = options?.failureMode === "return";
	const identityMode = returnFailure ? { failureMode: "return" as const } : {};
	const callKey = durableHash({ name, args, ...identityMode });
	const ordinal = (ordinals.get(callKey) ?? 0) + 1;
	ordinals.set(callKey, ordinal);
	const argsHash = durableHash({ name, args, ordinal, ...identityMode });

	const cached = input.backend.getToolCheckpoint(input.workflowId, argsHash);
	const node: ToolNodeSnapshot = {
		kind: "tool",
		id: cached?.topology?.nodeId ?? `tool:${argsHash}`,
		name,
		argsHash,
		ordinal: cached?.topology?.ordinal ?? ordinal,
		parentIds: Object.freeze(cached?.topology?.parentIds ?? []),
		status: "pending",
		...(cached !== undefined && cached.topology === undefined ? { topologyState: "unavailable" as const } : {}),
		...(cached !== undefined ? { replayed: true } : {}),
		...(cached?.topology?.order !== undefined ? { executionOrder: cached.topology.order } : {}),
		...(cached?.topology?.startedAt !== undefined ? { startedAt: cached.topology.startedAt } : {}),
		attachable: false,
	};
	control.bindNode(node.id);
	input.onNodeStart?.(node);
	if (cached !== undefined) {
		// A replayed call has no live callback to abort, so its registration
		// section ends here rather than at node-controller publication.
		control.releaseAdmission();
		const endedAt = cached.topology?.endedAt ?? cached.completedAt;
		try {
			await recordReplayedToolTopology(input, node, cached, argsHash, endedAt);
			const returnedOutcome =
				cached.outcomeKind === undefined ? undefined : workflowToolOutcomeFromValue<T>(cached.output);
			if (cached.outcomeKind !== undefined && returnedOutcome === undefined) {
				throw new Error(`atomic-workflows: invalid durable return outcome for ctx.tool ${name}`);
			}
			const output =
				returnedOutcome === undefined ? (cached.output as T) : replayedWorkflowToolOutcome(returnedOutcome);
			const failed = cached.outcomeKind === "return_failure";
			input.onNodeEnd?.(node.id, {
				status: failed ? "failed" : "cached",
				endedAt,
				...(failed && returnedOutcome?.ok === false
					? { error: returnedOutcome.error.message }
					: { resultSummary: summarizeToolResult(output) }),
			});
			input.onNodeSettle?.(node.id);
			return output;
		} catch (error) {
			const cancelled = input.signal?.aborted === true;
			if (cancelled) control.noteCancelled();
			else input.onFailureObserved?.(error, node.id);
			input.onNodeEnd?.(node.id, {
				status: cancelled ? "cancelled" : "failed",
				endedAt: Date.now(),
				error: error instanceof Error ? error.message : String(error),
			});
			input.onNodeSettle?.(node.id);
			throw error;
		}
	}
	return executeLiveToolInvocation({
		input,
		node,
		name,
		argsHash,
		ordinal,
		fn,
		options,
		control,
		returnFailure,
	});
}

interface LiveToolInvocation<T extends WorkflowSerializableValue> {
	readonly input: CreateToolPrimitiveInput;
	readonly node: ToolNodeSnapshot;
	readonly name: string;
	readonly argsHash: string;
	readonly ordinal: number;
	readonly fn: (toolCtx: WorkflowToolContext) => Promise<T>;
	readonly options: WorkflowToolOptions | undefined;
	readonly control: ToolInvocationAdmissionControl;
	readonly returnFailure: boolean;
}

/**
 * Execute one uncached tool call under its own abort controller.
 *
 * The callback signal combines the run signal with this node's controller, so a
 * run abort cascades to every node while `/workflow quit|interrupt` can abort
 * exactly one node without touching its siblings. A cancelled call never writes
 * a replayable checkpoint, so resume re-executes it at the same ordinal.
 */
async function executeLiveToolInvocation<T extends WorkflowSerializableValue>(
	live: LiveToolInvocation<T>,
): Promise<WorkflowToolInvocationResult<T>> {
	const { input, node, name, argsHash, ordinal, fn, options, control, returnFailure } = live;
	const nodeController = new AbortController();
	const toolSignal =
		input.signal === undefined ? nodeController.signal : AbortSignal.any([input.signal, nodeController.signal]);
	const settlement = Promise.withResolvers<void>();
	const unregisterControl = input.registerNodeControl?.({
		nodeId: node.id,
		name,
		controller: nodeController,
		settled: settlement.promise,
	});
	// The node is now abortable by quit, so this call's admission registration
	// section ends. Everything after this point is observable to `quitRun`.
	control.releaseAdmission();
	let callbackError: unknown;

	const startedAt = Date.now();
	let attempts = 0;
	let callbackCompleted = false;
	input.onNodeRunning?.(node.id, startedAt);
	try {
		const result = await executeWithRetries(
			() => {
				attempts += 1;
				return runCallback({ kind: "workflow.ctx_tool", name, runId: input.workflowId }, () =>
					fn({ signal: toolSignal }),
				).catch((error: unknown) => {
					callbackError = error;
					throw error;
				});
			},
			options,
			() => throwIfInvocationCancelled(input, toolSignal),
			toolSignal,
		);
		callbackCompleted = true;
		const output = returnFailure ? workflowToolSuccess(result, attempts, false) : result;

		// Linearization policy: cancellation observed before persistence prevents
		// a checkpoint. Once the durable write begins, a successful commit wins
		// for this node; the root still observes its aborted signal and is killed.
		// An abandoned callback that ignores its signal and returns late is
		// caught here, so its value can never become a replayable checkpoint.
		throwIfInvocationCancelled(input, toolSignal);
		const completedAt = Date.now();
		const checkpoint: DurableToolCheckpoint = {
			kind: "tool",
			workflowId: input.workflowId,
			checkpointId: `tool:${argsHash}`,
			name,
			argsHash,
			output,
			...(returnFailure ? { outcomeKind: "return_success" as const } : {}),
			completedAt,
			topology: {
				version: DURABLE_TOOL_TOPOLOGY_VERSION,
				nodeId: node.id,
				ordinal,
				order: node.executionOrder ?? 0,
				parentIds: [...node.parentIds],
				startedAt,
				endedAt: completedAt,
				...(input.runTopology !== undefined ? { run: { ...input.runTopology } } : {}),
			},
		};
		await recordCheckpointDurably(input.backend, checkpoint);
		input.onNodeEnd?.(node.id, {
			status: "completed",
			endedAt: completedAt,
			resultSummary: summarizeToolResult(output),
		});
		input.onNodeSettle?.(node.id);
		return output;
	} catch (error) {
		const cancellation = invocationCancellation(input, toolSignal);
		if (cancellation !== undefined) {
			control.noteCancelled();
			// A cancelled call never writes a replayable `tool:` checkpoint and never
			// a `return_failure` outcome, so resume re-executes it at the same
			// ordinal instead of replaying a cancellation as data. Return mode still
			// keeps one inspection-only `tool-failure:` record, which the backend
			// excludes from replay lookup. The record is written for every
			// cancellation timing — while the callback awaits, when it throws, and
			// when it fulfills after abort but before persistence — because this
			// branch runs at most once per logical invocation.
			if (returnFailure) {
				await recordCancelledToolInspection(live, startedAt, cancellation, attempts);
			}
			input.onNodeEnd?.(node.id, {
				status: "cancelled",
				endedAt: Date.now(),
				error: cancellation.message,
			});
			input.onNodeSettle?.(node.id);
			throw cancellation;
		}
		const callbackFailure = callbackError ?? error;
		if (returnFailure && !callbackCompleted && isExplicitCallbackCancellation(callbackFailure)) {
			input.onFailureObserved?.(callbackFailure, node.id);
			const failure = await recordThrowingToolFailure(
				input,
				node,
				{ name, argsHash, ordinal, startedAt },
				callbackFailure,
				attempts,
			);
			input.onNodeEnd?.(node.id, { status: "failed", endedAt: failure.failedAt, error: failure.message });
			input.onNodeSettle?.(node.id);
			throw callbackFailure;
		}
		if (returnFailure && !callbackCompleted) {
			const outcome = workflowToolFailure(callbackFailure, attempts, false);
			const completedAt = Date.now();
			const checkpoint: DurableToolCheckpoint = {
				kind: "tool",
				workflowId: input.workflowId,
				checkpointId: `tool:${argsHash}`,
				name,
				argsHash,
				output: outcome,
				outcomeKind: "return_failure",
				completedAt,
				topology: {
					version: DURABLE_TOOL_TOPOLOGY_VERSION,
					nodeId: node.id,
					ordinal,
					order: node.executionOrder ?? 0,
					parentIds: [...node.parentIds],
					startedAt,
					endedAt: completedAt,
					...(input.runTopology !== undefined ? { run: { ...input.runTopology } } : {}),
				},
			};
			try {
				await recordCheckpointDurably(input.backend, checkpoint);
			} catch (persistenceError) {
				input.onFailureObserved?.(persistenceError, node.id);
				input.onNodeEnd?.(node.id, {
					status: "failed",
					endedAt: Date.now(),
					error: persistenceError instanceof Error ? persistenceError.message : String(persistenceError),
				});
				input.onNodeSettle?.(node.id);
				throw persistenceError;
			}
			input.onNodeEnd?.(node.id, { status: "failed", endedAt: completedAt, error: outcome.error.message });
			input.onNodeSettle?.(node.id);
			throwIfInvocationCancelled(input, toolSignal);
			return outcome;
		}
		input.onFailureObserved?.(error, node.id);
		const failure = await recordThrowingToolFailure(
			input,
			node,
			{ name, argsHash, ordinal, startedAt },
			error,
			attempts,
		);
		input.onNodeEnd?.(node.id, { status: "failed", endedAt: failure.failedAt, error: failure.message });
		input.onNodeSettle?.(node.id);
		throw error;
	} finally {
		settlement.resolve();
		unregisterControl?.();
	}
}

/**
 * Persist exactly one inspection-only cancellation record for a
 * `failureMode: "return"` call.
 *
 * The record uses the non-replayable `tool-failure:` id, so
 * `getToolCheckpoint()` still returns undefined and resume re-runs the call. It
 * is best effort: a diagnostic write failure must not turn cancellation into a
 * storage failure, and no `return_failure` outcome is ever written.
 */
async function recordCancelledToolInspection<T extends WorkflowSerializableValue>(
	live: LiveToolInvocation<T>,
	startedAt: number,
	cancellation: Error,
	attempts: number,
): Promise<void> {
	try {
		await recordThrowingToolFailure(
			live.input,
			live.node,
			{ name: live.name, argsHash: live.argsHash, ordinal: live.ordinal, startedAt },
			cancellation,
			attempts,
		);
	} catch {
		// Inspection metadata is optional; the cancellation itself is authoritative.
	}
}

/** Resolve the cancellation reason for this invocation, if it was cancelled. */
function invocationCancellation(input: CreateToolPrimitiveInput, signal: AbortSignal): Error | undefined {
	try {
		input.throwIfCancelled();
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
	if (!signal.aborted) return undefined;
	return signal.reason instanceof Error ? signal.reason : new Error("atomic-workflows: workflow cancelled");
}

function throwIfInvocationCancelled(input: CreateToolPrimitiveInput, signal: AbortSignal): void {
	const cancellation = invocationCancellation(input, signal);
	if (cancellation !== undefined) throw cancellation;
}

const CALLBACK_CANCELLATION_NAMES = new Set([
	"aborterror",
	"aborted",
	"cancelederror",
	"cancellederror",
	"canceled",
	"cancelled",
]);
const CALLBACK_CANCELLATION_CODES = new Set([
	"aborterror",
	"abort_err",
	"aborted",
	"canceled",
	"cancelled",
	"ecanceled",
	"ecancelled",
	"err_canceled",
	"err_cancelled",
]);
const CALLBACK_CANCELLATION_STOP_REASONS = new Set(["aborted", "canceled", "cancelled"]);

function safeCancellationField(error: unknown, key: string): unknown {
	try {
		return field(error, key);
	} catch {
		return undefined;
	}
}

function hasCancellationMarker(markers: ReadonlySet<string>, value: unknown): boolean {
	return (typeof value === "string" || typeof value === "number") && markers.has(normalizeCode(value) ?? "");
}

function isExplicitCallbackCancellation(error: unknown): boolean {
	const seen = new Set<object>();
	const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value: error, depth: 0 }];
	while (pending.length > 0) {
		const current = pending.pop()!;
		if (current.value === undefined || current.value === null || current.depth >= 8) continue;
		if (typeof current.value === "object") {
			if (seen.has(current.value)) continue;
			seen.add(current.value);
		}
		const hasProcessFailure = hasProcessFailureEvidence(current.value);
		if (
			!hasProcessFailure &&
			hasCancellationMarker(CALLBACK_CANCELLATION_NAMES, safeCancellationField(current.value, "name"))
		)
			return true;
		if (
			!hasProcessFailure &&
			hasCancellationMarker(CALLBACK_CANCELLATION_STOP_REASONS, safeCancellationField(current.value, "stopReason"))
		)
			return true;
		if (
			!hasProcessFailure &&
			hasCancellationMarker(CALLBACK_CANCELLATION_CODES, safeCancellationField(current.value, "code"))
		)
			return true;

		for (const key of ["cause", "error", "response", "body"] as const) {
			pending.push({ value: safeCancellationField(current.value, key), depth: current.depth + 1 });
		}
		for (const key of ["diagnostics", "errors"] as const) {
			const entries = safeCancellationField(current.value, key);
			if (!Array.isArray(entries)) continue;
			for (const entry of entries) {
				pending.push({
					value: key === "diagnostics" ? (safeCancellationField(entry, "error") ?? entry) : entry,
					depth: current.depth + 1,
				});
			}
		}
	}
	return false;
}

async function recordReplayedToolTopology(
	input: CreateToolPrimitiveInput,
	node: ToolNodeSnapshot,
	cached: DurableToolCheckpoint,
	argsHash: string,
	endedAt: number,
): Promise<void> {
	const runTopology = input.runTopology;
	if (runTopology === undefined) return;
	if (cached.topology === undefined && runTopology.parentRunId === undefined) return;
	if (cached.topology?.run?.runId === runTopology.runId) return;
	const topology =
		cached.topology === undefined
			? {
					version: DURABLE_TOOL_TOPOLOGY_VERSION,
					nodeId: node.id,
					ordinal: node.ordinal,
					order: node.executionOrder ?? 0,
					parentIds: [...node.parentIds],
					endedAt,
					run: { ...runTopology },
				}
			: {
					...cached.topology,
					parentIds: [...node.parentIds],
					order: node.executionOrder ?? cached.topology.order,
					endedAt,
					run: { ...runTopology },
				};
	const unchanged =
		cached.topology !== undefined &&
		JSON.stringify(cached.topology.parentIds) === JSON.stringify(topology.parentIds) &&
		JSON.stringify(cached.topology.run) === JSON.stringify(topology.run) &&
		cached.topology.endedAt === topology.endedAt;
	if (unchanged) return;
	await input.backend.recordAdditiveCheckpointBestEffort({
		kind: "tool",
		workflowId: input.workflowId,
		checkpointId: `tool-replay-meta:${durableHash({ argsHash, topology })}`,
		name: node.name,
		argsHash,
		output: cached.output,
		...(cached.outcomeKind !== undefined ? { outcomeKind: cached.outcomeKind } : {}),
		completedAt: Date.now(),
		topology,
	});
	input.throwIfCancelled();
}
/**
 * Summaries are written into durable checkpoints and read back by status and
 * graph inspection, so they outlive the value they came from. Flatten the
 * truncation: a bare `slice` leaves a SlicedString pointing at the whole
 * serialized payload, and the 240-character bound would cap what you can read
 * without capping what is retained.
 */
function summarizeToolResult(value: WorkflowSerializableValue): string {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) return flattenTruncatedString(String(value).slice(0, 240));
	return serialized.length <= 240 ? serialized : `${flattenTruncatedString(serialized.slice(0, 237))}...`;
}

export async function recordCheckpointDurably(
	backend: DurableWorkflowBackend,
	checkpoint: DurableCheckpoint,
): Promise<void> {
	await backend.recordCheckpointAsync(checkpoint);
}

async function executeWithRetries<T>(
	fn: () => Promise<T>,
	options: WorkflowToolOptions | undefined,
	throwIfCancelled: () => void,
	signal?: AbortSignal,
): Promise<T> {
	throwIfCancelled();
	if (!options?.retriesAllowed) return fn();
	const maxAttempts = options.maxAttempts ?? 3;
	const intervalMs = options.intervalMs ?? 1000;
	const backoffRate = options.backoffRate ?? 2;
	let lastError: Error | undefined;
	let delay = intervalMs;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		throwIfCancelled();
		try {
			return await fn();
		} catch (err) {
			if (isExplicitCallbackCancellation(err)) throw err;
			lastError = err instanceof Error ? err : new Error(String(err));
			if (attempt < maxAttempts) {
				await sleepOrAbort(delay, signal);
				throwIfCancelled();
				delay = Math.min(delay * backoffRate, 3600_000);
			}
		}
	}
	throw lastError ?? new Error("ctx.tool: retries exhausted");
}

/**
 * Create a monotonic checkpoint id generator for a workflow.
 */
export function createCheckpointIdGenerator(): () => string {
	let counter = 0;
	return () => `cp-${++counter}`;
}
