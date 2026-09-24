import type { AgentTaskHost } from "./agent-adapter.js";
import type { OwnerSnapshot, TaskRecord } from "./contracts.js";

/** The caller synchronously blocks new launches; this never closes the owner or its messages. */
export async function cancelPausedOwnerTasks(host: AgentTaskHost): Promise<void> {
	const errors: Error[] = [];
	const cancel = async (tasks: TaskRecord[]): Promise<void> => {
		// Cancel every queued agent before an active cancellation can free a dispatch slot.
		const ordered = tasks.sort(
			(a, b) => Number(b.execution.kind === "queued") - Number(a.execution.kind === "queued"),
		);
		const results = await Promise.allSettled(ordered.map((task) => host.cancelTask(task.ref.taskId, "user")));
		for (const result of results) {
			if (result.status === "rejected") errors.push(new Error(String(result.reason)));
			else if (!result.value.ok) errors.push(new Error(`${result.value.error.code}: ${result.value.error.message}`));
		}
	};
	const watched = host.watchOwnerTasks();
	if (!watched.ok) throw new Error(`${watched.error.code}: ${watched.error.message}`);
	const watch = watched.value;
	try {
		await cancel(watch.snapshot.tasks.filter((task) => task.kind === "agent" && task.execution.kind !== "settled"));
		const { supervisor, owner } = host.ownerBinding;
		// Already-started native setup may briefly launch during the transition. Wait for
		// every admitted lease before cancelling shells and certifying the final snapshot.
		await supervisor.drainCommandAdmissions(owner);
		watch.drain();
		await cancel(watch.snapshot.tasks.filter((task) => task.kind === "command" && task.execution.kind !== "settled"));
		if (errors.length) throw new AggregateError(errors, "Workflow stage task cancellation failed");
		await new Promise<void>((resolve, reject) => {
			watch.onReconcile = (snapshot: OwnerSnapshot) => {
				if (
					snapshot.tasks.some(
						(task) =>
							task.cleanup.kind === "active" ||
							task.cleanup.kind === "draining" ||
							(task.execution.kind !== "settled" && task.cleanup.kind !== "failed"),
					)
				)
					return;
				const failures = snapshot.tasks.flatMap((task) =>
					task.cleanup.kind === "failed" ? task.cleanup.resources : [],
				);
				if (failures.length)
					reject(
						new Error(
							`Workflow stage task cleanup failed: ${failures.map((failure) => `${failure.resource}: ${failure.message}`).join("; ")}`,
						),
					);
				else resolve();
			};
			watch.drain();
			watch.onReconcile(watch.snapshot, []);
		});
	} finally {
		watch.dispose();
	}
}
