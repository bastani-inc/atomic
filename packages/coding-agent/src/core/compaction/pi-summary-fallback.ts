import { normalizeContext, retryAssistantCall, uuidv7 } from "@bastani/pi-ai";
import type { AssistantMessage, Usage } from "@bastani/pi-ai/compat";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { convertToLlm } from "../messages.ts";
import {
	buildSessionProjection,
	type ProjectedSessionEntry,
	type SessionEntry,
	sessionEntryToContextMessages,
} from "../session-manager.ts";
import { applyContextEdit, buildContextEntries, collectContextEdits } from "../session-manager-history.ts";
import { combineUsage } from "../usage-totals.ts";
import { estimateProjectedContextTokens } from "./compaction.ts";
import type { BorrowedPlanner } from "./compaction-types.js";
import { classifyPlannerFailure, isProviderPolicyRefusalResponse, syntheticErrorResponse } from "./planner-outcome.js";
import { plannerRequestModel, type RangePlannerOptions } from "./range-planner.js";
import { writeDiagnosticSidecar } from "./range-planner-diagnostics.js";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	formatFileOperations,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversation,
} from "./utils.ts";

export interface PiSummarySettings {
	reserveTokens: number;
	keepRecentTokens?: number;
}
export interface PiSummaryPreparation {
	firstKeptEntryId: string;
	messagesToSummarize: AgentMessage[];
	turnPrefixMessages: AgentMessage[];
	previousSummary?: string;
	tokensBefore: number;
	keptTailTokens: number;
	fileOps: FileOperations;
	settings: PiSummarySettings;
}
export interface PiSummaryResult {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	tokensAfter: number;
	readFiles: string[];
	modifiedFiles: string[];
	usage: Usage;
}

function estimatePiContentChars(content: string | readonly { type: string; text?: string }[]): number {
	if (typeof content === "string") return content.length;
	let chars = 0;
	for (const block of content) {
		if (block.type === "text" && block.text) chars += block.text.length;
		else if (block.type === "image") chars += 4800;
	}
	return chars;
}

function estimatePiTokens(message: AgentMessage): number {
	let chars = 0;
	switch (message.role) {
		case "system":
			chars = estimatePiContentChars(message.content);
			for (const section of Object.values(message.sections ?? {})) if (section) chars += section.length;
			if (message.toolsAdded) chars += JSON.stringify(message.toolsAdded).length;
			break;
		case "user":
		case "custom":
		case "toolResult":
			chars = estimatePiContentChars(message.content);
			break;
		case "assistant":
			for (const block of message.content) {
				if (block.type === "text") chars += block.text.length;
				else if (block.type === "thinking") chars += block.thinking.length;
				else if (block.type === "toolCall") chars += block.name.length + JSON.stringify(block.arguments).length;
			}
			break;
		case "bashExecution":
			chars = message.command.length + message.output.length;
			break;
		case "branchSummary":
			chars = message.summary.length;
			break;
	}
	return Math.ceil(chars / 4);
}

function startsTurn(entry: ProjectedSessionEntry): boolean {
	return (
		entry.sourceEntry.type !== "compaction" &&
		entry.messages.some(
			(message) =>
				message.role === "user" ||
				message.role === "bashExecution" ||
				message.role === "custom" ||
				message.role === "branchSummary",
		)
	);
}
function conversationMessages(entry: ProjectedSessionEntry): AgentMessage[] {
	return entry.sourceEntry.type === "compaction" ? [] : entry.messages.filter((message) => message.role !== "system");
}

export function preparePiSummaryCompaction(
	pathEntries: SessionEntry[],
	settings: PiSummarySettings,
): PiSummaryPreparation | undefined {
	if (pathEntries.at(-1)?.type === "compaction") return undefined;
	const projection = buildSessionProjection(pathEntries);
	const contextEntries = buildContextEntries(pathEntries);
	const edits = collectContextEdits(contextEntries);
	const entries: ProjectedSessionEntry[] = contextEntries.map((sourceEntry) => {
		const messages = sessionEntryToContextMessages(sourceEntry);
		const edit = edits.get(sourceEntry.id);
		return { sourceEntry, messages: edit ? applyContextEdit(messages, edit) : messages };
	});
	const previousIndex = entries.findIndex(
		(entry) => entry.sourceEntry.type === "compaction" && entry.messages.length > 0,
	);
	const previous = previousIndex >= 0 ? entries[previousIndex].sourceEntry : undefined;
	const start = previousIndex >= 0 ? previousIndex + 1 : 0;
	const cutPoints: number[] = [];
	for (let index = start; index < entries.length; index++) {
		const entry = entries[index];
		if (
			entry.sourceEntry.type !== "compaction" &&
			entry.messages.some((message) => message.role !== "toolResult" && message.role !== "system")
		)
			cutPoints.push(index);
	}
	if (cutPoints.length === 0) return undefined;
	let cut = cutPoints[0];
	let tokens = 0;
	let exceededBudget = false;
	for (let index = entries.length - 1; index >= start; index--) {
		const count = entries[index].messages.reduce((sum, message) => sum + estimatePiTokens(message), 0);
		if (count === 0) continue;
		tokens += count;
		if (tokens >= (settings.keepRecentTokens ?? 20000)) {
			exceededBudget = true;
			cut = cutPoints.find((candidate) => candidate >= index) ?? cutPoints[cutPoints.length - 1];
			break;
		}
	}
	const suffix = entries.slice(cut + 1);
	const intrinsicallyVisible = (entry: ProjectedSessionEntry): boolean =>
		entry.sourceEntry.type !== "context_edit" && sessionEntryToContextMessages(entry.sourceEntry).length > 0;
	const omitted = (entry: ProjectedSessionEntry): boolean =>
		intrinsicallyVisible(entry) && entry.messages.length === 0;
	const omittedIds = new Set(suffix.filter(omitted).map((entry) => entry.sourceEntry.id));
	const externalReplacement = suffix.some(
		(entry) =>
			entry.sourceEntry.type === "context_edit" &&
			entry.sourceEntry.replacement !== null &&
			!omittedIds.has(entry.sourceEntry.targetId),
	);
	if (
		exceededBudget &&
		!externalReplacement &&
		suffix.some(
			(entry) =>
				entry.sourceEntry.type === "message" && entry.sourceEntry.message.role === "assistant" && omitted(entry),
		) &&
		suffix.every(
			(entry) => entry.sourceEntry.type !== "compaction" && (!intrinsicallyVisible(entry) || omitted(entry)),
		)
	)
		cut++;
	while (cut > start && entries[cut - 1].sourceEntry.type !== "compaction" && entries[cut - 1].messages.length === 0)
		cut--;
	let turnStart = -1;
	if (!startsTurn(entries[cut])) {
		for (let index = cut; index >= start; index--)
			if (startsTurn(entries[index])) {
				turnStart = index;
				break;
			}
	}
	const messagesToSummarize = entries.slice(start, turnStart >= 0 ? turnStart : cut).flatMap(conversationMessages);
	const turnPrefixMessages = turnStart >= 0 ? entries.slice(turnStart, cut).flatMap(conversationMessages) : [];
	if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) return undefined;
	const fileOps = createFileOps();
	if (
		previous?.type === "compaction" &&
		!previous.fromHook &&
		previous.details &&
		typeof previous.details === "object"
	) {
		const previousDetails =
			"summary" in previous.details &&
			typeof previous.details.summary === "object" &&
			previous.details.summary !== null
				? previous.details.summary
				: previous.details;
		for (const [key, target] of [
			["readFiles", fileOps.read],
			["modifiedFiles", fileOps.edited],
		] as const) {
			if (key in previousDetails) {
				const files = (previousDetails as { readFiles?: string[]; modifiedFiles?: string[] })[key];
				if (Array.isArray(files)) for (const file of files) if (typeof file === "string") target.add(file);
			}
		}
	}
	for (const message of [...messagesToSummarize, ...turnPrefixMessages]) extractFileOpsFromMessage(message, fileOps);
	return {
		firstKeptEntryId: entries[cut].sourceEntry.id,
		messagesToSummarize,
		turnPrefixMessages,
		previousSummary: previous?.type === "compaction" ? previous.summary : undefined,
		tokensBefore: estimateProjectedContextTokens(projection, pathEntries).tokens,
		keptTailTokens: entries
			.slice(cut)
			.flatMap((entry) => entry.messages)
			.reduce((sum, message) => sum + estimatePiTokens(message), 0),
		fileOps,
		settings,
	};
}

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;
const TURN_PREFIX_SUMMARIZATION_PROMPT = `The messages above are earlier context from an ongoing conversation. Later messages are stored separately and do not need to be reconstructed.

Create a concise checkpoint of the user's request and the progress shown above. This checkpoint will be placed before the later messages so the conversation can continue with the necessary context.

## Original Request
[What did the user ask for?]

## Progress So Far
- [Key decisions and work completed in these messages]

## Context Needed to Continue
- [Information from these messages needed to understand the later work]

Only summarize information explicitly present above. Do not infer or recreate later messages.`;

export async function runPiSummaryFallback(
	entries: SessionEntry[],
	settings: PiSummarySettings,
	planner: BorrowedPlanner,
	options: RangePlannerOptions & { signal?: AbortSignal },
): Promise<PiSummaryResult> {
	const preparation = preparePiSummaryCompaction(entries, settings);
	if (!preparation) throw new Error("No compactable history for pi summary fallback");
	const model = plannerRequestModel(planner);
	const summarize = async (
		messages: AgentMessage[],
		prefix: boolean,
		previousSummary?: string,
	): Promise<{ text: string; usage: Usage }> => {
		const text = serializeConversation(convertToLlm(messages));
		const prompt = prefix
			? `# Conversation\n${text}\n\n# Instructions\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`
			: `<conversation>\n${text}\n</conversation>\n\n${previousSummary ? `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n` : ""}${previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT}`;
		const context = normalizeContext({
			systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
			messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
		});
		const requestMaxTokens = Math.min(
			Math.floor((prefix ? 0.5 : 0.8) * settings.reserveTokens),
			model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
		);
		const sessionId = uuidv7();
		let refusal: AssistantMessage | undefined;
		const response = await retryAssistantCall(
			async () => {
				let result: AssistantMessage;
				try {
					result = await (
						await options.streamFn(model, context, {
							apiKey: planner.auth.apiKey,
							headers: planner.auth.headers,
							signal: options.signal,
							cacheRetention: "none",
							sessionId,
							maxTokens: requestMaxTokens,
							...(model.reasoning && planner.budget.reasoning && planner.budget.reasoning !== "off"
								? { reasoning: planner.budget.reasoning }
								: {}),
						})
					).result();
				} catch (error) {
					if (options.signal?.aborted) throw new Error("Compaction cancelled");
					result = syntheticErrorResponse(model, error instanceof Error ? error.message : String(error));
				}
				options.onUsage?.(result.usage);
				if (isProviderPolicyRefusalResponse(result)) {
					refusal = result;
					return { ...result, stopReason: "stop" };
				}
				return result;
			},
			options.retry,
			options.signal,
			options.callbacks,
		);
		if (options.signal?.aborted || response.stopReason === "aborted") throw new Error("Compaction cancelled");
		if (refusal || response.stopReason === "error") {
			const failedResponse = refusal ?? response;
			const failureMessage = `Summarization failed: ${failedResponse.errorMessage || (refusal ? "The model refused to complete the request" : "Unknown error")}`;
			const failure = classifyPlannerFailure(failedResponse, model.contextWindow);
			const diagnosticPath = writeDiagnosticSidecar({
				sessionFilePath: options.sessionFilePath,
				model,
				requestMaxTokens,
				response: failedResponse,
				rawResponseText: failedResponse.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join(""),
				failureCategory: failure === "overflow" ? "context_overflow" : failure,
				failureMessage,
			});
			throw new Error(diagnosticPath ? `${failureMessage} (diagnostic: ${diagnosticPath})` : failureMessage);
		}
		if (response.stopReason === "length")
			throw new Error("Summarization failed: generation hit the token cap and the summary is incomplete");
		if (response.content.some((block) => block.type === "toolCall"))
			throw new Error("Summarization attempted to call a tool");
		const summary = response.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		if (!summary.trim()) throw new Error("Summarization returned empty text");
		return { text: summary, usage: response.usage };
	};
	let summary: string;
	let usage: Usage;
	if (preparation.turnPrefixMessages.length > 0) {
		const history =
			preparation.messagesToSummarize.length > 0
				? await summarize(preparation.messagesToSummarize, false, preparation.previousSummary)
				: undefined;
		const prefix = await summarize(preparation.turnPrefixMessages, true);
		summary = `${history?.text ?? preparation.previousSummary ?? "No prior history."}\n\n---\n\n**Turn Context (split turn):**\n\n${prefix.text}`;
		usage = history ? combineUsage(history.usage, prefix.usage) : prefix.usage;
	} else {
		const result = await summarize(preparation.messagesToSummarize, false, preparation.previousSummary);
		summary = result.text;
		usage = result.usage;
	}
	const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);
	return {
		summary,
		firstKeptEntryId: preparation.firstKeptEntryId,
		tokensBefore: preparation.tokensBefore,
		tokensAfter: Math.ceil(summary.length / 4) + preparation.keptTailTokens,
		readFiles,
		modifiedFiles,
		usage,
	};
}
