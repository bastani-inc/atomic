import { createHash } from "node:crypto";
import type { AssistantMessage, Usage } from "@bastani/atomic-ai/compat";
import type { CompactionEntry, SessionEntry } from "../../session-manager-types.ts";
import { SessionConflictError } from "./errors.js";
import { SessionKeyDigests } from "./key-digests.js";
import type {
	SessionBranchPageCut,
	SessionBranchSpan,
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

const LEAF_MOVE_TYPE = "atomic.leaf";
const TASK_COMPLETION_INTENT_TYPE = "task-completion-intent";
const TASK_COMPLETION_ACK_TYPE = "task-completion-ack";
const DELIVERY_OP_TYPE = "atomic-pooled-delivery-op";

type ResumeJump = readonly [startSeq: number, endSeq: number, parentSeq: number];
type ResumeCompaction = readonly [seq: number, firstKeptSeq: number, coveredSeq: number];
/** Version 8 carries snapshot record/restore presence when rebuilding from chunked session entries. */
const RESUME_INDEX_VERSION = 8;

export interface SessionResumeIndex {
	readonly version: typeof RESUME_INDEX_VERSION;
	readonly needsBranchRebuild?: boolean;
	readonly epoch: string;
	readonly latest: Readonly<Record<string, readonly number[]>>;
	readonly fields: Readonly<Record<string, readonly (readonly [number, readonly string[]])[]>>;
	readonly firstChildren: Readonly<Record<string, number>>;
	readonly workflowStarts: Readonly<Record<string, number>>;
	readonly models: readonly (readonly [number, string])[];
	readonly assistants: readonly number[];
	readonly admissions: string;
	readonly delivered: readonly string[];
	readonly deliveryOps: readonly string[];
	readonly settled: readonly string[];
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
	/**
	 * The acknowledgement of each acknowledged completion intent, on any branch. A resume that loads the intent loads
	 * its acknowledgement too, so a completion acknowledged on another branch is not delivered again.
	 */
	readonly acks: readonly (readonly [intentSeq: number, ackSeq: number])[];
	readonly state: string;
	readonly universal: readonly number[];
	readonly lastStateSeq: number;
	readonly settingsHistory: string;
	readonly lastSettingSeq: number;
	readonly snapshotRefs: string;
	readonly lastSnapshotRef: number;
	readonly hasRestoreHistory: boolean;
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
	return messageHistoryTotals(totals, entry, sign);
}
function messageHistoryTotals(totals: SessionHistoryTotals, entry: SessionEntry, sign: 1 | -1): SessionHistoryTotals {
	if (entry.type !== "message") return totals;
	if (entry.message === null || typeof entry.message !== "object") return totals;
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

const SESSION_STATE_TYPES = new Set(["model_change", "thinking_level_change", "worktree_snapshot"]);
const BRANCH_CUSTOM_STATE_TYPES = new Set([
	"atomic.tool-deactivation",
	"codemode-store",
	"event_subscription",
	"event_subscription_processed",
	"event_subscription_child",
	"intercom_released_reply_wait",
]);
export function isSessionHistoryEntry(entry: SessionEntry): boolean {
	if (entry.type === "message") return entry.message?.role !== "system";
	if (entry.type === "custom") return !BRANCH_CUSTOM_STATE_TYPES.has(entry.customType);
	return !SESSION_STATE_TYPES.has(entry.type);
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

function isLatestProtocol(kind: string, data: Record<string, unknown>, active: boolean): boolean {
	let valid = false;
	switch (kind) {
		case "intercom_session_identity":
			valid =
				typeof data.sessionId === "string" &&
				typeof data.intercomSessionId === "string" &&
				data.intercomSessionId.length > 0;
			break;
		case "intercom_session_memberships":
			valid =
				["sessionId", "homeGroup"].every((key) => typeof data[key] === "string") &&
				(data.groups === null ||
					(Array.isArray(data.groups) && data.groups.every((group) => typeof group === "string")));
			break;
		case "workspace_binding":
			valid = data.kind === "bound-workspace" && typeof data.worktree === "string";
			break;
		case "web-search-results": {
			const payload = data.type === "search" ? data.queries : data.type === "fetch" ? data.urls : undefined;
			valid =
				active &&
				typeof data.id === "string" &&
				data.id.length > 0 &&
				typeof data.timestamp === "number" &&
				Array.isArray(payload);
			break;
		}
		case "subagent-slash-final-snapshot":
		case "resume_timings":
			valid = active;
			break;
	}
	return valid;
}
function isChildState(data: Record<string, unknown>): boolean {
	return (
		data.version === 1 &&
		["childId", "runId", "agent", "cwd"].every((key) => typeof data[key] === "string") &&
		typeof data.index === "number" &&
		["running", "terminal"].includes(String(data.state))
	);
}
type ResumeProtocolIndex = Pick<
	SessionResumeIndex,
	| "latest"
	| "fields"
	| "firstChildren"
	| "workflowStarts"
	| "admissions"
	| "delivered"
	| "deliveryOps"
	| "settled"
	| "pending"
	| "parks"
	| "intents"
	| "acks"
>;
class ResumeProtocols {
	readonly latest: Record<string, readonly number[]>;
	readonly fields: Record<string, readonly (readonly [number, readonly string[]])[]>;
	readonly firstChildren: Record<string, number>;
	readonly workflowStarts: Record<string, number>;
	readonly admissions: SessionKeyDigests;
	readonly delivered: Set<string>;
	readonly deliveryOps: Set<string>;
	readonly settled: Set<string>;
	readonly pending: Record<string, number>;
	readonly parks: Record<string, { seq: number; remaining: readonly string[]; notified: readonly number[] }>;
	readonly intents: Map<string, number>;
	readonly acks: (readonly [number, number])[];
	constructor(previous?: ResumeProtocolIndex) {
		this.latest = { ...previous?.latest };
		this.fields = { ...previous?.fields };
		this.firstChildren = { ...previous?.firstChildren };
		this.workflowStarts = { ...previous?.workflowStarts };
		this.admissions = new SessionKeyDigests(previous?.admissions);
		this.delivered = new Set(previous?.delivered ?? []);
		this.deliveryOps = new Set(previous?.deliveryOps ?? []);
		this.settled = new Set(previous?.settled ?? []);
		this.pending = { ...previous?.pending };
		this.parks = { ...previous?.parks };
		this.intents = new Map(previous?.intents ?? []);
		this.acks = [...(previous?.acks ?? [])];
	}
	keepLatest(key: string, seq: number): void {
		this.latest[key] = [seq];
	}
	private keepPending(key: string, seq: number): void {
		if (this.settled.has(key)) return;
		this.latest[`pending:${key}`] = [...(this.latest[`pending:${key}`] ?? []), seq];
		this.pending[key] = seq;
	}
	private settle(key: string): void {
		if (!key.startsWith("notice:")) this.settled.add(key);
		delete this.latest[`pending:${key}`];
		delete this.pending[key];
	}
	private completion(entry: SessionEntry, seq: number, data: Record<string, unknown>): void {
		const completionId = completionIdOf(entry);
		if (completionId === undefined || entry.type !== "custom") return;
		if (entry.customType === TASK_COMPLETION_ACK_TYPE) {
			const intentSeq = this.intents.get(completionId);
			if (intentSeq !== undefined) this.acks.push([intentSeq, seq]);
			this.intents.delete(completionId);
			this.settle(`notice:${completionId}`);
		}
		if (entry.customType !== TASK_COMPLETION_INTENT_TYPE) return;
		this.intents.set(completionId, seq);
		this.settled.delete(`notice:${completionId}`);
		const task = `${text(data.ownerId) ?? ""}/${text(data.taskId) ?? ""}`;
		for (const [key, park] of Object.entries(this.parks)) {
			if (!park.remaining.includes(task)) continue;
			const remaining = park.remaining.filter((id) => id !== task);
			if (remaining.length === 0) delete this.parks[key];
			else this.parks[key] = { ...park, remaining, notified: [...park.notified, seq] };
		}
	}
	private custom(
		entry: Extract<SessionEntry, { type: "custom" }>,
		seq: number,
		data: Record<string, unknown>,
		branchActive: boolean,
	): void {
		const kind = entry.customType;
		if (branchActive && ["intercom_inbox", "intercom_received"].includes(kind)) {
			const message = record(data.message);
			if (message.expectsReply !== true && typeof message.replyTo === "string")
				this.keepPending(`reply:${message.replyTo}`, seq);
		}
		if (kind === "intercom_session_identity" && !this.latest[`identity-first:${text(data.sessionId) ?? ""}`])
			this.keepLatest(`identity-first:${text(data.sessionId) ?? ""}`, seq);
		const validLatest = isLatestProtocol(kind, data, branchActive);
		if (validLatest) this.keepLatest(`${kind}:${text(data.sessionId) ?? text(data.id) ?? ""}`, seq);
		if (kind === "subagent-child" && isChildState(data)) this.child(data, seq);
		if (kind === DELIVERY_OP_TYPE && typeof data.op === "string") this.deliveryOps.add(data.op);

		if (branchActive && kind === "intercom_inbox" && typeof record(data.message).id === "string") {
			const id = String(record(data.message).id);
			if (!this.delivered.has(id)) this.keepPending(`inbox:${id}`, seq);
		}
		if (branchActive && (kind === "intercom_received" || kind === "intercom_inbox_handled")) {
			const id = text(data.messageId);
			if (id) this.settle(`inbox:${id}`);
		}
		if (branchActive && kind === "intercom_ask" && typeof data.askId === "string")
			this.keepPending(`ask:${data.askId}`, seq);
		if (branchActive && kind === "intercom_ask_settled" && typeof data.askId === "string") {
			this.settle(`ask:${data.askId}`);
			this.settle(`reply:${data.askId}`);
		}
		if (branchActive && kind === "intercom_sent" && typeof record(data.message).replyTo === "string")
			this.settle(`inbound:${record(data.message).replyTo}`);
		updateWorkflowStarts(this.workflowStarts, entry, seq);
		if (branchActive && kind === "intercom_reply_wait" && typeof data.toolCallId === "string")
			this.keepPending(`wait:${data.toolCallId}`, seq);
		if (kind === "workflow-stage-parked-tasks" && Array.isArray(data.tasks)) {
			const remaining = data.tasks.map((task) => {
				const held = record(task);
				return `${text(held.ownerId) ?? ""}/${text(held.taskId) ?? ""}`;
			});
			if (remaining.length > 0) this.parks[`park:${entry.id}`] = { seq, remaining, notified: [] };
		}
	}
	private child(data: Record<string, unknown>, seq: number): void {
		const key = `${text(record(data.owner).sessionId) ?? ""}:${data.childId}`;
		if (this.firstChildren[key] === undefined) this.firstChildren[key] = seq;
		const seen = new Set(Object.keys(data));
		const kept: (readonly [number, readonly string[]])[] = [[seq, [...seen]]];
		for (const [at, keys] of [...(this.fields[key] ?? [])].reverse()) {
			if (keys.some((k) => !seen.has(k))) {
				kept.push([at, keys]);
				for (const k of keys) seen.add(k);
			}
		}
		this.fields[key] = kept.reverse();
	}
	private card(
		entry: Extract<SessionEntry, { type: "custom_message" }>,
		seq: number,
		data: Record<string, unknown>,
		branchActive: boolean,
	): void {
		if (branchActive && entry.stageAdmissionKey) this.admissions.add(entry.stageAdmissionKey);
		const reconciled = text(data.protectedReconciliationOf);
		if (branchActive && reconciled) this.settle(`protected:${reconciled}`);
		if (branchActive && entry.protectedReconciliation) this.keepPending(`protected:${entry.id}`, seq);
		if (entry.stageAdmissionKey && this.intents.has(entry.stageAdmissionKey))
			this.keepPending(`notice:${entry.stageAdmissionKey}`, seq);
		if (branchActive && entry.customType === "blueprint-context") this.keepLatest("blueprint-context", seq);
		if (entry.customType === "subagent-slash-result")
			this.keepLatest(`slash:${text(data.requestId) ?? entry.id}`, seq);
		if (branchActive && entry.customType === "intercom_message") {
			const message = record(data.message);
			const id = text(message.id);
			if (id) {
				this.delivered.add(id);
				this.settle(`inbox:${id}`);
				if (message.expectsReply === true && data.historyOnly !== true) this.keepPending(`inbound:${id}`, seq);
			}
			if (message.expectsReply !== true && typeof message.replyTo === "string")
				this.keepPending(`reply:${message.replyTo}`, seq);
		}
	}
	apply(entry: SessionEntry, seq: number, branchActive: boolean): void {
		const data = record(
			entry.type === "custom" ? entry.data : entry.type === "custom_message" ? entry.details : undefined,
		);
		if (branchActive && entry.type === "message" && entry.message?.role === "toolResult")
			this.settle(`wait:${entry.message.toolCallId}`);
		this.completion(entry, seq, data);
		if (entry.type === "label") this.keepLatest(`label:${entry.targetId}`, seq);
		if (entry.type === "custom") this.custom(entry, seq, data, branchActive);
		if (entry.type === "custom_message") this.card(entry, seq, data, branchActive);
	}
	serialize(): ResumeProtocolIndex {
		return {
			latest: this.latest,
			fields: this.fields,
			firstChildren: this.firstChildren,
			workflowStarts: this.workflowStarts,
			admissions: this.admissions.serialize(),
			delivered: [...this.delivered],
			deliveryOps: [...this.deliveryOps],
			settled: [...this.settled],
			pending: this.pending,
			parks: this.parks,
			intents: [...this.intents],
			acks: this.acks,
		};
	}
}

/** Positions of the latest valid starts which have no subsequent end. Workflow recovery only needs these
 * positions before it consults the run journal, not copies of stage output and run input records. */
export function updateWorkflowStarts(open: Record<string, number>, entry: SessionEntry, seq: number): void {
	if (
		entry.type !== "custom" ||
		(entry.customType !== "workflow.run.start" && entry.customType !== "workflow.run.end")
	)
		return;
	const data = record(entry.data);
	if (typeof data.runId !== "string") return;
	const key = createHash("sha256").update(data.runId, "utf16le").digest("hex").slice(0, 32);
	if (entry.customType === "workflow.run.end") delete open[key];
	else if (typeof data.name === "string" && typeof data.ts === "number") open[key] = seq;
}

function applyBranchState(
	protocols: ResumeProtocols,
	assistants: number[],
	entry: SessionEntry,
	seq: number,
	active: boolean,
	modelTransition: boolean,
): boolean {
	if (active && (entry.type === "model_change" || entry.type === "thinking_level_change"))
		protocols.keepLatest(`setting:${entry.type}`, seq);
	if (entry.type === "message" && entry.message?.role === "assistant") {
		if (modelTransition) protocols.keepLatest(`model-transition:${seq}`, seq);
		if (active) assistants.splice(0, assistants.length, seq);
	}
	protocols.apply(entry, seq, active);
	if (entry.type !== "worktree_snapshot" || !active) return false;
	if (entry.restore || entry.unrestored || entry.degradedFrom) return true;
	protocols.keepLatest(`snapshot-ref:${JSON.stringify([entry.root, entry.snapshotId])}`, seq);
	if (entry.captureMs != null) protocols.keepLatest(`snapshot-capture:${entry.root}`, seq);
	return false;
}

/** Select another leaf without changing the saved index. Topology and billing do not depend on the selected
 * branch. Fold only recovery state again; the supplied pages never collect the prior conversation. */
export async function selectResumeLeaf(
	index: SessionResumeIndex,
	leafSeq: number,
	pages: AsyncIterable<readonly SessionStoredEntry[]>,
): Promise<SessionResumeIndex> {
	const protocols = new ResumeProtocols();
	const assistants: number[] = [];
	const ranges = branchRanges(index, leafSeq);
	const transitions = new Set(index.models.map(([seq]) => seq));
	let hasRestoreHistory = false;
	for await (const page of pages) {
		for (const { entry, seq } of page) {
			if (applyBranchState(protocols, assistants, entry, seq, onBranch(ranges, seq), transitions.has(seq)))
				hasRestoreHistory = true;
		}
	}
	return { ...index, ...protocols.serialize(), leafSeq, assistants, hasRestoreHistory };
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
	const protocols = new ResumeProtocols(previous);
	const models = [...(previous?.models ?? [])];
	const assistants = [...(previous?.assistants ?? [])];
	let seq = previous?.seq ?? 0;
	let lastId = previous?.lastId ?? null;
	let leafSeq = previous?.leafSeq ?? 0;
	const jumps = [...(previous?.jumps ?? [])];
	const compactions = [...(previous?.compactions ?? [])];
	let nameSeq = previous?.nameSeq;
	let summarySeq = previous?.summarySeq;
	const universal = [...(previous?.universal ?? [])];
	let state = previous?.state ?? "";
	let lastStateSeq = previous?.lastStateSeq ?? 0;
	let settingsHistory = previous?.settingsHistory ?? "";
	let lastSettingSeq = previous?.lastSettingSeq ?? 0;
	let snapshotRefs = previous?.snapshotRefs ?? "";
	let lastSnapshotRef = previous?.lastSnapshotRef ?? 0;
	let hasRestoreHistory = previous?.hasRestoreHistory ?? false;
	let totals = previous?.totals ?? EMPTY_SESSION_HISTORY_TOTALS;
	let latestAssistantSeq = previous?.latestAssistantSeq;
	let needsBranchRebuild = previous?.needsBranchRebuild ?? false;
	const own = new Map<string, number>(lastId === null ? [] : [[lastId, seq]]);
	const resolve = (id: string | null | undefined): number =>
		typeof id === "string" ? (own.get(id) ?? seqOf(id) ?? -1) : -1;
	for (const entry of entries) {
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
		if (entry.type === "model_change") models.push([seq, `${entry.provider}/${entry.modelId}`]);
		let modelTransition = false;
		if (entry.type === "message" && entry.message?.role === "assistant") {
			const key = `${entry.message.provider}/${entry.message.model}`;
			const ranges = branchRanges({ jumps }, parentSeq);
			const effective = models.findLast(([at]) => onBranch(ranges, at));
			if (effective?.[1] !== key) {
				models.push([seq, key]);
				modelTransition = true;
			}
		}
		if (applyBranchState(protocols, assistants, entry, seq, branchActive, modelTransition)) hasRestoreHistory = true;
		const plainSnapshot =
			entry.type === "worktree_snapshot" && !entry.restore && !entry.unrestored && !entry.degradedFrom;
		if (!isSessionHistoryEntry(entry)) {
			if (
				(entry.type === "worktree_snapshot" && entry.snapshot !== undefined) ||
				(entry.type === "custom" && entry.customType.startsWith("event_subscription"))
			)
				universal.push(seq);
			if (
				entry.type === "model_change" ||
				entry.type === "thinking_level_change" ||
				(entry.type === "message" && entry.message.role === "system")
			) {
				const delta = (seq - lastSettingSeq).toString(36);
				settingsHistory = settingsHistory === "" ? delta : `${settingsHistory}.${delta}`;
				lastSettingSeq = seq;
			} else if (plainSnapshot && entry.type === "worktree_snapshot" && entry.snapshot === undefined) {
				const delta = (seq - lastSnapshotRef).toString(36);
				snapshotRefs = snapshotRefs === "" ? delta : `${snapshotRefs}.${delta}`;
				lastSnapshotRef = seq;
			} else {
				const delta = (seq - lastStateSeq).toString(36);
				state = state === "" ? delta : `${state}.${delta}`;
				lastStateSeq = seq;
			}
		}
		totals = addEntryToHistoryTotals(totals, entry);
		if (entry.type === "message" && entry.message?.role === "assistant" && countedUsage(entry.message.usage)) {
			latestAssistantSeq = seq;
		}
		own.set(entry.id, seq);
		lastId = entry.id;
	}
	return {
		version: RESUME_INDEX_VERSION,
		...(needsBranchRebuild ? { needsBranchRebuild: true } : {}),
		epoch: previous?.epoch ?? crypto.randomUUID(),
		...protocols.serialize(),
		models,
		assistants,
		seq,
		lastId,
		leafSeq,
		jumps,
		compactions,
		...(nameSeq !== undefined ? { nameSeq } : {}),
		...(summarySeq !== undefined ? { summarySeq } : {}),
		state,
		universal,
		lastStateSeq,
		settingsHistory,
		lastSettingSeq,
		snapshotRefs,
		lastSnapshotRef,
		hasRestoreHistory,
		totals,
		...(latestAssistantSeq !== undefined ? { latestAssistantSeq } : {}),
	};
}

export function isSessionResumeIndex(value: unknown, lastSeq: number): value is SessionResumeIndex {
	if (value === null || typeof value !== "object") return false;
	const index = value as Partial<SessionResumeIndex>;
	return (
		index.version === RESUME_INDEX_VERSION &&
		!index.needsBranchRebuild &&
		typeof index.admissions === "string" &&
		Array.isArray(index.deliveryOps) &&
		typeof index.epoch === "string" &&
		index.seq === lastSeq &&
		typeof index.leafSeq === "number" &&
		Array.isArray(index.jumps) &&
		Array.isArray(index.compactions) &&
		Array.isArray(index.intents) &&
		Array.isArray(index.acks) &&
		typeof index.state === "string" &&
		typeof index.lastStateSeq === "number" &&
		typeof index.settingsHistory === "string" &&
		typeof index.lastSettingSeq === "number" &&
		typeof index.snapshotRefs === "string" &&
		typeof index.lastSnapshotRef === "number" &&
		typeof index.hasRestoreHistory === "boolean" &&
		typeof index.totals === "object" &&
		index.totals !== null
	);
}

function branchJump(jumps: readonly ResumeJump[], high: number): number {
	let lowest = 0;
	let found = -1;
	for (let top = jumps.length - 1; lowest <= top; ) {
		const middle = (lowest + top) >> 1;
		if (jumps[middle]![0] <= high) {
			found = middle;
			lowest = middle + 1;
		} else top = middle - 1;
	}
	return found;
}

/** Find the contiguous run nearest the cursor. Only indices, never a stack of visited pages or message bodies,
 * cross a branch jump. Appends after the pinned leaf cannot become part of this walk. */
export function transcriptBranchSpan(
	sessionId: string,
	index: SessionResumeIndex,
	cut: SessionBranchPageCut,
): SessionBranchSpan | undefined {
	if ((cut.epoch !== undefined && cut.epoch !== index.epoch) || cut.leaf > index.seq)
		throw new SessionConflictError(sessionId, cut.leaf, index.seq);
	let newer = false;
	let candidate: SessionBranchSpan | undefined;
	for (let high = cut.leaf; high >= cut.first; ) {
		const jump = index.jumps[branchJump(index.jumps, high)];
		const low = !jump ? 1 : high > jump[1] ? jump[1] + 1 : high;
		const from = Math.max(cut.first, low),
			to = Math.min(cut.last, high);
		if (from <= to) {
			if (cut.backward) {
				if (candidate) return { ...candidate, older: true };
				if (from <= cut.pivot)
					candidate = { start: from, end: Math.min(to, cut.pivot), older: false, newer: newer || to > cut.pivot };
			} else {
				if (to < cut.pivot) return candidate && { ...candidate, older: true };
				candidate = { start: Math.max(from, cut.pivot), end: to, older: from < cut.pivot, newer };
				if (from < cut.pivot) return candidate;
			}
			newer = true;
		}
		const next = !jump ? 0 : high > jump[1] ? jump[1] : jump[2];
		if (next >= high) break;
		high = next;
	}
	return candidate;
}

export function branchRanges(index: Pick<SessionResumeIndex, "jumps">, leafSeq: number): (readonly [number, number])[] {
	const ranges: (readonly [number, number])[] = [];
	const jumps = index.jumps;
	let high = leafSeq;
	while (high > 0) {
		const found = branchJump(jumps, high);
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

export function stateSeqsBefore(index: SessionResumeIndex, fromSeq: number, windowOnly = false): number[] {
	const ranges = branchRanges(index, index.leafSeq);
	const lastAssistant = index.assistants.findLast((at) => onBranch(ranges, at));
	// Older senders put an empty replyTo on ordinary sends. Such a delivery can settle only an ask whose
	// actual ID was the empty string. Preserve that case, and any independently pending inbox/protected row.
	const omitEmptyReply = windowOnly && !Object.hasOwn(index.pending, "ask:");
	const retained = [
		index.nameSeq,
		index.summarySeq,
		lastAssistant,
		...index.intents.map(([, seq]) => seq),
		...Object.entries(index.latest).flatMap(([key, seqs]) => {
			if (omitEmptyReply && key === "pending:reply:") return [];
			return key.startsWith("model-transition:")
				? windowOnly
					? []
					: seqs.filter((seq) => onBranch(ranges, seq))
				: seqs;
		}),
		...Object.values(index.fields).flatMap((items) => items.map(([at]) => at)),
		...Object.values(index.firstChildren),
		...Object.entries(index.pending).flatMap(([key, seq]) => (omitEmptyReply && key === "reply:" ? [] : [seq])),
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
	const includeHistory = (deltas: string) => {
		if (!deltas) return;
		let at = 0;
		for (const delta of deltas.split(".")) {
			at += Number.parseInt(delta, 36);
			if (at >= fromSeq) break;
			if (onBranch(ranges, at)) seqs.add(at);
		}
	};
	if (!windowOnly) includeHistory(index.settingsHistory);
	if (!windowOnly || index.hasRestoreHistory) includeHistory(index.snapshotRefs);
	for (const [intentSeq, ackSeq] of index.acks) if (seqs.has(intentSeq) && ackSeq < fromSeq) seqs.add(ackSeq);
	return [...seqs].sort((left, right) => left - right);
}

export function omittedTotals(
	index: SessionResumeIndex,
	fromSeq: number,
	returned: Iterable<SessionEntry>,
	latestReturned = index.latestAssistantSeq !== undefined && index.latestAssistantSeq >= fromSeq,
): SessionHistoryTotals {
	let totals: SessionHistoryTotals = { ...index.totals };
	for (const entry of returned) totals = addEntryToHistoryTotals(totals, entry, -1);
	const { latestAssistantUsage: _latest, ...rest } = totals;
	return index.latestAssistantSeq !== undefined && !latestReturned && index.totals.latestAssistantUsage !== undefined
		? {
				...rest,
				latestAssistantUsage: index.totals.latestAssistantUsage,
				latestAssistantSeq: index.latestAssistantSeq,
			}
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
		omitted: omittedTotals(
			index,
			fromSeq,
			[...state.map(({ entry }) => entry), ...entries],
			(index.latestAssistantSeq !== undefined && index.latestAssistantSeq >= fromSeq) ||
				state.some((held) => held.seq === index.latestAssistantSeq),
		),
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
	if (!store.readTail) throw new TypeError(`Session store ${store.descriptor.adapter} must implement readTail`);
	return store.readTail(sessionId, fromSeq);
}

export async function readSessionRange(
	store: SessionStore,
	sessionId: string,
	startSeq: number,
	endSeq: number,
): Promise<SessionEntryRange> {
	if (!store.readRange) throw new TypeError(`Session store ${store.descriptor.adapter} must implement readRange`);
	return store.readRange(sessionId, startSeq, endSeq);
}

export async function findSessionCompaction(
	store: SessionStore,
	sessionId: string,
	leafId?: string,
): Promise<SessionCompactionPoint | undefined> {
	if (!store.findLatestCompaction)
		throw new TypeError(`Session store ${store.descriptor.adapter} must implement findLatestCompaction`);
	return store.findLatestCompaction(sessionId, leafId);
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
	// An intent in the tail keeps its acknowledgement, even one saved on another branch.
	const acks = index.acks.filter(([intentSeq, ackSeq]) => inTail(intentSeq) && !inTail(ackSeq));
	const state = [
		...new Set([
			...stateSeqsBefore(index, Number.MAX_SAFE_INTEGER, true).filter((seq) => !inTail(seq)),
			...acks.map(([, ackSeq]) => ackSeq),
		]),
	].sort((left, right) => left - right);
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
			returned.some((held) => held.seq === index.latestAssistantSeq),
		),
		recovery: {
			workflowStarts: index.workflowStarts,
			admissionDigests: index.admissions,
			intercomDeliveredIds: index.delivered,
			deliveryOpIds: index.deliveryOps,
		},
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
