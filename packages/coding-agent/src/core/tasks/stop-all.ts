import type { WorkflowRunControl } from "../extensions/workflow-run-control.js";
import { getOwnerTaskStore } from "./owner-store.js";
import { ownerTaskViewSource } from "./task-view-source.js";

/** What Ctrl+X Ctrl+K stopped: background subagents, workflow runs, and what could not be stopped. */
export interface StopAllBackgroundOutcome {
	readonly agents: number;
	readonly workflowRuns: number;
	readonly failures: readonly string[];
}

/** The session whose background subagents and workflow runs Ctrl+X Ctrl+K stops. */
export interface StopAllBackgroundSession {
	readonly workflows?: Pick<WorkflowRunControl, "listRuns" | "quit">;
}

const ACTIVE_RUN_STATUSES = new Set(["pending", "running", "paused"]);

/**
 * Stops every running or queued background subagent this session owns, and quits every workflow run it owns. Shells
 * keep running. A quit workflow run stays resumable; a stopped subagent's result says it was stopped.
 */
export async function stopAllBackgroundWork(session: StopAllBackgroundSession): Promise<StopAllBackgroundOutcome> {
	const failures: string[] = [];
	const store = getOwnerTaskStore(session);
	const source = store === undefined ? undefined : ownerTaskViewSource(store);
	const agents = (store?.backgroundTasks ?? []).filter(
		(task) => task.kind === "agent" && task.execution.kind !== "settled",
	);
	const stoppedAgents = await Promise.all(
		agents.map(async (task) => {
			const result = await source?.cancelTask(task.ref.taskId);
			if (result?.ok) return 1;
			failures.push(`${task.agentName ?? task.title}: ${result?.error.message ?? "task owner unavailable"}`);
			return 0;
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
	return { agents: stoppedAgents.reduce<number>((sum, value) => sum + value, 0), workflowRuns, failures };
}

/** The one-line notice a stop-all leaves in the chat. */
export function stopAllBackgroundMessage(outcome: StopAllBackgroundOutcome): string {
	const parts: string[] = [];
	if (outcome.agents > 0) parts.push(`${outcome.agents} ${outcome.agents === 1 ? "subagent" : "subagents"}`);
	if (outcome.workflowRuns > 0)
		parts.push(`${outcome.workflowRuns} workflow ${outcome.workflowRuns === 1 ? "run" : "runs"}`);
	const stopped =
		parts.length > 0 ? `Stopped ${parts.join(" and ")}.` : "No background subagents or workflow runs to stop.";
	return outcome.failures.length > 0 ? `${stopped} Could not stop: ${outcome.failures.join("; ")}` : stopped;
}
