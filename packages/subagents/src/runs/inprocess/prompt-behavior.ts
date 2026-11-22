import { hasRecordedTransformedPrompt, type SessionEntry, startedAsFork } from "@bastani/atomic";
import type { AgentMessage } from "@bastani/atomic-agent-core";
import { subagentForkStartIndex } from "../../shared/fork-context.js";

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

function replaceTaggedBlocks(prompt: string, openTag: string, closeTag: string, replacement: string): string {
	let output = "";
	let copied = 0;
	let searchFrom = 0;
	while (searchFrom < prompt.length) {
		const openIdx = prompt.indexOf(openTag, searchFrom);
		if (openIdx === -1) break;
		const closeIdx = prompt.indexOf(closeTag, openIdx + openTag.length);
		if (closeIdx === -1) break;
		let start = openIdx;
		while (start > copied && prompt.charCodeAt(start - 1) === 0x0a) {
			start--;
		}
		let end = closeIdx + closeTag.length;
		while (end < prompt.length && prompt.charCodeAt(end) === 0x0a) {
			end++;
		}
		output += `${prompt.slice(copied, start)}${replacement}`;
		copied = end;
		searchFrom = end;
	}
	return copied === 0 ? prompt : `${output}${prompt.slice(copied)}`;
}

function isJsWhitespaceCode(code: number): boolean {
	return (
		code === 0x20 ||
		(code >= 0x09 && code <= 0x0d) ||
		code === 0xa0 ||
		code === 0x1680 ||
		(code >= 0x2000 && code <= 0x200a) ||
		code === 0x2028 ||
		code === 0x2029 ||
		code === 0x202f ||
		code === 0x205f ||
		code === 0x3000 ||
		code === 0xfeff
	);
}

function stripNamedSubagentSkillBlocks(prompt: string): string {
	const openPrefix = "<skill";
	const closeTag = "</skill>";
	let output = "";
	let copied = 0;
	let searchFrom = 0;
	while (searchFrom < prompt.length) {
		const openIdx = prompt.indexOf(openPrefix, searchFrom);
		if (openIdx === -1) break;
		let wsEnd = openIdx + openPrefix.length;
		while (wsEnd < prompt.length && isJsWhitespaceCode(prompt.charCodeAt(wsEnd))) {
			wsEnd++;
		}
		if (wsEnd === openIdx + openPrefix.length || !prompt.startsWith("name=", wsEnd)) {
			searchFrom = Math.max(openIdx + openPrefix.length, wsEnd);
			continue;
		}
		const quotePos = wsEnd + 5;
		if (quotePos >= prompt.length) break;
		const openQuote = prompt.charCodeAt(quotePos);
		if (openQuote !== 0x22 && openQuote !== 0x27) {
			searchFrom = quotePos;
			continue;
		}
		const nameStart = quotePos + 1;
		if (!prompt.startsWith("subagent", nameStart)) {
			searchFrom = nameStart;
			continue;
		}
		let afterName = nameStart + 8;
		if (afterName < prompt.length && prompt.charCodeAt(afterName) === 0x40) {
			afterName++;
			while (afterName < prompt.length) {
				const c = prompt.charCodeAt(afterName);
				if (c === 0x22 || c === 0x27) break;
				afterName++;
			}
			if (afterName >= prompt.length) break;
		}
		if (afterName >= prompt.length) break;
		const closeQuote = prompt.charCodeAt(afterName);
		if (closeQuote !== 0x22 && closeQuote !== 0x27) {
			searchFrom = afterName;
			continue;
		}
		const gtIdx = prompt.indexOf(">", afterName + 1);
		if (gtIdx === -1) break;
		const closeIdx = prompt.indexOf(closeTag, gtIdx + 1);
		if (closeIdx === -1) break;
		let start = openIdx;
		let lead = 0;
		while (lead < 2 && start > copied && prompt.charCodeAt(start - 1) === 0x0a) {
			start--;
			lead++;
		}
		let end = closeIdx + closeTag.length;
		let trail = 0;
		while (trail < 2 && end < prompt.length && prompt.charCodeAt(end) === 0x0a) {
			end++;
			trail++;
		}
		output += `${prompt.slice(copied, start)}\n\n`;
		copied = end;
		searchFrom = end;
	}
	return copied === 0 ? prompt : `${output}${prompt.slice(copied)}`;
}

export function stripProjectContext(prompt: string): string {
	const tagged = replaceTaggedBlocks(prompt, "<project_context>", "</project_context>", "\n");
	const startIndex = tagged.indexOf(PROJECT_CONTEXT_HEADER);
	if (startIndex === -1) return tagged;
	const endIndex = findSectionEnd(tagged, startIndex + PROJECT_CONTEXT_HEADER.length, [SKILLS_HEADER, DATE_HEADER]);
	return `${tagged.slice(0, startIndex)}${tagged.slice(endIndex)}`;
}

export function stripInheritedSkills(prompt: string): string {
	const tagged = replaceTaggedBlocks(prompt, "<skills>", "</skills>", "\n");
	const startIndex = tagged.indexOf(SKILLS_HEADER);
	if (startIndex === -1) return tagged;
	const endIndex = findSectionEnd(tagged, startIndex + SKILLS_HEADER.length, [DATE_HEADER]);
	return `${tagged.slice(0, startIndex)}${tagged.slice(endIndex)}`;
}

export function stripSubagentOrchestrationSkill(prompt: string): string {
	return stripSkillBlocksNamingSubagent(stripNamedSubagentSkillBlocks(prompt));
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

/**
 * The tools a forked child runs with: its own, plus codemode when its parent's requests declare codemode and its own
 * tools do not include it. That codemode (`codemodeRoutingOnly`) is a routing channel: its scripts reach exactly the
 * child's own tools, with no models, so it grants nothing a fresh child of the same agent could not do. It lets the
 * child call codemode as its parent's conversation declares it, and reach the tools only the child has where the
 * provider cannot add them to the parent's tool list.
 */
export function forkedChildTools(
	tools: readonly string[] | undefined,
	parentToolNames: readonly string[] | undefined,
): { readonly tools: string[] | undefined; readonly codemodeRoutingOnly: boolean } {
	if (tools === undefined || tools.includes("codemode") || !parentToolNames?.includes("codemode"))
		return { tools: tools && [...tools], codemodeRoutingOnly: false };
	return { tools: [...tools, "codemode"], codemodeRoutingOnly: true };
}

/**
 * The parent whose conversation a child's session continues as a fork, or undefined. A fork continues that
 * conversation from its first request, and its recorded prompt says so for every reopen after. A fork session that
 * already holds the child's own turns without a recorded prompt (an earlier version ran it) is reopened as the child
 * it was, under its own prompt, and stays that child. The child's own turns are those after the fork's start entry;
 * a fork an earlier version made has none, and only there a reply stamped after the fork was made counts as its own.
 */
export function forkedParentSessionId(session: {
	getHeader(): { readonly id: string; readonly parentSessionId?: string; readonly createdAt: string } | null;
	getBranch(): readonly SessionEntry[];
	buildSessionContext(): { readonly messages: readonly AgentMessage[] };
}): string | undefined {
	const header = session.getHeader();
	if (header?.parentSessionId === undefined) return undefined;
	const { messages } = session.buildSessionContext();
	if (startedAsFork(messages)) return header.parentSessionId;
	if (hasRecordedTransformedPrompt(messages)) return undefined;
	const branch = session.getBranch();
	const forkStart = subagentForkStartIndex(branch, header.id);
	const ownTurns =
		forkStart === -1
			? messages.some((message) => message.role === "assistant" && message.timestamp > Date.parse(header.createdAt))
			: branch.slice(forkStart + 1).some((entry) => entry.type === "message" && entry.message.role === "assistant");
	return ownTurns ? undefined : header.parentSessionId;
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
