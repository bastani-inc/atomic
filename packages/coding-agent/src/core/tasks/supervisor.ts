import { AsyncResource } from "node:async_hooks";
import type * as native from "@bastani/atomic-natives";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createModuleRequire } from "../../utils/module-require.ts";
import type { AgentSessionEvent } from "../agent-session.js";
import type { SessionManager } from "../session-manager.ts";
import { COMMAND_FOREGROUND_BUDGET_MS } from "./command-output.js";
import type { TaskCompletionSource } from "./completion-ordering.js";
import type * as C from "./contracts.js";

export type TaskTranscriptSource = Pick<SessionManager, "getSessionId" | "getEntries"> & {
	readonly completionSource?: TaskCompletionSource;
	/** Viewer-only subscription; updates never publish task lifecycle events. */
	subscribe?(listener: (event: AgentSessionEvent) => void): () => void;
	getStreamingMessage?(): AgentMessage | undefined;
};

export const DEFAULT_AGENT_WAIT_BUDGET_MS = 30000;
/** These objects are live authority, not DTOs, restart tokens or model arguments. */
class Capability {
	#live = true;
	toJSON(): never {
		throw new TypeError(`Task capability is not serializable (${this.#live ? "live" : "closed"})`);
	}
}
class HostCapability extends Capability {
	readonly kind = "host";
}
class OwnerCapability extends Capability {
	readonly kind = "owner";
}
class TaskCapability extends Capability {
	readonly kind = "task";
}
class WaitCapability extends Capability {
	readonly kind = "wait";
}
class SubscriptionCapability extends Capability {
	readonly kind = "subscription";
}
class StdinCapability extends Capability {
	readonly kind = "stdin";
}
export type StdinLease = StdinCapability;
export type HostSession = HostCapability;
export type OwnerLease = OwnerCapability;
export type TaskLease = TaskCapability;
export type WaitLease = WaitCapability;
export type SubscriptionLease = SubscriptionCapability;

export type FakeRunnerContext = {
	ref: C.NativeTaskRef;
	signal: AbortSignal;
	reportActivity(report: C.ActivityReport): C.Result<C.ReportReceipt, C.ReportError>;
	/** Bind existing child history while holding the admitted runner authority. */
	bindTranscript(session: TaskTranscriptSource): void;
};
/** Independent cleanup evidence: an outcome alone never proves resource release. */
export type FakeExecution = { result: Promise<C.TaskResult>; cleanup: Promise<C.Cleanup> };
export type TrustedTaskHost = {
	scope: C.OwnerScope;
	/** Owner-host observation settings; never an execution deadline. */
	tasks?: { wait?: C.TaskWaitConfiguration };
	/** The existing host/tool refusal throws here, before native admission. */
	authorizeCommandLaunch?(intent: C.CommandIntent): void;
	authorizeLaunch(intent: C.AgentIntent): void;
	onTaskSettled?(ref: C.NativeTaskRef, receipt: C.SettlementReceipt): void;
	createRunner(context: FakeRunnerContext, intent: C.AgentIntent): FakeExecution;
};
type HostState = { native: native.HostSession; binding: TrustedTaskHost };
type OwnerState = {
	native: native.OwnerLease;
	host: HostState;
	tasks: Map<C.TaskId, TaskLease>;
	watches: Set<TaskSubscription>;
	settledTasks: Set<C.TaskId>;
	commandAdmissions: Set<Promise<void>>;
};
type TaskState = {
	native: native.TaskLease;
	owner: OwnerState;
	ref: C.NativeTaskRef;
	controller: AbortController;
	kind?: "command";
	execution?: Promise<C.Result<C.Cleanup, C.ReportError>>;
	transcript?: TaskTranscriptSource;
	inheritedEntryCount?: number;
};
type WaitState = { native: native.WaitLease; outcome: Promise<C.Result<C.WaitOutcome, C.WaitError>> };

// Native supervisors share one actor per environment; their JS continuations must too.
const environment = {
	hosts: new WeakMap<HostSession, HostState>(),
	owners: new WeakMap<OwnerLease, OwnerState>(),
	tasks: new WeakMap<TaskLease, TaskState>(),
	inputs: new WeakMap<StdinLease, native.StdinLease>(),
	waits: new WeakMap<WaitLease, WaitState>(),
	waitRegistry: new Map<C.WaitId, WaitLease>(),
	ownerIds: new Map<C.OwnerId, OwnerLease>(),
};

/** Reads only history bound by the admitted runner, never a caller-selected session. */
export function taskTranscriptSource(
	task: TaskLease,
): C.Result<{ session: TaskTranscriptSource; taskId: C.TaskId }, C.Failure<"UnknownTask" | "TranscriptUnavailable">> {
	const state = environment.tasks.get(task);
	if (!state) return { ok: false, error: { code: "UnknownTask", message: "Unknown task" } };
	if (!state.transcript)
		return { ok: false, error: { code: "TranscriptUnavailable", message: "Transcript unavailable" } };
	return { ok: true, value: { session: state.transcript, taskId: state.ref.taskId } };
}

/** History the runner produced; a forked child's inherited parent entries are excluded. */
export function taskOwnTranscriptEntries(task: TaskLease): ReturnType<TaskTranscriptSource["getEntries"]> | undefined {
	const state = environment.tasks.get(task);
	return state?.transcript?.getEntries().slice(state.inheritedEntryCount ?? 0);
}

/** Promise rejections, setup throws and consumer exceptions may be arbitrary JavaScript values. */
function rejectionMessage<T>(reason: T): string {
	try {
		const message = reason instanceof Error ? reason.message : reason;
		return typeof message === "string" ? message : String(message);
	} catch {
		return "Unprintable JavaScript rejection";
	}
}
function mapped<T, U, Code extends string>(
	result: C.Result<T, native.TaskFailure>,
	convert: (value: T) => U,
	codes: readonly Code[],
): C.Result<U, C.Failure<Code>> {
	if (result.ok) return { ok: true, value: convert(result.value) };
	const code = codes.find((candidate) => candidate === result.error.code);
	if (!code) throw new Error(`Unexpected native task refusal: ${result.error.code}: ${result.error.message}`);
	return { ok: false, error: { code, message: result.error.message } };
}
const ownerErrors = ["ScopeMismatch", "EnvironmentClosing"] as const;
const startErrors = [
	"OwnerClosing",
	"UnknownAgent",
	"InvalidCwd",
	"DepthExceeded",
	"CapacityExhausted",
	"DispatchGuardBusy",
	"OperationConflict",
	"RunnerUnavailable",
	"SpawnFailed",
	"ContainmentUnavailable",
] as const;
const waitErrors = ["UnknownTask", "OwnerClosed", "EnvironmentClosing", "ScopeMismatch", "ObserverCancelled"] as const;
const reportErrors = ["StaleAttempt", "OwnerClosing", "TaskTerminal", "ReportConflict"] as const;
const watchErrors = ["OwnerClosed", "StaleGeneration", "EnvironmentClosing"] as const;
function reference(value: native.NativeTaskRef): C.NativeTaskRef {
	return {
		ownerId: value.ownerId as C.OwnerId,
		taskId: value.taskId as C.TaskId,
		attemptId: value.attemptId as C.AttemptId,
		generation: value.generation as C.Generation,
	};
}
function cursor(value: native.Cursor): C.Cursor {
	return { generation: value.generation as C.Generation, sequence: value.sequence as C.Sequence };
}
function output(value: native.OutputRef): C.OutputRef {
	return {
		ownerId: value.ownerId as C.OwnerId,
		taskId: value.taskId as C.TaskId,
		artifactId: value.artifactId,
		byteCount: value.byteCount,
		omittedRanges: value.omittedRanges.map(({ start, end }) => ({ start, end })),
	};
}
function taskResult(value: native.TaskResult): C.TaskResult {
	switch (value.kind) {
		case "completed":
			return {
				kind: value.kind,
				output: output(value.output),
				...(value.exitCode === undefined ? {} : { exitCode: value.exitCode }),
			};
		case "failed":
			return {
				kind: value.kind,
				code: value.code,
				message: value.message,
				...(value.output === undefined ? {} : { output: output(value.output) }),
				...(value.exitCode === undefined ? {} : { exitCode: value.exitCode }),
			};
		case "cancelled":
			return {
				kind: value.kind,
				cause: value.cause,
				...(value.output === undefined ? {} : { output: output(value.output) }),
			};
	}
}
function execution(value: native.Execution): C.Execution {
	return value.kind === "settled" ? { kind: "settled", result: taskResult(value.result) } : value;
}
function observation(value: native.HostObservation): C.HostObservation {
	if (value.kind === "foreground") return { kind: value.kind, waitId: value.waitId as C.WaitId };
	if (value.kind === "none" && (value.reason === "task-settled" || value.reason === "owner-closing"))
		return { kind: value.kind, reason: value.reason };
	const reasons = [
		"explicit",
		"default-background",
		"elapsed",
		"intercom-coordination",
		"input-needed",
		"not-observed",
		"observer-cancelled",
	] as const;
	const reason = reasons.find((reason) => reason === value.reason);
	if (value.kind === "background" && reason) return { kind: value.kind, reason };
	throw new Error("Invalid native host observation");
}
// Native records own lifecycle and mutable execution metadata. Routing provenance is
// immutable host metadata, retained for the same environment lifetime as task records.
const routerSelections = new Map<string, C.RouterSelection>();
function record(value: native.TaskRecord): C.TaskRecord {
	if (value.kind !== "agent" && value.kind !== "command") throw new Error(`Invalid native task kind: ${value.kind}`);
	const routerSelection = routerSelections.get(value.ref.taskId);
	return {
		ref: reference(value.ref),
		launchOperationId: value.launchOperationId as C.OperationId,
		...(value.parentTaskId === undefined ? {} : { parentTaskId: value.parentTaskId as C.TaskId }),
		...(value.launchGroupId === undefined ? {} : { launchGroupId: value.launchGroupId }),
		launchOrdinal: value.launchOrdinal,
		kind: value.kind,
		title: value.title,
		...(value.agentName === undefined ? {} : { agentName: value.agentName }),
		...(value.model === undefined ? {} : { model: value.model }),
		...(value.thinking === undefined ? {} : { thinking: value.thinking }),
		...(routerSelection ? { routerSelection } : {}),
		execution: execution(value.execution),
		observation: observation(value.observation),
		...(value.wasBackground === undefined ? {} : { wasBackground: value.wasBackground }),
		attention: value.attention,
		cleanup: value.cleanup,
		...(value.currentAction === undefined
			? {}
			: { currentAction: { tool: value.currentAction.tool, text: value.currentAction.text } }),
		...(value.metrics === undefined
			? {}
			: {
					metrics: {
						...(value.metrics.elapsedMs === undefined ? {} : { elapsedMs: value.metrics.elapsedMs }),
						...(value.metrics.toolCount === undefined ? {} : { toolCount: value.metrics.toolCount }),
						...(value.metrics.tokenCount === undefined ? {} : { tokenCount: value.metrics.tokenCount }),
					},
				}),
		output: output(value.output),
	};
}
function snapshot(value: native.OwnerSnapshot): C.OwnerSnapshot {
	if (value.state !== "open" && value.state !== "closing" && value.state !== "closed")
		throw new Error(`Invalid native owner state: ${value.state}`);
	return {
		ownerId: value.ownerId as C.OwnerId,
		scope: value.scope,
		generation: value.generation as C.Generation,
		state: value.state,
		tasks: value.tasks.map(record),
		cursor: cursor(value.cursor),
	};
}
function activity(value: native.ActivityReport): C.ActivityReport {
	if (value.change.kind === "attention-set" && value.change.attention.kind === "none")
		throw new Error("Native attention-set cannot clear attention");
	// Native tagged variants are owned wire data; only attention-set has a wider generated declaration.
	return value as C.ActivityReport;
}
function payload(value: native.TaskEvent): C.TaskEvent {
	switch (value.kind) {
		case "task-admitted":
			return { kind: value.kind, task: record(value.task) };
		case "task-started":
			return { kind: value.kind, ref: reference(value.ref) };
		case "wait-started": {
			if (value.observer !== "sdk" && value.observer !== "host") throw new Error("Invalid native observer");
			return {
				kind: value.kind,
				ref: reference(value.ref),
				waitId: value.waitId as C.WaitId,
				observer: value.observer,
			};
		}
		case "wait-yielded":
			return { kind: value.kind, ref: reference(value.ref), waitId: value.waitId as C.WaitId, reason: value.reason };
		case "host-observation-changed":
			return { kind: value.kind, ref: reference(value.ref), observation: observation(value.observation) };
		case "task-activity":
			return { kind: value.kind, ref: reference(value.ref), activity: activity(value.activity) };
		case "task-cancelling":
			return { kind: value.kind, ref: reference(value.ref), cause: value.cause };
		case "task-settled":
			return {
				kind: value.kind,
				ref: reference(value.ref),
				result: taskResult(value.result),
				completionId: value.completionId,
			};
		case "cleanup-changed":
			return { kind: value.kind, ref: reference(value.ref), cleanup: value.cleanup };
		case "owner-closing":
		case "owner-closed":
			return { kind: value.kind };
	}
}
function event(value: native.NativeEvent): C.NativeEvent {
	if (value.schemaVersion !== 1) throw new Error("Unsupported native task event schema");
	return {
		schemaVersion: 1,
		cursor: cursor(value.cursor),
		ownerId: value.ownerId as C.OwnerId,
		...(value.taskId === undefined ? {} : { taskId: value.taskId as C.TaskId }),
		payload: payload(value.payload),
	};
}
function waitOutcome(value: native.WaitOutcome): C.WaitOutcome {
	return value.kind === "settled"
		? { kind: value.kind, taskId: value.taskId as C.TaskId, result: taskResult(value.result) }
		: { kind: value.kind, taskId: value.taskId as C.TaskId, waitId: value.waitId as C.WaitId, reason: value.reason };
}
function cancelReceipt(value: native.CancelReceipt): C.CancelReceipt {
	if (value.decision !== "already-settled" && value.decision !== "cancellation-requested")
		throw new Error("Invalid cancellation decision");
	return {
		taskId: value.taskId as C.TaskId,
		decision: value.decision,
		execution: execution(value.execution),
		cleanup: value.cleanup,
	};
}

function reportReceipt(value: native.ReportReceipt): C.ReportReceipt {
	if (value.disposition !== "accepted" && value.disposition !== "duplicate")
		throw new Error("Invalid report disposition");
	return { reportId: value.reportId, cursor: cursor(value.cursor), disposition: value.disposition };
}
/** Projection only: native ordering remains the sole lifecycle authority. */
function applyEvent(current: C.OwnerSnapshot, value: C.NativeEvent): C.OwnerSnapshot {
	const next: C.OwnerSnapshot = { ...current, tasks: [...current.tasks], cursor: value.cursor };
	const change = value.payload;
	if (change.kind === "owner-closing") {
		next.state = "closing";
		next.tasks = next.tasks.map((task) =>
			task.execution.kind === "settled" ? task : { ...task, attention: { kind: "none" } },
		);
		return next;
	}
	if (change.kind === "owner-closed") {
		next.state = "closed";
		return next;
	}
	if (change.kind === "task-admitted") {
		next.tasks.push(change.task);
		return next;
	}
	const index = next.tasks.findIndex((task) => task.ref.taskId === change.ref.taskId);
	if (index < 0) throw new Error("Native delta references a task absent from its snapshot");
	const task: C.TaskRecord = { ...next.tasks[index] };
	next.tasks[index] = task;
	switch (change.kind) {
		case "task-started":
			task.execution = { kind: "running" };
			break;
		case "host-observation-changed":
			task.observation = change.observation;
			if (change.observation.kind === "background" && change.observation.reason !== "not-observed")
				task.wasBackground = true;
			break;
		case "task-cancelling":
			task.execution = { kind: "cancelling", cause: change.cause };
			break;
		case "task-settled":
			task.execution = { kind: "settled", result: change.result };
			task.attention = { kind: "none" };
			if (change.result.output !== undefined) task.output = change.result.output;
			break;
		case "cleanup-changed":
			task.cleanup = change.cleanup;
			break;
		case "task-activity": {
			const activity = change.activity.change;
			switch (activity.kind) {
				case "action":
					task.currentAction = { tool: activity.tool, text: activity.text };
					if (task.attention.kind === "no-recent-activity") task.attention = { kind: "none" };
					break;
				case "model":
					task.model = activity.model;
					task.thinking = activity.thinking;
					break;
				case "metrics":
					task.metrics = {
						...task.metrics,
						...(activity.elapsedMs === undefined ? {} : { elapsedMs: activity.elapsedMs }),
						...(activity.toolCount === undefined ? {} : { toolCount: activity.toolCount }),
						...(activity.tokenCount === undefined ? {} : { tokenCount: activity.tokenCount }),
					};
					break;
				case "attention-set":
					task.attention = activity.attention;
					break;
				case "attention-clear":
					if (task.attention.kind === "input-needed" && task.attention.requestId === activity.requestId)
						task.attention = { kind: "none" };
					break;
				case "output":
					break;
			}
			break;
		}
		case "wait-started":
		case "wait-yielded":
			break;
	}
	return next;
}
/** One bounded wake poll per live subscription, including a journal with no retained event. */
const RECONCILE_INTERVAL_MS = 25;
const MAX_PENDING_EVENTS = 64;
export class TaskSubscription {
	#native: native.TaskSupervisor;
	#lease: native.SubscriptionLease;
	#resource = new AsyncResource("TaskSubscription");
	#timer?: ReturnType<typeof setTimeout>;
	#queue: C.NativeEvent[] = [];
	#epoch = 0;
	#next?: (value: IteratorResult<C.NativeEvent>) => void;
	#disposed = false;
	#snapshot: C.OwnerSnapshot;
	#cursor: C.Cursor;
	/** Reconciliation supplements the RFC snapshot/cursor/iterable contract. */
	onReconcile: (snapshot: C.OwnerSnapshot) => void = () => {};
	#onDispose: () => void;
	#failure?: Error;
	readonly events: AsyncIterable<C.NativeEvent>;
	readonly lease: SubscriptionLease = new SubscriptionCapability();

	constructor(actor: native.TaskSupervisor, initial: native.NativeTaskSubscription, onDispose: () => void) {
		Object.freeze(this.lease);
		this.#native = actor;
		this.#lease = initial.lease;
		this.#snapshot = snapshot(initial.snapshot);
		this.#cursor = cursor(initial.cursor);
		this.#onDispose = onDispose;
		this.events = {
			[Symbol.asyncIterator]: () => {
				const epoch = this.#epoch;
				return {
					next: () => {
						if (epoch !== this.#epoch) return Promise.resolve({ done: true, value: undefined });
						const value = this.#queue.shift();
						if (value) return Promise.resolve({ done: false, value });
						if (this.#disposed) return Promise.resolve({ done: true, value: undefined });
						if (this.#next) return Promise.reject(new Error("Only one pending subscription read is supported"));
						return new Promise((resolve) => {
							this.#next = resolve;
						});
					},
					return: async () => {
						if (epoch === this.#epoch) this.dispose();
						return { done: true, value: undefined };
					},
				};
			},
		};
		this.#arm();
	}
	get snapshot(): C.OwnerSnapshot {
		return this.#snapshot;
	}
	get cursor(): C.Cursor {
		return this.#cursor;
	}
	/** Consumer exceptions are observable without breaking the native wake or fallback poll. */
	get failure(): Error | undefined {
		return this.#failure;
	}
	/** Callback payloads are authentic hints; only the journal/snapshot is authoritative. */
	wake(_hint: native.NativeEvent): void {
		this.#resource.runInAsyncScope(() => this.drain());
	}
	#arm(): void {
		if (this.#disposed || this.#timer) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.#resource.runInAsyncScope(() => this.drain());
			this.#arm();
		}, RECONCILE_INTERVAL_MS);
		this.#timer.unref();
	}
	drain(): void {
		if (this.#disposed) return;
		const drained = this.#native.drainOwnerTasks(this.#lease);
		if (!drained.ok) {
			this.dispose();
			return;
		}
		const events = drained.value.events.map(event);
		if (drained.value.snapshot) this.#snapshot = snapshot(drained.value.snapshot);
		for (const value of events) {
			if (BigInt(value.cursor.sequence) > BigInt(this.#snapshot.cursor.sequence))
				this.#snapshot = applyEvent(this.#snapshot, value);
		}
		this.#cursor = cursor(drained.value.cursor);
		this.#snapshot = { ...this.#snapshot, cursor: this.#cursor };
		const overflow = this.#queue.length + events.length > MAX_PENDING_EVENTS;
		const reset = drained.value.reset || overflow;
		if (reset) {
			this.#queue = [];
			this.#epoch++;
			// End the old iterator only after publishing the authoritative snapshot/cursor.
			// A new iterator on the same iterable observes subsequent authentic deltas.
			this.#next?.({ done: true, value: undefined });
			this.#next = undefined;
		}
		if (drained.value.snapshot || events.length) {
			try {
				this.#resource.runInAsyncScope(this.onReconcile, undefined, this.#snapshot);
			} catch (error) {
				this.#failure = new Error(rejectionMessage(error));
			}
		}
		if (this.#disposed) return;
		if (!reset)
			for (const value of events) {
				if (this.#next) {
					const next = this.#next;
					this.#next = undefined;
					next({ done: false, value });
				} else this.#queue.push(value);
			}
		if (this.#snapshot.state === "closed") this.dispose(false);
	}
	dispose(clear = true): void {
		if (this.#disposed) return;
		this.#disposed = true;
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#native.disposeSubscription(this.#lease);
		if (clear) this.#queue = [];
		this.#next?.({ done: true, value: undefined });
		this.#next = undefined;
		this.#resource.emitDestroy();
		this.#onDispose();
	}
}

function createNativeSupervisor(): native.TaskSupervisor {
	// Keep loading separate from `new`: type-assertion erasure in the build
	// must not move construction onto createModuleRequire instead of the class.
	const binding = createModuleRequire(import.meta.url)("@bastani/atomic-natives") as typeof native;
	return new binding.TaskSupervisor();
}

export class TaskSupervisor {
	#native = createNativeSupervisor();
	#hosts = environment.hosts;
	#owners = environment.owners;
	#tasks = environment.tasks;
	#waits = environment.waits;
	#waitRegistry = environment.waitRegistry;
	#ownerIds = environment.ownerIds;
	bindHostSession(binding: TrustedTaskHost): HostSession {
		const host = new HostCapability();
		Object.freeze(host);
		this.#hosts.set(host, { native: this.#native.bindHostSession(binding.scope), binding });
		return host;
	}
	openTaskOwner(host: HostSession, scope: C.OwnerScope): C.Result<OwnerLease, C.OwnerError> {
		const state = this.#host(host);
		return mapped(
			this.#native.openTaskOwner(state.native, scope),
			(lease) => {
				const probe = this.#native.watchOwnerTasks(lease, (_hint) => {});
				if (!probe.ok) throw new Error(probe.error.message);
				const id = probe.value.snapshot.ownerId as C.OwnerId;
				this.#native.disposeSubscription(probe.value.lease);
				const existing = this.#ownerIds.get(id);
				if (existing) return existing;
				const owner = new OwnerCapability();
				Object.freeze(owner);
				const ownerState: OwnerState = {
					native: lease,
					host: state,
					tasks: new Map(),
					watches: new Set(),
					settledTasks: new Set(),
					commandAdmissions: new Set(),
				};
				this.#owners.set(owner, ownerState);
				this.#ownerIds.set(id, owner);
				const watched = this.watchOwnerTasks(owner);
				if (!watched.ok) throw new Error(watched.error.message);
				watched.value.onReconcile = (projection) => {
					if (projection.state === "closed") this.#ownerIds.delete(projection.ownerId);
					for (const record of projection.tasks) {
						const cause =
							record.execution.kind === "cancelling"
								? record.execution.cause
								: projection.state !== "open" && record.cleanup.kind !== "reaped"
									? "owner-close"
									: undefined;
						if (!cause) continue;
						const task = this.#owner(owner).tasks.get(record.ref.taskId);
						if (task) this.#task(task).controller.abort(cause);
					}
					let failure: Error | undefined;
					for (const record of projection.tasks) {
						if (
							record.execution.kind !== "settled" ||
							ownerState.settledTasks.has(record.ref.taskId) ||
							!state.binding.onTaskSettled
						)
							continue;
						try {
							// Cancellation settles at cleanup (or while queued), without a runner outcome.
							// Recover its authentic receipt even when the bounded journal has reset.
							const task = this.#native.lookupTask(lease, record.ref.taskId);
							if (!task.ok) throw new Error(task.error.message);
							const settled = this.#native.taskSettlement(task.value);
							if (!settled.ok) throw new Error(settled.error.message);
							this.#notifyTaskSettled(ownerState, record.ref, settled.value);
						} catch (error) {
							failure ??= new Error(rejectionMessage(error));
						}
					}
					if (failure) throw failure;
				};
				watched.value.onReconcile(watched.value.snapshot);
				return owner;
			},
			ownerErrors,
		);
	}
	#notifyTaskSettled(state: OwnerState, ref: C.NativeTaskRef, receipt: native.SettlementReceipt): void {
		if (!state.host.binding.onTaskSettled || state.settledTasks.has(ref.taskId)) return;
		// Runner outcomes and snapshot recovery share one delivery door. Mark before
		// host code so reentrant drains or callback failures cannot redeliver.
		state.settledTasks.add(ref.taskId);
		state.host.binding.onTaskSettled(ref, {
			taskId: receipt.taskId as C.TaskId,
			cursor: cursor(receipt.cursor),
			result: taskResult(receipt.result),
			completionId: receipt.completionId,
		});
	}
	async startCommandTask(
		owner: OwnerLease,
		intent: C.CommandIntent,
		operation: C.OperationId,
	): Promise<C.Result<TaskLease, C.StartFailure>> {
		const state = this.#owner(owner);
		state.host.binding.authorizeCommandLaunch?.(intent);
		// Native command setup can be admitted before its task lease is visible in JS.
		let finishAdmission!: () => void;
		const admission = new Promise<void>((resolve) => {
			finishAdmission = resolve;
		});
		state.commandAdmissions.add(admission);
		try {
			const admitted = mapped(
				await this.#native.startCommandTask(state.native, intent, operation),
				(lease) => lease,
				startErrors,
			);
			if (!admitted.ok) return admitted;
			const ref = this.#native.taskReference(admitted.value);
			if (!ref.ok) throw new Error(ref.error.message);
			const id = ref.value.taskId as C.TaskId;
			const existing = state.tasks.get(id);
			if (existing) return { ok: true, value: existing };
			const task = new TaskCapability();
			this.#tasks.set(task, {
				native: admitted.value,
				owner: state,
				ref: reference(ref.value),
				controller: new AbortController(),
				kind: "command",
			});
			state.tasks.set(id, task);
			return { ok: true, value: task };
		} finally {
			state.commandAdmissions.delete(admission);
			finishAdmission();
		}
	}
	/** Caller must hold launch authorization closed while this snapshot drains. */
	async drainCommandAdmissions(owner: OwnerLease): Promise<void> {
		await Promise.all([...this.#owner(owner).commandAdmissions]);
	}
	taskStdin(task: TaskLease): C.Result<StdinLease, C.InputError> {
		return mapped(
			this.#native.taskStdin(this.#task(task).native),
			(input) => {
				const lease = new StdinCapability();
				environment.inputs.set(lease, input);
				return lease;
			},
			["TaskTerminal", "StdinClosed", "UnknownTask", "OutputUnavailable"] as const,
		);
	}
	async writeTaskInput(
		input: StdinLease,
		operation: C.OperationId,
		data: C.InputData,
	): Promise<C.Result<C.InputReceipt, C.InputError>> {
		const lease = environment.inputs.get(input);
		if (!lease) throw new TypeError("Foreign stdin capability");
		return mapped(
			await this.#native.writeTaskInput(
				lease,
				operation,
				data.kind === "bytes" ? { kind: "bytes", bytes: Buffer.from(data.bytes) } : data,
			),
			(value) => ({
				operationId: value.operationId as C.OperationId,
				acceptedBytes: value.acceptedBytes,
				kind: value.kind as "bytes" | "eof",
			}),
			["TaskTerminal", "StdinClosed", "InputBackpressure", "OperationConflict", "InputDeliveryUnknown"] as const,
		);
	}
	async readTaskOutput(task: TaskLease, range: C.OutputRange): Promise<C.Result<C.OutputPage, C.OutputError>> {
		return mapped(
			await this.#native.readTaskOutput(this.#task(task).native, range),
			(page) => ({
				requested: page.requested,
				chunks: page.chunks.map((chunk) => ({ offsets: chunk.offsets, bytes: new Uint8Array(chunk.bytes) })),
				omittedRanges: page.omittedRanges,
				...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }),
			}),
			["UnknownTask", "OutputUnavailable"] as const,
		);
	}
	async startAgentTask(
		owner: OwnerLease,
		intent: C.AgentIntent,
		operation: C.OperationId,
		schedule?: (dispatch: () => Promise<void>) => void,
	): Promise<C.Result<TaskLease, C.StartFailure>> {
		const state = this.#owner(owner);
		state.host.binding.authorizeLaunch(intent);
		const admitted = mapped(
			this.#native.startAgentTask(state.native, intent, operation),
			(lease) => lease,
			startErrors,
		);
		if (!admitted.ok) return admitted;
		const ref = this.#native.taskReference(admitted.value);
		if (!ref.ok) throw new Error(ref.error.message);
		const id = ref.value.taskId as C.TaskId;
		const existing = state.tasks.get(id);
		if (existing) return { ok: true, value: existing };
		if (intent.routerSelection) routerSelections.set(id, Object.freeze({ ...intent.routerSelection }));
		const task = new TaskCapability();
		Object.freeze(task);
		const taskState: TaskState = {
			native: admitted.value,
			owner: state,
			ref: reference(ref.value),
			controller: new AbortController(),
		};
		this.#tasks.set(task, taskState);
		state.tasks.set(id, task);
		const dispatch = AsyncResource.bind(async () => {
			if (taskState.controller.signal.aborted) return;
			const runner = mapped(this.#native.claimTaskRunner(admitted.value), (lease) => lease, startErrors);
			if (!runner.ok) throw new Error(`${runner.error.code}: ${runner.error.message}`);
			let execution: FakeExecution;
			try {
				execution = state.host.binding.createRunner(
					{
						ref: reference(taskState.ref),
						signal: taskState.controller.signal,
						bindTranscript: (session) => {
							taskState.inheritedEntryCount ??= session.getEntries().length;
							taskState.transcript = session;
						},
						reportActivity: (report) =>
							mapped(this.#native.reportTaskActivity(runner.value, report), reportReceipt, reportErrors),
					},
					intent,
				);
			} catch (error) {
				const message = rejectionMessage(error);
				execution = {
					result: Promise.resolve({ kind: "failed", code: "SpawnFailed", message }),
					cleanup: Promise.resolve({
						kind: "failed",
						resources: [{ resource: "fake-runner-setup", code: "CleanupUnconfirmed", message }],
					}),
				};
			}
			const outcome = execution.result
				.catch((error) => ({ kind: "failed" as const, code: "RunnerFailed", message: rejectionMessage(error) }))
				.then((result) => {
					return mapped(
						this.#native.reportRunnerOutcome(runner.value, result),
						(receipt) => this.#notifyTaskSettled(state, taskState.ref, receipt),
						reportErrors,
					);
				});
			const cleanup = execution.cleanup.catch(
				(error): C.Cleanup => ({
					kind: "failed",
					resources: [{ resource: "fake-runner", code: "CleanupFailed", message: rejectionMessage(error) }],
				}),
			);
			taskState.execution = cleanup.then(async (evidence) => {
				// Natural reaping follows its outcome; cancellation needs only confirmed stop.
				// A result may never arrive after abort, including when cleanup arrived first.
				const signal = taskState.controller.signal;
				let stopped!: () => void;
				const cancelled = new Promise<undefined>((resolve) => {
					stopped = () => resolve(undefined);
					if (signal.aborted) stopped();
					else signal.addEventListener("abort", stopped, { once: true });
				});
				const reported = await Promise.race([outcome, cancelled]).finally(() => {
					signal.removeEventListener("abort", stopped);
				});
				const acknowledged = mapped(
					this.#native.acknowledgeTaskCleanup(runner.value, evidence),
					(cleanup) => cleanup,
					reportErrors,
				);
				if (reported && !reported.ok && !(signal.aborted && reported.error.code === "ReportConflict"))
					return reported;
				return acknowledged;
			});
			await taskState.execution;
		});
		if (schedule) schedule(dispatch);
		else void dispatch();
		// Setup is complete. Do not await execution; ready terminal microtasks may win observation.
		await Promise.resolve();
		return { ok: true, value: task };
	}
	taskReference(task: TaskLease): C.NativeTaskRef {
		return reference(this.#task(task).ref);
	}
	async waitForTask(
		task: TaskLease,
		budgetMs?: number,
		designation?: HostSession,
	): Promise<C.Result<C.WaitOutcome, C.WaitError>> {
		const registered = mapped(
			this.#native.waitForTask(
				this.#task(task).native,
				this.#agentBudget(this.#task(task).owner, budgetMs, this.#task(task).kind === "command"),
				designation ? this.#host(designation).native : undefined,
			),
			(lease) => this.#register(lease),
			waitErrors,
		);
		return registered.ok ? this.observeTaskWait(registered.value) : registered;
	}
	/** Resolve only a task admitted under this live owner; IDs alone confer no authority. */
	lookupTask(owner: OwnerLease, taskId: C.TaskId): C.Result<TaskLease, C.WaitError> {
		const state = this.#owner(owner);
		const found = mapped(this.#native.lookupTask(state.native, taskId), () => state.tasks.get(taskId), waitErrors);
		if (!found.ok) return found;
		if (!found.value) return { ok: false, error: { code: "UnknownTask", message: "No agent runner bound to task" } };
		return { ok: true, value: found.value };
	}

	async waitForTaskId(
		owner: OwnerLease,
		taskId: C.TaskId,
		budgetMs?: number,
		onRegistered?: (wait: WaitLease) => void,
	): Promise<C.Result<C.WaitOutcome, C.WaitError>> {
		const found = mapped(this.#native.lookupTask(this.#owner(owner).native, taskId), (lease) => lease, waitErrors);
		if (!found.ok) return found;
		const known = this.#owner(owner).tasks.get(taskId);
		const registered = mapped(
			this.#native.waitForTask(
				found.value,
				this.#agentBudget(
					this.#owner(owner),
					budgetMs,
					known !== undefined && this.#task(known).kind === "command",
				),
			),
			(lease) => this.#register(lease),
			waitErrors,
		);
		if (!registered.ok) return registered;
		onRegistered?.(registered.value);
		return this.observeTaskWait(registered.value);
	}
	async foregroundTask(task: TaskLease, budgetMs?: number): Promise<C.Result<C.WaitOutcome, C.ForegroundError>> {
		const state = this.#task(task);
		const errors = ["TaskTerminal", "OwnerClosing", "UnknownTask", "ObserverCancelled"] as const;
		const registered = mapped(
			this.#native.foregroundTask(
				state.native,
				state.owner.host.native,
				this.#agentBudget(state.owner, budgetMs, state.kind === "command"),
			),
			(lease) => this.#register(lease),
			errors,
		);
		return registered.ok
			? mapped(await this.observeTaskWait(registered.value), (outcome) => outcome, errors)
			: registered;
	}
	waitId(wait: WaitLease): C.WaitId {
		return this.#wait(wait).native.waitId as C.WaitId;
	}
	findWait(id: C.WaitId): WaitLease | undefined {
		return this.#waitRegistry.get(id);
	}
	observeTaskWait(wait: WaitLease): Promise<C.Result<C.WaitOutcome, C.WaitError>> {
		return this.#wait(wait).outcome;
	}
	yieldTaskWait(wait: WaitLease, reason: C.YieldReason): C.Result<C.WaitOutcome, C.YieldError> {
		return mapped(this.#native.yieldTaskWait(this.#wait(wait).native, reason), waitOutcome, [
			"UnknownWait",
			"StaleGeneration",
			"ObserverCancelled",
		]);
	}
	disposeTaskWait(wait: WaitLease): C.Result<void, C.WaitError> {
		return mapped(this.#native.disposeTaskWait(this.#wait(wait).native), () => undefined, waitErrors);
	}
	async initialObservation(
		task: TaskLease,
		policy?: C.WaitPolicy,
		onRegistered?: (wait: WaitLease) => void,
	): Promise<C.Result<C.WaitOutcome, C.WaitError>> {
		const state = this.#task(task);
		policy ??= state.kind === "command" ? { kind: "foreground" } : undefined;
		const registered = mapped(
			this.#native.waitForTask(
				state.native,
				policy?.kind === "foreground"
					? this.#agentBudget(state.owner, policy.budgetMs, state.kind === "command")
					: undefined,
				state.owner.host.native,
			),
			(lease) => this.#register(lease),
			waitErrors,
		);
		if (!registered.ok) return registered;
		onRegistered?.(registered.value);
		if (policy?.kind !== "foreground")
			this.yieldTaskWait(registered.value, policy ? "explicit" : "default-background");
		return this.observeTaskWait(registered.value);
	}
	async cancelTask(task: TaskLease, cause: C.CancelCause): Promise<C.Result<C.CancelReceipt, C.CancelError>> {
		const state = this.#task(task);
		const result = mapped(this.#native.cancelTask(state.native, cause), cancelReceipt, [
			"UnknownTask",
			"CleanupFailed",
		]);
		if (result.ok && result.value.decision === "cancellation-requested") state.controller.abort(cause);
		return result;
	}
	async closeTaskOwner(
		owner: OwnerLease,
		cause: C.OwnerCloseCause,
	): Promise<C.Result<C.OwnerCloseReceipt, C.CloseError>> {
		const state = this.#owner(owner);
		const closing = this.#native.closeTaskOwner(state.native, cause);
		for (const task of state.tasks.values()) this.#task(task).controller.abort("owner-close");
		const result = mapped(
			await closing,
			(receipt): C.OwnerCloseReceipt => ({
				ownerId: receipt.ownerId as C.OwnerId,
				state: "closed",
				tasks: receipt.tasks.map(cancelReceipt),
			}),
			["CleanupFailed", "EnvironmentClosing"],
		);
		if (result.ok)
			for (const task of state.tasks.values()) {
				const completed = await this.#task(task).execution;
				if (completed && !completed.ok)
					throw new Error(`Runner protocol failed: ${completed.error.code}: ${completed.error.message}`);
			}
		if (result.ok)
			for (const watch of state.watches) {
				watch.drain();
				watch.dispose(false);
			}
		return result;
	}
	/**
	 * The bounded stream carries only authentic deltas. Overflow/native reset publishes
	 * snapshot/cursor then ends the current iterator, even with no surviving delta.
	 * Reconcile on completion; obtain a new iterator on the same events iterable to
	 * continue observing. Apply snapshots first and ignore deltas at/below their cursor.
	 * onReconcile is optional; consumer failures never disable the fallback poll.
	 */
	watchOwnerTasks(owner: OwnerLease, from?: C.Cursor): C.Result<TaskSubscription, C.WatchError> {
		const state = this.#owner(owner);
		let subscription: TaskSubscription | undefined;
		return mapped(
			this.#native.watchOwnerTasks(state.native, (hint) => subscription?.wake(hint), from),
			(initial) => {
				subscription = new TaskSubscription(this.#native, initial, () => {
					if (subscription) state.watches.delete(subscription);
				});
				state.watches.add(subscription);
				return subscription;
			},
			watchErrors,
		);
	}
	#agentBudget(owner: OwnerState, budgetMs?: number, command = false): number | undefined {
		if (budgetMs !== undefined) return budgetMs;
		const configuration = owner.host.binding.tasks?.wait;
		if (configuration?.kind === "until-settled") return undefined;
		return command
			? (configuration?.commandBudgetMs ?? COMMAND_FOREGROUND_BUDGET_MS)
			: (configuration?.agentBudgetMs ?? DEFAULT_AGENT_WAIT_BUDGET_MS);
	}
	#register(lease: native.WaitLease): WaitLease {
		const wait = new WaitCapability();
		Object.freeze(wait);
		const id = lease.waitId as C.WaitId;
		this.#waitRegistry.set(id, wait);
		const outcome = this.#native
			.observeTaskWait(lease)
			.then((result) => mapped(result, waitOutcome, waitErrors))
			.finally(() => {
				this.#waitRegistry.delete(id);
			});
		this.#waits.set(wait, { native: lease, outcome });
		return wait;
	}
	#host(host: HostSession): HostState {
		const state = this.#hosts.get(host);
		if (!state) throw new TypeError("Foreign host capability");
		return state;
	}
	#owner(owner: OwnerLease): OwnerState {
		const state = this.#owners.get(owner);
		if (!state) throw new TypeError("Foreign owner capability");
		return state;
	}
	#task(task: TaskLease): TaskState {
		const state = this.#tasks.get(task);
		if (!state) throw new TypeError("Foreign task capability");
		return state;
	}
	#wait(wait: WaitLease): WaitState {
		const state = this.#waits.get(wait);
		if (!state) throw new TypeError("Foreign wait capability");
		return state;
	}
}
