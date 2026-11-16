import type { AssistantMessage, Usage } from "@bastani/atomic-ai/compat";
import type { CompactionEntry, SessionEntry } from "../../session-manager-types.ts";
import type {
	SessionCompactionPoint,
	SessionEntryRange,
	SessionHistoryTotals,
	SessionRecordHeader,
	SessionStateEntry,
	SessionStore,
	SessionTail,
	SessionUsageTotals,
} from "./types.js";
import { validateSessionText } from "./validation.js";

const LEAF_MOVE_TYPE = "atomic.leaf";
const TASK_COMPLETION_INTENT_TYPE = "task-completion-intent";
const TASK_COMPLETION_ACK_TYPE = "task-completion-ack";
const BACKGROUND_COMPACTION_RESULT_TYPE = "atomic:background-compaction-result";

/**
 * Entries `startSeq` through `endSeq` whose parent is not the entry stored just before each but `parentSeq`, the same
 * for all of them: a branch point, or a run of entries that start trees of their own.
 */
type ResumeJump = readonly [startSeq: number, endSeq: number, parentSeq: number];
/** A verbatim compaction boundary, with the seqs of its first kept and last covered entries, -1 when it has none. */
type ResumeCompaction = readonly [seq: number, firstKeptSeq: number, coveredSeq: number];

/**
 * What a store keeps about a session so that a resume reads its tail without its history (#5249): its branch points,
 * compaction boundaries, latest name and summary, open task completions and usage totals, all bounded by how often
 * those happen rather than by how long the session is. Parent seqs are -1 for an entry the session does not hold.
 */
export interface SessionResumeIndex {
	/** The last seq this index covers. */
	readonly seq: number;
	readonly lastId: string | null;
	/** The seq the session continues from; 0 before its first entry, -1 when a leaf move names no entry. */
	readonly leafSeq: number;
	readonly jumps: readonly ResumeJump[];
	readonly compactions: readonly ResumeCompaction[];
	readonly nameSeq?: number;
	readonly summarySeq?: number;
	/** Task completion intents without an acknowledgement, by completion id. */
	readonly intents: readonly (readonly [completionId: string, seq: number])[];
	/** The seqs of the entries that hold state, in increasing order, as base-36 differences joined by `.`. */
	readonly state: string;
	readonly lastStateSeq: number;
	readonly totals: SessionHistoryTotals;
	readonly latestAssistantSeq?: number;
}

const ZERO_USAGE: SessionUsageTotals = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });

export const EMPTY_SESSION_HISTORY_TOTALS: SessionHistoryTotals = Object.freeze({
	assistant: ZERO_USAGE,
	toolResult: ZERO_USAGE,
	summaries: ZERO_USAGE,
	userMessages: 0,
	assistantMessages: 0,
	toolResults: 0,
	totalMessages: 0,
	toolCalls: 0,
});

function addUsage(totals: SessionUsageTotals, usage: Usage, sign: 1 | -1): SessionUsageTotals {
	return {
		input: totals.input + sign * usage.input,
		output: totals.output + sign * usage.output,
		cacheRead: totals.cacheRead + sign * usage.cacheRead,
		cacheWrite: totals.cacheWrite + sign * usage.cacheWrite,
		cost: totals.cost + sign * usage.cost.total,
	};
}

/** `value` when it is usage a total can add: an index is written with every store write, so no entry may break it. */
function countedUsage(value: unknown): Usage | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const usage = value as Partial<Usage>;
	return [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.cost?.total].every(
		(part) => typeof part === "number" && Number.isFinite(part),
	)
		? (usage as Usage)
		: undefined;
}

/** `totals` with what `entry` adds to a session's usage figures, or with it taken away for a `sign` of -1. */
export function addEntryToHistoryTotals(
	totals: SessionHistoryTotals,
	entry: SessionEntry,
	sign: 1 | -1 = 1,
): SessionHistoryTotals {
	if (entry.type === "compaction" || entry.type === "branch_summary" || entry.type === "session_summary") {
		const usage = countedUsage(entry.usage);
		return usage ? { ...totals, summaries: addUsage(totals.summaries, usage, sign) } : totals;
	}
	if (entry.type !== "message" || entry.message === null || typeof entry.message !== "object") return totals;
	const message = entry.message;
	const counted = { ...totals, totalMessages: totals.totalMessages + sign };
	if (message.role === "user") return { ...counted, userMessages: counted.userMessages + sign };
	if (message.role === "toolResult") {
		const usage = countedUsage((message as { usage?: unknown }).usage);
		return {
			...counted,
			toolResults: counted.toolResults + sign,
			...(usage ? { toolResult: addUsage(counted.toolResult, usage, sign) } : {}),
		};
	}
	if (message.role !== "assistant") return counted;
	const assistant = message as AssistantMessage;
	const usage = countedUsage(assistant.usage);
	const toolCalls = Array.isArray(assistant.content)
		? assistant.content.filter((content) => content?.type === "toolCall").length
		: 0;
	return {
		...counted,
		assistantMessages: counted.assistantMessages + sign,
		toolCalls: counted.toolCalls + sign * toolCalls,
		...(usage ? { assistant: addUsage(counted.assistant, usage, sign) } : {}),
		...(sign === 1 && usage ? { latestAssistantUsage: usage } : {}),
	};
}

function isVerbatimCompaction(entry: SessionEntry): entry is CompactionEntry {
	return (
		entry.type === "compaction" &&
		(entry.details as { strategy?: unknown } | undefined)?.strategy === "verbatim-lines"
	);
}

function completionIdOf(entry: SessionEntry): string | undefined {
	if (entry.type !== "custom") return undefined;
	const completionId = (entry.data as { completionId?: unknown } | undefined)?.completionId;
	return typeof completionId === "string" ? completionId : undefined;
}

/**
 * Whether a resume can leave `entry` out when it comes before the tail it reads (#5249): messages other than system
 * messages, compactions, branch summaries, context edits and retired context compactions only give the history the
 * latest boundary replaces, and the index keeps their usage, the latest name and summary, and the task completions
 * still open. Background compaction results before the tail are covered by the boundary the tail starts from.
 */
export function isSessionHistoryEntry(entry: SessionEntry): boolean {
	switch (entry.type) {
		case "message":
			return entry.message.role !== "system";
		case "compaction":
		case "branch_summary":
		case "context_edit":
		case "context_compaction":
		case "session_info":
		case "session_summary":
			return true;
		case "custom":
			return (
				entry.customType === TASK_COMPLETION_INTENT_TYPE ||
				entry.customType === TASK_COMPLETION_ACK_TYPE ||
				entry.customType === BACKGROUND_COMPACTION_RESULT_TYPE
			);
		default:
			return false;
	}
}

/** Ids `entries` refer to that are neither in them nor the entry `previous` ends with: a store resolves them first. */
export function foreignResumeIds(previous: SessionResumeIndex, entries: readonly SessionEntry[]): string[] {
	const own = new Set(entries.map((entry) => entry.id));
	const foreign = new Set<string>();
	const note = (id: string | null | undefined) => {
		if (typeof id === "string" && !own.has(id) && id !== previous.lastId) foreign.add(id);
	};
	for (const entry of entries) {
		note(entry.parentId);
		if (isVerbatimCompaction(entry)) {
			note(entry.firstKeptEntryId);
			note(entry.coveredThroughEntryId);
		}
	}
	return [...foreign];
}

/**
 * The index of a session after `entries` are stored past `previous` (from scratch when undefined). `seqOf` gives the
 * seq of an earlier entry by id, for those {@link foreignResumeIds} names.
 */
export function foldSessionResume(
	previous: SessionResumeIndex | undefined,
	entries: readonly SessionEntry[],
	seqOf: (id: string) => number | undefined = () => undefined,
): SessionResumeIndex {
	let seq = previous?.seq ?? 0;
	let lastId = previous?.lastId ?? null;
	let leafSeq = previous?.leafSeq ?? 0;
	const jumps = [...(previous?.jumps ?? [])];
	const compactions = [...(previous?.compactions ?? [])];
	let nameSeq = previous?.nameSeq;
	let summarySeq = previous?.summarySeq;
	const intents = new Map(previous?.intents ?? []);
	let state = previous?.state ?? "";
	let lastStateSeq = previous?.lastStateSeq ?? 0;
	let totals = previous?.totals ?? EMPTY_SESSION_HISTORY_TOTALS;
	let latestAssistantSeq = previous?.latestAssistantSeq;
	const own = new Map<string, number>(lastId === null ? [] : [[lastId, seq]]);
	const resolve = (id: string | null | undefined): number =>
		typeof id === "string" ? (own.get(id) ?? seqOf(id) ?? -1) : -1;
	for (const entry of entries) {
		const parentSeq = entry.parentId === null ? 0 : resolve(entry.parentId);
		seq++;
		if (parentSeq !== seq - 1) {
			const last = jumps.at(-1);
			if (last !== undefined && last[1] === seq - 1 && last[2] === parentSeq)
				jumps[jumps.length - 1] = [last[0], seq, parentSeq];
			else jumps.push([seq, seq, parentSeq]);
		}
		leafSeq = entry.type === "custom" && entry.customType === LEAF_MOVE_TYPE ? parentSeq : seq;
		if (isVerbatimCompaction(entry)) {
			compactions.push([
				seq,
				entry.firstKeptEntryId === null ? -1 : resolve(entry.firstKeptEntryId),
				resolve(entry.coveredThroughEntryId),
			]);
		}
		if (entry.type === "session_info") nameSeq = seq;
		else if (entry.type === "session_summary") summarySeq = seq;
		else if (entry.type === "branch_summary") summarySeq = undefined;
		const completionId = completionIdOf(entry);
		if (completionId !== undefined && entry.type === "custom") {
			if (entry.customType === TASK_COMPLETION_INTENT_TYPE) intents.set(completionId, seq);
			else if (entry.customType === TASK_COMPLETION_ACK_TYPE) intents.delete(completionId);
		}
		if (!isSessionHistoryEntry(entry)) {
			const delta = (seq - lastStateSeq).toString(36);
			state = state === "" ? delta : `${state}.${delta}`;
			lastStateSeq = seq;
		}
		totals = addEntryToHistoryTotals(totals, entry);
		if (entry.type === "message" && entry.message?.role === "assistant" && countedUsage(entry.message.usage)) {
			latestAssistantSeq = seq;
		}
		own.set(entry.id, seq);
		lastId = entry.id;
	}
	return {
		seq,
		lastId,
		leafSeq,
		jumps,
		compactions,
		...(nameSeq !== undefined ? { nameSeq } : {}),
		...(summarySeq !== undefined ? { summarySeq } : {}),
		intents: [...intents],
		state,
		lastStateSeq,
		totals,
		...(latestAssistantSeq !== undefined ? { latestAssistantSeq } : {}),
	};
}

/** Whether `value` is an index this build wrote for a session whose last seq is `lastSeq`. */
export function isSessionResumeIndex(value: unknown, lastSeq: number): value is SessionResumeIndex {
	if (value === null || typeof value !== "object") return false;
	const index = value as Partial<SessionResumeIndex>;
	return (
		index.seq === lastSeq &&
		typeof index.leafSeq === "number" &&
		Array.isArray(index.jumps) &&
		Array.isArray(index.compactions) &&
		Array.isArray(index.intents) &&
		typeof index.state === "string" &&
		typeof index.lastStateSeq === "number" &&
		typeof index.totals === "object" &&
		index.totals !== null
	);
}

/** The seq ranges, newest first, of the branch that ends at `leafSeq`. */
export function branchRanges(index: SessionResumeIndex, leafSeq: number): (readonly [number, number])[] {
	const ranges: (readonly [number, number])[] = [];
	const jumps = index.jumps;
	let high = leafSeq;
	while (high > 0) {
		let lowest = 0;
		let found = -1;
		for (let top = jumps.length - 1; lowest <= top; ) {
			const middle = (lowest + top) >> 1;
			if (jumps[middle]![0] <= high) {
				found = middle;
				lowest = middle + 1;
			} else top = middle - 1;
		}
		if (found < 0) {
			ranges.push([1, high]);
			break;
		}
		const [, end, parentSeq] = jumps[found]!;
		if (high > end) {
			ranges.push([end + 1, high]);
			high = end;
			continue;
		}
		ranges.push([high, high]);
		if (parentSeq >= high) break;
		high = parentSeq;
	}
	return ranges;
}

function onBranch(ranges: readonly (readonly [number, number])[], seq: number): boolean {
	return ranges.some(([low, high]) => seq >= low && seq <= high);
}

/** The branch entry right after `seq`, which is on the branch, up to `limit`. */
function nextOnBranch(ranges: readonly (readonly [number, number])[], seq: number, limit: number): number {
	let next = limit;
	for (const [low, high] of ranges) {
		if (seq >= low && seq < high) return seq + 1;
		if (low > seq && low < next) next = low;
	}
	return next;
}

/** Where the latest compaction boundary on the branch to `leafSeq` is, by the rule `buildContextEntries` replays. */
export function latestCompactionOf(
	index: SessionResumeIndex,
	leafSeq: number,
): Omit<SessionCompactionPoint, "entry" | "leafId" | "lastSeq"> | undefined {
	if (leafSeq <= 0) return undefined;
	const ranges = branchRanges(index, leafSeq);
	for (let position = index.compactions.length - 1; position >= 0; position--) {
		const [seq, firstKept, covered] = index.compactions[position]!;
		if (seq > leafSeq || !onBranch(ranges, seq)) continue;
		const before = (candidate: number) => candidate > 0 && candidate < seq && onBranch(ranges, candidate);
		const firstKeptSeq = before(firstKept) ? firstKept : undefined;
		const coveredThroughSeq = before(covered) ? covered : undefined;
		const retainedStartSeq =
			firstKeptSeq ?? (coveredThroughSeq === undefined ? seq : nextOnBranch(ranges, coveredThroughSeq, seq));
		return {
			seq,
			...(firstKeptSeq !== undefined ? { firstKeptSeq } : {}),
			...(coveredThroughSeq !== undefined ? { coveredThroughSeq } : {}),
			retainedStartSeq,
		};
	}
	return undefined;
}

/**
 * The seqs before `fromSeq` whose entries a tail read returns as state, in increasing order: every entry that is not
 * history, and the latest name, summary and open task completion intents among the history.
 */
export function stateSeqsBefore(index: SessionResumeIndex, fromSeq: number): number[] {
	const retained = [index.nameSeq, index.summarySeq, ...index.intents.map(([, seq]) => seq)];
	const seqs = new Set(retained.filter((seq): seq is number => seq !== undefined && seq < fromSeq));
	let seq = 0;
	if (index.state !== "") {
		for (const delta of index.state.split(".")) {
			seq += Number.parseInt(delta, 36);
			if (seq >= fromSeq) break;
			seqs.add(seq);
		}
	}
	return [...seqs].sort((left, right) => left - right);
}

/** What the entries a tail read returns add to the session's totals, taken from the index's totals. */
export function omittedTotals(
	index: SessionResumeIndex,
	fromSeq: number,
	returned: Iterable<SessionEntry>,
): SessionHistoryTotals {
	let totals: SessionHistoryTotals = { ...index.totals };
	for (const entry of returned) totals = addEntryToHistoryTotals(totals, entry, -1);
	const { latestAssistantUsage: _latest, ...rest } = totals;
	return index.latestAssistantSeq !== undefined &&
		index.latestAssistantSeq < fromSeq &&
		index.totals.latestAssistantUsage !== undefined
		? { ...rest, latestAssistantUsage: index.totals.latestAssistantUsage }
		: rest;
}

/** A tail read built from the state entries a store selected and its index. */
export function sessionTailFrom(
	index: SessionResumeIndex,
	header: SessionRecordHeader,
	fromSeq: number,
	state: readonly { readonly seq: number; readonly entry: SessionEntry }[],
	entries: readonly SessionEntry[],
): SessionTail {
	const ranges = branchRanges(index, index.leafSeq);
	const stateEntries: SessionStateEntry[] = state.map(({ seq, entry }) => ({
		seq,
		entry,
		onBranch: onBranch(ranges, seq),
	}));
	return {
		header,
		fromSeq,
		entries,
		state: stateEntries,
		omitted: omittedTotals(index, fromSeq, [...state.map(({ entry }) => entry), ...entries]),
		lastSeq: index.seq,
	};
}

/** The tail read of a session a store holds whole (#5249). */
export function sessionTailOf(
	header: SessionRecordHeader,
	entries: readonly SessionEntry[],
	fromSeq: number,
	index = foldSessionResume(undefined, entries),
): SessionTail {
	const start = Math.max(1, fromSeq);
	const state = stateSeqsBefore(index, start).map((seq) => ({ seq, entry: entries[seq - 1]! }));
	return sessionTailFrom(index, header, start, state, entries.slice(start - 1));
}

/** The range read of a session a store holds whole (#5249). */
export function sessionRangeOf(entries: readonly SessionEntry[], startSeq: number, endSeq: number): SessionEntryRange {
	const start = Math.max(1, startSeq);
	return {
		startSeq: start,
		entries: endSeq < start ? [] : entries.slice(start - 1, Math.max(start - 1, endSeq)),
		lastSeq: entries.length,
	};
}

/** The latest compaction of a session a store holds whole (#5249). */
export function sessionCompactionOf(
	entries: readonly SessionEntry[],
	leafId?: string,
	index = foldSessionResume(undefined, entries),
): SessionCompactionPoint | undefined {
	let leafSeq = index.leafSeq;
	if (leafId !== undefined) {
		leafSeq = -1;
		for (let position = entries.length - 1; position >= 0; position--) {
			if (entries[position]!.id === leafId) {
				leafSeq = position + 1;
				break;
			}
		}
	}
	const point = latestCompactionOf(index, leafSeq);
	if (point === undefined) return undefined;
	return {
		...point,
		entry: entries[point.seq - 1] as CompactionEntry,
		leafId: entries[leafSeq - 1]!.id,
		lastSeq: entries.length,
	};
}

/** `store.readTail`, or the same read from a whole load on a store without it (#5249). */
export async function readSessionTail(store: SessionStore, sessionId: string, fromSeq: number): Promise<SessionTail> {
	if (store.readTail !== undefined) return store.readTail(sessionId, fromSeq);
	const { header, entries } = await store.load(sessionId);
	return sessionTailOf(header, entries, fromSeq);
}

/** `store.readRange`, or the same read from a whole load on a store without it (#5249). */
export async function readSessionRange(
	store: SessionStore,
	sessionId: string,
	startSeq: number,
	endSeq: number,
): Promise<SessionEntryRange> {
	if (store.readRange !== undefined) return store.readRange(sessionId, startSeq, endSeq);
	return sessionRangeOf((await store.load(sessionId)).entries, startSeq, endSeq);
}

/** `store.findLatestCompaction`, or the same lookup from a whole load on a store without it (#5249). */
export async function findSessionCompaction(
	store: SessionStore,
	sessionId: string,
	leafId?: string,
): Promise<SessionCompactionPoint | undefined> {
	if (store.findLatestCompaction !== undefined) return store.findLatestCompaction(sessionId, leafId);
	if (leafId !== undefined) validateSessionText("entry.id", leafId);
	return sessionCompactionOf((await store.load(sessionId)).entries, leafId);
}
