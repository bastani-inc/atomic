import { randomUUID } from "node:crypto";
import { hasToolDetachment, waitsOnDetachedResults } from "./agent-session-detached-tools.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { hasUnreadProtectedCustomMessage } from "./agent-session-persistent-custom-messages.ts";
import { getExtensionRuntimeEventBus } from "./extensions/loader-core.js";
import { sessionGenerationClosing } from "./session-lifecycle-work.ts";
import { AgentTaskHost } from "./tasks/agent-adapter.js";
import { type ChildTaskCompletionRoute, childTaskCompletionRoute } from "./tasks/child-command-owner.js";
import { type TaskCompletionEnvelope, TaskCompletionOutbox } from "./tasks/completion.js";
import { commandOutputExcerpt, taskCompletionMessage } from "./tasks/completion-message.js";
import { flushTaskCompletionMessages } from "./tasks/completion-ordering.js";
import type * as C from "./tasks/contracts.js";
import { TASK_HEARTBEAT_MESSAGE_TYPE, type TaskHeartbeatDelivery } from "./tasks/heartbeat.js";
import { bindOwnerTaskStore, getOwnerTaskStore, OwnerTaskStore } from "./tasks/owner-store.js";
import { taskOwnTranscriptEntries, taskTranscriptSource } from "./tasks/supervisor.js";
import type { SupervisedCommandOwner } from "./tools/bash-pty-native.js";
import { WorkflowStageAdmissionBoundary } from "./workflow-stage-admission.ts";

// Native owners identify live generations, never borrowed persisted storage.
// Explicit workflow-stage owners remain borrowed across session replacement.
const replacementOwnerScopes = new WeakMap<object, string>();

/** An admitted in-process subagent child; top-level sessions may carry a policy without `depth`. */
export function isSubagentChildSession(session: Pick<AgentSession, "_subagentPolicy">): boolean {
	return (session._subagentPolicy?.depth ?? 0) >= 1;
}

/**
 * A child launched from a workflow stage inherits the stage's admission boundary for
 * message delivery, but must never bind or rebind the stage's own task owner.
 */
function stageTaskAdmission(session: AgentSession) {
	return isSubagentChildSession(session) ? undefined : session._workflowStageAdmission;
}

/** Whether the session runs its tasks on a workflow stage's own task host, which outlives each of its sessions. */
export function isWorkflowStageTaskOwner(session: AgentSession): boolean {
	return stageTaskAdmission(session) !== undefined;
}

export function replaceSessionTaskOwner(session: AgentSession): void {
	if (stageTaskAdmission(session)) return;
	replacementOwnerScopes.set(session, randomUUID());
	session._agentTaskHost = undefined;
	session._taskAdmission = undefined;
	session._taskCompletionOutbox = undefined;
}

/**
 * The task host a subagent child of this session runs its shells in. A workflow stage's host outlives each of the
 * stage's sessions, so its workers keep their shells when the session that launched them is released or replaced
 * (#4639).
 */
export function childCommandTaskHost(session: AgentSession): AgentTaskHost {
	return stageTaskAdmission(session)?.agentTaskHost() ?? session.getAgentTaskHost();
}

export function getAgentTaskHost(this: AgentSession): AgentTaskHost {
	if (this._disposed || sessionGenerationClosing.has(this)) throw new Error("Task owner is closed");
	if (this._agentTaskHost) return this._agentTaskHost;
	const stageAdmission = stageTaskAdmission(this);
	const admission = stageAdmission ?? WorkflowStageAdmissionBoundary.restore(this.sessionManager.getEntries());
	this._taskAdmission = admission;
	const outbox = new TaskCompletionOutbox(
		this.sessionManager,
		() => !this._disposed && admission.isOpen(),
		async (envelope, restored) => {
			// Settlement can precede the UI projection's next drain. Read the owner
			// snapshot, not the display store, when attaching completion context.
			const host = this._agentTaskHost;
			const watched = host?.watchOwnerTasks();
			const task = watched?.ok
				? watched.value.snapshot.tasks.find(
						(item) => item.ref.taskId === envelope.taskId && item.ref.ownerId === envelope.ownerId,
					)
				: undefined;
			if (watched?.ok) watched.value.dispose();
			// Foreground shell results already return through their tool call. Do not
			// create a second model turn or background card for that same execution.
			if (task?.kind === "command" && !task.wasBackground) return;
			const lease = task ? host?.resolveTask(envelope.taskId) : undefined;
			const source = lease?.ok ? taskTranscriptSource(lease.value) : undefined;
			const ownEntries = lease?.ok ? taskOwnTranscriptEntries(lease.value) : undefined;
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
			let output =
				response?.type === "message" && response.message.role === "assistant"
					? response.message.content
							.filter((block) => block.type === "text")
							.map((block) => block.text)
							.join("\n")
					: undefined;
			if (task?.kind === "command" && lease?.ok && host)
				output = await commandOutputExcerpt(host, lease.value, task);
			const message = taskCompletionMessage(envelope, task, output);
			const childRoute =
				host && task?.kind === "command" ? childTaskCompletionRoute(host, envelope.taskId) : undefined;
			if (childRoute) {
				try {
					await childRoute.deliver(message);
					return;
				} catch {
					// The launching child ended before delivery; the owning parent receives the notice.
				}
			}
			const completionSource = source?.ok ? source.value.session.completionSource : undefined;
			if (completionSource) {
				await flushTaskCompletionMessages(
					getExtensionRuntimeEventBus(this._resourceLoader.getExtensions().runtime),
					completionSource,
					envelope.completionId,
				);
			}
			const deliver = () =>
				this.sendCustomMessage(
					message,
					restored
						? { triggerTurn: false, stageAdmissionKey: envelope.completionId }
						: { triggerTurn: true, persistWhenStreaming: true, stageAdmissionKey: envelope.completionId },
				);
			if (stageAdmission) await deliver();
			else {
				await admission.admit(envelope.completionId, deliver, () => {
					throw new Error("Task owner is closed");
				}).completion;
			}
		},
		// Each notice holds its task's record until it is delivered, so a burst of finishes cannot evict what the
		// notice is built from (#4385).
		(envelope) => this._agentTaskHost?.releaseTaskRecord(envelope.taskId),
		() => !waitsOnDetachedResults(this),
		(envelope) => releaseDeliveredTaskRecord(this._agentTaskHost, envelope),
	);
	this._taskCompletionOutbox = outbox;
	const heartbeat: TaskHeartbeatDelivery = {
		defaultIntervalMs: () => this.settingsManager.getTaskHeartbeatMs(),
		hasUnreadHeartbeat: () => hasUnreadProtectedCustomMessage(this, TASK_HEARTBEAT_MESSAGE_TYPE),
		deliver: async (message) => {
			if (this._disposed || !admission.isOpen()) throw new Error("Task owner is closed");
			// The workflow heartbeat delivery: a visible card plus a steer that waits for the next safe boundary,
			// never interrupting a response in progress.
			const deliver = () =>
				this.sendCustomMessage(message, { triggerTurn: true, deliverAs: "steer", persistWhenStreaming: true });
			if (stageAdmission) await deliver();
			else
				await admission.admit(undefined, deliver, () => {
					throw new Error("Task owner is closed");
				}).completion;
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
		onTaskSettled: (
			...[ref, receipt]: Parameters<NonNullable<import("./tasks/supervisor.js").TrustedTaskHost["onTaskSettled"]>>
		) => {
			// Save the task's kind with the intent: a notice replayed after a restart has no task record to read it from.
			const watched = this._agentTaskHost?.watchOwnerTasks();
			const kind = watched?.ok
				? watched.value.snapshot.tasks.find((task) => task.ref.taskId === receipt.taskId)?.kind
				: undefined;
			if (watched?.ok) watched.value.dispose();
			this._agentTaskHost?.retainTaskRecord(receipt.taskId);
			outbox.record(ref.ownerId, receipt, kind);
			void outbox.flush();
		},
		onTaskCleanupQuarantined: (ref: C.NativeTaskRef, resources: readonly C.ResourceFailure[]) =>
			this._emit({ type: "task_cleanup_quarantined", taskId: ref.taskId, resources }),
	};
	if (!stageAdmission && !replacementOwnerScopes.has(this)) replacementOwnerScopes.set(this, randomUUID());
	this._agentTaskHost = stageAdmission
		? stageAdmission.bindAgentTaskHost(binding)
		: new AgentTaskHost({
				...binding,
				scope: {
					kind: "session",
					sessionId: replacementOwnerScopes.get(this)!,
				},
			});
	const { supervisor, owner } = this._agentTaskHost.ownerBinding;
	const store = new OwnerTaskStore(supervisor, owner);
	const connected = store.connect();
	if (!connected.ok) throw new Error(connected.error.message);
	bindOwnerTaskStore(this, store);
	// Tasks that settled while the stage was released reach this session's transcript as a restart's would.
	const parked = stageAdmission?.takeParkedTaskSettlements() ?? [];
	for (const settlement of parked) outbox.record(settlement.ownerId, settlement.receipt, settlement.kind, true);
	if (parked.length > 0) void outbox.flushRestored();
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

export async function closeSessionTasks(this: AgentSession): Promise<void> {
	this._parentCommandTaskOwner?.unbind(this.sessionManager.getSessionId());
	// Replacement stage sessions share generation lifetime; disposal is not stage closure. The session's own view of
	// the stage's tasks ends with it: the stage opens a new one for each session.
	if (stageTaskAdmission(this)) {
		getOwnerTaskStore(this)?.dispose();
		return;
	}
	this._taskAdmission?.seal();
	const host = this._agentTaskHost;
	const closed = await host?.close("session-close");
	if (closed && !closed.ok) throw host!.closeError("session-close", closed.error);
}

/** Workflow controller only: main-chat message pause does not stop owned tasks. */
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
