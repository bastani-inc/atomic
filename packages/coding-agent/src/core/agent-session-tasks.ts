import { randomUUID } from "node:crypto";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { getExtensionRuntimeEventBus } from "./extensions/loader-core.js";
import { sessionGenerationClosing } from "./session-lifecycle-work.ts";
import { AgentTaskHost } from "./tasks/agent-adapter.js";
import { type ChildTaskCompletionRoute, childTaskCompletionRoute } from "./tasks/child-command-owner.js";
import { COMMAND_DETAIL_TAIL_BYTES, taskOutputText } from "./tasks/command-output.js";
import {
	formatTaskCompletion,
	TASK_COMPLETION_MESSAGE_TYPE,
	TaskCompletionOutbox,
	taskCompletionNotice,
} from "./tasks/completion.js";
import { flushTaskCompletionMessages } from "./tasks/completion-ordering.js";
import { bindOwnerTaskStore, OwnerTaskStore } from "./tasks/owner-store.js";
import { taskTranscriptSource } from "./tasks/supervisor.js";
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

export function replaceSessionTaskOwner(session: AgentSession): void {
	if (stageTaskAdmission(session)) return;
	replacementOwnerScopes.set(session, randomUUID());
	session._agentTaskHost = undefined;
	session._taskAdmission = undefined;
	session._taskCompletionOutbox = undefined;
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
		async (envelope) => {
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
			const response = source?.ok
				? source.value.session
						.getEntries()
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
			if (task?.kind === "command" && lease?.ok && host) {
				try {
					const bytes = BigInt(task.output.byteCount);
					const start = bytes > BigInt(COMMAND_DETAIL_TAIL_BYTES) ? bytes - BigInt(COMMAND_DETAIL_TAIL_BYTES) : 0n;
					const page = await host.ownerBinding.supervisor.readTaskOutput(lease.value, {
						start: String(start),
						maximumBytes: COMMAND_DETAIL_TAIL_BYTES,
					});
					output = page.ok
						? `${start > 0n ? "[Earlier output omitted]\n" : ""}${taskOutputText(page.value)}`
						: "Output unavailable";
				} catch {
					// Missing retained output must not suppress a terminal notification.
					output = "Output unavailable";
				}
			}
			const message = {
				customType: TASK_COMPLETION_MESSAGE_TYPE,
				content: formatTaskCompletion(envelope, task, output),
				details: { ...envelope, notification: taskCompletionNotice(envelope, task, output) },
				display: true as const,
			};
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
			await admission.admit(
				envelope.completionId,
				() =>
					this.sendCustomMessage(message, {
						triggerTurn: true,
						persistWhenStreaming: true,
						stageAdmissionKey: envelope.completionId,
					}),
				() => {
					throw new Error("Task owner is closed");
				},
			).completion;
		},
	);
	this._taskCompletionOutbox = outbox;
	const binding = {
		authorizeLaunch: () => {
			if (this._disposed || sessionGenerationClosing.has(this) || !admission.isOpen())
				throw new Error("Task owner is closed");
			if (isSubagentChildSession(this)) throw new Error("Subagent delegation is not available inside a subagent");
		},
		onTaskSettled: (
			...[ref, receipt]: Parameters<NonNullable<import("./tasks/supervisor.js").TrustedTaskHost["onTaskSettled"]>>
		) => {
			outbox.record(ref.ownerId, receipt);
			void outbox.flush();
		},
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
	return this._agentTaskHost;
}

/**
 * Shell task owner for this session. A subagent child runs shells in its parent's owner,
 * so they appear in the parent's `/tasks` and outlive the child.
 */
export function _getCommandTaskOwner(this: AgentSession): SupervisedCommandOwner | undefined {
	if (!isSubagentChildSession(this)) return this.getAgentTaskHost().ownerBinding;
	if (!this._parentCommandTaskOwner || this._disposed) return undefined;
	const route: ChildTaskCompletionRoute = {
		isOpen: () => !this._disposed && this._subagentPolicy?.messageAdmission?.isOpen() === true,
		deliver: async (message) => {
			const admission = this._subagentPolicy?.messageAdmission;
			if (!admission) throw new Error("Subagent execution cannot accept messages");
			await admission.run(() => this.sendCustomMessage(message, { triggerTurn: true, persistWhenStreaming: true }));
		},
	};
	return this._parentCommandTaskOwner.bind(this.sessionManager.getSessionId(), route, this._childTaskWaits);
}

export async function closeSessionTasks(this: AgentSession): Promise<void> {
	// Replacement stage sessions share generation lifetime; disposal is not stage closure.
	if (stageTaskAdmission(this)) return;
	this._taskAdmission?.seal();
	const closed = await this._agentTaskHost?.close("session-close");
	if (closed && !closed.ok) throw new Error(`${closed.error.code}: ${closed.error.message}`);
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
