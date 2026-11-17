import type { SessionManager } from "./session-manager.ts";
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
	/** `launchedBy` names the worker whose shell it is; absent for the stage's own. */
	readonly tasks: readonly { readonly ownerId: OwnerId; readonly taskId: TaskId; readonly launchedBy?: string }[];
}

/** Save the stage's running shells as the stage is released, before its session lets go of the store. */
export async function recordParkedStageTasks(
	sessionManager: Pick<SessionManager, "appendCustomEntry">,
	boundary: WorkflowStageAdmissionBoundary,
): Promise<void> {
	// A boundary parks only once a session bound the stage's task host.
	const watched = boundary.isParked() ? boundary.agentTaskHost()!.watchOwnerTasks() : undefined;
	if (!watched?.ok) return;
	const tasks = watched.value.snapshot.tasks
		.filter((task) => task.kind === "command" && task.execution.kind !== "settled")
		.map((task) => ({
			ownerId: task.ref.ownerId,
			taskId: task.ref.taskId,
			...(task.launchedBy === undefined ? {} : { launchedBy: task.launchedBy }),
		}));
	watched.value.dispose();
	if (tasks.length === 0) return;
	const marker: ParkedStageTasks = { attemptId: boundary.attemptId, tasks };
	await sessionManager.appendCustomEntry(PARKED_STAGE_TASKS_TYPE, marker);
}

/**
 * Save, once, an interrupted-by-a-restart completion intent for each shell an earlier process's release of the stage
 * left without one. A release in this process still holds their completions, and an intent saved after the release for
 * a shell, by that process or by an earlier recovery, is its notice: task ids restart with each process, so only an
 * intent saved after the release names that shell. Returns how many were saved.
 */
export async function recordTasksInterruptedByRestart(
	sessionManager: Pick<SessionManager, "getEntries" | "appendCustomEntry"> &
		Partial<Pick<SessionManager, "loadFullHistory">>,
	attemptId: string | undefined,
): Promise<number> {
	const entries = sessionManager.getEntries();
	const interrupted: TaskCompletionEnvelope[] = [];
	for (const [index, entry] of entries.entries()) {
		if (entry.type !== "custom" || entry.customType !== PARKED_STAGE_TASKS_TYPE) continue;
		const marker = entry.data as ParkedStageTasks;
		if (marker.attemptId === attemptId) continue;
		const notified = new Set(
			entries
				.slice(index + 1)
				.flatMap((later) =>
					later.type === "custom" && later.customType === "task-completion-intent"
						? [taskKey(later.data as TaskCompletionEnvelope)]
						: [],
				),
		);
		for (const { ownerId, taskId, launchedBy } of marker.tasks) {
			if (notified.has(taskKey({ ownerId, taskId }))) continue;
			interrupted.push({
				completionId: `restart-interrupted:${marker.attemptId}:${ownerId}:${taskId}`,
				ownerId,
				taskId,
				terminalSequence: "0" as Sequence,
				result: { kind: "cancelled", cause: "shutdown" },
				display: false,
				taskKind: "command",
				interruptedByRestart: true,
				// A worker's shell is that worker's to hear of, never the stage's.
				...(launchedBy === undefined ? {} : { launchedBy }),
			});
		}
	}
	for (const envelope of interrupted) await sessionManager.appendCustomEntry("task-completion-intent", envelope);
	return interrupted.length;
}

function taskKey(task: Pick<TaskCompletionEnvelope, "ownerId" | "taskId">): string {
	return `${task.ownerId}\0${task.taskId}`;
}
