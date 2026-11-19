import { getOwnerTaskStore } from "./owner-store.js";
import { ownerTaskViewSource } from "./task-view-source.js";

/** What Ctrl+X Ctrl+K stopped: background subagents, shells, and what could not be stopped. */
export interface StopAllBackgroundOutcome {
	readonly agents: number;
	readonly shells: number;
	readonly failures: readonly string[];
}

/** Stop every running or queued background subagent and shell owned by this session. */
export async function stopAllBackgroundWork(session: object): Promise<StopAllBackgroundOutcome> {
	const failures: string[] = [];
	const store = getOwnerTaskStore(session);
	const source = store === undefined ? undefined : ownerTaskViewSource(store);
	// Everything this session's owner runs stops, the shells its subagents launched there included.
	const live = (store?.ownerBackgroundTasks ?? []).filter(
		(task) => task.execution.kind !== "settled" && task.execution.kind !== "cancelling",
	);
	const stopped = await Promise.all(
		live.map(async (task) => {
			const result = await source?.cancelTask(task.ref.taskId);
			if (result?.ok) return task.kind;
			failures.push(`${task.agentName ?? task.title}: ${result?.error.message ?? "task owner unavailable"}`);
			return undefined;
		}),
	);
	return {
		agents: stopped.filter((kind) => kind === "agent").length,
		shells: stopped.filter((kind) => kind === "command").length,
		failures,
	};
}

/** The one-line notice a stop-all leaves in the chat. */
export function stopAllBackgroundMessage(outcome: StopAllBackgroundOutcome): string {
	const parts: string[] = [];
	if (outcome.agents > 0) parts.push(`${outcome.agents} ${outcome.agents === 1 ? "subagent" : "subagents"}`);
	if (outcome.shells > 0) parts.push(`${outcome.shells} ${outcome.shells === 1 ? "shell" : "shells"}`);
	const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
	const stopped = list === undefined ? "No background work to stop." : `Stopped ${list}.`;
	return outcome.failures.length > 0 ? `${stopped} Could not stop: ${outcome.failures.join("; ")}` : stopped;
}
