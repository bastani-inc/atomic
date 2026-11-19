import type { WorkflowRunControl } from "../extensions/workflow-run-control.js";
import { getOwnerTaskStore } from "./owner-store.js";
import { pluralNoun, toolTaskNoun, unreachableTaskKind } from "./task-kind.js";
import { ownerTaskViewSource } from "./task-view-source.js";

/** What Ctrl+X Ctrl+K stopped: background subagents, shells, workflow runs, and what could not be stopped. */
export interface StopAllBackgroundOutcome {
	readonly agents: number;
	readonly shells: number;
	/** Tool calls' background work stopped, by what the tool calls it: `{ search: 2 }`. */
	readonly tools?: Readonly<Record<string, number>>;
	readonly workflowRuns: number;
	readonly failures: readonly string[];
}

/** The session whose background subagents, shells and workflow runs Ctrl+X Ctrl+K stops. */
export interface StopAllBackgroundSession {
	readonly workflows?: Pick<WorkflowRunControl, "listRuns" | "quit">;
}

const ACTIVE_RUN_STATUSES = new Set(["pending", "running", "paused"]);

/**
 * Stops every running or queued background subagent and shell this session owns, and quits every workflow run it owns.
 * A quit workflow run stays resumable; a stopped task's result says it was stopped.
 */
export async function stopAllBackgroundWork(session: StopAllBackgroundSession): Promise<StopAllBackgroundOutcome> {
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
			if (result?.ok) return task;
			failures.push(`${task.agentName ?? task.title}: ${result?.error.message ?? "task owner unavailable"}`);
			return undefined;
		}),
	);
	let workflowRuns = 0;
	const workflows = session.workflows;
	if (workflows !== undefined) {
		try {
			const active = (await workflows.listRuns()).filter(
				(run) => ACTIVE_RUN_STATUSES.has(run.status) && run.endedAt === undefined,
			);
			if (active.length > 0) {
				const outcome = await workflows.quit({ all: true });
				const failed = outcome.failedRuns ?? [];
				workflowRuns = active.length - failed.length;
				for (const run of failed) failures.push(`workflow ${run.runId}: ${run.message ?? run.reason}`);
			}
		} catch (error) {
			// A session without the workflows extension has no runs to stop.
			const code = (error as { code?: string }).code;
			if (code !== "WORKFLOW_RUN_CONTROL_UNAVAILABLE")
				failures.push(`workflows: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const tools: Record<string, number> = {};
	let agents = 0;
	let shells = 0;
	for (const task of stopped) {
		if (task === undefined) continue;
		switch (task.kind) {
			case "agent":
				agents++;
				break;
			case "command":
				shells++;
				break;
			case "tool": {
				const noun = toolTaskNoun(task);
				tools[noun] = (tools[noun] ?? 0) + 1;
				break;
			}
			default:
				unreachableTaskKind(task.kind);
		}
	}
	return { agents, shells, ...(Object.keys(tools).length > 0 ? { tools } : {}), workflowRuns, failures };
}

/** The one-line notice a stop-all leaves in the chat. */
export function stopAllBackgroundMessage(outcome: StopAllBackgroundOutcome): string {
	const parts: string[] = [];
	if (outcome.agents > 0) parts.push(`${outcome.agents} ${outcome.agents === 1 ? "subagent" : "subagents"}`);
	if (outcome.shells > 0) parts.push(`${outcome.shells} ${outcome.shells === 1 ? "shell" : "shells"}`);
	for (const [noun, count] of Object.entries(outcome.tools ?? {}))
		if (count > 0) parts.push(`${count} ${count === 1 ? noun : pluralNoun(noun)}`);
	if (outcome.workflowRuns > 0)
		parts.push(`${outcome.workflowRuns} workflow ${outcome.workflowRuns === 1 ? "run" : "runs"}`);
	const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
	const stopped = list === undefined ? "No background work to stop." : `Stopped ${list}.`;
	return outcome.failures.length > 0 ? `${stopped} Could not stop: ${outcome.failures.join("; ")}` : stopped;
}
