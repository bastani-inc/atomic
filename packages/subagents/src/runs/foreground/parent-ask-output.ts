import type { ForegroundParentAskPause, ParentAskPauseRequest } from "../../shared/types.js";

export const RELEASED_SIBLING_RESUME_MESSAGE = "Continue from the point where parent coordination paused the group.";

function formatAttachments(request: ParentAskPauseRequest): string {
	let text = "";
	for (const attachment of request.attachments ?? []) {
		if (attachment.language) {
			text += `\n\n---\n📎 ${attachment.name}\n~~~${attachment.language}\n${attachment.content}\n~~~`;
		} else {
			text += `\n\n---\n📎 ${attachment.name}\n${attachment.content}`;
		}
	}
	return text;
}

function formatQuestion(request: ParentAskPauseRequest): string {
	const parts: string[] = [];
	if (request.question.length > 0) parts.push(request.question);
	if (request.interview) parts.push(JSON.stringify(request.interview, null, 2));
	return (parts.join("\n\n") || "(No question text supplied.)") + formatAttachments(request);
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
