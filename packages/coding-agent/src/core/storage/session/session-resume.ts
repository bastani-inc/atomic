import type { AssistantMessage, Usage } from "@bastani/atomic-ai/compat";
import type { CompactionEntry, SessionEntry } from "../../session-manager-types.ts";
import type {
	SessionCompactionPoint,
	SessionEntryRange,
	SessionHistoryTotals,
	SessionRecordHeader,
	SessionResume,
	SessionStateEntry,
	SessionStore,
	SessionStoredEntry,
	SessionTail,
	SessionUsageTotals,
} from "./types.js";
import { validateSessionText } from "./validation.js";

const LEAF_MOVE_TYPE = "atomic.leaf";
const TASK_COMPLETION_INTENT_TYPE = "task-completion-intent";
const TASK_COMPLETION_ACK_TYPE = "task-completion-ack";

type ResumeJump = readonly [startSeq: number, endSeq: number, parentSeq: number];
type ResumeCompaction = readonly [seq: number, firstKeptSeq: number, coveredSeq: number];

export interface SessionResumeIndex {
	readonly version: 2;
	readonly needsBranchRebuild?: boolean;
	readonly epoch: string;
	readonly latest: Readonly<Record<string, readonly number[]>>;
	readonly fields: Readonly<Record<string, readonly (readonly [number, readonly string[]])[]>>;
	readonly models: readonly (readonly [number, string])[];
	readonly assistants: readonly number[];
	readonly admissions: readonly string[];
	readonly delivered: readonly string[];
	readonly pending: Readonly<Record<string, number>>;
	readonly parks: Readonly<
		Record<
			string,
			{ readonly seq: number; readonly remaining: readonly string[]; readonly notified: readonly number[] }
		>
	>;
	readonly seq: number;
	readonly lastId: string | null;
	readonly leafSeq: number;
	readonly jumps: readonly ResumeJump[];
	readonly compactions: readonly ResumeCompaction[];
	readonly nameSeq?: number;
	readonly summarySeq?: number;
	readonly intents: readonly (readonly [completionId: string, seq: number])[];
	readonly state: string;
	readonly universal: readonly number[];
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

function countedUsage(value: unknown): Usage | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const usage = value as Partial<Usage>;
	return [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.cost?.total].every(
		(part) => typeof part === "number" && Number.isFinite(part),
	)
		? (usage as Usage)
		: undefined;
}

export function addEntryToHistoryTotals(
	totals: SessionHistoryTotals,
	entry: SessionEntry,
	sign: 1 | -1 = 1,
): SessionHistoryTotals {
	if (entry.type === "usage") {
		const usage = countedUsage(entry.usage);
		return usage ? { ...totals, auxiliary: addUsage(totals.auxiliary ?? ZERO_USAGE, usage, sign) } : totals;
	}

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

export function isSessionHistoryEntry(entry: SessionEntry): boolean {
	return !(
		entry.type === "model_change" ||
		entry.type === "thinking_level_change" ||
		entry.type === "worktree_snapshot" ||
		(entry.type === "message" && entry.message?.role === "system") ||
		(entry.type === "custom" &&
			[
				"atomic.tool-deactivation",
				"codemode-store",
				"event_subscription",
				"event_subscription_processed",
				"event_subscription_child",
				"intercom_released_reply_wait",
			].includes(entry.customType))
	);
}

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
function text(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

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

export function foldSessionResume(
	previous: SessionResumeIndex | undefined,
	entries: readonly SessionEntry[],
	seqOf: (id: string) => number | undefined = () => undefined,
	activeSeq?: (seq: number) => boolean,
): SessionResumeIndex {
	if (previous === undefined && activeSeq === undefined && entries.length > 0) {
		const ids = new Map(entries.map((entry, i) => [entry.id, { entry, seq: i + 1 }]));
		const last = entries.at(-1)!;
		let leaf = last.type === "custom" && last.customType === LEAF_MOVE_TYPE ? last.parentId : last.id;
		const active = new Set<number>();
		while (leaf) {
			const held = ids.get(leaf);
			if (!held || active.has(held.seq)) break;
			active.add(held.seq);
			leaf = held.entry.parentId;
		}
		activeSeq = (seq) => active.has(seq);
	}
	const latest: Record<string, readonly number[]> = { ...previous?.latest };
	const fields: Record<string, readonly (readonly [number, readonly string[]])[]> = { ...previous?.fields };
	const models = [...(previous?.models ?? [])];
	const assistants = [...(previous?.assistants ?? [])];
	const admissions = new Set(previous?.admissions ?? []);
	const delivered = new Set(previous?.delivered ?? []);
	const pending: Record<string, number> = { ...previous?.pending };
	const parks: Record<string, { seq: number; remaining: readonly string[]; notified: readonly number[] }> = {
		...previous?.parks,
	};
	let seq = previous?.seq ?? 0;
	let lastId = previous?.lastId ?? null;
	let leafSeq = previous?.leafSeq ?? 0;
	const jumps = [...(previous?.jumps ?? [])];
	const compactions = [...(previous?.compactions ?? [])];
	let nameSeq = previous?.nameSeq;
	let summarySeq = previous?.summarySeq;
	const intents = new Map(previous?.intents ?? []);
	const universal = [...(previous?.universal ?? [])];
	let state = previous?.state ?? "";
	let lastStateSeq = previous?.lastStateSeq ?? 0;
	let totals = previous?.totals ?? EMPTY_SESSION_HISTORY_TOTALS;
	let latestAssistantSeq = previous?.latestAssistantSeq;
	let needsBranchRebuild = previous?.needsBranchRebuild ?? false;
	const own = new Map<string, number>(lastId === null ? [] : [[lastId, seq]]);
	const resolve = (id: string | null | undefined): number =>
		typeof id === "string" ? (own.get(id) ?? seqOf(id) ?? -1) : -1;
	const keepLatest = (key: string, at: number) => {
		latest[key] = [at];
	};
	const settle = (key: string) => {
		delete pending[key];
	};
	for (const entry of entries) {
		const data = record(
			entry.type === "custom" ? entry.data : entry.type === "custom_message" ? entry.details : undefined,
		);
		const parentSeq = entry.parentId === null ? 0 : resolve(entry.parentId);
		seq++;
		if (parentSeq !== seq - 1) {
			if (previous !== undefined && activeSeq === undefined) needsBranchRebuild = true;
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
		const branchActive = activeSeq?.(seq) ?? true;
		if (branchActive && entry.type === "message" && entry.message?.role === "toolResult")
			settle(`wait:${entry.message.toolCallId}`);
		const completionId = completionIdOf(entry);
		if (completionId !== undefined && entry.type === "custom") {
			if (entry.customType === TASK_COMPLETION_INTENT_TYPE) {
				intents.set(completionId, seq);
				const task = `${text(data.ownerId) ?? ""}/${text(data.taskId) ?? ""}`;
				for (const [key, park] of Object.entries(parks))
					if (park.remaining.includes(task)) {
						const remaining = park.remaining.filter((id) => id !== task);
						if (remaining.length === 0) delete parks[key];
						else parks[key] = { ...park, remaining, notified: [...park.notified, seq] };
					}
			} else if (entry.customType === TASK_COMPLETION_ACK_TYPE) intents.delete(completionId);
		}
		if (entry.type === "model_change") models.push([seq, `${entry.provider}/${entry.modelId}`]);
		if (entry.type === "message" && entry.message?.role === "assistant") {
			const key = `${entry.message.provider}/${entry.message.model}`;
			const ranges = branchRanges({ jumps }, parentSeq);
			const effective = models.findLast(([at]) => onBranch(ranges, at));
			if (effective?.[1] !== key) {
				models.push([seq, key]);
				keepLatest(`model-transition:${seq}`, seq);
			}
			if (branchActive) assistants.splice(0, assistants.length, seq);
		}
		if (entry.type === "label") keepLatest(`label:${entry.targetId}`, seq);
		if (entry.type === "custom") {
			const kind = entry.customType;
			if (branchActive && ["intercom_inbox", "intercom_received"].includes(kind)) {
				const message = record(data.message);
				if (message.expectsReply !== true && typeof message.replyTo === "string")
					pending[`reply:${message.replyTo}`] = seq;
			}
			if (kind === "intercom_session_identity" && !latest[`identity-first:${text(data.sessionId) ?? ""}`])
				keepLatest(`identity-first:${text(data.sessionId) ?? ""}`, seq);
			if (
				[
					"intercom_session_identity",
					"intercom_session_memberships",
					"workspace_binding",
					"subagent-slash-final-snapshot",
					"resume_timings",
					"web-search-results",
				].includes(kind)
			)
				keepLatest(`${kind}:${text(data.sessionId) ?? text(data.id) ?? ""}`, seq);
			if (
				kind === "subagent-child" &&
				data.version === 1 &&
				typeof data.childId === "string" &&
				typeof data.runId === "string" &&
				typeof data.index === "number" &&
				typeof data.agent === "string" &&
				typeof data.cwd === "string" &&
				(data.state === "running" || data.state === "terminal")
			) {
				const key = `${text(record(data.owner).sessionId) ?? ""}:${data.childId}`;
				const seen = new Set(Object.keys(data));
				const kept: (readonly [number, readonly string[]])[] = [[seq, [...seen]]];
				for (const [at, keys] of [...(fields[key] ?? [])].reverse()) {
					if (keys.some((k) => !seen.has(k))) {
						kept.push([at, keys]);
						for (const k of keys) seen.add(k);
					}
				}
				fields[key] = kept.reverse();
			}
			if (branchActive && kind === "intercom_inbox" && typeof record(data.message).id === "string") {
				const id = String(record(data.message).id);
				if (!delivered.has(id)) pending[`inbox:${id}`] = seq;
			}
			if (branchActive && (kind === "intercom_received" || kind === "intercom_inbox_handled")) {
				const id = text(data.messageId) ?? text(record(data.message).id);
				if (id) settle(`inbox:${id}`);
			}
			if (branchActive && kind === "intercom_ask" && typeof data.askId === "string")
				pending[`ask:${data.askId}`] = seq;
			if (branchActive && kind === "intercom_ask_settled" && typeof data.askId === "string") {
				settle(`ask:${data.askId}`);
				settle(`reply:${data.askId}`);
			}
			if (branchActive && kind === "intercom_sent" && typeof record(data.message).replyTo === "string")
				settle(`inbound:${record(data.message).replyTo}`);
			if (
				(kind === "workflow.run.start" || kind === "workflow.stage.start" || kind === "workflow.stage.end") &&
				typeof data.runId === "string"
			) {
				const key = `run:${data.runId}`;
				latest[key] = [...(latest[key] ?? []), seq];
			}
			if (kind === "workflow.run.end" && typeof data.runId === "string") delete latest[`run:${data.runId}`];
			if (branchActive && kind === "intercom_reply_wait" && typeof data.toolCallId === "string")
				pending[`wait:${data.toolCallId}`] = seq;
			if (kind === "workflow-stage-parked-tasks" && Array.isArray(data.tasks)) {
				const remaining = data.tasks.map((task) => {
					const held = record(task);
					return `${text(held.ownerId) ?? ""}/${text(held.taskId) ?? ""}`;
				});
				if (remaining.length > 0) parks[entry.id] = { seq, remaining, notified: [] };
			}
		}
		if (entry.type === "custom_message") {
			if (branchActive && entry.stageAdmissionKey) admissions.add(entry.stageAdmissionKey);
			const reconciled = text(data.protectedReconciliationOf);
			if (branchActive && reconciled) settle(`protected:${reconciled}`);
			if (branchActive && entry.protectedReconciliation) pending[`protected:${entry.id}`] = seq;
			if (entry.stageAdmissionKey && intents.has(entry.stageAdmissionKey))
				pending[`notice:${entry.stageAdmissionKey}`] = seq;
			if (branchActive && entry.customType === "blueprint-context") keepLatest("blueprint-context", seq);
			if (entry.customType === "subagent-slash-result") keepLatest(`slash:${text(data.requestId) ?? entry.id}`, seq);
			if (branchActive && entry.customType === "intercom_message") {
				const message = record(data.message);
				const id = text(message.id);
				if (id) {
					delivered.add(id);
					settle(`inbox:${id}`);
					if (message.expectsReply === true && data.historyOnly !== true) pending[`inbound:${id}`] = seq;
				}
				if (message.expectsReply !== true && typeof message.replyTo === "string")
					pending[`reply:${message.replyTo}`] = seq;
			}
		}
		if (entry.type === "custom" && entry.customType === TASK_COMPLETION_ACK_TYPE && completionId)
			settle(`notice:${completionId}`);
		if (!isSessionHistoryEntry(entry)) {
			if (
				(entry.type === "worktree_snapshot" && entry.snapshot !== undefined) ||
				(entry.type === "custom" && entry.customType.startsWith("event_subscription"))
			)
				universal.push(seq);
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
		version: 2,
		...(needsBranchRebuild ? { needsBranchRebuild: true } : {}),
		epoch: previous?.epoch ?? crypto.randomUUID(),
		latest,
		fields,
		models,
		assistants,
		admissions: [...admissions],
		delivered: [...delivered],
		pending,
		parks,
		seq,
		lastId,
		leafSeq,
		jumps,
		compactions,
		...(nameSeq !== undefined ? { nameSeq } : {}),
		...(summarySeq !== undefined ? { summarySeq } : {}),
		intents: [...intents],
		state,
		universal,
		lastStateSeq,
		totals,
		...(latestAssistantSeq !== undefined ? { latestAssistantSeq } : {}),
	};
}

export function isSessionResumeIndex(value: unknown, lastSeq: number): value is SessionResumeIndex {
	if (value === null || typeof value !== "object") return false;
	const index = value as Partial<SessionResumeIndex>;
	return (
		index.version === 2 &&
		!index.needsBranchRebuild &&
		typeof index.epoch === "string" &&
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

export function branchRanges(index: Pick<SessionResumeIndex, "jumps">, leafSeq: number): (readonly [number, number])[] {
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

function nextOnBranch(ranges: readonly (readonly [number, number])[], seq: number, limit: number): number {
	let next = limit;
	for (const [low, high] of ranges) {
		if (seq >= low && seq < high) return seq + 1;
		if (low > seq && low < next) next = low;
	}
	return next;
}

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

export function stateSeqsBefore(index: SessionResumeIndex, fromSeq: number): number[] {
	const ranges = branchRanges(index, index.leafSeq);
	const lastAssistant = index.assistants.findLast((at) => onBranch(ranges, at));
	const retained = [
		index.nameSeq,
		index.summarySeq,
		lastAssistant,
		...index.intents.map(([, seq]) => seq),
		...Object.entries(index.latest).flatMap(([key, seqs]) =>
			key.startsWith("model-transition:") ? seqs.filter((seq) => onBranch(ranges, seq)) : seqs,
		),
		...Object.values(index.fields).flatMap((items) => items.map(([at]) => at)),
		...Object.values(index.pending),
		...Object.values(index.parks).flatMap((park) => [park.seq, ...park.notified]),
	];
	const seqs = new Set(retained.filter((seq): seq is number => seq !== undefined && seq < fromSeq));
	let seq = 0;
	if (index.state !== "") {
		for (const delta of index.state.split(".")) {
			seq += Number.parseInt(delta, 36);
			if (seq >= fromSeq) break;
			if (onBranch(ranges, seq) || index.universal.includes(seq)) seqs.add(seq);
		}
	}
	return [...seqs].sort((left, right) => left - right);
}

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
		epoch: index.epoch,
		lastEntryId: index.lastId,
		seqs: entries.map((_, i) => fromSeq + i),
		fromSeq,
		entries,
		state: stateEntries,
		omitted: omittedTotals(index, fromSeq, [...state.map(({ entry }) => entry), ...entries]),
		lastSeq: index.seq,
	};
}

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

export function sessionRangeOf(entries: readonly SessionEntry[], startSeq: number, endSeq: number): SessionEntryRange {
	const start = Math.max(1, startSeq);
	return {
		startSeq: start,
		entries: endSeq < start ? [] : entries.slice(start - 1, Math.max(start - 1, endSeq)),
		lastSeq: entries.length,
	};
}

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

export async function readSessionTail(store: SessionStore, sessionId: string, fromSeq: number): Promise<SessionTail> {
	if (store.readTail !== undefined) return store.readTail(sessionId, fromSeq);
	const { header, entries } = await store.load(sessionId);
	return sessionTailOf(header, entries, fromSeq);
}

export async function readSessionRange(
	store: SessionStore,
	sessionId: string,
	startSeq: number,
	endSeq: number,
): Promise<SessionEntryRange> {
	if (store.readRange !== undefined) return store.readRange(sessionId, startSeq, endSeq);
	return sessionRangeOf((await store.load(sessionId)).entries, startSeq, endSeq);
}

export async function findSessionCompaction(
	store: SessionStore,
	sessionId: string,
	leafId?: string,
): Promise<SessionCompactionPoint | undefined> {
	if (store.findLatestCompaction !== undefined) return store.findLatestCompaction(sessionId, leafId);
	if (leafId !== undefined) validateSessionText("entry.id", leafId);
	return sessionCompactionOf((await store.load(sessionId)).entries, leafId);
}

export function sessionResumePlan(index: SessionResumeIndex, leafSeq = index.leafSeq) {
	const compaction = latestCompactionOf(index, leafSeq);
	const from =
		compaction === undefined
			? 1
			: Math.min(compaction.retainedStartSeq, compaction.coveredThroughSeq ?? compaction.retainedStartSeq);
	const ranges = branchRanges(index, leafSeq);
	const branch = ranges
		.map(([a, b]) => [Math.max(a, from), b] as const)
		.filter(([a, b]) => a <= b)
		.reverse();
	const inTail = (seq: number) => branch.some(([a, b]) => seq >= a && seq <= b);
	const state = stateSeqsBefore(index, Number.MAX_SAFE_INTEGER).filter((seq) => !inTail(seq));
	return { leafSeq, compaction, branch, state };
}

export function sessionResumeFrom(
	index: SessionResumeIndex,
	header: SessionRecordHeader,
	branch: readonly SessionStoredEntry[],
	state: readonly SessionStoredEntry[],
	leafId: string | null,
): SessionResume {
	const ranges = branchRanges(index, index.leafSeq);
	const plan = sessionResumePlan(index);
	const boundary =
		plan.compaction === undefined ? undefined : branch.find((held) => held.seq === plan.compaction!.seq)?.entry;
	const returned = [...state, ...branch].sort((a, b) => a.seq - b.seq);
	return {
		header,
		lastSeq: index.seq,
		lastEntryId: index.lastId,
		epoch: index.epoch,
		leafId,
		...(boundary?.type === "compaction" && plan.compaction && leafId
			? { compaction: { ...plan.compaction, entry: boundary, leafId, lastSeq: index.seq } }
			: {}),
		branch,
		state: state.map((held) => ({ ...held, onBranch: onBranch(ranges, held.seq) })),
		omitted: omittedTotals(
			index,
			branch[0]?.seq ?? index.seq + 1,
			returned.map((held) => held.entry),
		),
		recovery: { admissionKeys: index.admissions, intercomDeliveredIds: index.delivered },
	};
}

export function sessionResumeOf(
	header: SessionRecordHeader,
	entries: readonly SessionEntry[],
	leafId?: string,
	index = foldSessionResume(undefined, entries),
): SessionResume {
	const leafSeq = leafId === undefined ? index.leafSeq : entries.findLastIndex((e) => e.id === leafId) + 1;
	const ranges = branchRanges(index, leafSeq);
	const selected =
		leafSeq === index.leafSeq
			? index
			: {
					...foldSessionResume(
						undefined,
						entries,
						() => undefined,
						(seq) => onBranch(ranges, seq),
					),
					leafSeq,
					epoch: index.epoch,
				};
	const plan = sessionResumePlan(selected);
	const branch = plan.branch.flatMap(([a, b]) => entries.slice(a - 1, b).map((entry, i) => ({ seq: a + i, entry })));
	const state = plan.state.map((seq) => ({ seq, entry: entries[seq - 1]! }));
	return sessionResumeFrom(selected, header, branch, state, leafSeq > 0 ? entries[leafSeq - 1]!.id : null);
}

export function resumeIndexNeedsRefold(previous: SessionResumeIndex, entries: readonly SessionEntry[]): boolean {
	return entries.some((entry, i) => entry.parentId !== (i === 0 ? previous.lastId : entries[i - 1]!.id));
}
export function refoldSessionResume(
	previous: SessionResumeIndex,
	entries: readonly SessionEntry[],
): SessionResumeIndex {
	return { ...foldSessionResume(undefined, entries), epoch: previous.epoch };
}
