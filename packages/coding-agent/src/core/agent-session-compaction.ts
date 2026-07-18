import { formatNoModelSelectedMessage } from "./auth-guidance.ts";
import type { AgentSessionInternalSurface as AgentSession, VerbatimCompactionApplyOptions } from "./agent-session-methods.ts";
import {
	compactionRequestIdentityMatches,
	getKeptTailTokenEstimate,
	prepareCompactionBoundary,
	prepareFullCollapseBoundary,
	runFullCollapseCompaction,
	VERBATIM_COMPACTION_FORMAT_FULL,
	VERBATIM_COMPACTION_PROMPT_VERSION,
	VERBATIM_COMPACTION_STRATEGY,
	type CompactionCacheTelemetry,
	type CompactionPlanOptions,
	type VerbatimCompactionDetails,
	type VerbatimCompactionParameters,
	type VerbatimCompactionPreparation,
	type VerbatimCompactionResult,
	type VerbatimCompactionStats,
} from "./compaction/index.ts";
import type { SessionBeforeCompactEvent, SessionBeforeCompactResult, SessionCompactEvent } from "./extensions/index.ts";
import type { CompactionEntry } from "./session-manager.ts";

function frozenCollectionMutation(): never {
	throw new TypeError("Cannot mutate frozen compaction preparation");
}

function deepFreeze<T>(value: T): T {
	if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
	if (value instanceof Map) {
		for (const [key, nested] of value) { deepFreeze(key); deepFreeze(nested); }
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
		percentReduction: preparation.tokensBefore === 0 ? 0 : Math.round((1 - tokensAfter / preparation.tokensBefore) * 1000) / 10,
	};
}

export class StaleCompactionPlanError extends Error {
	readonly retryable = true;
	constructor() {
		super("Compaction plan became stale because the session changed during planning");
		this.name = "StaleCompactionPlanError";
	}
}

export async function _applyVerbatimCompaction(
	this: AgentSession,
	options: VerbatimCompactionApplyOptions,
): Promise<VerbatimCompactionResult | undefined> {
	if (!this.model) throw new Error(formatNoModelSelectedMessage());
	const model = this.model;
	const pathEntries = this.sessionManager.getBranch();
	const settings = this.settingsManager.getCompactionSettings();
	const planningLeafId = this.sessionManager.getLeafId();
	const parameterOptions = {
		...(options.compression_ratio === undefined ? {} : { compression_ratio: options.compression_ratio }),
		...(options.preserve_recent === undefined ? {} : { preserve_recent: options.preserve_recent }),
		...(options.query === undefined ? {} : { query: options.query }),
	};
	const compatiblePathEntries = options.excludeEntryId
		? pathEntries.filter((entry) => entry.id !== options.excludeEntryId) : pathEntries;
	const fullPreparation = prepareFullCollapseBoundary(compatiblePathEntries, settings, {
		...parameterOptions,
		...(options.excludeEntryId && planningLeafId ? { anchorId: planningLeafId } : {}),
	});
	if (!fullPreparation) {
		if (options.reason === "overflow") throw new Error("Context compaction found no compactable transcript entries; nothing more was safely deletable");
		return undefined;
	}
	const hasBeforeHook = this._extensionRunner.hasHandlers("session_before_compact");
	const legacyPreparation = hasBeforeHook
		? prepareCompactionBoundary(compatiblePathEntries, settings, parameterOptions) : undefined;
	const extensionPreparation = legacyPreparation ?? fullPreparation;
	const capturedPrefix = this._activeRequestPrefix
		&& compactionRequestIdentityMatches(this._activeRequestPrefix.identity, model)
		&& this._activeRequestPrefix.identity.sessionId === this.sessionManager.getSessionId()
		? this._activeRequestPrefix : undefined;
	const plan: CompactionPlanOptions = {
		streamFn: this._originatingStreamFn,
		sessionFilePath: this.sessionManager.getSessionFile(),
		...(capturedPrefix ? { prefix: capturedPrefix } : {}),
	};
	let fromExtension = false;
	let boundaryPreparation: VerbatimCompactionPreparation = fullPreparation;
	let compacted:
		| { text: string; stats: VerbatimCompactionStats; rung: VerbatimCompactionResult["rung"]; cache?: CompactionCacheTelemetry }
		| undefined;

	if (hasBeforeHook) {
		let snapshot: VerbatimCompactionPreparation;
		try {
			snapshot = deepFreeze(structuredClone(extensionPreparation));
		} catch (error) {
			throw new Error(`Failed to snapshot transcript for compaction extensions: ${error instanceof Error ? error.message : String(error)}`);
		}
		const hookResult = (await this._extensionRunner.emit({
			type: "session_before_compact",
			reason: options.reason,
			parameters: extensionPreparation.parameters,
			preparation: snapshot,
			branchEntries: pathEntries,
			signal: options.abortController.signal,
		} satisfies SessionBeforeCompactEvent)) as SessionBeforeCompactResult | undefined;
		if (hookResult?.cancel) throw new Error("Compaction cancelled");
		if (hookResult?.compactedText !== undefined) {
			if (hookResult.compactedText.trim().length === 0) throw new Error("No compacted text provided by extension");
			if (!legacyPreparation) {
				throw new Error("Extension compactedText requires a compatible legacy kept-tail boundary");
			}
			boundaryPreparation = legacyPreparation;
			compacted = {
				text: hookResult.compactedText,
				stats: extensionStats(legacyPreparation, hookResult.compactedText),
				rung: "extension",
			};
			fromExtension = true;
		}
	}

	if (!compacted) {
		const auth = await options.resolvePlannerAuth();
		if (!auth) throw new Error("Compaction provider authentication is unavailable");
		compacted = await runFullCollapseCompaction(
			fullPreparation,
			model,
			auth.apiKey,
			auth.headers,
			options.abortController.signal,
			this.thinkingLevel,
			plan,
		);
		boundaryPreparation = fullPreparation;
	}
	if (options.abortController.signal.aborted) throw new Error("Compaction cancelled");
	if (this.sessionManager.getLeafId() !== planningLeafId) throw new StaleCompactionPlanError();

	const backupPath = this.sessionManager.writeBackupSnapshot(options.backupLabel);
	const promptVersion = fromExtension ? 3 : VERBATIM_COMPACTION_PROMPT_VERSION;
	const details: VerbatimCompactionDetails = {
		strategy: VERBATIM_COMPACTION_STRATEGY,
		promptVersion,
		...(fromExtension ? {} : { format: VERBATIM_COMPACTION_FORMAT_FULL }),
		parameters: boundaryPreparation.parameters,
		stats: compacted.stats,
		rung: compacted.rung,
		...(compacted.cache ? { cache: compacted.cache } : {}),
		...(backupPath ? { backupPath } : {}),
	};
	const excludedParentId = fromExtension && options.excludeEntryId
		? this.sessionManager.getEntry(options.excludeEntryId)?.parentId : undefined;
	if (excludedParentId) this.sessionManager.branch(excludedParentId);
	let entryId: string;
	try {
		entryId = this.sessionManager.appendCompaction(
			compacted.text, boundaryPreparation.firstKeptEntryId, boundaryPreparation.tokensBefore, details,
		);
	} catch (error) {
		if (excludedParentId && planningLeafId) this.sessionManager.branch(planningLeafId);
		throw error;
	}
	this.agent.state.messages = this.sessionManager.buildSessionContext().messages;
	const result: VerbatimCompactionResult = {
		compactedText: compacted.text,
		firstKeptEntryId: boundaryPreparation.firstKeptEntryId,
		tokensBefore: boundaryPreparation.tokensBefore,
		stats: compacted.stats,
		parameters: boundaryPreparation.parameters,
		promptVersion,
		...(fromExtension ? {} : { format: VERBATIM_COMPACTION_FORMAT_FULL }),
		rung: compacted.rung,
		...(compacted.cache ? { cache: compacted.cache } : {}),
		...(backupPath ? { backupPath } : {}),
	};
	const compactionEntry = this.sessionManager.getEntry(entryId) as CompactionEntry<VerbatimCompactionDetails>;
	try {
		await this._extensionRunner.emit({
			type: "session_compact", reason: options.reason, parameters: boundaryPreparation.parameters,
			result, compactionEntry, fromExtension,
		} satisfies SessionCompactEvent);
	} catch (error) {
		this._extensionRunner.emitError({ extensionPath: "<session_compact>", event: "session_compact", error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
	}
	return result;
}

/** Persist one verbatim line-subset compaction boundary. */
export async function compact(this: AgentSession, options: Partial<VerbatimCompactionParameters> = {}): Promise<VerbatimCompactionResult> {
	this._disconnectFromAgent();
	await this.abort();
	this._compactionAbortController = new AbortController();
	this._emit({ type: "compaction_start", reason: "manual" });
	try {
		if (!this.model) throw new Error(formatNoModelSelectedMessage());
		const model = this.model;
		const applyOptions: VerbatimCompactionApplyOptions = {
			resolvePlannerAuth: () => this._getRequiredRequestAuth(model), abortController: this._compactionAbortController,
			backupLabel: "compact", reason: "manual", ...options,
		};
		let result: VerbatimCompactionResult | undefined;
		try {
			result = await this._applyVerbatimCompaction(applyOptions);
		} catch (error) {
			if (!(error instanceof StaleCompactionPlanError)) throw error;
			result = await this._applyVerbatimCompaction(applyOptions);
		}
		if (!result) throw new Error("Nothing to compact (session too small)");
		this._emit({ type: "compaction_end", reason: "manual", result, aborted: false, willRetry: false });
		return result;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const aborted = message === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError");
		this._emit({ type: "compaction_end", reason: "manual", result: undefined, aborted, willRetry: false, errorMessage: aborted ? undefined : `Compaction failed: ${message}` });
		throw error;
	} finally {
		this._compactionAbortController = undefined;
		this._reconnectToAgent();
	}
}

export function abortCompaction(this: AgentSession): void { this._compactionAbortController?.abort(); this._autoCompactionAbortController?.abort(); }
export function abortBranchSummary(this: AgentSession): void { this._branchSummaryAbortController?.abort(); }
export function setAutoCompactionEnabled(this: AgentSession, enabled: boolean): void { this.settingsManager.setCompactionEnabled(enabled); }

export const agentSessionCompactionMethods = { _applyVerbatimCompaction, compact, abortCompaction, abortBranchSummary, setAutoCompactionEnabled };
