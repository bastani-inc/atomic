import { AsyncLocalStorage } from "node:async_hooks";
import { TaskCleanupError, type TaskCleanupPhase } from "./cleanup-error.js";
import type * as C from "./contracts.js";
import { trackAdmittedAgentTask } from "./execution-scope.js";
import { defaultTaskHeartbeatMs, type TaskHeartbeatDelivery, TaskHeartbeatMonitor } from "./heartbeat.js";
import { cancelPausedOwnerTasks } from "./pause.js";
import {
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

// S1 converges repeated live-scope bindings on one owner, so dispatch context is shared too.
const runners = new AsyncLocalStorage<AgentTaskRunnerFactory>();

/** Internal trusted-host seam. Bind actual host identity, never model-supplied scope. */
export class AgentTaskHost {
	private readonly supervisor = new TaskSupervisor();
	private readonly owner;
	private binding: AgentTaskHostBinding;
	private readonly messageWaits = new Set<WaitLease>();
	private readonly heartbeats: TaskHeartbeatMonitor;
	/** Whether this owner has launched anything; owners that never do pay nothing for heartbeats. */
	private launched = false;
	/** Stage replacement updates callbacks, never native identity or ownership. */
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
		const host = this.supervisor.bindHostSession({
			...binding,
			authorizeLaunch: (intent) => {
				this.authorizeTaskLaunch();
				this.binding.authorizeLaunch(intent);
			},
			authorizeCommandLaunch: (intent) => {
				this.authorizeTaskLaunch();
				this.binding.authorizeCommandLaunch?.(intent);
			},
			onTaskSettled: (ref, receipt) => this.binding.onTaskSettled?.(ref, receipt),
			onTaskCleanupQuarantined: (ref, resources) => this.binding.onTaskCleanupQuarantined?.(ref, resources),
			defaultHeartbeatMs: () =>
				this.binding.heartbeat ? defaultTaskHeartbeatMs(this.binding.heartbeat) : undefined,
			createRunner: (context, intent) => {
				const runner = runners.getStore();
				if (!runner) throw new Error("Agent runner factory missing from launch context");
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
		if (this.launched && this.binding.heartbeat) this.heartbeats.start();
	}

	async startAgentTask(
		intent: C.AgentIntent,
		operation: C.OperationId,
		runner: AgentTaskRunnerFactory,
		schedule?: (dispatch: () => Promise<void>) => void,
	): Promise<C.Result<{ taskId: C.TaskId; lease: TaskLease }, C.StartFailure>> {
		const started = await runners.run(runner, () =>
			this.supervisor.startAgentTask(this.owner, intent, operation, schedule),
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

	observeAgentLaunch(
		taskId: C.TaskId,
		policy?: C.WaitPolicy,
		onRegistered?: (yieldWait: (reason: C.YieldReason) => C.Result<C.WaitOutcome, C.YieldError>) => void,
	) {
		const task = this.resolveTask(taskId);
		return task.ok
			? this.supervisor.initialObservation(task.value, policy, (wait) => {
					if (policy?.kind === "foreground") this.trackMessageWait(wait);
					onRegistered?.((reason) => this.supervisor.yieldTaskWait(wait, reason));
				})
			: Promise.resolve(task);
	}

	waitForTask(taskId: C.TaskId, budgetMs?: number, onRegistered?: (wait: WaitLease) => void) {
		return this.supervisor.waitForTaskId(this.owner, taskId, budgetMs, (wait) => {
			this.trackMessageWait(wait);
			onRegistered?.(wait);
		});
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
		if (this.tasksPaused) throw new Error("Workflow stage tasks are paused");
		this.launched = true;
		this.watchHeartbeats();
	}
}
