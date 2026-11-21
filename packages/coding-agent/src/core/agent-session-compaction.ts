import type { AgentMessage } from "@bastani/atomic-agent-core";
import { getCurrentSystemMessage } from "@bastani/atomic-ai";
import type { Usage } from "@bastani/atomic-ai/compat";
import { redactCredentialShapes } from "../utils/credential-redaction.js";
import { awaitedToolTurnEntryId } from "./agent-session-detached-tools.ts";
import type {
	AgentSessionInternalSurface as AgentSession,
	SessionCompactOptions,
	VerbatimCompactionApplyOptions,
} from "./agent-session-methods.ts";
import { formatNoModelSelectedMessage } from "./auth-guidance.ts";
import {
	buildBoundaryText,
	buildBoundaryTextWithLocation,
	buildCompactorMessages,
	type CompactionBackend,
	CompactorFailure,
	compactedOutputTokenCap,
	estimateTextTokens,
	estimateTokens,
	findUnansweredToolCall,
	type HistoryAccess,
	prepareCompactionBoundary,
	requestCompactorOutput,
	resolveCompactionModel,
	VERBATIM_COMPACTION_PROMPT_VERSION,
	VERBATIM_COMPACTION_STRATEGY,
	type VerbatimCompactionDetails,
	type VerbatimCompactionPreparation,
	type VerbatimCompactionResult,
	type VerbatimCompactionStats,
} from "./compaction/index.ts";
import { reportDebugAsync as reportDebug } from "./debug.ts";
import type {
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
	SessionCompactEvent,
	SessionCompactFailedEvent,
} from "./extensions/index.js";
import { isVerbatimCompactionMessage } from "./messages.ts";
import { assertSessionOpen as assertCompactionOpen, trackSessionWork } from "./session-lifecycle-work.ts";
import type { CompactionEntry, SessionEntry } from "./session-manager.ts";
import { buildSessionProjection } from "./session-manager-history.ts";

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

/** Why a manual compaction writes nothing while a tool call still waits for its result. */
export const PENDING_TOOL_CALL_MESSAGE =
	"A tool call is still waiting for its result; compact after it finishes, so the call and its result stay together";

/** Replacement text from a compactor model or an extension. */
interface CompactedReplacement {
	readonly text: string;
	readonly backend: CompactionBackend;
	/** The compactor model, as `provider/model`. */
	readonly model?: string;
}

/** A decided compaction, ready to be persisted as one boundary. The boundary text is built when it is appended. */
export interface PlannedVerbatimCompaction {
	readonly firstKeptEntryId: null;
	readonly tokensBefore: number;
	readonly preparation: VerbatimCompactionPreparation;
	readonly compacted?: CompactedReplacement;
	/** Why a configured compactor was not used and the context is cleared instead. */
	readonly fallbackReason?: string;
	/** The `/compact` instructions, when the caller gave any. */
	readonly instructions?: string;
	readonly access: HistoryAccess;
	/** Estimated tokens of the system message replayed at the boundary. */
	readonly systemTokens: number;
	readonly usage?: Usage;
	readonly fromExtension: boolean;
	/** Last entry the boundary covers, when entries after it stay in the context. */
	readonly coveredThroughEntryId?: string;
}

/** Whether the agent can search and read its own history with its own tools. */
function historyAccess(session: AgentSession): HistoryAccess {
	const active = new Set(session.getActiveToolNames());
	return active.has("read") && active.has("search") ? "read-search" : "session-history-tool";
}

function stats(planned: PlannedVerbatimCompaction, text: string): VerbatimCompactionStats {
	const linesBefore = planned.preparation.region.lines.length;
	const linesKept = planned.compacted ? planned.compacted.text.split("\n").length : 0;
	const tokensBefore = planned.tokensBefore;
	const tokensAfter = planned.systemTokens + estimateTextTokens(text);
	return {
		linesBefore,
		linesDeleted: Math.max(0, linesBefore - linesKept),
		linesKept,
		rangeCount: 0,
		tokensBefore,
		tokensAfter,
		percentReduction: tokensBefore === 0 ? 0 : Math.round((1 - tokensAfter / tokensBefore) * 1000) / 10,
	};
}

/** The boundary text and durable details for a planned compaction, given the history's last entry position. */
export function buildPlannedBoundary(
	planned: PlannedVerbatimCompaction,
	sessionId: string,
	historyEntries: number,
): { text: string; details: VerbatimCompactionDetails } {
	const { text, history } = buildBoundaryTextWithLocation({
		sessionId,
		tokensBefore: planned.tokensBefore,
		entriesBefore: historyEntries,
		access: planned.access,
		...(planned.instructions ? { instructions: planned.instructions } : {}),
		...(planned.compacted
			? {
					compacted: {
						text: planned.compacted.text,
						source: planned.compacted.model ?? "an extension",
					},
				}
			: {}),
	});
	return {
		text,
		details: {
			strategy: VERBATIM_COMPACTION_STRATEGY,
			promptVersion: VERBATIM_COMPACTION_PROMPT_VERSION,
			parameters: planned.preparation.parameters,
			stats: stats(planned, text),
			form: planned.compacted ? "compacted" : "cleared",
			...(planned.compacted ? { backend: planned.compacted.backend } : {}),
			...(planned.compacted?.model ? { model: planned.compacted.model } : {}),
			...(planned.fallbackReason ? { fallbackReason: planned.fallbackReason } : {}),
			history,
			historyAccess: planned.access,
		},
	};
}

function fallbackReasonText(error: Error | string, apiKey: string | undefined): string {
	const message = typeof error === "string" ? error : error.message || error.name;
	return redactCredentialShapes(apiKey ? message.replaceAll(apiKey, "[redacted]") : message);
}

/**
 * Run the configured compactor model once over the current context window. Returns its text, or the reason it could
 * not be used; a cancel of the compaction itself throws.
 */
async function runCompactor(
	session: AgentSession,
	selection: { fullId: string; model: { provider: string; id: string; baseUrl?: string } },
	pathEntries: SessionEntry[],
	preparation: VerbatimCompactionPreparation,
	signal: AbortSignal,
	reason: VerbatimCompactionApplyOptions["reason"],
): Promise<{ compacted: CompactedReplacement; usage?: Usage } | { fallbackReason: string }> {
	let apiKey: string | undefined;
	// Stopping the request (Escape, `abortCompaction()`) clears the context instead; a cancel of the compaction itself
	// (a takeover, closing the session) still cancels.
	const stop = new AbortController();
	session._compactorAbortController = stop;
	try {
		apiKey = (
			await session._modelRuntime.getAuth(selection.model.provider, {
				signal: AbortSignal.any([signal, stop.signal]),
			})
		)?.auth.apiKey;
		stop.signal.throwIfAborted();
		const messages: AgentMessage[] = buildSessionProjection(pathEntries).messages;
		const output = await requestCompactorOutput({
			apiKey,
			modelId: selection.model.id,
			...(selection.model.baseUrl ? { baseUrl: selection.model.baseUrl } : {}),
			messages: buildCompactorMessages(
				messages,
				(message) => message.role === "custom" && isVerbatimCompactionMessage(message),
			),
			query: preparation.parameters.query,
			signal,
			stop: stop.signal,
		});
		if (output.usage) session._emit({ type: "compaction_usage", reason, usage: output.usage });
		const oversized = oversizedCompactedText(session, output.text);
		if (oversized !== undefined) return { fallbackReason: oversized };
		return {
			compacted: { text: output.text, backend: "compactor", model: selection.fullId },
			...(output.usage ? { usage: output.usage } : {}),
		};
	} catch (error) {
		if (signal.aborted) throw new Error("Compaction cancelled");
		if (stop.signal.aborted) return { fallbackReason: "request aborted" };
		if (error instanceof CompactorFailure) return { fallbackReason: error.message };
		return { fallbackReason: fallbackReasonText(error instanceof Error ? error : String(error), apiKey) };
	} finally {
		if (session._compactorAbortController === stop) session._compactorAbortController = undefined;
	}
}

function oversizedCompactedText(session: AgentSession, text: string): string | undefined {
	const model = session.model;
	const trigger = model ? model.contextWindow - session.settingsManager.getCompactionSettings(model).reserveTokens : 0;
	const cap = compactedOutputTokenCap(trigger);
	const tokens = estimateTextTokens(text);
	return tokens > cap ? `output too long (${tokens} > ${cap} tokens)` : undefined;
}

function overflowingBoundary(
	session: AgentSession,
	planned: Pick<PlannedVerbatimCompaction, "tokensBefore" | "access" | "systemTokens" | "instructions" | "compacted">,
): string | undefined {
	const after = contextAfterBoundary(session, planned);
	return after.trigger !== undefined && after.tokens >= after.trigger
		? `output too long for the context (${after.tokens} > ${after.trigger} tokens)`
		: undefined;
}

/**
 * Estimated tokens of the context right after a boundary, and the automatic trigger: the system prompt plus the whole
 * boundary message, compacted text included. The trigger is undefined for a model with no known context window.
 */
function contextAfterBoundary(
	session: AgentSession,
	planned: Pick<PlannedVerbatimCompaction, "tokensBefore" | "access" | "systemTokens" | "instructions" | "compacted">,
): { tokens: number; trigger: number | undefined } {
	const boundary = buildBoundaryText(
		{
			sessionId: session.sessionManager.getSessionId(),
			tokensBefore: planned.tokensBefore,
			entriesBefore: 0,
			access: planned.access,
			...(planned.instructions ? { instructions: planned.instructions } : {}),
			...(planned.compacted
				? { compacted: { text: planned.compacted.text, source: planned.compacted.model ?? "an extension" } }
				: {}),
		},
		0,
	);
	const tokens = planned.systemTokens + estimateTextTokens(boundary);
	const model = session.model;
	if (!model || model.contextWindow <= 0) return { tokens, trigger: undefined };
	return { tokens, trigger: model.contextWindow - session.settingsManager.getCompactionSettings(model).reserveTokens };
}

/** The boundary message text an automatic clear writes when nothing replaces the earlier conversation. */
export function automaticBoundaryText(session: AgentSession): string {
	return buildBoundaryText(
		{
			sessionId: session.sessionManager.getSessionId(),
			tokensBefore: 0,
			entriesBefore: 0,
			access: historyAccess(session),
		},
		0,
	);
}

/** Whether the system prompt plus the boundary message stays below the automatic compaction trigger. */
function fitsBelowTrigger(
	session: AgentSession,
	planned: Pick<PlannedVerbatimCompaction, "tokensBefore" | "access" | "systemTokens" | "instructions" | "compacted">,
): boolean {
	const { tokens, trigger } = contextAfterBoundary(session, planned);
	return trigger === undefined || tokens < trigger;
}

function ignoredModelReason(configured: string, reason: "chat" | "classifier" | "unknown"): string {
	return reason === "unknown"
		? `compaction model ${configured} is not available`
		: `${configured} is a ${reason} model, not a compactor`;
}

/**
 * Decide one compaction of `pathEntries` without changing the session: the extension hook, then the configured
 * compactor, if any. No chat model is called. Returns undefined when nothing is in context since the last boundary.
 */
export async function planVerbatimCompaction(
	this: AgentSession,
	options: Omit<VerbatimCompactionApplyOptions, "backupLabel">,
	pathEntries: SessionEntry[],
): Promise<PlannedVerbatimCompaction | undefined> {
	assertCompactionOpen(this);
	if (!this.model) throw new Error(formatNoModelSelectedMessage());
	const signal = options.abortController.signal;
	signal.throwIfAborted();
	const settings = this.settingsManager.getCompactionSettings(this.model);
	const instructions = options.query?.trim() || undefined;
	const preparation = prepareCompactionBoundary(
		pathEntries,
		settings,
		instructions ? { query: instructions } : {},
		this.sessionManager.getBranch(),
	);
	if (!preparation) return undefined;
	const systemMessage = getCurrentSystemMessage(buildSessionProjection(pathEntries).messages);
	const base = {
		firstKeptEntryId: null,
		tokensBefore: preparation.tokensBefore,
		preparation,
		...(instructions ? { instructions } : {}),
		access: historyAccess(this),
		systemTokens: systemMessage ? estimateTokens(systemMessage) : 0,
		...(options.coveredThroughEntryId ? { coveredThroughEntryId: options.coveredThroughEntryId } : {}),
	} satisfies Partial<PlannedVerbatimCompaction>;
	// An automatic clear that cannot bring the context below the trigger would only destroy context and fire again.
	if (options.reason !== "manual" && !fitsBelowTrigger(this, base)) return undefined;

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
			signal,
		} satisfies SessionBeforeCompactEvent)) as SessionBeforeCompactResult | undefined;
		assertCompactionOpen(this);
		if (signal.aborted) throw new Error("Compaction cancelled");
		if (hookResult?.cancel) {
			options.abortController.abort();
			throw new Error("Compaction cancelled");
		}
		// Empty or whitespace text is no override: the configured form runs instead (#4977).
		if (hookResult?.compactedText !== undefined && hookResult.compactedText.trim().length > 0) {
			const compacted: CompactedReplacement = { text: hookResult.compactedText, backend: "extension" };
			const oversized =
				oversizedCompactedText(this, compacted.text) ?? overflowingBoundary(this, { ...base, compacted });
			if (oversized !== undefined)
				return { ...base, fallbackReason: `extension failed: ${oversized}`, fromExtension: false };
			options.onCompactionSource?.(true);
			return { ...base, compacted, fromExtension: true };
		}
	}

	const selection = resolveCompactionModel(
		options.compactionModel ?? this.settingsManager.getCompactionModel(),
		this._modelRuntime.getAllModels(),
	);
	if (selection.kind === "auto") {
		return {
			...base,
			...(selection.ignored
				? { fallbackReason: ignoredModelReason(selection.ignored.configured, selection.ignored.reason) }
				: {}),
			fromExtension: false,
		};
	}
	const outcome = await runCompactor(this, selection, pathEntries, preparation, signal, options.reason);
	assertCompactionOpen(this);
	if (signal.aborted) throw new Error("Compaction cancelled");
	if ("fallbackReason" in outcome) {
		return { ...base, fallbackReason: `${selection.fullId} failed: ${outcome.fallbackReason}`, fromExtension: false };
	}
	// The whole replacement, system prompt and recovery instructions included, must leave room below the trigger.
	const overflow = overflowingBoundary(this, { ...base, compacted: outcome.compacted });
	if (overflow !== undefined) {
		return {
			...base,
			fallbackReason: `${selection.fullId} failed: ${overflow}`,
			...(outcome.usage ? { usage: outcome.usage } : {}),
			fromExtension: false,
		};
	}
	return {
		...base,
		compacted: outcome.compacted,
		...(outcome.usage ? { usage: outcome.usage } : {}),
		fromExtension: false,
	};
}

/** A boundary entry that has been written but not yet announced. */
export interface AppendedVerbatimBoundary {
	readonly entryId: string;
	readonly text: string;
	readonly details: VerbatimCompactionDetails;
	readonly backupPath: string | undefined;
}

/**
 * Write the pre-compaction backup. The backup is best effort: a store that cannot write it (`ENOSPC`,
 * `EACCES`) still takes the boundary, which then records no backup path (#4977).
 */
async function writeBestEffortBackup(this: AgentSession, label: string): Promise<string | undefined> {
	try {
		return await this.sessionManager.writeBackupSnapshot(label);
	} catch (error) {
		reportDebug("storage", "compaction-backup-unwritable", {
			label,
			code: (error as NodeJS.ErrnoException | undefined)?.code,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

/**
 * Back up the session and append a planned compaction as one boundary. The boundary text, with the history entry
 * positions it advertises, is built inside the append's queued mutation. Nothing else changes, so a failure here leaves
 * history and the in-memory context as they were. `signal` is checked inside the mutation: the append is the commit
 * point, so a cancel that arrives before it leaves the session unchanged.
 */
export async function appendVerbatimBoundary(
	this: AgentSession,
	planned: PlannedVerbatimCompaction,
	options: { backupLabel: string; signal?: AbortSignal },
): Promise<AppendedVerbatimBoundary> {
	const backupPath = await writeBestEffortBackup.call(this, options.backupLabel);
	const { signal } = options;
	const sessionId = this.sessionManager.getSessionId();
	let built: { text: string; details: VerbatimCompactionDetails } | undefined;
	const entryId = await this.sessionManager.appendCompaction(
		(historyEntries) => {
			const boundary = buildPlannedBoundary(planned, sessionId, historyEntries);
			built = { text: boundary.text, details: { ...boundary.details, ...(backupPath ? { backupPath } : {}) } };
			return built;
		},
		null,
		planned.tokensBefore,
		buildPlannedBoundary(planned, sessionId, 0).details,
		planned.usage,
		planned.coveredThroughEntryId,
		signal
			? () => {
					if (signal.aborted) throw new Error("Compaction cancelled");
				}
			: undefined,
	);
	if (!built) throw new Error("Compaction boundary was not built");
	return { entryId, text: built.text, details: built.details, backupPath };
}

/** Refresh the in-memory context after an appended boundary and notify `session_compact` listeners. */
export async function finishVerbatimCommit(
	this: AgentSession,
	planned: PlannedVerbatimCompaction,
	appended: AppendedVerbatimBoundary,
	reason: "manual" | "threshold" | "overflow",
): Promise<VerbatimCompactionResult> {
	const { entryId, text, details, backupPath } = appended;
	if (planned.access === "session-history-tool") this._enableSessionHistoryTool();
	this._refreshFinalizedContext();
	const result: VerbatimCompactionResult = {
		compactedText: text,
		firstKeptEntryId: null,
		tokensBefore: planned.tokensBefore,
		stats: details.stats,
		parameters: details.parameters,
		promptVersion: VERBATIM_COMPACTION_PROMPT_VERSION,
		form: details.form,
		...(details.backend ? { backend: details.backend } : {}),
		...(details.model ? { model: details.model } : {}),
		...(details.fallbackReason ? { fallbackReason: details.fallbackReason } : {}),
		...(details.history ? { history: details.history } : {}),
		...(planned.usage ? { usage: planned.usage } : {}),
		...(backupPath ? { backupPath } : {}),
	};
	const compactionEntry = this.sessionManager.getEntry(entryId) as CompactionEntry<VerbatimCompactionDetails>;
	try {
		await this._extensionRunner.emit({
			type: "session_compact",
			reason,
			parameters: details.parameters,
			result,
			compactionEntry,
			fromExtension: planned.fromExtension,
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

export async function _applyVerbatimCompaction(
	this: AgentSession,
	options: VerbatimCompactionApplyOptions,
): Promise<VerbatimCompactionResult | undefined> {
	const branch = this.sessionManager.getBranch();
	// A boundary never separates a tool call from its result, and nothing replays after it: while a call still waits
	// for its result (a detached call's, #4580), no boundary is written. The continuation that records the result
	// clears the context instead, before its request.
	if (findUnansweredToolCall(branch, awaitedToolTurnEntryId(this)) !== undefined) {
		if (options.reason === "manual") throw new Error(PENDING_TOOL_CALL_MESSAGE);
		return undefined;
	}
	const covered = options.coveredThroughEntryId
		? branch.findIndex((entry) => entry.id === options.coveredThroughEntryId)
		: branch.length - 1;
	if (covered === -1) return undefined;
	const planned = await planVerbatimCompaction.call(this, options, branch.slice(0, covered + 1));
	if (!planned) return undefined;
	const appended = await appendVerbatimBoundary.call(this, planned, {
		backupLabel: options.backupLabel,
		signal: options.abortController.signal,
	});
	return finishVerbatimCommit.call(this, planned, appended, options.reason);
}

export async function emitSessionCompactFailed(
	session: AgentSession,
	event: Omit<SessionCompactFailedEvent, "type">,
): Promise<void> {
	if (session._extensionRunner?.hasHandlers("session_compact_failed")) {
		await session._extensionRunner.emit({ type: "session_compact_failed", ...event });
	}
}

function clearOwnedManualCompactionState(this: AgentSession, controller: AbortController): void {
	if (this._compactionAbortController !== controller) return;
	this._compactionAbortController = undefined;
	if (this._compactionReason === "manual") {
		this._compactionReason = undefined;
		this._compactionStartedAt = undefined;
	}
	// Lifecycle listeners run synchronously. Once the manual end event is
	// emitted, a new /compact must own a new run rather than join the settled one.
	this._manualCompactionPromise = undefined;
}

async function emitManualCompactionFailure(
	this: AgentSession,
	controller: AbortController,
	error: unknown,
	fromExtension: boolean,
): Promise<void> {
	const message = error instanceof Error ? error.message : String(error);
	const aborted = controller.signal.aborted;
	const errorMessage = aborted ? undefined : `Compaction failed: ${message}`;
	clearOwnedManualCompactionState.call(this, controller);
	this._emit({
		type: "compaction_end",
		reason: "manual",
		result: undefined,
		aborted,
		willRetry: false,
		errorMessage,
	});
	await emitSessionCompactFailed(this, {
		reason: "manual",
		errorMessage,
		aborted,
		willRetry: false,
		fromExtension,
	});
}

async function runOwnedManualCompaction(
	this: AgentSession,
	controller: AbortController,
	options: SessionCompactOptions,
): Promise<VerbatimCompactionResult> {
	this._compactionStartedAt = Date.now();
	this._emit({ type: "compaction_start", reason: "manual" });
	let fromExtension = false;
	try {
		controller.signal.throwIfAborted();
		if (!this.model) throw new Error(formatNoModelSelectedMessage());
		const result = await this._applyVerbatimCompaction({
			// Caller parameters are projected explicitly, so no extra runtime property survives. Removed options
			// such as `compression_ratio` and `preserve_recent` are accepted and ignored.
			...(options.query === undefined ? {} : { query: options.query }),
			...(options.compactionModel === undefined ? {} : { compactionModel: options.compactionModel }),
			abortController: controller,
			backupLabel: "compact",
			reason: "manual",
			onCompactionSource: (value) => {
				fromExtension = value;
			},
		});
		if (!result) throw new Error("Nothing to compact: the context holds nothing new since the last boundary");
		// compaction_end listeners synchronously flush queued prompts, so they must
		// observe an idle session before dispatching the next user turn.
		clearOwnedManualCompactionState.call(this, controller);
		this._emit({ type: "compaction_end", reason: "manual", result, aborted: false, willRetry: false });
		return result;
	} catch (error) {
		await emitManualCompactionFailure.call(this, controller, error, fromExtension);
		throw error;
	}
}

/**
 * Persist one compaction boundary: clear the context window, or replace it with a configured compactor's text.
 *
 * Re-entrancy safe: a call made while a manual compaction is still in flight
 * joins that run instead of starting a second one. Manual compaction aborts an
 * active agent run before it starts, while agent event delivery remains live so
 * a pending threshold check cannot race the requested manual boundary.
 */
export function compact(this: AgentSession, options: SessionCompactOptions = {}): Promise<VerbatimCompactionResult> {
	try {
		assertCompactionOpen(this);
	} catch (error) {
		return Promise.reject(error);
	}
	const inFlight = this._manualCompactionPromise;
	if (inFlight) return inFlight;

	// A manual boundary replaces the automatic turn that scheduled any pending
	// retry. Invalidate its timer before this run claims compaction ownership.
	this._postCompactionContinuationToken += 1;
	this._pendingPostCompactionContinuation = undefined;

	const automaticCompletion = this._autoCompactionCompletion;
	// The manual request wins. Abort the active automatic compaction now, before the
	// next microtask can admit a post-tool or threshold boundary, then wait for
	// its owner to settle before mutating the transcript ourselves. Start the
	// session abort before publishing this new manual owner so abort() cancels
	// prior work rather than cancelling or waiting on the compaction being started.
	this._autoCompactionAbortController?.abort();
	const abortBoundary = this.abort();

	const controller = new AbortController();
	this._compactionAbortController = controller;
	this._compactionReason = "manual";
	this._compactionStartedAt ??= Date.now();
	// Handle rejection now so a failing event drain cannot become unhandled
	// while an automatic run finishes.
	void abortBoundary.catch(() => {});
	let flight!: Promise<VerbatimCompactionResult>;
	// Start the owned run in a microtask so both single-flight fields are
	// published before any joiner can observe a partially claimed compaction.
	flight = trackSessionWork(this, () =>
		Promise.resolve().then(async () => {
			try {
				if (automaticCompletion !== undefined) await automaticCompletion;
				await abortBoundary;
			} catch (error) {
				// The abort drain can fail before compaction starts. Finish the
				// manual lifecycle so event consumers can release queued input.
				await emitManualCompactionFailure.call(this, controller, error, false);
				throw error;
			}
			assertCompactionOpen(this);
			return runOwnedManualCompaction.call(this, controller, options);
		}),
	).finally(() => {
		clearOwnedManualCompactionState.call(this, controller);
		if (this._manualCompactionPromise === flight) this._manualCompactionPromise = undefined;
	});
	this._manualCompactionPromise = flight;
	return flight;
}

export function abortCompaction(this: AgentSession): void {
	// While a compactor request runs, stopping it falls back to clearing the context rather than cancelling.
	const compactor = this._compactorAbortController;
	if (compactor !== undefined) {
		compactor.abort();
		return;
	}
	this._compactionAbortController?.abort();
	this._autoCompactionAbortController?.abort();
}
export function abortBranchSummary(this: AgentSession): void {
	this._branchSummaryAbortController?.abort();
}
export function _enableSessionHistoryTool(this: AgentSession): void {
	if (this._sessionHistoryToolEnabled) return;
	this._sessionHistoryToolEnabled = true;
	this._setActiveTools(this.getActiveToolNames());
}
export function setAutoCompactionEnabled(this: AgentSession, enabled: boolean): void {
	this.settingsManager.setCompactionEnabled(enabled);
}

export const agentSessionCompactionMethods = {
	_applyVerbatimCompaction,
	_enableSessionHistoryTool,
	compact,
	abortCompaction,
	abortBranchSummary,
	setAutoCompactionEnabled,
};
