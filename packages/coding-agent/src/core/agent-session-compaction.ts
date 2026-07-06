import { formatNoModelSelectedMessage } from "./auth-guidance.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import type { ContextCompactionApplyOptions } from "./agent-session-methods.ts";
import { getEffectiveInputBudget } from "./context-window.ts";
import { type ContextCompactionParameters, type ContextCompactionPreparation, type ContextCompactionResult, type ContextDeletionRequest, type ValidatedContextDeletionResult, contextCompact as runContextCompact, prepareContextCompaction, validateContextDeletionRequest } from "./compaction/index.ts";
import { runDeterministicContextEviction } from "./compaction/context-compaction-eviction.ts";
// Type-only import: erased at runtime so module mocks of the compaction barrel stay authoritative.
import type { ContextCompactionLadderOptions } from "./compaction/context-compaction-runner.ts";
import type { SessionBeforeCompactEvent, SessionBeforeCompactResult, SessionCompactEvent } from "./extensions/index.ts";
import type { ContextCompactionEntry } from "./session-manager.ts";

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object") {
		Object.freeze(value);
		for (const nested of Object.values(value)) {
			deepFreeze(nested);
		}
	}
	return value;
}

export async function _applyContextVerbatimCompaction(
	this: AgentSession,
	options: ContextCompactionApplyOptions,
): Promise<ContextCompactionResult | undefined> {
	if (!this.model) {
		throw new Error(formatNoModelSelectedMessage());
	}
	// Capture the narrowed model now (control-flow narrowing holds immediately after the
	// guard) so the lazy planner-fallback closure below can use a non-undefined model.
	const model = this.model;
	const compactionThinkingLevel = this.thinkingLevel;

	const pathEntries = this.sessionManager.getBranch();
	const settings = this.settingsManager.getCompactionSettings();
	const preparation = prepareContextCompaction(pathEntries, settings, {
		...(options.compression_ratio === undefined ? {} : { compression_ratio: options.compression_ratio }),
		...(options.preserve_recent === undefined ? {} : { preserve_recent: options.preserve_recent }),
		...(options.query === undefined ? {} : { query: options.query }),
	});
	if (!preparation) {
		// Overflow recovery must be loud when there is no transcript the ladder can compact:
		// a silent no-op would leave the session overflowing without proving safe deletion is exhausted.
		if (options.reason === "overflow") {
			throw new Error("Context compaction found no compactable transcript entries; nothing more was safely deletable");
		}
		return undefined;
	}
	const parameters: ContextCompactionParameters = preparation.parameters;
	const effectiveBudget = getEffectiveInputBudget(model);
	const ladderOptions: ContextCompactionLadderOptions | undefined =
		options.reason === "overflow"
			? { acceptanceTokenBudget: effectiveBudget, criticalEvictionTokenBudget: effectiveBudget }
			: options.reason === "threshold"
				// Match the shouldCompact trigger boundary in transcript-estimate space:
				// tokensAfter <= effectiveBudget - reserveTokens is equivalent to
				// !shouldCompact(tokensAfter, effectiveBudget, settings). The live post-retry
				// trigger uses provider usage (system/tools included), so this is a best-effort
				// boundary; a negative boundary correctly means no estimated result fits.
				? { acceptanceTokenBudget: effectiveBudget - settings.reserveTokens }
				: undefined;

	// Planner fallback used when no extension supplies a deletionRequest. Auth is resolved
	// lazily here so extension-provided deletion requests keep working offline. Overflow with
	// missing auth uses deterministic eviction directly instead of silently no-oping.
	const runPlanner = async (): Promise<ValidatedContextDeletionResult | undefined> => {
		const auth = await options.resolvePlannerAuth();
		if (!auth) {
			if (options.reason === "overflow") return runDeterministicContextEviction(preparation.transcript, effectiveBudget);
			return undefined;
		}
		return runContextCompact(
			preparation,
			model,
			auth.apiKey,
			auth.headers,
			options.abortController.signal,
			compactionThinkingLevel,
			ladderOptions,
		);
	};

	// Emit session_before_compact to allow extensions to cancel or provide a deletion request.
	// This happens BEFORE any auth resolution so local extension deletion requests work
	// without configured API credentials.
	let fromExtension = false;
	let validated: ValidatedContextDeletionResult | undefined;

	if (this._extensionRunner.hasHandlers("session_before_compact")) {
		// Deep-clone the preparation only when a before-compact handler actually exists. Extensions
		// receive an isolated, frozen snapshot so they cannot mutate protection metadata
		// (protectedEntryIds, entry .protected flags, etc.) on the internal preparation used for
		// validation. Building it lazily avoids deep-cloning the transcript — largest exactly when
		// compaction fires — on the common no-extension path.
		let extensionPreparation: ContextCompactionPreparation;
		try {
			extensionPreparation = deepFreeze(structuredClone(preparation));
		} catch (error) {
			// structuredClone only throws if an entry carries a non-cloneable value (a function or a
			// class instance). Transcript entries are plain data today, so this guards a latent
			// invariant: surface a clear error instead of letting a raw DataCloneError abort an
			// otherwise-viable compaction.
			throw new Error(
				`Failed to snapshot transcript for compaction extensions: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		const hookResult = (await this._extensionRunner.emit({
			type: "session_before_compact",
			reason: options.reason,
			parameters,
			preparation: extensionPreparation,
			branchEntries: pathEntries,
			signal: options.abortController.signal,
		} satisfies SessionBeforeCompactEvent)) as SessionBeforeCompactResult | undefined;

		if (hookResult?.cancel) {
			throw new Error("Compaction cancelled");
		}

		if (hookResult?.deletionRequest) {
			const extensionDeletionRequest = hookResult.deletionRequest as ContextDeletionRequest;
			// Reject empty deletion requests before any side effects (backup, append, rebuild).
			if (!Array.isArray(extensionDeletionRequest.deletions) || extensionDeletionRequest.deletions.length === 0) {
				throw new Error("No safe context deletions proposed by extension");
			}
			// Validate against the internal transcript snapshot, not the extension-facing clone.
			// Auth is NOT resolved here — local extension deletion requests work offline.
			validated = validateContextDeletionRequest(extensionDeletionRequest, preparation.transcript);
			// Reject if reconciliation reduced deletions to zero.
			if (validated.deletedTargets.length === 0) {
				throw new Error("No safe context deletions proposed by extension");
			}
			fromExtension = true;
		}
	}

	// Planner fallback shared by both paths: no before-compact handler at all, or a handler that
	// observed without supplying a deletionRequest. Resolves auth lazily; undefined means auth is
	// unavailable (auto-mode resolvers), so compaction is a no-op.
	if (!validated) {
		const plannerResult = await runPlanner();
		if (!plannerResult) {
			return undefined;
		}
		validated = plannerResult;
	}

	if (options.abortController.signal.aborted) {
		throw new Error("Compaction cancelled");
	}

	const backupPath = this.sessionManager.writeBackupSnapshot(options.backupLabel);
	const compactionEntryId = this.sessionManager.appendContextCompaction(
		validated.deletedTargets,
		validated.protectedEntryIds,
		validated.stats,
		backupPath,
	);
	const sessionContext = this.sessionManager.buildSessionContext();
	this.agent.state.messages = sessionContext.messages;

	const result: ContextCompactionResult = {
		...validated,
		promptVersion: 1,
		parameters,
		...(backupPath ? { backupPath } : {}),
	};

	// Emit session_compact so extensions can observe the validated result. This is a pure
	// observation hook fired AFTER the compaction has been committed (backup written,
	// context_compaction entry persisted, active context rebuilt). A misbehaving observer must
	// never turn a successful, already-persisted compaction into a reported failure, so any
	// throw is routed to the non-fatal extension-error channel and compaction still reports
	// success.
	const contextCompactionEntry = this.sessionManager.getEntry(compactionEntryId) as ContextCompactionEntry;
	try {
		await this._extensionRunner.emit({
			type: "session_compact",
			reason: options.reason,
			parameters,
			result,
			contextCompactionEntry,
			fromExtension,
		} satisfies SessionCompactEvent);
	} catch (error) {
		this._extensionRunner.emitError({
			extensionPath: "<session_compact>",
			event: "session_compact",
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
		});
	}

	return result;
}

/**
 * Manually compact the session context using deletion-only verbatim context compaction.
 * Aborts current agent operation first.
 */

export async function compact(this: AgentSession, options: Partial<ContextCompactionParameters> = {}): Promise<ContextCompactionResult> {
	this._disconnectFromAgent();
	await this.abort();
	this._compactionAbortController = new AbortController();
	this._emit({ type: "compaction_start", reason: "manual" });

	try {
		if (!this.model) {
			throw new Error(formatNoModelSelectedMessage());
		}

		// Auth is resolved lazily: only called when the planner fallback is needed.
		// Extensions that provide a deletionRequest work without configured credentials.
		const model = this.model;
		const result = await this._applyContextVerbatimCompaction({
			resolvePlannerAuth: () => this._getRequiredRequestAuth(model),
			abortController: this._compactionAbortController,
			backupLabel: "compact",
			reason: "manual",
			...(options.compression_ratio === undefined ? {} : { compression_ratio: options.compression_ratio }),
			...(options.preserve_recent === undefined ? {} : { preserve_recent: options.preserve_recent }),
			...(options.query === undefined ? {} : { query: options.query }),
		});
		if (!result) {
			throw new Error("Nothing to compact (session too small)");
		}

		this._emit({
			type: "compaction_end",
			reason: "manual",
			result,
			aborted: false,
			willRetry: false,
		});
		return result;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const aborted = message === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError");
		this._emit({
			type: "compaction_end",
			reason: "manual",
			result: undefined,
			aborted,
			willRetry: false,
			errorMessage: aborted ? undefined : `Compaction failed: ${message}`,
		});
		throw error;
	} finally {
		this._compactionAbortController = undefined;
		this._reconnectToAgent();
	}
}

/**
 * Manually compact the session context by applying validated logical deletions.
 * Retained transcript entries/content blocks stay verbatim; no user prompt text is accepted.
 */

export async function contextCompact(this: AgentSession): Promise<ContextCompactionResult> {
	this._disconnectFromAgent();
	await this.abort();
	this._compactionAbortController = new AbortController();
	this._emit({ type: "context_compaction_start", reason: "manual" });

	try {
		if (!this.model) {
			throw new Error(formatNoModelSelectedMessage());
		}

		// Auth is resolved lazily: only called when the planner fallback is needed.
		// Extensions that provide a deletionRequest work without configured credentials.
		const model = this.model;
		const result = await this._applyContextVerbatimCompaction({
			resolvePlannerAuth: () => this._getRequiredRequestAuth(model),
			abortController: this._compactionAbortController,
			backupLabel: "context-compact",
			reason: "manual",
		});
		if (!result) {
			throw new Error("Nothing to context-compact (session too small)");
		}

		this._emit({
			type: "context_compaction_end",
			reason: "manual",
			result,
			aborted: false,
			willRetry: false,
		});
		return result;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const aborted = message === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError");
		this._emit({
			type: "context_compaction_end",
			reason: "manual",
			result: undefined,
			aborted,
			willRetry: false,
			errorMessage: aborted ? undefined : `Context compaction failed: ${message}`,
		});
		throw error;
	} finally {
		this._compactionAbortController = undefined;
		this._reconnectToAgent();
	}
}

/**
 * Cancel in-progress compaction (manual or auto).
 */

export function abortCompaction(this: AgentSession): void {
	this._compactionAbortController?.abort();
	this._autoCompactionAbortController?.abort();
}

/**
 * Cancel in-progress branch summarization.
 */

export function abortBranchSummary(this: AgentSession): void {
	this._branchSummaryAbortController?.abort();
}

/**
 * Check if compaction is needed and run it.
 * Called after agent_end and before prompt submission.
 *
 * Two cases:
 * 1. Overflow: LLM returned context overflow error, remove error message from agent state, compact, auto-retry
 * 2. Threshold: Context over threshold, compact, resume queued active-turn work if present; otherwise wait for user
 *
 * @param assistantMessage The assistant message to check
 * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
 */

export function setAutoCompactionEnabled(this: AgentSession, enabled: boolean): void {
	this.settingsManager.setCompactionEnabled(enabled);
}

/** Whether auto-compaction is enabled */

export const agentSessionCompactionMethods = {
	_applyContextVerbatimCompaction,
	compact,
	contextCompact,
	abortCompaction,
	abortBranchSummary,
	setAutoCompactionEnabled,
};
