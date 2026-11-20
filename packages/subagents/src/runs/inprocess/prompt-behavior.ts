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

/** Remove parent-only orchestration history while preserving it for an authorized fanout child. */
export function stripParentOnlySubagentMessages<T>(messages: T[], preserveFanoutToolHistory = false): T[] {
	let changed = false;
	const filtered: T[] = [];
	for (const message of messages) {
		if (
			isParentOnlySubagentMessage(message) ||
			(!preserveFanoutToolHistory && isSubagentToolResultMessage(message))
		) {
			changed = true;
			continue;
		}
		const stripped = preserveFanoutToolHistory ? message : stripAssistantSubagentToolCallBlocks(message);
		if (stripped === undefined) {
			changed = true;
			continue;
		}
		if (stripped !== message) changed = true;
		filtered.push(stripped);
	}
	return changed ? filtered : messages;
}

const forkReplayFilter = Symbol.for("atomic.subagents/fork-replay-filter@1");

export interface InProcessChildPromptBehavior {
	readonly systemPromptTransform: (prompt: string) => string;
	readonly systemPromptSections: {
		readonly key: string;
		readonly transform: (sections: Record<string, string>) => Record<string, string>;
		readonly fork?: {
			readonly sessionId: string;
			readonly hiddenTools?: readonly string[];
			readonly note: (tools: {
				readonly tools: readonly string[];
				readonly throughCodemode: readonly string[];
			}) => string;
		};
	};
	/** Absent in a fork, which keeps its parent's conversation as it was sent. */
	readonly initialContextTransform?: (messages: AgentMessage[]) => AgentMessage[];
	readonly [forkReplayFilter]?: {
		project: (messages: AgentMessage[]) => AgentMessage[];
		boundary: (message: AgentMessage) => "visible" | "hidden" | undefined;
	};
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

/**
 * The child's view of each section of the prompt `createInProcessChildSystemPromptTransform` rewrites: the same
 * rewrites applied section by section, sections left empty dropped, the boundary instructions first and the
 * explicitly selected skills last. A resumed child keeps the prompt it was first sent and is told later changes to
 * these sections as updates.
 */
export function createInProcessChildSystemPromptSectionsTransform(
	policy: ChildPromptPolicy,
	explicitSkillInjection = "",
): (sections: Record<string, string>) => Record<string, string> {
	return (sections) => {
		const child: Record<string, string> = {
			subagent_boundary: policy.fanoutAuthorized
				? CHILD_FANOUT_BOUNDARY_INSTRUCTIONS
				: CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS,
		};
		for (const [name, text] of Object.entries(sections)) {
			let rewritten = text;
			if (!policy.inheritProjectContext) rewritten = stripProjectContext(rewritten);
			if (!policy.inheritSkills) rewritten = stripInheritedSkills(rewritten);
			rewritten = stripChildBoundaryInstructions(stripSubagentOrchestrationSkill(rewritten));
			if (rewritten.trim()) child[name] = rewritten;
		}
		if (explicitSkillInjection) child.subagent_skills = explicitSkillInjection;
		return child;
	};
}

/** The note that opens what a forked child adds after its parent's conversation. */
export function forkedChildNote(tools: {
	readonly tools: readonly string[];
	readonly throughCodemode: readonly string[];
}): string {
	return [
		"You are now a subagent started from the conversation above. That conversation is your parent's context: its tool calls are history, and their sessions and processes are not yours. Follow your own role and task below, and report your result to your parent.",
		`The tools you may call: ${tools.tools.join(", ") || "none"}. A call to any other tool declared above fails.`,
		...(tools.throughCodemode.length > 0
			? [
					`Call ${tools.throughCodemode.join(", ")} through codemode as \`tools.<name>(args)\`; codemode's tool search and descriptions show their arguments.`,
				]
			: []),
	].join("\n");
}

/**
 * Build the construction-time transforms for one admitted in-process child. A forked child (`fork`: its session
 * continues its parent's) keeps the parent's conversation exactly as the parent sent it, so its first request is read
 * from the parent's prompt cache, and adds its own role and task after it.
 */
export function createInProcessChildPromptBehavior(
	policy: ChildPromptPolicy,
	explicitSkillInjection = "",
	fork?: { readonly parentSessionId: string; readonly parentHiddenTools?: readonly string[] },
): InProcessChildPromptBehavior {
	const systemPromptSections = {
		key: JSON.stringify([policy.inheritProjectContext, policy.inheritSkills, policy.fanoutAuthorized]),
		transform: createInProcessChildSystemPromptSectionsTransform(policy, explicitSkillInjection),
	};
	const systemPromptTransform = createInProcessChildSystemPromptTransform(policy, explicitSkillInjection);
	if (fork)
		return {
			systemPromptTransform,
			systemPromptSections: {
				...systemPromptSections,
				fork: {
					sessionId: fork.parentSessionId,
					...(fork.parentHiddenTools?.length ? { hiddenTools: fork.parentHiddenTools } : {}),
					note: forkedChildNote,
				},
			},
		};
	const project = (messages: AgentMessage[]) => stripParentOnlySubagentMessages(messages, policy.fanoutAuthorized);
	return {
		systemPromptTransform,
		systemPromptSections,
		initialContextTransform: project,
		[forkReplayFilter]: {
			project,
			boundary(message) {
				if (!policy.fanoutAuthorized && isSubagentToolResultMessage(message)) return "visible";
				if (
					!policy.fanoutAuthorized &&
					message.role === "assistant" &&
					message.content?.length &&
					message.content.every(isSubagentToolCallBlock)
				)
					return "hidden";
				if (!isParentOnlySubagentMessage(message) || message.role !== "custom") return undefined;
				return !("excludeFromContext" in message && message.excludeFromContext === true) &&
					typeof message.content === "string" &&
					(message.content.at(0)?.trim() || message.content.at(-1)?.trim())
					? "visible"
					: "hidden";
			},
		},
	};
}
