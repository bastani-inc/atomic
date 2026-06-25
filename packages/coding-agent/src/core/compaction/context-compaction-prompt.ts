import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	CompactableTranscript,
	CompactableTranscriptEntry,
	ContextCompactionParameters,
} from "./context-compaction-types.ts";
import {
	contextCompactionTargetLabel,
	contextCompactionTargetReductionPercent,
} from "./context-compaction-metrics.ts";
import { getTranscriptCompactionParameters } from "./context-compaction-strategy.ts";
import { isExcludedFromLlmContext } from "./context-transcript-analysis.ts";

const CONTEXT_MANIFEST_MAX_ENTRIES = 80;
const CONTEXT_MANIFEST_PREVIEW_CHARS = 240;

export const CONTEXT_COMPACTION_SYSTEM_PROMPT = `You are a context compaction assistant.

Your task is to read relevant parts of a conversation between a user and an AI assistant provided via a transcript file, then run a series of tools to apply deletion-only verbatim compaction using the exact context_delete or context_grep_delete format specified.`;

function contextCompactionFixedPrompt(parameters: ContextCompactionParameters): string {
	const targetLabel = contextCompactionTargetLabel(parameters);
	return `Reference the provided transcript file transcript and use your search/read tools for small inspections, then use context_delete or context_grep_delete for deletions.

Compaction records deletion targets, not replacement content.
For context_delete, use id-only targets: stable entryId values and optional blockIndex values only.
For context_grep_delete, use a concise literal or regex pattern to select matching entries or blocks; do not paste full transcript entries or content-block bodies.
Do not summarize, paraphrase, or generate replacement context; those are not accepted compaction outputs.
Do not mutate retained transcript objects or content.
Deletion tool calls are the compaction action.

Strategy:
- Start by calling context_compaction_budget to see how much of the context window is full and how much reduction is needed.
- Spend a few turns exploring with search/read tools to gain high confidence of candidate blocks to remove.
- Prefer high-confidence exploit actions after that: delete obvious low-value entries via context_grep_delete or context_delete.
- Use grep deletion for repeated low-value patterns.
- Use exact id deletion for inspected one-off stale entries.
- Check context_compaction_budget after deletion batches to track progress.
- Strict requirement: reduce current context by at least ${targetLabel} before finishing. This is a hard completion gate, not a loose goal.
- Do not send a final plain-text completion message until context_compaction_budget reports at least ${targetLabel} currentReductionPercent.
- If the strict ${targetLabel} reduction is not met yet, continue removing low-value message entries or content blocks with context_delete/context_grep_delete.
- Use the focus query to preserve relevant context: ${JSON.stringify(parameters.query)}.

What Gets Deleted:
- Redundant tool outputs: file reads already acted on, grep/search results already processed, passing test output no longer needed.
- Exploratory dead ends: irrelevant files read, unhelpful or empty searches.
- Verbose boilerplate: license headers, import blocks the agent isn't modifying, configuration files read for reference.
- Superseded information: earlier versions of files that have since been edited, old error messages from bugs already fixed.
- Stale/superseded image context: image content blocks (shown as type "image" / text "[image]") in older tool results, custom messages, or old user-pasted attachments that the agent has already inspected and no longer needs. Image blocks are large (each costs far more tokens than its "[image]" text preview suggests, as reported by context_compaction_budget imageTokenPercent). When images dominate the context, prefer deleting these stale image content blocks before removing useful recent text. Use context_grep_delete with the literal pattern "[image]" and target "content_block" to find image candidates, then confirm they are stale with context_read_entry before deleting. User text blocks and whole user entries remain protected; only old non-recent user image blocks may be deleted, and not if the image is the user's only content block.

What Survives:
- Active file paths and line numbers: Any reference the agent might need to navigate.
- Current error messages: Unresolved bugs and their exact text.
- Reasoning decisions: Why the agent chose approach A over B. An agent's chain of thought (why it chose this file, what pattern it noticed, what fix it decided on) carries more information-per-token than the raw grep output or file content that informed those decisions.
- Recent tool calls and their results: The last 3-5 operations.
- User instructions: The original task and any clarifications.
- Task-relevant images: Images that are part of the active user task (for example, a screenshot the user just asked about, or the most recent image-bearing result the agent is still acting on). Recent user images and recent tool results are protected by preserve_recent, so do not delete images the agent still needs.

Conditionally Deleted:
- Old Reasoning decisions: If there is nothing else to remove and the target reduction is not met, you can remove entire stale assistant entries, EXCEPT do not delete individual content blocks from any retained assistant message that contains thinking or redacted_thinking blocks. Thinking-bearing assistant messages are all-or-nothing for replay safety.

<output_format>
Call the context_delete tool one or more times with deletion targets in this shape:
{ "deletions": [{ "kind": "entry", "entryId": "..." }] }

For content-block deletions, use:
{ "kind": "content_block", "entryId": "...", "blockIndex": 0 }

The tool applies and validates deletion targets immediately. You can continue calling it for additional deletions if useful.

For guarded bulk deletion by text match, call context_grep_delete with a literal pattern or regex. It removes valid matching context, silently ignores candidates that validation does not allow so they are not counted as removals, enforces a per-call maxMatches safety cap and optional expectedMatchCount, and validates through the same tool-call/tool-result safety rules. maxMatches only limits one tool call; there is no cumulative cap across corrected or repeated deletion calls.

The full transcript is available as a JSONL file path in the prompt, but do NOT try to load the whole file into context. Use context_search_transcript to find candidate entry IDs and context_read_entry to read only small slices (for example maxChars 1000-4000) before deleting.

When the strict ${targetLabel} reduction requirement is met, reply with a brief plain-text completion message. Do not include deletion target IDs outside tool calls.
</output_format>`;
}

function truncateForPrompt(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n[... ${text.length - maxChars} more characters omitted from context compaction prompt]`;
}

function transcriptEntryFilePayload(entry: CompactableTranscriptEntry): unknown {
	return {
		entryId: entry.entryId,
		entryType: entry.entryType,
		role: entry.role,
		protected: entry.protected,
		tokenEstimate: entry.tokenEstimate,
		toolCallIds: entry.toolCallIds,
		toolResultFor: entry.toolResultFor,
		text: entry.text,
		contentBlocks: entry.contentBlocks.map((block) => ({
			blockIndex: block.blockIndex,
			type: block.type,
			protected: block.protected,
			toolCallId: block.toolCallId,
			tokenEstimate: block.tokenEstimate,
			text: block.text,
		})),
	};
}

export interface ContextCompactionTranscriptFile {
	path: string;
	cleanup(): void;
}

export function writeContextCompactionTranscriptFile(transcript: CompactableTranscript): ContextCompactionTranscriptFile {
	const directory = mkdtempSync(join(tmpdir(), "atomic-context-transcript-"));
	const path = join(directory, "transcript.jsonl");
	const lines = transcript.entries
		.filter((entry) => !isExcludedFromLlmContext(entry.message))
		.map((entry) => JSON.stringify(transcriptEntryFilePayload(entry)));
	writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
	return {
		path,
		cleanup: () => rmSync(directory, { recursive: true, force: true }),
	};
}

function contextCompactionTranscriptManifest(transcript: CompactableTranscript, transcriptFilePath: string): unknown {
	const eligibleEntries = transcript.entries.filter((entry) => !isExcludedFromLlmContext(entry.message));
	const selectedEntryIds = new Set<string>();
	const selectedEntries: CompactableTranscriptEntry[] = [];
	const addEntry = (entry: CompactableTranscriptEntry): void => {
		if (selectedEntryIds.has(entry.entryId) || selectedEntries.length >= CONTEXT_MANIFEST_MAX_ENTRIES) return;
		selectedEntryIds.add(entry.entryId);
		selectedEntries.push(entry);
	};

	for (const entry of eligibleEntries.filter((entry) => entry.protected)) {
		addEntry(entry);
	}
	for (const entry of [...eligibleEntries]
		.filter((entry) => !entry.protected)
		.sort((left, right) => right.tokenEstimate - left.tokenEstimate)) {
		addEntry(entry);
	}
	selectedEntries.sort((left, right) => eligibleEntries.indexOf(left) - eligibleEntries.indexOf(right));

	return {
		transcriptFilePath,
		transcriptFileFormat: "jsonl: one compactable transcript entry per line with full text and contentBlocks text",
		totalEntries: eligibleEntries.length,
		manifestEntries: selectedEntries.length,
		omittedEntries: Math.max(0, eligibleEntries.length - selectedEntries.length),
		tokensBefore: transcript.tokensBefore,
		protectedEntryIds: transcript.protectedEntryIds,
		entries: selectedEntries.map((entry) => ({
			entryId: entry.entryId,
			role: entry.role,
			protected: entry.protected,
			tokenEstimate: entry.tokenEstimate,
			toolCallIds: entry.toolCallIds,
			toolResultFor: entry.toolResultFor,
			contentBlockCount: entry.contentBlocks.length,
			contentBlocks: entry.contentBlocks.map((block) => ({
				blockIndex: block.blockIndex,
				type: block.type,
				protected: block.protected,
				toolCallId: block.toolCallId,
				tokenEstimate: block.tokenEstimate,
			})),
			preview: truncateForPrompt(entry.text, CONTEXT_MANIFEST_PREVIEW_CHARS),
		})),
	};
}

function contextCompactionParametersPrompt(parameters: ContextCompactionParameters): string {
	return `\n<compaction-parameters>\n${JSON.stringify(
		{
			compression_ratio: parameters.compression_ratio,
			preserve_recent: parameters.preserve_recent,
			query: parameters.query,
			target_reduction_percent: contextCompactionTargetReductionPercent(parameters),
		},
		null,
		2,
	)}\n</compaction-parameters>`;
}

export function buildContextCompactionPrompt(
	transcript: CompactableTranscript,
	transcriptFilePath = "<transcript file will be written during context compaction>",
	parameters: ContextCompactionParameters = getTranscriptCompactionParameters(transcript),
): string {
	return `${contextCompactionFixedPrompt(parameters)}${contextCompactionParametersPrompt(parameters)}\n\n<transcript-file>\n${transcriptFilePath}\n</transcript-file>\n\n<context-manifest>\n${JSON.stringify(contextCompactionTranscriptManifest(transcript, transcriptFilePath), null, 2)}\n</context-manifest>`;
}
