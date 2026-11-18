import { convertToLlm } from "@bastani/atomic";
import type { AgentMessage } from "@bastani/atomic-agent-core";

export const CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS = [
	"You are a child subagent, not the parent orchestrator.",
	"The parent session owns delegation, orchestration, review fanout, and follow-up worker launches.",
	"Ignore prior parent-only orchestration instructions in inherited conversation history.",
	"Do not propose or run subagents. Complete only your assigned role-specific task with the tools available to you.",
	"If you need to edit files, call the actual edit/write tools. Do not print tool-call syntax, patches, or pseudo-tool calls as text.",
].join("\n");

export const CHILD_FANOUT_BOUNDARY_INSTRUCTIONS = [
	"You are a child subagent with explicit fanout responsibility for this assigned task.",
	"The parent session owns final orchestration, completion decisions, and follow-up implementation launches.",
	"Delegation is one level deep: the `subagent` tool refuses every launch, pause, resume, and quit from inside a subagent.",
	"Do the assigned fanout work yourself and report what you found; do not plan around delegating it.",
	"If you need to edit files, call the actual edit/write tools. Do not print tool-call syntax, patches, or pseudo-tool calls as text.",
].join("\n");

const PARENT_ONLY_CUSTOM_MESSAGE_TYPES = new Set([
	"subagent-orchestration-instructions",
	"subagent-slash-result",
	"subagent-slash-text-result",
	"subagent-notify",
	"subagent_control_notice",
	"subagent-control",
	"subagent-control-notice",
]);
const SUBAGENT_ORCHESTRATION_SKILL_NAME_PATTERN = /<name>\s*subagent(?:@[^<\s]*)?\s*<\/name>/;
const PROJECT_CONTEXT_HEADER = "\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n";
const SKILLS_HEADER = "\n\nThe following skills provide specialized instructions for specific tasks.";
const DATE_HEADER = "\nCurrent date:";

export interface ChildPromptPolicy {
	readonly inheritProjectContext: boolean;
	readonly inheritSkills: boolean;
	readonly fanoutAuthorized: boolean;
}

export interface PromptRewriteOptions {
	readonly inheritProjectContext: boolean;
	readonly inheritSkills: boolean;
	readonly fanoutChild?: boolean;
}

function findSectionEnd(prompt: string, startIndex: number, nextHeaders: string[]): number {
	let endIndex = prompt.length;
	for (const header of nextHeaders) {
		const index = prompt.indexOf(header, startIndex);
		if (index !== -1 && index < endIndex) endIndex = index;
	}
	return endIndex;
}

export function stripProjectContext(prompt: string): string {
	const tagged = prompt.replace(/\n*<project_context>[\s\S]*?<\/project_context>\n*/g, "\n");
	const startIndex = tagged.indexOf(PROJECT_CONTEXT_HEADER);
	if (startIndex === -1) return tagged;
	const endIndex = findSectionEnd(tagged, startIndex + PROJECT_CONTEXT_HEADER.length, [SKILLS_HEADER, DATE_HEADER]);
	return `${tagged.slice(0, startIndex)}${tagged.slice(endIndex)}`;
}

export function stripInheritedSkills(prompt: string): string {
	const tagged = prompt.replace(/\n*<skills>[\s\S]*?<\/skills>\n*/g, "\n");
	const startIndex = tagged.indexOf(SKILLS_HEADER);
	if (startIndex === -1) return tagged;
	const endIndex = findSectionEnd(tagged, startIndex + SKILLS_HEADER.length, [DATE_HEADER]);
	return `${tagged.slice(0, startIndex)}${tagged.slice(endIndex)}`;
}

export function stripSubagentOrchestrationSkill(prompt: string): string {
	return stripSkillBlocksNamingSubagent(
		prompt.replace(/\n{0,2}<skill\s+name=["']subagent(?:@[^"']*)?["'][^>]*>[\s\S]*?<\/skill>\n{0,2}/g, "\n\n"),
	);
}

const SKILL_OPEN = "<skill>";
const SKILL_CLOSE = "</skill>";
const WHITESPACE_RUN = /\s*/y;

function stripSkillBlocksNamingSubagent(prompt: string): string {
	let output = "";
	let copied = 0;
	let searchFrom = 0;
	while (true) {
		const opening = prompt.indexOf(SKILL_OPEN, searchFrom);
		if (opening === -1) break;
		const closing = prompt.indexOf(SKILL_CLOSE, opening + SKILL_OPEN.length);
		if (closing === -1) break;
		let start = opening;
		while (start > searchFrom && (prompt[start - 1] === " " || prompt[start - 1] === "\t")) start--;
		WHITESPACE_RUN.lastIndex = closing + SKILL_CLOSE.length;
		WHITESPACE_RUN.exec(prompt);
		const end = WHITESPACE_RUN.lastIndex;
		if (SUBAGENT_ORCHESTRATION_SKILL_NAME_PATTERN.test(prompt.slice(start, end))) {
			output += prompt.slice(copied, start);
			copied = end;
		}
		searchFrom = end;
	}
	return output + prompt.slice(copied);
}

function stripChildBoundaryInstructions(prompt: string): string {
	let rewritten = prompt;
	for (const boundary of [CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS, CHILD_FANOUT_BOUNDARY_INSTRUCTIONS]) {
		rewritten = rewritten.split(boundary).join("");
	}
	return rewritten.replace(/^(?:[ \t]*\r?\n)+/, "");
}

export function rewriteSubagentPrompt(prompt: string, options: PromptRewriteOptions): string {
	let rewritten = prompt;
	if (!options.inheritProjectContext) rewritten = stripProjectContext(rewritten);
	if (!options.inheritSkills) rewritten = stripInheritedSkills(rewritten);
	rewritten = stripSubagentOrchestrationSkill(rewritten);
	rewritten = stripChildBoundaryInstructions(rewritten);
	const boundary = options.fanoutChild ? CHILD_FANOUT_BOUNDARY_INSTRUCTIONS : CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS;
	return `${boundary}\n\n${rewritten}`;
}

function isParentOnlySubagentMessage(message: unknown): boolean {
	const m = message as { role?: string; customType?: string };
	return (
		m?.role === "custom" && typeof m.customType === "string" && PARENT_ONLY_CUSTOM_MESSAGE_TYPES.has(m.customType)
	);
}

function isSubagentToolResultMessage(message: unknown): boolean {
	const m = message as { role?: string; toolName?: string };
	return m?.role === "toolResult" && m.toolName === "subagent";
}

function isSubagentToolCallBlock(block: unknown): boolean {
	const b = block as { type?: string; name?: string };
	return b?.type === "toolCall" && b.name === "subagent";
}

function stripAssistantSubagentToolCallBlocks<T>(message: T): T | undefined {
	const m = message as { role?: string; content?: unknown };
	if (m?.role !== "assistant" || !Array.isArray(m.content)) return message;
	const filteredContent = m.content.filter((block) => !isSubagentToolCallBlock(block));
	if (filteredContent.length === m.content.length) return message;
	if (filteredContent.length === 0) return undefined;
	return { ...m, content: filteredContent } as T;
}

function isAssistantMessage(message: unknown): boolean {
	return (message as { role?: string })?.role === "assistant";
}

/**
 * Whether the model sees `message` as something between two assistant turns: a tool result, or a message it reads as
 * a user turn. A message the model never sees, or a system message, leaves the turns around it adjacent.
 */
function separatesAssistantTurns(message: unknown): boolean {
	const role = (message as { role?: string })?.role;
	if (role === "toolResult") return true;
	if (role === "assistant" || role === "system") return false;
	return convertToLlm([message as AgentMessage]).some((converted) => converted.role === "user");
}

function isReasoningBlock(block: unknown): boolean {
	const type = (block as { type?: string })?.type;
	return type === "thinking" || type === "redacted_thinking";
}

/** The assistant message without its reasoning blocks, or undefined when nothing else is left. */
function withoutReasoning<T>(message: T): T | undefined {
	const m = message as { content?: unknown };
	if (!Array.isArray(m.content)) return message;
	const content = m.content.filter((block) => !isReasoningBlock(block));
	if (content.length === m.content.length) return message;
	if (content.length === 0) return undefined;
	return { ...m, content } as T;
}

/**
 * Called when removed messages leave the last kept assistant message directly before the next one. Providers join
 * back-to-back assistant messages into one turn, so if the earlier message carries thinking, that turn holds thinking
 * from two separate responses, and Anthropic rejects it as modified thinking (#5481). The earlier message loses its
 * thinking, or is dropped when nothing else is left, which repeats the check for the assistant message before it. The
 * next turn is replayed exactly as returned.
 */
function dropReasoningJoinedToNextTurn<T>(kept: T[]): void {
	for (let index = kept.length - 1; index >= 0; index--) {
		const message = kept[index];
		if (!isAssistantMessage(message)) {
			if (separatesAssistantTurns(message)) return;
			continue;
		}
		const replayed = withoutReasoning(message);
		if (replayed !== undefined) {
			kept[index] = replayed;
			return;
		}
		kept.splice(index, 1);
	}
}

/**
 * Remove parent-only orchestration history while preserving it for an authorized fanout child. Where a removal leaves
 * two assistant messages back to back, the earlier one is replayed without its thinking (#5481).
 */
export function stripParentOnlySubagentMessages<T>(messages: T[], preserveFanoutToolHistory = false): T[] {
	let changed = false;
	// Something that separated the last kept assistant message from the next one was removed.
	let separatorRemoved = false;
	const filtered: T[] = [];
	for (const message of messages) {
		if (
			isParentOnlySubagentMessage(message) ||
			(!preserveFanoutToolHistory && isSubagentToolResultMessage(message))
		) {
			changed = true;
			if (!separatorRemoved && separatesAssistantTurns(message)) separatorRemoved = true;
			continue;
		}
		const stripped = preserveFanoutToolHistory ? message : stripAssistantSubagentToolCallBlocks(message);
		if (stripped === undefined) {
			changed = true;
			continue;
		}
		if (stripped !== message) changed = true;
		if (isAssistantMessage(stripped)) {
			if (separatorRemoved) dropReasoningJoinedToNextTurn(filtered);
			separatorRemoved = false;
		} else if (separatorRemoved && separatesAssistantTurns(stripped)) {
			separatorRemoved = false;
		}
		filtered.push(stripped);
	}
	return changed ? filtered : messages;
}

export interface InProcessChildPromptBehavior {
	readonly systemPromptTransform: (prompt: string) => string;
	readonly initialContextTransform: (messages: AgentMessage[]) => AgentMessage[];
}

export function createInProcessChildSystemPromptTransform(
	policy: ChildPromptPolicy,
	explicitSkillInjection = "",
): (prompt: string) => string {
	return (prompt) => {
		const rewritten = rewriteSubagentPrompt(prompt, {
			inheritProjectContext: policy.inheritProjectContext,
			inheritSkills: policy.inheritSkills,
			fanoutChild: policy.fanoutAuthorized,
		});
		return explicitSkillInjection ? `${rewritten}\n\n${explicitSkillInjection}` : rewritten;
	};
}

/** Build the construction-time transforms for one admitted in-process child. */
export function createInProcessChildPromptBehavior(policy: ChildPromptPolicy): InProcessChildPromptBehavior {
	return {
		systemPromptTransform: createInProcessChildSystemPromptTransform(policy),
		initialContextTransform: (messages) => stripParentOnlySubagentMessages(messages, policy.fanoutAuthorized),
	};
}
