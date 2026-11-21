import { AsyncLocalStorage } from "node:async_hooks";
import { asyncScope } from "../async-scope.ts";
import { TaskCleanupError, type TaskCleanupPhase } from "./cleanup-error.js";
import type * as C from "./contracts.js";
import { trackAdmittedAgentTask } from "./execution-scope.js";
import { defaultTaskHeartbeatMs, type TaskHeartbeatDelivery, TaskHeartbeatMonitor } from "./heartbeat.js";
import { cancelPausedOwnerTasks } from "./pause.js";
import {
	automaticWaitBudgetMs,
	DEFAULT_AGENT_WAIT_BUDGET_MS,
	type FakeExecution,
	type FakeRunnerContext,
	type OwnerLease,
	type TaskLease,
	TaskSupervisor,
	type TrustedTaskHost,
	type WaitLease,
} from "./supervisor.js";

export type AgentTaskRunnerFactory = (context: FakeRunnerContext, intent: C.AgentIntent) => FakeExecution;
export type AgentTaskHostBinding = Omit<TrustedTaskHost, "createRunner"> & {
	/** The owner's chat for periodic task heartbeats; omitted, the owner's tasks never heartbeat. */
	heartbeat?: TaskHeartbeatDelivery;
};

/**
 * The runner factory of one launch, handed to its dispatch once. The task runs in this launch's async context, and on
 * Node 22 every promise it creates keeps that context's store, including promises that outlive the task, such as a
 * module it imports first or its owner's session write chain. So the store keeps the factory, and the launch input
 * it closes over, only until the dispatch takes it.
 */
interface RunnerHandoff {
	factory: AgentTaskRunnerFactory | undefined;
}

// S1 converges repeated live-scope bindings on one owner, so dispatch context is shared too.
const runners = asyncScope<RunnerHandoff>();

/**
 * Runs a callback in the async context of this module's load, outside every session. An owner can outlive the
 * session that first bound it, so what it keeps for its lifetime must not start in that
 * session's async context, which would keep the session reachable.
 */
const outsideAnySession = AsyncLocalStorage.snapshot();

/** Internal trusted-host seam. Bind actual host identity, never model-supplied scope. */
export class AgentTaskHost {
	private readonly supervisor = new TaskSupervisor();
	private readonly owner;
	private binding: AgentTaskHostBinding;
	private readonly messageWaits = new Set<WaitLease>();
	private readonly heartbeats: TaskHeartbeatMonitor;
	/** Whether this owner has launched anything; owners that never do pay nothing for heartbeats. */
	private launched = false;
	/** Rebinding updates callbacks, never native identity or ownership. */
	updateBinding(binding: Omit<AgentTaskHostBinding, "scope">): void {
		this.binding = { ...this.binding, ...binding };
		this.watchHeartbeats();
	}
	/** Internal projection binding; never serialize these native-backed capabilities. */
	get ownerBinding(): { supervisor: TaskSupervisor; owner: OwnerLease; waitForTask: AgentTaskHost["waitForTask"] } {
		return { supervisor: this.supervisor, owner: this.owner, waitForTask: this.waitForTask.bind(this) };
	}

	constructor(binding: AgentTaskHostBinding) {
		this.binding = binding;
		// The native host keeps this binding as long as the owner lives; the heartbeat belongs to whichever session
		// binds the owner, so it reaches the monitor only through `updateBinding`.
		const { heartbeat: _heartbeat, ...hostBinding } = binding;
		const host = this.supervisor.bindHostSession({
			...hostBinding,
			authorizeLaunch: (intent) => {
				this.authorizeTaskLaunch();
				this.binding.authorizeLaunch(intent);
			},
			authorizeCommandLaunch: (intent, origin) => {
				this.authorizeTaskLaunch();
				this.binding.authorizeCommandLaunch?.(intent, origin);
			},
			onTaskFinishing: (ref, receipt, until) => this.binding.onTaskFinishing?.(ref, receipt, until),
			onTaskSettled: (ref, receipt, timing) => this.binding.onTaskSettled?.(ref, receipt, timing),
			onTaskCleanupQuarantined: (ref, resources) => this.binding.onTaskCleanupQuarantined?.(ref, resources),
			defaultHeartbeatMs: () =>
				this.binding.heartbeat ? defaultTaskHeartbeatMs(this.binding.heartbeat) : undefined,
			createRunner: (context, intent) => {
				const handoff = runners.getStore();
				const runner = handoff?.factory;
				if (!handoff || !runner) throw new Error("Agent runner factory missing from launch context");
				handoff.factory = undefined;
				return runner(context, intent);
			},
		});
		const opened = this.supervisor.openTaskOwner(host, binding.scope);
		if (!opened.ok) throw new Error(`${opened.error.code}: ${opened.error.message}`);
		this.owner = opened.value;
		// One monitor per owner, whichever session currently binds it.
		this.heartbeats = new TaskHeartbeatMonitor({
			supervisor: this.supervisor,
			owner: this.owner,
			delivery: () => this.binding.heartbeat,
		});
	}

	/** One monitor per owner, started with its first launch, whichever session binds it then. */
	private watchHeartbeats(): void {
		if (this.launched && this.binding.heartbeat) outsideAnySession(() => this.heartbeats.start());
	}

	async startAgentTask(
		intent: C.AgentIntent,
		operation: C.OperationId,
		runner: AgentTaskRunnerFactory,
		schedule?: (dispatch: () => Promise<void>) => void,
		cleanupQueued?: (
			taskId: C.TaskId,
			cause: C.CancelCause,
			intent: Promise<void> | undefined,
			handoff: () => void,
		) => Promise<void>,
	): Promise<C.Result<{ taskId: C.TaskId; lease: TaskLease }, C.StartFailure>> {
		const started = await runners.run({ factory: runner }, () =>
			this.supervisor.startAgentTask(this.owner, intent, operation, schedule, cleanupQueued),
		);
		if (started.ok)
			trackAdmittedAgentTask({ host: this, taskId: this.supervisor.taskReference(started.value).taskId });
		return started.ok
			? {
					ok: true as const,
					value: { taskId: this.supervisor.taskReference(started.value).taskId, lease: started.value },
				}
			: started;
	}
	resolveTask(taskId: C.TaskId): C.Result<TaskLease, C.WaitError> {
		return this.supervisor.lookupTask(this.owner, taskId);
	}
	/**
	 * Keeps a finished task's record past the finished-task retention until {@link releaseTaskRecord}, while its
	 * completion notice is still being built (#4385). A task this owner does not hold, or never had, is left alone and
	 * the refusal returned: a task the owner already evicted, also one it evicts while this call resolves it, refuses
	 * with `TaskEvicted` (#4472).
	 */
	retainTaskRecord(taskId: C.TaskId): C.Result<void, C.WaitError> {
		const task = this.resolveTask(taskId);
		return task.ok ? this.supervisor.retainTaskRecord(task.value) : task;
	}
	/** Ends a {@link retainTaskRecord} hold; a task this owner no longer keeps is left alone. */
	releaseTaskRecord(taskId: C.TaskId): void {
		const task = this.resolveTask(taskId);
		if (task.ok) this.supervisor.releaseTaskRecord(task.value);
	}

	/**
	 * The launch's observation of an agent task, which always runs in the background: it yields once registered, with
	 * `explicit` when the launch asked for the background and `default-background` otherwise, also for any other policy
	 * an untyped caller passes. Wait for the task explicitly with {@link waitForTask}.
	 */
	observeAgentLaunch(taskId: C.TaskId, policy?: { readonly kind: "background" }, onRegistered?: () => void) {
		const task = this.resolveTask(taskId);
		const background = policy?.kind === "background" ? policy : undefined;
		return task.ok
			? this.supervisor.initialObservation(task.value, background, () => onRegistered?.())
			: Promise.resolve(task);
	}

	/**
	 * Waits for the task to settle, until `budgetMs` (the owner's agent budget when omitted) yields the wait. An aborted
	 * `signal` ends the wait at once with `ObserverCancelled`, as it does when it is already aborted; the task keeps running.
	 */
	waitForTask(taskId: C.TaskId, budgetMs?: number, onRegistered?: (wait: WaitLease) => void, signal?: AbortSignal) {
		let registered: WaitLease | undefined;
		const stop = () => {
			if (registered) this.supervisor.disposeTaskWait(registered);
		};
		signal?.addEventListener("abort", stop, { once: true });
		return this.supervisor
			.waitForTaskId(this.owner, taskId, budgetMs, (wait) => {
				registered = wait;
				this.trackMessageWait(wait);
				onRegistered?.(wait);
				if (signal?.aborted) stop();
			})
			.finally(() => signal?.removeEventListener("abort", stop));
	}

	/** The automatic foreground budget this owner gives a command wait that names none (bash's default); `undefined` waits until settled. */
	get commandWaitBudgetMs(): number | undefined {
		return automaticWaitBudgetMs(this.binding.tasks?.wait, true);
	}

	/** Budget for an explicit bounded observation, including when this owner's normal policy waits until settled. */
	get boundedAgentWaitBudgetMs(): number {
		return automaticWaitBudgetMs(this.binding.tasks?.wait, false) ?? DEFAULT_AGENT_WAIT_BUDGET_MS;
	}

	/** Let inbound routing reach SDK admission instead of waiting for this owner to become idle. */
	get hasActiveTaskWaits(): boolean {
		return this.messageWaits.size > 0;
	}

	/** Incoming owner messages release observation only, never the child execution. */
	yieldTaskWaits(reason: C.YieldReason): void {
		for (const wait of this.messageWaits) this.supervisor.yieldTaskWait(wait, reason);
	}

	private trackMessageWait(wait: WaitLease): void {
		this.messageWaits.add(wait);
		const remove = () => this.messageWaits.delete(wait);
		void this.supervisor.observeTaskWait(wait).then(remove, remove);
	}

	cancelTask(taskId: C.TaskId, cause: C.CancelCause) {
		const task = this.resolveTask(taskId);
		return task.ok ? this.supervisor.cancelTask(task.value, cause) : Promise.resolve(task);
	}

	watchOwnerTasks(cursor?: C.Cursor) {
		return this.supervisor.watchOwnerTasks(this.owner, cursor);
	}

	/** This owner's current records of the tasks `ids` names, or of all, without a fresh snapshot of them (#5186). */
	taskRecords(ids?: ReadonlySet<C.TaskId>): readonly C.TaskRecord[] {
		return this.supervisor.taskRecords(this.owner, ids);
	}

	reportSettledTasks(): void {
		this.supervisor.reportSettledTasks(this.owner);
	}

	close(cause: C.OwnerCloseCause) {
		this.heartbeats.dispose();
		return this.supervisor.closeTaskOwner(this.owner, cause);
	}

	/** The error a failed close reports: a {@link TaskCleanupError} naming every unconfirmed resource when cleanup failed. */
	closeError(phase: TaskCleanupPhase, failure: C.CloseError): Error {
		if (failure.code !== "CleanupFailed") return new Error(`${failure.code}: ${failure.message}`);
		return new TaskCleanupError(phase, this.supervisor.failedTaskCleanups(this.owner), { cause: failure });
	}

	private tasksPaused = false;
	/** Reversible execution hold; message admission and owner identity remain open. */
	pauseTasks(): Promise<void> {
		this.tasksPaused = true;
		return cancelPausedOwnerTasks(this);
	}
	resumeTasks(): void {
		this.tasksPaused = false;
	}
	private authorizeTaskLaunch(): void {
		if (this.tasksPaused) throw new Error("Tasks are paused");
		this.launched = true;
		this.watchHeartbeats();
	}
}
