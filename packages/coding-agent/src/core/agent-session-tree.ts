import type { BranchSummaryEntry } from "./session-manager.ts";
import { collectEntriesForBranchSummary, generateBranchSummary } from "./compaction/index.ts";
import type { SessionBeforeTreeResult, TreePreparation } from "./extensions/index.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";

export function setSessionName(this: AgentSession, name: string): void {
	this.sessionManager.appendSessionInfo(name);
	const event = { type: "session_info_changed", name: this.sessionManager.getSessionName() } as const;
	this._emit(event);
	void this._extensionRunner.emit(event);
}

// =========================================================================
// Tree Navigation
// =========================================================================

/**
 * Navigate to a different node in the session tree.
 * Unlike fork() which creates a new session file, this stays in the same file.
 *
 * @param targetId The entry ID to navigate to
 * @param options.summarize Whether user wants to summarize abandoned branch
 * @param options.customInstructions Custom instructions for summarizer
 * @param options.replaceInstructions If true, customInstructions replaces the default prompt
 * @param options.label Label to attach to the branch summary entry
 * @returns Result with editorText (if user message) and cancelled status
 */

export async function navigateTree(this: AgentSession, 
	targetId: string,
	options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {},
): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
	const oldLeafId = this.sessionManager.getLeafId();

	// No-op if already at target
	if (targetId === oldLeafId) {
		return { cancelled: false };
	}

	// Model required for summarization
	if (options.summarize && !this.model) {
		throw new Error("No model available for summarization");
	}

	const targetEntry = this.sessionManager.getEntry(targetId);
	if (!targetEntry) {
		throw new Error(`Entry ${targetId} not found`);
	}

	// Collect entries to summarize (from old leaf to common ancestor)
	const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
		this.sessionManager,
		oldLeafId,
		targetId,
	);

	// Prepare event data - mutable so extensions can override
	let customInstructions = options.customInstructions;
	let replaceInstructions = options.replaceInstructions;
	let label = options.label;

	const preparation: TreePreparation = {
		targetId,
		oldLeafId,
		commonAncestorId,
		entriesToSummarize,
		userWantsSummary: options.summarize ?? false,
		customInstructions,
		replaceInstructions,
		label,
	};

	// Set up abort controller for summarization
	this._branchSummaryAbortController = new AbortController();

	try {
		let extensionSummary: { summary: string; details?: unknown } | undefined;
		let fromExtension = false;

		// Emit session_before_tree event
		if (this._extensionRunner.hasHandlers("session_before_tree")) {
			const result = (await this._extensionRunner.emit({
				type: "session_before_tree",
				preparation,
				signal: this._branchSummaryAbortController.signal,
			})) as SessionBeforeTreeResult | undefined;

			if (result?.cancel) {
				return { cancelled: true };
			}

			if (result?.summary && options.summarize) {
				extensionSummary = result.summary;
				fromExtension = true;
			}

			// Allow extensions to override instructions and label
			if (result?.customInstructions !== undefined) {
				customInstructions = result.customInstructions;
			}
			if (result?.replaceInstructions !== undefined) {
				replaceInstructions = result.replaceInstructions;
			}
			if (result?.label !== undefined) {
				label = result.label;
			}
		}

		// Run default summarizer if needed
		let summaryText: string | undefined;
		let summaryDetails: unknown;
		if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
			const model = this.model!;
			const { apiKey, headers } = await this._getRequiredRequestAuth(model);
			const branchSummarySettings = this.settingsManager.getBranchSummarySettings();
			const result = await generateBranchSummary(entriesToSummarize, {
				model,
				apiKey,
				headers,
				signal: this._branchSummaryAbortController.signal,
				customInstructions,
				replaceInstructions,
				reserveTokens: branchSummarySettings.reserveTokens,
				streamFn: this.agent.streamFn,
			});
			if (result.aborted) {
				return { cancelled: true, aborted: true };
			}
			if (result.error) {
				throw new Error(result.error);
			}
			summaryText = result.summary;
			summaryDetails = {
				readFiles: result.readFiles || [],
				modifiedFiles: result.modifiedFiles || [],
			};
		} else if (extensionSummary) {
			summaryText = extensionSummary.summary;
			summaryDetails = extensionSummary.details;
		}

		// Determine the new leaf position based on target type
		let newLeafId: string | null;
		let editorText: string | undefined;

		if (targetEntry.type === "message" && targetEntry.message.role === "user") {
			// User message: leaf = parent (null if root), text goes to editor
			newLeafId = targetEntry.parentId;
			editorText = this._extractUserMessageText(targetEntry.message.content);
		} else if (targetEntry.type === "custom_message") {
			// Custom message: leaf = parent (null if root), text goes to editor
			newLeafId = targetEntry.parentId;
			editorText =
				typeof targetEntry.content === "string"
					? targetEntry.content
					: targetEntry.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join("");
		} else {
			// Non-user message: leaf = selected node
			newLeafId = targetId;
		}

		// Switch leaf (with or without summary)
		// Summary is attached at the navigation target position (newLeafId), not the old branch
		let summaryEntry: BranchSummaryEntry | undefined;
		if (summaryText) {
			// Create summary at target position (can be null for root)
			const summaryId = this.sessionManager.branchWithSummary(
				newLeafId,
				summaryText,
				summaryDetails,
				fromExtension,
			);
			summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;

			// Attach label to the summary entry
			if (label) {
				this.sessionManager.appendLabelChange(summaryId, label);
			}
		} else if (newLeafId === null) {
			// No summary, navigating to root - reset leaf
			this.sessionManager.resetLeaf();
		} else {
			// No summary, navigating to non-root
			this.sessionManager.branch(newLeafId);
		}

		// Attach label to target entry when not summarizing (no summary entry to label)
		if (label && !summaryText) {
			this.sessionManager.appendLabelChange(targetId, label);
		}

		// Update agent state
		const sessionContext = this.sessionManager.buildSessionContext();
		this.agent.state.messages = sessionContext.messages;
		this._applyContextWindowReplay(sessionContext.contextWindow);

		// Emit session_tree event
		await this._extensionRunner.emit({
			type: "session_tree",
			newLeafId: this.sessionManager.getLeafId(),
			oldLeafId,
			summaryEntry,
			fromExtension: summaryText ? fromExtension : undefined,
		});

		// Emit to custom tools

		return { editorText, cancelled: false, summaryEntry };
	} finally {
		this._branchSummaryAbortController = undefined;
	}
}

/**
 * Get all user messages from session for fork selector.
 */

export function getUserMessagesForForking(this: AgentSession): Array<{ entryId: string; text: string }> {
	const entries = this.sessionManager.getEntries();
	const result: Array<{ entryId: string; text: string }> = [];

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		if (entry.message.role !== "user") continue;

		const text = this._extractUserMessageText(entry.message.content);
		if (text) {
			result.push({ entryId: entry.id, text });
		}
	}

	return result;
}


export function _extractUserMessageText(this: AgentSession, content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("");
	}
	return "";
}

/**
 * Get session statistics.
 */

export const agentSessionTreeMethods = {
	setSessionName,
	navigateTree,
	getUserMessagesForForking,
	_extractUserMessageText,
};
