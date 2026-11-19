export interface SessionActivity {
	state: "working" | "idle" | "blocked";
	reason: "executing" | "awaiting_input" | "quiescent";
	message?: "Waiting for approval";
}

export interface SessionActivityInput {
	agentRunning: boolean;
	tasksRunning?: boolean;
	openPromptCount: number;
}

export function deriveSessionActivity(input: SessionActivityInput): SessionActivity {
	if (input.tasksRunning || (input.agentRunning && input.openPromptCount === 0))
		return { state: "working", reason: "executing" };
	if (input.openPromptCount > 0)
		return { state: "blocked", reason: "awaiting_input", message: "Waiting for approval" };
	return { state: "idle", reason: "quiescent" };
}
