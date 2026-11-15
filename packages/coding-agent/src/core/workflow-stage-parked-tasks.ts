import type { SessionManager } from "./session-manager.ts";
import type { AgentTaskHost } from "./tasks/agent-adapter.js";
import type { TaskCompletionEnvelope } from "./tasks/completion.js";
import type { OwnerId, Sequence, TaskId } from "./tasks/contracts.js";
import type { WorkflowStageAdmissionBoundary } from "./workflow-stage-admission.ts";

/**
 * The shells a workflow stage ran when it was released (#5079). Their completions then wait in the process's memory for
 * the stage's next session; a restart loses them, and the resumed stage is told instead that they were interrupted.
 */
export const PARKED_STAGE_TASKS_TYPE = "workflow-stage-parked-tasks";

interface ParkedStageTasks {
	/** The stage generation, in the process that released the stage. */
	readonly attemptId: string;
	readonly tasks: readonly { readonly ownerId: OwnerId; readonly taskId: TaskId }[];
}

/** Save the stage's running shells as the stage is released, before its session lets go of the store. */
export async function recordParkedStageTasks(
	sessionManager: Pick<SessionManager, "appendCustomEntry">,
	boundary: WorkflowStageAdmissionBoundary,
	host: AgentTaskHost | undefined,
): Promise<void> {
	if (!boundary.isParked() || host === undefined) return;
	const watched = host.watchOwnerTasks();
	if (!watched.ok) return;
	const tasks = watched.value.snapshot.tasks
		.filter(
			(task) => task.kind === "command" && (task.execution.kind === "queued" || task.execution.kind === "running"),
		)
		.map((task) => ({ ownerId: task.ref.ownerId, taskId: task.ref.taskId }));
	watched.value.dispose();
	if (tasks.length === 0) return;
	const marker: ParkedStageTasks = { attemptId: boundary.attemptId, tasks };
	await sessionManager.appendCustomEntry(PARKED_STAGE_TASKS_TYPE, marker);
}

/**
 * Save, once, an interrupted-by-a-restart completion intent for each shell an earlier process's release of the stage
 * left without one. A release in this process still holds their completions, and an intent already saved for a shell,
 * from that process or by an earlier recovery, is its notice. Returns how many were saved.
 */
export async function recordTasksInterruptedByRestart(
	sessionManager: Pick<SessionManager, "getEntries" | "appendCustomEntry">,
	attemptId: string | undefined,
): Promise<number> {
	const entries = sessionManager.getEntries();
	const intents = new Set<string>();
	const interrupted: TaskCompletionEnvelope[] = [];
	for (const [index, entry] of entries.entries()) {
		if (entry.type !== "custom" || entry.customType !== PARKED_STAGE_TASKS_TYPE) continue;
		const marker = entry.data as ParkedStageTasks;
		if (marker.attemptId === attemptId) continue;
		intents.clear();
		for (const later of entries.slice(index + 1)) {
			if (later.type !== "custom" || later.customType !== "task-completion-intent") continue;
			const envelope = later.data as TaskCompletionEnvelope;
			intents.add(envelope.completionId);
			intents.add(`${envelope.ownerId}\0${envelope.taskId}`);
		}
		for (const { ownerId, taskId } of marker.tasks) {
			const completionId = `restart-interrupted:${marker.attemptId}:${ownerId}:${taskId}`;
			if (intents.has(completionId) || intents.has(`${ownerId}\0${taskId}`)) continue;
			interrupted.push({
				completionId,
				ownerId,
				taskId,
				terminalSequence: "0" as Sequence,
				result: { kind: "cancelled", cause: "shutdown" },
				display: false,
				taskKind: "command",
				interruptedByRestart: true,
			});
		}
	}
	for (const envelope of interrupted) await sessionManager.appendCustomEntry("task-completion-intent", envelope);
	return interrupted.length;
}
