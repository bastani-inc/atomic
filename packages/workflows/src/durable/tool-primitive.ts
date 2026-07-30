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
import type { ToolNodeSnapshot } from "../shared/store-types.js";
import type {
	WorkflowSerializableValue,
	WorkflowToolOptions,
	WorkflowToolOutcome,
	WorkflowToolPrimitive,
} from "../shared/types.js";
import { field, hasProcessFailureEvidence, normalizeCode } from "../shared/workflow-failures-signals.js";
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

export type { WorkflowToolOptions, WorkflowToolPrimitive } from "../shared/types.js";

type WorkflowToolInvocationResult<TValue extends WorkflowSerializableValue> = TValue | WorkflowToolOutcome<TValue>;

export type WorkflowToolExecutionAdmission =
	| { readonly accepted?: true; bindNode(nodeId: string): void }
	| { readonly accepted: false; readonly error: Error; bindNode(nodeId: string): void };

export interface CreateToolPrimitiveInput {
	readonly workflowId: string;
	readonly backend: DurableWorkflowBackend;
	/** Monotonic checkpoint id counter source. */
	readonly nextCheckpointId: () => string;
	/** Abort check; throws if the workflow has been cancelled. */
	readonly throwIfCancelled: () => void;
	/** Optional signal for aborting retry backoff sleeps. */
	readonly signal?: AbortSignal;
	/** Track the final logical execution promise and bind it to its graph node. */
	readonly trackExecution?: <T>(execution: Promise<T>) => WorkflowToolExecutionAdmission | void;
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
		fn: () => Promise<T>,
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
		const admission = input.trackExecution?.(execution);
		if (admission?.accepted === false) {
			void execution.catch(() => undefined);
			rejectExecution(admission.error);
			return execution;
		}
		void executeToolInvocation(input, ordinals, name, args, fn, options, (nodeId) =>
			admission?.bindNode(nodeId),
		).then(resolveExecution, rejectExecution);
		return execution;
	}) as WorkflowToolPrimitive;
}

async function executeToolInvocation<T extends WorkflowSerializableValue>(
	input: CreateToolPrimitiveInput,
	ordinals: Map<string, number>,
	name: string,
	args: Readonly<Record<string, WorkflowSerializableValue>>,
	fn: () => Promise<T>,
	options: WorkflowToolOptions | undefined,
	bindNode: (nodeId: string) => void,
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
	bindNode(node.id);
	input.onNodeStart?.(node);
	if (cached !== undefined) {
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
			const status = input.signal?.aborted === true ? "cancelled" : "failed";
			if (status === "failed") input.onFailureObserved?.(error, node.id);
			input.onNodeEnd?.(node.id, {
				status,
				endedAt: Date.now(),
				error: error instanceof Error ? error.message : String(error),
			});
			input.onNodeSettle?.(node.id);
			throw error;
		}
	}
	let callbackError: unknown;

	const startedAt = Date.now();
	let attempts = 0;
	let callbackCompleted = false;
	input.onNodeRunning?.(node.id, startedAt);
	try {
		const result = await executeWithRetries(
			() => {
				attempts += 1;
				return runCallback({ kind: "workflow.ctx_tool", name, runId: input.workflowId }, fn).catch(
					(error: unknown) => {
						callbackError = error;
						throw error;
					},
				);
			},
			options,
			input.throwIfCancelled,
			input.signal,
		);
		callbackCompleted = true;
		const output = returnFailure ? workflowToolSuccess(result, attempts, false) : result;

		// Linearization policy: cancellation observed before persistence prevents
		// a checkpoint. Once the durable write begins, a successful commit wins
		// for this node; the root still observes its aborted signal and is killed.
		input.throwIfCancelled();
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
		try {
			throwIfInvocationCancelled(input);
		} catch (cancelledError) {
			input.onNodeEnd?.(node.id, {
				status: "cancelled",
				endedAt: Date.now(),
				error: cancelledError instanceof Error ? cancelledError.message : String(cancelledError),
			});
			input.onNodeSettle?.(node.id);
			throw cancelledError;
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
			throwIfInvocationCancelled(input);
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
	}
}

function throwIfInvocationCancelled(input: CreateToolPrimitiveInput): void {
	input.throwIfCancelled();
	if (!input.signal?.aborted) return;
	throw input.signal.reason instanceof Error ? input.signal.reason : new Error("atomic-workflows: workflow cancelled");
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
function summarizeToolResult(value: WorkflowSerializableValue): string {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) return String(value).slice(0, 240);
	return serialized.length <= 240 ? serialized : `${serialized.slice(0, 237)}...`;
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

export function sleepOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted)
		return Promise.reject(
			signal.reason instanceof Error ? signal.reason : new Error("atomic-workflows: workflow cancelled"),
		);
	return new Promise((resolve, reject) => {
		let settled = false;
		const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
		const finish = (): void => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve();
		};
		const fail = (err: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			cleanup();
			reject(err);
		};
		const timer = setTimeout(finish, ms);
		const onAbort = (): void =>
			fail(signal?.reason instanceof Error ? signal.reason : new Error("atomic-workflows: workflow cancelled"));
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Create a monotonic checkpoint id generator for a workflow.
 */
export function createCheckpointIdGenerator(): () => string {
	let counter = 0;
	return () => `cp-${++counter}`;
}
