import type {
	AgentSessionInternalSurface as AgentSession,
	VerbatimCompactionApplyOptions,
} from "./agent-session-methods.ts";
import { formatNoModelSelectedMessage } from "./auth-guidance.ts";
import {
	type CompactionPlannerModel,
	type CompactionPlanOptions,
	type CompactionRung,
	type FallbackPlannerContext,
	getKeptTailTokenEstimate,
	prepareCompactionBoundary,
	runVerbatimCompaction,
	VERBATIM_COMPACTION_PROMPT_VERSION,
	VERBATIM_COMPACTION_STRATEGY,
	type VerbatimCompactionDetails,
	type VerbatimCompactionParameters,
	type VerbatimCompactionPreparation,
	type VerbatimCompactionResult,
	type VerbatimCompactionStats,
} from "./compaction/index.ts";
import type { SessionBeforeCompactEvent, SessionBeforeCompactResult, SessionCompactEvent } from "./extensions/index.ts";
import type { CompactionEntry } from "./session-manager.ts";
import { createSummarizationRetryCallbacks } from "./summarization-retry.ts";

function frozenCollectionMutation(): never {
	throw new TypeError("Cannot mutate frozen compaction preparation");
}

function deepFreeze<T>(value: T): T {
	if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
	if (value instanceof Map) {
		for (const [key, nested] of value) {
			deepFreeze(key);
			deepFreeze(nested);
		}
		Object.defineProperties(value, {
			set: { value: frozenCollectionMutation },
			delete: { value: frozenCollectionMutation },
			clear: { value: frozenCollectionMutation },
		});
	} else if (value instanceof Set) {
		for (const nested of value) deepFreeze(nested);
		Object.defineProperties(value, {
			add: { value: frozenCollectionMutation },
			delete: { value: frozenCollectionMutation },
			clear: { value: frozenCollectionMutation },
		});
	} else {
		for (const nested of Object.values(value)) deepFreeze(nested);
	}
	return Object.freeze(value);
}

function extensionStats(preparation: VerbatimCompactionPreparation, compactedText: string): VerbatimCompactionStats {
	const linesBefore = preparation.region.lines.length;
	const linesKept = compactedText.split("\n").length;
	const tokensAfter = Math.ceil(compactedText.length / 4) + getKeptTailTokenEstimate(preparation);
	return {
		linesBefore,
		linesDeleted: Math.max(0, linesBefore - linesKept),
		linesKept,
		rangeCount: 0,
		tokensBefore: preparation.tokensBefore,
		tokensAfter,
		percentReduction:
			preparation.tokensBefore === 0 ? 0 : Math.round((1 - tokensAfter / preparation.tokensBefore) * 1000) / 10,
	};
}

export async function _applyVerbatimCompaction(
	this: AgentSession,
	options: VerbatimCompactionApplyOptions,
): Promise<VerbatimCompactionResult | undefined> {
	if (!this.model) throw new Error(formatNoModelSelectedMessage());
	const model = this.model;
	const pathEntries = this.sessionManager.getBranch();
	const settings = this.settingsManager.getCompactionSettings();
	// A sub-minimum region is admitted only when the caller already knows the
	// context does not fit: overflow recovery, or a post-tool preflight over the
	// provider hard input limit. A threshold crossing that still fits must not
	// clear context — its follow-up request can be sent as-is. `load_bearing`
	// alone does not mean "must destroy context".
	const allowSmallRegion = options.urgency === "load_bearing" && options.allowSmallRegion === true;
	const preparation = prepareCompactionBoundary(
		pathEntries,
		settings,
		{
			...(options.compression_ratio === undefined ? {} : { compression_ratio: options.compression_ratio }),
			...(options.preserve_recent === undefined ? {} : { preserve_recent: options.preserve_recent }),
			...(options.query === undefined ? {} : { query: options.query }),
		},
		{ allowSmallRegion },
	);
	if (!preparation) {
		// Mid-turn threshold preflight needs the load-bearing planner fallback if
		// a region exists, but a context that still fits is safe to send unchanged.
		// True overflow and a hard-limit preflight have no such escape hatch.
		const mustFreeContext = options.urgency === "load_bearing" && (options.reason === "overflow" || allowSmallRegion);
		if (mustFreeContext) {
			throw new Error(
				"Context compaction found no compactable transcript entries; nothing more was safely deletable",
			);
		}
		return undefined;
	}

	const plan: CompactionPlanOptions = {
		streamFn: this.agent.streamFunction,
		sessionFilePath: this.sessionManager.getSessionFile(),
		retry: this.settingsManager.getRetrySettings(),
		callbacks: createSummarizationRetryCallbacks(this, { source: "compaction", reason: options.reason }),
	};
	let fromExtension = false;
	let compacted:
		| {
				text: string;
				stats: VerbatimCompactionStats;
				rung: CompactionRung;
				plannerModel?: CompactionPlannerModel;
				keptTail: boolean;
		  }
		| undefined;

	if (this._extensionRunner.hasHandlers("session_before_compact")) {
		let snapshot: VerbatimCompactionPreparation;
		try {
			snapshot = deepFreeze(structuredClone(preparation));
		} catch (error) {
			throw new Error(
				`Failed to snapshot transcript for compaction extensions: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const hookResult = (await this._extensionRunner.emit({
			type: "session_before_compact",
			reason: options.reason,
			parameters: preparation.parameters,
			preparation: snapshot,
			branchEntries: pathEntries,
			signal: options.abortController.signal,
		} satisfies SessionBeforeCompactEvent)) as SessionBeforeCompactResult | undefined;
		if (hookResult?.cancel) throw new Error("Compaction cancelled");
		if (hookResult?.compactedText !== undefined) {
			if (hookResult.compactedText.trim().length === 0) throw new Error("No compacted text provided by extension");
			compacted = {
				text: hookResult.compactedText,
				stats: extensionStats(preparation, hookResult.compactedText),
				rung: "extension",
				keptTail: true,
			};
			fromExtension = true;
		}
	}

	if (!compacted) {
		// Borrowing walks the session's *effective* fallback list, which SDK
		// options may override, and resolves credentials per candidate. It never
		// touches session model state or the main chat's attempted-key set.
		const fallback: FallbackPlannerContext = {
			fallbackModels: this._fallbackModels,
			registry: this._modelRuntime,
			preferredProvider: model.provider,
			sessionThinkingLevel: this.thinkingLevel,
		};
		const run = await runVerbatimCompaction(preparation, model, {
			...plan,
			resolveAuth: options.resolvePlannerAuth,
			signal: options.abortController.signal,
			thinkingLevel: this.thinkingLevel,
			urgency: options.urgency,
			fallback,
		});
		compacted = {
			text: run.text,
			stats: run.stats,
			rung: run.rung,
			...(run.plannerModel ? { plannerModel: run.plannerModel } : {}),
			keptTail: run.keptTail,
		};
	}
	if (options.abortController.signal.aborted) throw new Error("Compaction cancelled");

	// A fresh rung that had to drop the protected tail persists no tail boundary.
	const firstKeptEntryId = compacted.keptTail ? preparation.firstKeptEntryId : null;
	const backupPath = this.sessionManager.writeBackupSnapshot(options.backupLabel);
	const details: VerbatimCompactionDetails = {
		strategy: VERBATIM_COMPACTION_STRATEGY,
		promptVersion: VERBATIM_COMPACTION_PROMPT_VERSION,
		parameters: preparation.parameters,
		stats: compacted.stats,
		rung: compacted.rung,
		...(compacted.plannerModel ? { plannerModel: compacted.plannerModel } : {}),
		...(backupPath ? { backupPath } : {}),
	};
	const entryId = this.sessionManager.appendCompaction(
		compacted.text,
		firstKeptEntryId,
		preparation.tokensBefore,
		details,
	);
	this.agent.state.messages = this.sessionManager.buildSessionContext().messages;
	const result: VerbatimCompactionResult = {
		compactedText: compacted.text,
		firstKeptEntryId,
		tokensBefore: preparation.tokensBefore,
		stats: compacted.stats,
		parameters: preparation.parameters,
		promptVersion: VERBATIM_COMPACTION_PROMPT_VERSION,
		rung: compacted.rung,
		...(compacted.plannerModel ? { plannerModel: compacted.plannerModel } : {}),
		...(backupPath ? { backupPath } : {}),
	};
	const compactionEntry = this.sessionManager.getEntry(entryId) as CompactionEntry<VerbatimCompactionDetails>;
	try {
		await this._extensionRunner.emit({
			type: "session_compact",
			reason: options.reason,
			parameters: preparation.parameters,
			result,
			compactionEntry,
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

function clearOwnedManualCompactionState(this: AgentSession, controller: AbortController): void {
	if (this._compactionAbortController !== controller) return;
	this._compactionAbortController = undefined;
	if (this._compactionReason === "manual") this._compactionReason = undefined;
	// Lifecycle listeners run synchronously. Once the manual end event is
	// emitted, a new /compact must own a new run rather than join the settled one.
	this._manualCompactionPromise = undefined;
}

function emitManualCompactionFailure(this: AgentSession, controller: AbortController, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	const aborted = message === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError");
	clearOwnedManualCompactionState.call(this, controller);
	this._emit({
		type: "compaction_end",
		reason: "manual",
		result: undefined,
		aborted,
		willRetry: false,
		errorMessage: aborted ? undefined : `Compaction failed: ${message}`,
	});
}

async function runOwnedManualCompaction(
	this: AgentSession,
	controller: AbortController,
	options: Partial<VerbatimCompactionParameters>,
): Promise<VerbatimCompactionResult> {
	this._emit({ type: "compaction_start", reason: "manual" });
	try {
		if (!this.model) throw new Error(formatNoModelSelectedMessage());
		const result = await this._applyVerbatimCompaction({
			// Caller parameters are projected explicitly, so no extra runtime
			// property survives. A widened or cast object could otherwise carry
			// `urgency: "load_bearing"` through a public `session.compact()` call and
			// reach the context-destroying rung, which manual compaction must never do.
			...(options.compression_ratio === undefined ? {} : { compression_ratio: options.compression_ratio }),
			...(options.preserve_recent === undefined ? {} : { preserve_recent: options.preserve_recent }),
			...(options.query === undefined ? {} : { query: options.query }),
			resolvePlannerAuth: (candidate) => this._getRequiredRequestAuth(candidate),
			abortController: controller,
			backupLabel: "compact",
			reason: "manual",
			urgency: "recoverable",
		});
		if (!result) throw new Error("Nothing to compact (session too small)");
		// compaction_end listeners synchronously flush queued prompts, so they must
		// observe an idle session before dispatching the next user turn.
		clearOwnedManualCompactionState.call(this, controller);
		this._emit({ type: "compaction_end", reason: "manual", result, aborted: false, willRetry: false });
		return result;
	} catch (error) {
		emitManualCompactionFailure.call(this, controller, error);
		throw error;
	}
}

/**
 * Persist one verbatim line-subset compaction boundary.
 *
 * Re-entrancy safe: a call made while a manual compaction is still in flight
 * joins that run instead of starting a second one. Manual compaction aborts an
 * active agent run before it starts, while agent event delivery remains live so
 * a pending threshold check cannot race the requested manual boundary.
 */
export function compact(
	this: AgentSession,
	options: Partial<VerbatimCompactionParameters> = {},
): Promise<VerbatimCompactionResult> {
	const inFlight = this._manualCompactionPromise;
	if (inFlight) return inFlight;

	// A manual boundary replaces the automatic turn that scheduled any pending
	// retry. Invalidate its timer before this run claims compaction ownership.
	this._postCompactionContinuationToken += 1;
	this._pendingPostCompactionContinuation = undefined;

	const controller = new AbortController();
	this._compactionAbortController = controller;
	this._compactionReason = "manual";
	const automaticCompletion = this._autoCompactionCompletion;
	// The manual request wins. Abort the active automatic planner now, before the
	// next microtask can admit a post-tool or threshold boundary, then wait for
	// its owner to settle before mutating the transcript ourselves.
	this._autoCompactionAbortController?.abort();
	const abortBoundary = this.abort();
	// This settles only after any active automatic run. Handle its rejection now
	// so a failing event drain cannot become unhandled while that run finishes.
	void abortBoundary.catch(() => {});
	let flight!: Promise<VerbatimCompactionResult>;
	// Start the owned run in a microtask so both single-flight fields are
	// published before any joiner can observe a partially claimed compaction.
	flight = Promise.resolve()
		.then(async () => {
			try {
				if (automaticCompletion !== undefined) await automaticCompletion;
				await abortBoundary;
			} catch (error) {
				// The abort drain can fail before the planner starts. Finish the
				// manual lifecycle so event consumers can release queued input.
				emitManualCompactionFailure.call(this, controller, error);
				throw error;
			}
			return runOwnedManualCompaction.call(this, controller, options);
		})
		.finally(() => {
			clearOwnedManualCompactionState.call(this, controller);
			if (this._manualCompactionPromise === flight) this._manualCompactionPromise = undefined;
		});
	this._manualCompactionPromise = flight;
	return flight;
}

export function abortCompaction(this: AgentSession): void {
	this._compactionAbortController?.abort();
	this._autoCompactionAbortController?.abort();
}
export function abortBranchSummary(this: AgentSession): void {
	this._branchSummaryAbortController?.abort();
}
export function setAutoCompactionEnabled(this: AgentSession, enabled: boolean): void {
	this.settingsManager.setCompactionEnabled(enabled);
}

export const agentSessionCompactionMethods = {
	_applyVerbatimCompaction,
	compact,
	abortCompaction,
	abortBranchSummary,
	setAutoCompactionEnabled,
};
