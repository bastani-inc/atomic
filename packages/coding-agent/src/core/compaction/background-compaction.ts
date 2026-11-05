/**
 * Background compaction scheduling primitives (#4330).
 *
 * Pure functions over the active branch path. Positions are indices in that path, so a fork or a
 * branch taken before a result was stored never sees it, and the latest result that fits a position
 * wins. The compaction algorithm itself is unchanged; only when it runs and when its result is
 * committed is decided here.
 */

import type { Usage } from "@bastani/pi-ai/compat";
import type { CompactionEntry, CustomEntry, SessionEntry } from "../session-manager-types.ts";
import { SETTINGS_DEFAULTS } from "../settings-defaults.ts";
import {
	BackgroundCompactionConfigError,
	type BackgroundCompactionConfigSource,
	BackgroundCompactionDiscardedError,
	type BackgroundCompactionDiscardReason,
	type BackgroundCompactionError,
	rehydrateBackgroundCompactionError,
	type SerializedBackgroundCompactionError,
	serializeBackgroundCompactionError,
} from "./background-compaction-errors.ts";
import { VERBATIM_COMPACTION_STRATEGY, type VerbatimCompactionDetails } from "./compaction-types.js";

/**
 * Background compaction state of one session.
 *
 * - `idle`: nothing is running and no result waits for a commit.
 * - `running`: a task compacts the prefix through `upToEntryId`.
 * - `ready`: a stored result for `upToEntryId` waits for the next turn boundary.
 * - `failed`: the last task failed with `error`; history is unchanged and a later boundary retries.
 */
export type BackgroundCompactionStatus = "idle" | "running" | "ready" | "failed";

export interface BackgroundCompactionState {
	readonly state: BackgroundCompactionStatus;
	/** Last entry of the frozen prefix; absent while idle. */
	readonly upToEntryId?: string;
	/** ISO time the task started; absent while idle. */
	readonly startedAt?: string;
	/** Typed reason of a failed task; present only when `state` is `failed`. */
	readonly error?: BackgroundCompactionError;
}

/** `BackgroundCompactionState` as RPC and workflow status carry it. */
export interface SerializedBackgroundCompactionState {
	readonly state: BackgroundCompactionStatus;
	readonly upToEntryId?: string;
	readonly startedAt?: string;
	readonly error?: SerializedBackgroundCompactionError;
}

export const IDLE_BACKGROUND_COMPACTION_STATE: BackgroundCompactionState = Object.freeze({ state: "idle" });

export function serializeBackgroundCompactionState(
	state: BackgroundCompactionState,
): SerializedBackgroundCompactionState {
	return {
		state: state.state,
		...(state.upToEntryId === undefined ? {} : { upToEntryId: state.upToEntryId }),
		...(state.startedAt === undefined ? {} : { startedAt: state.startedAt }),
		...(state.error === undefined ? {} : { error: serializeBackgroundCompactionError(state.error) }),
	};
}

export function rehydrateBackgroundCompactionState(
	serialized: SerializedBackgroundCompactionState,
): BackgroundCompactionState {
	return {
		state: serialized.state,
		...(serialized.upToEntryId === undefined ? {} : { upToEntryId: serialized.upToEntryId }),
		...(serialized.startedAt === undefined ? {} : { startedAt: serialized.startedAt }),
		...(serialized.error === undefined ? {} : { error: rehydrateBackgroundCompactionError(serialized.error) }),
	};
}

/** The "compaction ready" wake for a session whose result is stored and waits for its next turn. */
export interface CompactionReadyWake {
	readonly sessionId: string;
	/** Session entry that stores the result. */
	readonly resultEntryId: string;
	readonly upToEntryId: string;
}

/**
 * Narrow wake interface for background compaction. The task never holds the agent: it stores its
 * result and calls `compactionReady`, and the agent applies the result at its next turn boundary.
 * Without a dispatcher the session notifies its own listeners in process.
 */
export interface CompactionWakeDispatcher {
	compactionReady(wake: CompactionReadyWake): void;
}

/** `customType` of the session entry that stores a finished background compaction until it is committed. */
export const BACKGROUND_COMPACTION_RESULT_TYPE = "atomic:background-compaction-result";

/** Default soft threshold, as a percentage of the context window. */
export const DEFAULT_BACKGROUND_COMPACTION_THRESHOLD_PERCENT: number =
	SETTINGS_DEFAULTS.compaction.backgroundThresholdPercent;

/** First retry delay after a failed background compaction; doubles per failure up to the cap. */
export const BACKGROUND_COMPACTION_RETRY_BASE_MS = 15_000;
export const BACKGROUND_COMPACTION_RETRY_MAX_MS = 15 * 60_000;

/** A finished compaction of the frozen prefix ending at `upToEntryId`, stored until a turn boundary commits it. */
export interface BackgroundCompactionResultRecord {
	readonly version: 1;
	/** Last entry of the frozen prefix. Entries after it are replayed unchanged after the commit. */
	readonly upToEntryId: string;
	readonly startedAt: string;
	readonly completedAt: string;
	readonly summary: string;
	readonly firstKeptEntryId: string | null;
	readonly tokensBefore: number;
	readonly details: VerbatimCompactionDetails;
	readonly usage?: Usage;
	readonly fromExtension: boolean;
}

/** A stored result selected for the current branch, with its path positions. */
export interface ReadyBackgroundCompaction {
	readonly entry: CustomEntry;
	readonly record: BackgroundCompactionResultRecord;
	/** Path index of `record.upToEntryId`. */
	readonly upToIndex: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate a stored record at the storage boundary; anything else is `malformed`. */
export function isBackgroundCompactionResultRecord(value: unknown): value is BackgroundCompactionResultRecord {
	if (!isRecord(value)) return false;
	const details = value.details;
	return (
		value.version === 1 &&
		typeof value.upToEntryId === "string" &&
		typeof value.startedAt === "string" &&
		typeof value.completedAt === "string" &&
		typeof value.summary === "string" &&
		value.summary.trim().length > 0 &&
		(value.firstKeptEntryId === null || typeof value.firstKeptEntryId === "string") &&
		typeof value.tokensBefore === "number" &&
		Number.isFinite(value.tokensBefore) &&
		typeof value.fromExtension === "boolean" &&
		(value.usage === undefined || isRecord(value.usage)) &&
		isRecord(details) &&
		details.strategy === VERBATIM_COMPACTION_STRATEGY &&
		isRecord(details.stats) &&
		isRecord(details.parameters) &&
		typeof details.rung === "string"
	);
}

function toolCallIds(entry: SessionEntry): string[] {
	if (entry.type !== "message" || entry.message.role !== "assistant" || !Array.isArray(entry.message.content))
		return [];
	return entry.message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []));
}

/** Entries that never end the trailing tool run: they contribute no model message. */
function isPassiveEntry(entry: SessionEntry): boolean {
	return (
		entry.type === "custom" ||
		entry.type === "label" ||
		entry.type === "model_change" ||
		entry.type === "thinking_level_change" ||
		entry.type === "usage" ||
		entry.type === "session_info" ||
		entry.type === "session_summary" ||
		entry.type === "context_edit"
	);
}

/**
 * Path index of the last entry a background task may freeze, or -1 when nothing is safe.
 *
 * Walks the trailing run of tool calls and tool results backwards, tracking which calls have a
 * result, and cuts before the earliest assistant message in that run with an unanswered call: it and
 * everything after it stay out of the prefix (infinity's `safe_spawn_point`). Any other message ends
 * the run. A safe point never lands on a label, which a branched copy drops.
 */
export function findBackgroundCompactionSafePoint(branch: readonly SessionEntry[]): number {
	const answered = new Set<string>();
	let safe = branch.length;
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (isPassiveEntry(entry)) continue;
		if (entry.type === "message" && entry.message.role === "toolResult") {
			answered.add(entry.message.toolCallId);
			continue;
		}
		const calls = toolCallIds(entry);
		if (calls.length === 0) break;
		if (calls.some((id) => !answered.has(id))) safe = index;
	}
	let last = safe - 1;
	while (last >= 0 && branch[last].type === "label") last--;
	return last;
}

function isVerbatimBoundary(entry: SessionEntry): entry is CompactionEntry<VerbatimCompactionDetails> {
	return (
		entry.type === "compaction" &&
		(entry.details as { strategy?: string } | undefined)?.strategy === VERBATIM_COMPACTION_STRATEGY
	);
}

/**
 * Path index of the last entry the latest compaction boundary covers, or -1 without one.
 * A foreground boundary covers everything before it; a committed background boundary covers through
 * its `coveredThroughEntryId`.
 */
export function coveredThroughIndex(
	branch: readonly SessionEntry[],
	indexById: ReadonlyMap<string, number> = indexBranch(branch),
): number {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (!isVerbatimBoundary(entry)) continue;
		const covered =
			entry.coveredThroughEntryId === undefined ? undefined : indexById.get(entry.coveredThroughEntryId);
		return covered !== undefined && covered < index ? covered : index - 1;
	}
	return -1;
}

function indexBranch(branch: readonly SessionEntry[]): Map<string, number> {
	return new Map(branch.map((entry, index) => [entry.id, index]));
}

/** Why a stored result cannot be committed on this branch, or undefined when it can. */
export function backgroundCompactionDiscardReason(
	branch: readonly SessionEntry[],
	resultIndex: number,
	indexById: ReadonlyMap<string, number> = indexBranch(branch),
): BackgroundCompactionDiscardReason | undefined {
	const entry = branch[resultIndex];
	if (entry?.type !== "custom" || !isBackgroundCompactionResultRecord(entry.data)) return "malformed";
	const record = entry.data;
	const upToIndex = indexById.get(record.upToEntryId);
	if (upToIndex === undefined || upToIndex >= resultIndex) return "off-branch";
	if (record.firstKeptEntryId !== null) {
		const keptIndex = indexById.get(record.firstKeptEntryId);
		if (keptIndex === undefined || keptIndex > upToIndex) return "off-branch";
	}
	if (upToIndex <= coveredThroughIndex(branch, indexById)) return "superseded";
	for (let index = upToIndex + 1; index < branch.length; index++) {
		const later = branch[index];
		if (later.type !== "context_edit") continue;
		const target = indexById.get(later.targetId);
		if (target !== undefined && target <= upToIndex) return "context-edited";
	}
	return undefined;
}

/**
 * The stored result to commit on this branch: among results on the path that still fit, the one
 * covering the latest position wins, and a tie goes to the later record.
 */
export function selectReadyBackgroundCompaction(
	branch: readonly SessionEntry[],
): ReadyBackgroundCompaction | undefined {
	const indexById = indexBranch(branch);
	let best: ReadyBackgroundCompaction | undefined;
	for (let index = 0; index < branch.length; index++) {
		const entry = branch[index];
		if (entry.type !== "custom" || entry.customType !== BACKGROUND_COMPACTION_RESULT_TYPE) continue;
		if (backgroundCompactionDiscardReason(branch, index, indexById) !== undefined) continue;
		const record = entry.data as BackgroundCompactionResultRecord;
		const upToIndex = indexById.get(record.upToEntryId) as number;
		if (best === undefined || upToIndex >= best.upToIndex) best = { entry, record, upToIndex };
	}
	return best;
}

/** The typed reason a known stored result was dropped, or undefined when it is still committable. */
export function discardedBackgroundCompaction(
	branch: readonly SessionEntry[],
	resultEntryId: string,
): BackgroundCompactionDiscardedError | undefined {
	const indexById = indexBranch(branch);
	const resultIndex = indexById.get(resultEntryId);
	if (resultIndex === undefined) return undefined;
	const reason = backgroundCompactionDiscardReason(branch, resultIndex, indexById);
	if (reason === undefined) return undefined;
	const entry = branch[resultIndex] as CustomEntry;
	const upToEntryId = isBackgroundCompactionResultRecord(entry.data) ? entry.data.upToEntryId : resultEntryId;
	return new BackgroundCompactionDiscardedError({ upToEntryId, reason });
}

/** Token count at which a background task starts for this window and percentage. */
export function backgroundCompactionThresholdTokens(contextWindow: number, thresholdPercent: number): number {
	return (contextWindow * thresholdPercent) / 100;
}

/** Whether context usage has passed the soft threshold. A window of 0 (unknown) never triggers. */
export function shouldStartBackgroundCompaction(
	contextTokens: number,
	contextWindow: number,
	thresholdPercent: number,
): boolean {
	return contextWindow > 0 && contextTokens > backgroundCompactionThresholdTokens(contextWindow, thresholdPercent);
}

/** Delay before retry `failures + 1` after `failures` consecutive failures: exponential, capped. */
export function backgroundCompactionRetryDelayMs(failures: number): number {
	if (failures <= 0) return 0;
	return Math.min(BACKGROUND_COMPACTION_RETRY_MAX_MS, BACKGROUND_COMPACTION_RETRY_BASE_MS * 2 ** (failures - 1));
}

/** `compaction.background`, or its default when unset; anything but a boolean is a typed config error. */
export function resolveBackgroundCompactionEnabled(value: unknown, source: BackgroundCompactionConfigSource): boolean {
	if (value === undefined) return SETTINGS_DEFAULTS.compaction.background;
	if (typeof value !== "boolean")
		throw new BackgroundCompactionConfigError({ source, field: "compaction.background", reason: "not-a-boolean" });
	return value;
}

/** `compaction.backgroundThresholdPercent`, or 75 when unset; it must be a number above 0 and below 100. */
export function resolveBackgroundCompactionThresholdPercent(
	value: unknown,
	source: BackgroundCompactionConfigSource,
): number {
	if (value === undefined) return DEFAULT_BACKGROUND_COMPACTION_THRESHOLD_PERCENT;
	const field = "compaction.backgroundThresholdPercent";
	if (typeof value !== "number" || !Number.isFinite(value))
		throw new BackgroundCompactionConfigError({ source, field, reason: "not-a-number" });
	if (value <= 0 || value >= 100) throw new BackgroundCompactionConfigError({ source, field, reason: "out-of-range" });
	return value;
}
