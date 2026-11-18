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
 * The session options that make a session an admitted in-process child: its rewritten system prompt. A forked child's
 * inherited conversation is left exactly as the parent would send it (#5481); what it must not act on is covered by
 * the boundary instructions and the child's tool policy.
 */
export function createInProcessChildPromptBehavior(
	policy: ChildPromptPolicy,
	explicitSkillInjection = "",
): { readonly systemPromptTransform: (prompt: string) => string } {
	return { systemPromptTransform: createInProcessChildSystemPromptTransform(policy, explicitSkillInjection) };
}
