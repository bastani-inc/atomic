import type { ForegroundParentAskHandoff, ParentAskHandoffRequest } from "../../shared/types.js";

function formatAttachments(request: ParentAskHandoffRequest): string {
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

function formatQuestion(request: ParentAskHandoffRequest): string {
	const parts: string[] = [];
	if (request.question.length > 0) parts.push(request.question);
	if (request.interview) parts.push(JSON.stringify(request.interview, null, 2));
	return parts.join("\n\n") + formatAttachments(request);
}

function freshTask(request: ParentAskHandoffRequest): string {
	return [
		"[TASK_CONTEXT]",
		"Original delegated task and objective:",
		request.taskContext ?? "(Original task context unavailable.)",
		"",
		`Previous child identity: ${request.agent} (child ${request.index + 1})`,
		"Previous child question:",
		formatQuestion(request),
		"",
		"Continue with this supervisor answer: <SUPERVISOR_ANSWER>",
	].join("\n");
}

export function formatParentAskHandoffOutput(handoff: ForegroundParentAskHandoff): string {
	const request = handoff.request;
	const call = JSON.stringify({ agent: request.agent, task: freshTask(request) }, null, 2);
	return [
		`Subagent yielded for parent input (${request.agent}, child ${request.index + 1}).`,
		`Previous run (terminal): ${request.runId}`,
		"Question:",
		formatQuestion(request),
		"",
		"Start a fresh subagent with a new run identity, replacing <SUPERVISOR_ANSWER> with your answer:",
		`subagent(${call})`,
	].join("\n");
}
