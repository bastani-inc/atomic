import type { ForegroundParentAskPause, ParentAskPauseRequest } from "../../shared/types.js";

export const RELEASED_SIBLING_RESUME_MESSAGE = "Continue from the point where parent coordination paused the group.";

function formatQuestion(request: ParentAskPauseRequest): string {
	const parts: string[] = [];
	if (request.question.length > 0) parts.push(request.question);
	if (request.interview) parts.push(JSON.stringify(request.interview, null, 2));
	return parts.join("\n\n") || "(No question text supplied.)";
}

export function formatParentAskPauseOutput(pause: ForegroundParentAskPause): string {
	const request = pause.request;
	return [
		`Subagent paused for parent input (${request.agent}, child ${request.index + 1}).`,
		`Run: ${request.runId}`,
		"Question:",
		formatQuestion(request),
		"",
		`Resume with: subagent({ action: "resume", id: "${request.runId}", message: "<answer>" })`,
	].join("\n");
}
