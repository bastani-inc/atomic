import { randomUUID } from "node:crypto";
import { hasToolDetachment, waitsOnDetachedResults } from "./agent-session-detached-tools.ts";
import { pendingCustomMessageSaved } from "./agent-session-message-queue.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { hasUnreadProtectedCustomMessage } from "./agent-session-persistent-custom-messages.ts";
import { getExtensionRuntimeEventBus } from "./extensions/loader-core.js";
import { MessageAdmissionBoundary } from "./message-admission.js";
import { sessionGenerationClosing } from "./session-lifecycle-work.ts";
import { AgentTaskHost } from "./tasks/agent-adapter.js";
import {
	type ChildTaskCompletionRoute,
	deliverToLaunchingSession,
	forgetChildDelivery,
	type TaskCompletionMessage,
} from "./tasks/child-command-owner.js";
import {
	type AdmittedTaskCompletion,
	releasedWaitingOn,
	type TaskCompletionEnvelope,
	TaskCompletionOutbox,
} from "./tasks/completion.js";
import { type CommandOutputExcerpt, commandOutputExcerpt, taskCompletionMessage } from "./tasks/completion-message.js";
import type { TaskCompletionSource } from "./tasks/completion-ordering.js";
import { flushTaskCompletionMessages } from "./tasks/completion-ordering.js";
import type * as C from "./tasks/contracts.js";
import { TASK_HEARTBEAT_MESSAGE_TYPE, type TaskHeartbeatDelivery } from "./tasks/heartbeat.js";
import { bindOwnerTaskStore, OwnerTaskStore } from "./tasks/owner-store.js";
import { loadTaskOwnTranscriptEntries, taskTranscriptSource } from "./tasks/supervisor.js";
import type { SupervisedCommandOwner } from "./tools/bash-pty-native.js";

// Native owners identify live generations, never borrowed persisted storage.
const replacementOwnerScopes = new WeakMap<object, string>();

/** An admitted in-process subagent child; top-level sessions may carry a policy without `depth`. */
export function isSubagentChildSession(session: Pick<AgentSession, "_subagentPolicy">): boolean {
	return (session._subagentPolicy?.depth ?? 0) >= 1;
}

export function replaceSessionTaskOwner(session: AgentSession): void {
	replacementOwnerScopes.set(session, randomUUID());
	session._agentTaskHost = undefined;
	session._taskAdmission = undefined;
	session._taskCompletionOutbox = undefined;
}

export function childCommandTaskHost(session: AgentSession): AgentTaskHost {
	return session.getAgentTaskHost();
}

/** A finished task's notice, built and ready to deliver. */
interface PreparedNotice {
	readonly envelope: TaskCompletionEnvelope;
	readonly message: TaskCompletionMessage;
	/** Whether the task's record was read: a notice without one starts no turn. */
	readonly hasTask: boolean;
	readonly completionSource: TaskCompletionSource | undefined;
}

/** {@link childCommandTaskHost} when the session already holds it, without opening one. */
export function openChildCommandTaskHost(session: AgentSession): AgentTaskHost | undefined {
	if (session._disposed) return undefined;
	return session._agentTaskHost;
}

export function getAgentTaskHost(this: AgentSession): AgentTaskHost {
	if (this._disposed || sessionGenerationClosing.has(this)) throw new Error("Task owner is closed");
	if (this._agentTaskHost) return this._agentTaskHost;
	const admission = MessageAdmissionBoundary.restore(
		this.sessionManager.getEntries(),
		undefined,
		this.sessionManager.getSessionRecoveryState?.().admissionDigests,
	);
	this._taskAdmission = admission;
	/** A settled task's notice, read from the owner's snapshot; undefined for a foreground shell, which has none. */
	const prepare = async (envelope: TaskCompletionEnvelope): Promise<PreparedNotice | undefined> => {
		// Settlement can precede the UI projection's next drain. Read the owner
		// snapshot, not the display store, when attaching completion context.
		const host = this._agentTaskHost;
		const task = host
			?.taskRecords(new Set([envelope.taskId as C.TaskId]))
			.find((item) => item.ref.ownerId === envelope.ownerId && settledWithCompletion(host, envelope));
		// Foreground shell results already return through their tool call. Do not
		// create a second model turn or background card for that same execution.
		if (task?.kind === "command" && !task.wasBackground) return undefined;
		const lease = task ? host?.resolveTask(envelope.taskId) : undefined;
		const source = lease?.ok ? taskTranscriptSource(lease.value) : undefined;
		// A finished child keeps its history in its session store, not in memory (#5186).
		const ownEntries = lease?.ok ? await loadTaskOwnTranscriptEntries(lease.value) : undefined;
		const response = ownEntries
			? ownEntries
					.slice()
					.reverse()
					.find(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "assistant" &&
							entry.message.content.some((block) => block.type === "text" && block.text.trim()),
					)
			: undefined;
		let output: string | CommandOutputExcerpt | undefined =
			response?.type === "message" && response.message.role === "assistant"
				? response.message.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n")
				: undefined;
		if (task?.kind === "command" && lease?.ok && host) output = await commandOutputExcerpt(host, lease.value, task);
		const completionSource = source?.ok ? source.value.session.completionSource : undefined;
		return {
			envelope,
			message: taskCompletionMessage(envelope, task, output, completionSource?.intercomTarget),
			hasTask: task !== undefined,
			completionSource,
		};
	};
	/**
	 * The notices of tasks that finished together reach their session as one message, so as one turn. A shell a subagent
	 * launched in this owner belongs to that subagent's session: its notice goes there, now or when it runs again, and
	 * never to this session; it is acknowledged here once the subagent took it. This session's own notices reach it or
	 * wait for it.
	 */
	const admitBatch = async (
		envelopes: readonly TaskCompletionEnvelope[],
		restored: boolean,
	): Promise<AdmittedTaskCompletion[]> => {
		const prepared = await Promise.all(envelopes.map(prepare));
		const admitted: AdmittedTaskCompletion[] = envelopes.map(() => undefined);
		const own: PreparedNotice[] = [];
		const launched = new Map<string, PreparedNotice[]>();
		for (const notice of prepared) {
			if (notice === undefined) continue;
			const launcher = notice.envelope.launchedBy;
			if (launcher === undefined) own.push(notice);
			else launched.set(launcher, [...(launched.get(launcher) ?? []), notice]);
		}
		const host = this._agentTaskHost;
		for (const [launcher, notices] of launched) {
			if (host === undefined) throw new Error("Task owner is closed");
			for (const notice of notices)
				admitted[envelopes.indexOf(notice.envelope)] = {
					saved: deliverToLaunchingSession(host, launcher, notice.envelope.taskId, notice.message),
				};
		}
		if (own.length === 0) return admitted;
		try {
			for (const notice of own) {
				if (notice.completionSource === undefined) continue;
				await flushTaskCompletionMessages(
					getExtensionRuntimeEventBus(this._resourceLoader.getExtensions().runtime),
					notice.completionSource,
					notice.envelope.completionId,
				);
			}
			const key = own[0]!.envelope.completionId;
			// A restored notice, or one whose task is gone, joins the transcript without starting a turn. So does the notice of
			// a subagent released while it waits: it wakes by itself and nothing is asked of this session, which reads the
			// notice with its next turn. Notices admitted together reach the model in one request, which they start as one turn.
			const live =
				!restored &&
				own.some((notice) => notice.hasTask && releasedWaitingOn(notice.envelope.result) === undefined);
			const options = {
				triggerTurn: live,
				...(live ? { persistWhenStreaming: true } : {}),
				stageAdmissionKey: key,
			};
			const deliver = () =>
				own.length === 1
					? this.sendCustomMessage(own[0]!.message, options)
					: this.sendCustomMessages(
							own.map((notice) => notice.message),
							// Each notice keeps its own entry, recognized by its own completion after a restart.
							{ ...options, stageAdmissionKeys: own.map((notice) => notice.envelope.completionId) },
						);
			await admission.admit(key, deliver, () => {
				throw new Error("Task owner is closed");
			});
			// Without a turn, a notice admitted mid-turn waits in memory for that turn's end; it is acknowledged once saved (#5047).
			if (!live)
				for (const notice of own) {
					const saved = pendingCustomMessageSaved(this, notice.envelope.completionId);
					if (saved !== undefined) admitted[envelopes.indexOf(notice.envelope)] = { saved };
				}
		} catch {
			for (const notice of own) admitted[envelopes.indexOf(notice.envelope)] = { failed: true };
		}
		return admitted;
	};
	const outbox = new TaskCompletionOutbox(
		this.sessionManager,
		() => !this._disposed && admission.isOpen(),
		async (envelope, restored) => (await admitBatch([envelope], restored))[0],
		// Each notice holds its task's record until it is delivered, so a burst of finishes cannot evict what the
		// notice is built from (#4385).
		(envelope) => {
			forgetChildDelivery(host, envelope.completionId, envelope.taskId);
			host.releaseTaskRecord(envelope.taskId);
		},
		() => !waitsOnDetachedResults(this),
		(envelope) => {
			forgetChildDelivery(host, envelope.completionId);
			releaseDeliveredTaskRecord(host, envelope);
		},
		{ admitBatch },
	);
	this._taskCompletionOutbox = outbox;
	const heartbeat: TaskHeartbeatDelivery = {
		defaultIntervalMs: () => this.settingsManager.getTaskHeartbeatMs(),
		hasUnreadHeartbeat: () => hasUnreadProtectedCustomMessage(this, TASK_HEARTBEAT_MESSAGE_TYPE),
		deliver: async (message) => {
			if (this._disposed || !admission.isOpen()) throw new Error("Task owner is closed");
			// A task heartbeat: a visible card plus a steer that waits for the next safe boundary,
			// never interrupting a response in progress, and that starts a turn in a chat left idle by an interrupt.
			const deliver = () =>
				this.sendCustomMessage(message, {
					triggerTurn: true,
					deliverAs: "steer",
					persistWhenStreaming: true,
					wakeIdleSession: true,
				});
			await admission.admit(undefined, deliver, () => {
				throw new Error("Task owner is closed");
			});
		},
	};
	const binding = {
		resourceAdmission: this._resourceAdmission,
		heartbeat,
		authorizeLaunch: () => {
			if (this._disposed || sessionGenerationClosing.has(this) || !admission.isOpen())
				throw new Error("Task owner is closed");
			if (isSubagentChildSession(this)) throw new Error("Subagent delegation is not available inside a subagent");
		},
		onTaskFinishing: (
			...[ref, receipt, until]: Parameters<
				NonNullable<import("./tasks/supervisor.js").TrustedTaskHost["onTaskFinishing"]>
			>
		) => outbox.saveFinishing(ref.ownerId, receipt, until),
		onTaskSettled: (
			...[ref, receipt, timing]: Parameters<
				NonNullable<import("./tasks/supervisor.js").TrustedTaskHost["onTaskSettled"]>
			>
		) => {
			// Save the task's kind with the intent: a notice replayed after a restart has no task record to read it from.
			const kind =
				closingTaskKinds.get(this)?.get(receipt.taskId) ??
				this._agentTaskHost?.taskRecords(new Set([receipt.taskId]))[0]?.kind;
			this._agentTaskHost?.retainTaskRecord(receipt.taskId);
			// The intent keeps how long a command ran, for its notice line.
			outbox.record(
				ref.ownerId,
				timing?.elapsedMs === undefined ? receipt : { ...receipt, elapsedMs: timing.elapsedMs },
				kind,
			);
			void outbox.flush();
		},
		onTaskCleanupQuarantined: (ref: C.NativeTaskRef, resources: readonly C.ResourceFailure[]) =>
			this._emit({ type: "task_cleanup_quarantined", taskId: ref.taskId, resources }),
	};
	if (!replacementOwnerScopes.has(this)) replacementOwnerScopes.set(this, randomUUID());
	const host = new AgentTaskHost({
		...binding,
		scope: {
			kind: "session",
			sessionId: replacementOwnerScopes.get(this)!,
		},
	});
	this._agentTaskHost = host;
	const { supervisor, owner } = host.ownerBinding;
	const store = new OwnerTaskStore(supervisor, owner);
	const connected = store.connect();
	if (!connected.ok) throw new Error(connected.error.message);
	bindOwnerTaskStore(this, store);
	return this._agentTaskHost;
}

/**
 * Deliver the completion notices that waited while the transcript waited on a detached call's result, now that the
 * turn has resumed. Restored ones, from a release or an earlier process, reach the transcript without a turn.
 */
export function deliverHeldTaskCompletions(session: AgentSession): void {
	const outbox = session._taskCompletionOutbox;
	if (outbox === undefined || outbox.pending.length === 0 || waitsOnDetachedResults(session)) return;
	void outbox.flushRestored();
	void outbox.flush();
}

/**
 * Whether the owner's task with this id is the one that settled with this completion. Task ids restart with each
 * process, so a restored completion may name the id of a new, unrelated task; its notice then renders from its envelope
 * alone (#5047).
 */
function settledWithCompletion(host: AgentTaskHost, envelope: Pick<TaskCompletionEnvelope, "taskId" | "completionId">) {
	const task = host.resolveTask(envelope.taskId);
	return task.ok && host.ownerBinding.supervisor.taskCompletionId(task.value) === envelope.completionId;
}

function releaseDeliveredTaskRecord(
	host: AgentTaskHost | undefined,
	envelope: Pick<TaskCompletionEnvelope, "taskId" | "completionId">,
): void {
	if (host === undefined) return;
	const task = host.resolveTask(envelope.taskId);
	if (!task.ok) return;
	const { supervisor } = host.ownerBinding;
	if (supervisor.taskCompletionId(task.value) === envelope.completionId) supervisor.releaseTaskRecord(task.value);
}

/**
 * Shell task owner for this session. A subagent child runs shells in its parent's owner,
 * so they appear in the parent's `/tasks` and outlive the child.
 */
export function _getCommandTaskOwner(this: AgentSession): SupervisedCommandOwner | undefined {
	if (!isSubagentChildSession(this))
		return waitingUntilSettled(this.getAgentTaskHost().ownerBinding, hasToolDetachment(this));
	if (!this._parentCommandTaskOwner || this._disposed) return undefined;
	const route: ChildTaskCompletionRoute = {
		isOpen: () => !this._disposed && this._subagentPolicy?.messageAdmission?.isOpen() === true,
		deliver: async (message) => {
			const admission = this._subagentPolicy?.messageAdmission;
			if (!admission) throw new Error("Subagent execution cannot accept messages");
			await admission.run(() => this.sendCustomMessage(message, { triggerTurn: true, persistWhenStreaming: true }));
		},
	};
	return waitingUntilSettled(
		this._parentCommandTaskOwner.bind(this.sessionManager.getSessionId(), route, this._childTaskWaits),
		hasToolDetachment(this),
	);
}

/**
 * A subagent session that runs, or runs again, takes the notices of the shells it launched that were kept for it while
 * it could not, as soon as it opens rather than at its first shell call.
 */
export function bindChildTaskNotices(session: AgentSession): void {
	if (!isSubagentChildSession(session) || session._parentCommandTaskOwner === undefined) return;
	if (!session._parentCommandTaskOwner.hasOpenHost()) return;
	try {
		session._getCommandTaskOwner();
	} catch {
		// The launcher's task owner is closed: it keeps nothing for this session.
	}
}

type TaskWait = NonNullable<SupervisedCommandOwner["waitForTask"]>;

/** Wait for `taskId` to settle, through the yields of the owner's default budget. Takes no session: it outlives its run. */
async function waitUntilTaskSettles(
	wait: TaskWait,
	taskId: Parameters<TaskWait>[0],
	onRegistered: Parameters<TaskWait>[2],
): ReturnType<TaskWait> {
	for (;;) {
		const observed = await wait(taskId, undefined, onRegistered);
		if (!observed.ok || observed.value.kind !== "yielded" || observed.value.reason !== "elapsed") return observed;
	}
}

/**
 * In a session whose detachable calls may outlive its runs (`detaches`, decided when the owner is resolved), a shell
 * wait without a budget waits until its task settles instead of yielding at the owner's default budget, so the call can
 * detach and the session be released while the task runs. A wait that yields for any other reason, such as a message
 * for the session, still returns. The returned owner holds the owner binding and the flag, never the session: a
 * released child's wait runs on, and must not keep the child's session reachable.
 */
export function waitingUntilSettled(owner: SupervisedCommandOwner, detaches: boolean): SupervisedCommandOwner {
	const wait: TaskWait =
		owner.waitForTask ??
		((taskId, budgetMs, onRegistered) => owner.supervisor.waitForTaskId(owner.owner, taskId, budgetMs, onRegistered));
	return {
		...owner,
		waitForTask: (taskId, budgetMs, onRegistered) =>
			budgetMs !== undefined || !detaches
				? wait(taskId, budgetMs, onRegistered)
				: waitUntilTaskSettles(wait, taskId, onRegistered),
	};
}

/** The kinds of a closing session's tasks, read before its close leaves its owner unreadable (#5079). */
const closingTaskKinds = new WeakMap<AgentSession, ReadonlyMap<string, C.TaskRecord["kind"]>>();

export async function closeSessionTasks(this: AgentSession): Promise<void> {
	this._parentCommandTaskOwner?.unbind(this.sessionManager.getSessionId());
	this._taskAdmission?.seal();
	const host = this._agentTaskHost;
	const watched = host?.watchOwnerTasks();
	if (watched?.ok) {
		closingTaskKinds.set(this, new Map(watched.value.snapshot.tasks.map((task) => [task.ref.taskId, task.kind])));
		watched.value.dispose();
	}
	const closed = await host?.close("session-close");
	// The intents of the tasks the close cancelled are saved before the session's store closes, so the session's next
	// open shows their notices (#5079).
	await this._taskCompletionOutbox?.flush();
	if (closed && !closed.ok) throw host!.closeError("session-close", closed.error);
}

/** Main-chat message pause does not stop owned tasks. */
export async function pauseTasks(this: AgentSession): Promise<void> {
	await this.getAgentTaskHost().pauseTasks();
}

export function resumeTasks(this: AgentSession): void {
	this._agentTaskHost?.resumeTasks();
}

export const agentSessionTaskMethods = {
	getAgentTaskHost,
	_getCommandTaskOwner,
	closeSessionTasks,
	pauseTasks,
	resumeTasks,
};
