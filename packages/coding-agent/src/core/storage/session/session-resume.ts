import type { AssistantMessage, Usage } from "@bastani/atomic-ai/compat";
import { hash } from "fast-sha256";
import type { CompactionEntry, SessionEntry } from "../../session-manager-types.ts";
import {
	type CompletionProxyCheck,
	type LegacyCompletionTarget,
	legacyCompletionTarget,
	rememberEarlierCompletion,
} from "../../tasks/reopened-completion.js";
import { SessionConflictError } from "./errors.js";
import { SessionKeyDigests } from "./key-digests.js";
import type {
	SessionBranchPageCut,
	SessionBranchSpan,
	SessionChildAliases,
	SessionCompactionPoint,
	SessionEntryRange,
	SessionHistoryTotals,
	SessionRecordHeader,
	SessionResume,
	SessionSnapshotCut,
	SessionStateEntry,
	SessionStore,
	SessionStoredEntry,
	SessionTail,
	SessionUsageTotals,
} from "./types.js";
import { SESSION_HISTORY_PAGE_BYTES } from "./types.js";
import { validateSessionText } from "./validation.js";
import { yieldTurn } from "./yield-turn.js";

const LEAF_MOVE_TYPE = "atomic.leaf";
const TASK_COMPLETION_INTENT_TYPE = "task-completion-intent";
const TASK_COMPLETION_ACK_TYPE = "task-completion-ack";
const DELIVERY_OP_TYPE = "atomic-pooled-delivery-op";

type ResumeJump = readonly [startSeq: number, endSeq: number, parentSeq: number];
type ResumeCompaction = readonly [seq: number, firstKeptSeq: number, coveredSeq: number];
/** Rebuild older projections once to recover prior task aliases and the exact records named by active checkouts. */
const RESUME_INDEX_VERSION = 11;

type SnapshotHead = readonly [seq: number, snapshotId: string];
/**
 * The plain snapshot entries (no restore, unrestored or degraded record) a resume keeps of one checkout root on the
 * active branch: the first, which keeps the order roots appear in; the latest, which is what the checkout holds; and
 * the latest naming another snapshot than the latest, which ends a restore notice of that root as every one between
 * them would. Restore history entries are kept whole. Earlier entries are read from the archive on demand.
 */
export interface SnapshotHeads {
	readonly first: SnapshotHead;
	readonly latest: SnapshotHead;
	readonly other?: SnapshotHead;
}

export interface SessionResumeIndex {
	readonly version: typeof RESUME_INDEX_VERSION;
	readonly needsBranchRebuild?: boolean;
	readonly epoch: string;
	readonly latest: Readonly<Record<string, readonly number[]>>;
	readonly fields: Readonly<Record<string, readonly (readonly [number, readonly string[]])[]>>;
	readonly firstChildren: Readonly<Record<string, number>>;
	readonly childAliases: Readonly<Record<string, SessionChildAliases>>;
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
	/** Every plain snapshot entry (no restore, unrestored or degraded record), as deltas. */
	readonly snapshotRefs: string;
	readonly lastSnapshotRef: number;
	/** By checkout root, the plain snapshot entries of the active branch a resume keeps. */
	readonly snapshotHeads: Readonly<Record<string, SnapshotHeads>>;
	/** The snapshot ids the active branch's restore history names: its own and the ones it is degraded from. */
	readonly snapshotPins: readonly string[];
	/** The latest entry carrying each snapshot record, by snapshot id, on any branch. */
	readonly snapshotRecords: Readonly<Record<string, number>>;
	readonly totals: SessionHistoryTotals;
	readonly latestAssistantSeq?: number;
	/**
	 * Every entry an extension saved with `pi.appendEntry` (see {@link isExtensionCustomState}), on any branch. They
	 * remain history; a subagent fork copies those on its branch. Absent from an index an earlier build saved or
	 * extended, which a fork then compensates for by scanning.
	 */
	readonly extensionState?: readonly number[];
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

export function completionIdOf(entry: SessionEntry): string | undefined {
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
export function isBranchCustomState(customType: string | undefined): boolean {
	return customType !== undefined && BRANCH_CUSTOM_STATE_TYPES.has(customType);
}
/**
 * Custom entry types that Atomic and its bundled extensions write, or still read from older sessions. Every other
 * type is state an extension saved with `pi.appendEntry`, which a subagent fork copies from its branch as the
 * complete-branch copy did (#5500). A type missing here is copied too, so the list only limits what a fork copies.
 */
const ATOMIC_CUSTOM_TYPES = new Set([
	...BRANCH_CUSTOM_STATE_TYPES,
	LEAF_MOVE_TYPE,
	TASK_COMPLETION_INTENT_TYPE,
	TASK_COMPLETION_ACK_TYPE,
	DELIVERY_OP_TYPE,
	"atomic.fork-anchor",
	"atomic.share",
	"atomic.tool-output",
	"intercom_ask",
	"intercom_ask_settled",
	"intercom_control_error",
	"intercom_inbox",
	"intercom_inbox_handled",
	"intercom_received",
	"intercom_reply_wait",
	"intercom_result_error",
	"intercom_sent",
	"intercom_session_identity",
	"intercom_session_memberships",
	"resume_timings",
	"subagent-child",
	"subagent-slash-final-snapshot",
	"web-search-results",
	"workflow-stage-parked-tasks",
	"workflow.run.blocked",
	"workflow.run.end",
	"workflow.run.start",
	"workflow.stage.end",
	"workflow.stage.progress",
	"workflow.stage.start",
	"workspace_binding",
]);
export function isExtensionCustomState(customType: string | undefined): boolean {
	return !!customType && !ATOMIC_CUSTOM_TYPES.has(customType);
}
export function isSessionHistoryEntry(entry: SessionEntry): boolean {
	if (entry.type === "message") return entry.message?.role !== "system";
	if (entry.type === "custom") return !isBranchCustomState(entry.customType);
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
	| "childAliases"
	| "workflowStarts"
	| "admissions"
	| "delivered"
	| "deliveryOps"
	| "settled"
	| "pending"
	| "parks"
	| "intents"
	| "acks"
	| "snapshotHeads"
	| "snapshotPins"
>;
class ResumeProtocols {
	readonly latest: Record<string, readonly number[]>;
	readonly fields: Record<string, readonly (readonly [number, readonly string[]])[]>;
	readonly firstChildren: Record<string, number>;
	readonly childAliases: Record<string, SessionChildAliases>;
	readonly workflowStarts: Record<string, number>;
	readonly admissions: SessionKeyDigests;
	readonly delivered: Set<string>;
	readonly deliveryOps: Set<string>;
	readonly settled: Set<string>;
	readonly pending: Record<string, number>;
	readonly parks: Record<string, { seq: number; remaining: readonly string[]; notified: readonly number[] }>;
	readonly intents: Map<string, number>;
	readonly acks: (readonly [number, number])[];
	readonly snapshotHeads: Record<string, SnapshotHeads>;
	readonly snapshotPins: Set<string>;
	constructor(previous?: ResumeProtocolIndex) {
		this.latest = { ...previous?.latest };
		this.fields = { ...previous?.fields };
		this.firstChildren = { ...previous?.firstChildren };
		this.childAliases = { ...previous?.childAliases };
		this.workflowStarts = { ...previous?.workflowStarts };
		this.admissions = new SessionKeyDigests(previous?.admissions);
		this.delivered = new Set(previous?.delivered ?? []);
		this.deliveryOps = new Set(previous?.deliveryOps ?? []);
		this.settled = new Set(previous?.settled ?? []);
		this.pending = { ...previous?.pending };
		this.parks = { ...previous?.parks };
		this.intents = new Map(previous?.intents ?? []);
		this.acks = [...(previous?.acks ?? [])];
		this.snapshotHeads = { ...previous?.snapshotHeads };
		this.snapshotPins = new Set(previous?.snapshotPins ?? []);
	}
	keepLatest(key: string, seq: number): void {
		this.latest[key] = [seq];
	}
	/** A snapshot entry on the active branch. Restore history is kept whole; of the plain entries only the heads. */
	snapshot(entry: Extract<SessionEntry, { type: "worktree_snapshot" }>, seq: number): void {
		if (entry.restore || entry.unrestored || entry.degradedFrom) {
			this.snapshotPins.add(entry.snapshotId);
			// Chunked projections carry only whether an entry names one.
			if (typeof entry.degradedFrom === "string") this.snapshotPins.add(entry.degradedFrom);
			return;
		}
		const head: SnapshotHead = [seq, entry.snapshotId];
		const heads = this.snapshotHeads[entry.root];
		this.snapshotHeads[entry.root] =
			heads === undefined
				? { first: head, latest: head }
				: {
						first: heads.first,
						latest: head,
						...(heads.latest[1] !== entry.snapshotId
							? { other: heads.latest }
							: heads.other
								? { other: heads.other }
								: {}),
					};
		if (entry.captureMs != null) this.keepLatest(`snapshot-capture:${entry.root}`, seq);
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
		const aliasKey = JSON.stringify([text(record(data.owner).sessionId) ?? "", data.childId]);
		const prev = this.childAliases[aliasKey];
		const lastTask = Object.hasOwn(data, "taskId") ? text(data.taskId) : prev?.lastTask;
		const lastStatus = Object.hasOwn(data, "terminalStatus") ? text(data.terminalStatus) : prev?.lastStatus;
		if (lastTask !== undefined || lastStatus !== undefined) {
			const ids = prev?.taskIds ?? [],
				released = new Set(prev?.releasedTaskIds);
			if (lastTask !== undefined) {
				if (data.state === "terminal" && lastStatus === "released") released.add(lastTask);
				else released.delete(lastTask);
			}
			this.childAliases[aliasKey] = {
				taskIds: lastTask !== undefined && !ids.includes(lastTask) ? [...ids, lastTask] : ids,
				releasedTaskIds: [...released],
				lastTask,
				lastStatus,
			};
		}
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
		if (branchActive && typeof entry.stageAdmissionKey === "string" && entry.stageAdmissionKey.length)
			this.admissions.add(entry.stageAdmissionKey);
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
			childAliases: this.childAliases,
			workflowStarts: this.workflowStarts,
			admissions: this.admissions.serialize(),
			delivered: [...this.delivered],
			deliveryOps: [...this.deliveryOps],
			settled: [...this.settled],
			pending: this.pending,
			parks: this.parks,
			intents: [...this.intents],
			acks: this.acks,
			snapshotHeads: this.snapshotHeads,
			snapshotPins: [...this.snapshotPins],
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
	const key = Buffer.from(hash(Buffer.from(data.runId, "utf16le")).subarray(0, 16)).toString("hex");
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
): void {
	if (active && (entry.type === "model_change" || entry.type === "thinking_level_change"))
		protocols.keepLatest(`setting:${entry.type}`, seq);
	if (entry.type === "message" && entry.message?.role === "assistant") {
		if (modelTransition) protocols.keepLatest(`model-transition:${seq}`, seq);
		if (active) assistants.splice(0, assistants.length, seq);
	}
	protocols.apply(entry, seq, active);
	if (entry.type === "worktree_snapshot" && active) protocols.snapshot(entry, seq);
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
	for await (const page of pages) {
		for (const { entry, seq } of page)
			applyBranchState(protocols, assistants, entry, seq, onBranch(ranges, seq), transitions.has(seq));
	}
	return { ...index, ...protocols.serialize(), leafSeq, assistants };
}

/** Where the entries outside the conversation are, by kind, and the latest entry carrying each snapshot record. */
interface StatePositions {
	state: string;
	readonly universal: number[];
	lastStateSeq: number;
	settingsHistory: string;
	lastSettingSeq: number;
	snapshotRefs: string;
	lastSnapshotRef: number;
	readonly snapshotRecords: Record<string, number>;
}

function statePositions(previous?: Pick<SessionResumeIndex, keyof StatePositions>): StatePositions {
	return {
		state: previous?.state ?? "",
		universal: [...(previous?.universal ?? [])],
		lastStateSeq: previous?.lastStateSeq ?? 0,
		settingsHistory: previous?.settingsHistory ?? "",
		lastSettingSeq: previous?.lastSettingSeq ?? 0,
		snapshotRefs: previous?.snapshotRefs ?? "",
		lastSnapshotRef: previous?.lastSnapshotRef ?? 0,
		snapshotRecords: { ...previous?.snapshotRecords },
	};
}

function addStatePosition(positions: StatePositions, entry: SessionEntry, seq: number): void {
	const plainSnapshot =
		entry.type === "worktree_snapshot" && !entry.restore && !entry.unrestored && !entry.degradedFrom;
	if (entry.type === "worktree_snapshot" && entry.snapshot !== undefined)
		positions.snapshotRecords[entry.snapshotId] = seq;
	if (isSessionHistoryEntry(entry)) return;
	if (entry.type === "custom" && entry.customType.startsWith("event_subscription")) positions.universal.push(seq);
	// Model/effort history can be compacted to its effective settings. Every system loadout change
	// stays branch state: extensions synchronously restore their tool inventory from it on open.
	if (
		entry.type === "model_change" ||
		entry.type === "thinking_level_change" ||
		(entry.type === "message" &&
			entry.message.role === "system" &&
			!entry.message.toolsAdded &&
			!entry.message.toolsRemoved)
	) {
		const delta = (seq - positions.lastSettingSeq).toString(36);
		positions.settingsHistory = positions.settingsHistory === "" ? delta : `${positions.settingsHistory}.${delta}`;
		positions.lastSettingSeq = seq;
	} else if (plainSnapshot) {
		const delta = (seq - positions.lastSnapshotRef).toString(36);
		positions.snapshotRefs = positions.snapshotRefs === "" ? delta : `${positions.snapshotRefs}.${delta}`;
		positions.lastSnapshotRef = seq;
	} else {
		const delta = (seq - positions.lastStateSeq).toString(36);
		positions.state = positions.state === "" ? delta : `${positions.state}.${delta}`;
		positions.lastStateSeq = seq;
	}
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
	const positions = statePositions(previous);
	let totals = previous?.totals ?? EMPTY_SESSION_HISTORY_TOTALS;
	let latestAssistantSeq = previous?.latestAssistantSeq;
	// An index an earlier build saved does not list extension state, so extending it cannot either.
	const extensionState = previous === undefined ? [] : previous.extensionState && [...previous.extensionState];
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
		applyBranchState(protocols, assistants, entry, seq, branchActive, modelTransition);
		addStatePosition(positions, entry, seq);
		if (entry.type === "custom" && isExtensionCustomState(entry.customType)) extensionState?.push(seq);
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
		...positions,
		totals,
		...(latestAssistantSeq !== undefined ? { latestAssistantSeq } : {}),
		...(extensionState ? { extensionState } : {}),
	};
}

/** The index format the 0.9 releases save. Its successor is converted, never folded from every entry again. */
const UPGRADABLE_RESUME_INDEX_VERSION = 5;
/**
 * The format `sessionResumeUpgrade` produces. Any other current version disables the upgrade (a full rebuild
 * follows) until the upgrade is checked against that version's fold.
 */
const UPGRADED_RESUME_INDEX_VERSION = 11;

/** A version-5 index: admissions are keys, and the fields an upgrade derives are absent or in an older form. */
export type UpgradableSessionResumeIndex = Omit<
	SessionResumeIndex,
	| "version"
	| "admissions"
	| "childAliases"
	| "workflowStarts"
	| "settingsHistory"
	| "lastSettingSeq"
	| "snapshotRefs"
	| "lastSnapshotRef"
	| "snapshotHeads"
	| "snapshotPins"
	| "snapshotRecords"
> & { readonly version: typeof UPGRADABLE_RESUME_INDEX_VERSION; readonly admissions: readonly string[] };

const isObject = (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value);

/** The version-5 validity check, and the shape of each field an upgrade carries over. */
export function isUpgradableSessionResumeIndex(value: unknown, lastSeq: number): value is UpgradableSessionResumeIndex {
	if (!isObject(value) || RESUME_INDEX_VERSION !== UPGRADED_RESUME_INDEX_VERSION) return false;
	const index = value as Partial<UpgradableSessionResumeIndex>;
	return (
		index.version === UPGRADABLE_RESUME_INDEX_VERSION &&
		!index.needsBranchRebuild &&
		typeof index.epoch === "string" &&
		index.seq === lastSeq &&
		typeof index.leafSeq === "number" &&
		Array.isArray(index.jumps) &&
		Array.isArray(index.compactions) &&
		Array.isArray(index.intents) &&
		Array.isArray(index.acks) &&
		typeof index.state === "string" &&
		typeof index.lastStateSeq === "number" &&
		isObject(index.totals) &&
		isObject(index.latest) &&
		Array.isArray(index.admissions) &&
		index.admissions.every((key) => typeof key === "string") &&
		Array.isArray(index.delivered) &&
		Array.isArray(index.deliveryOps) &&
		Array.isArray(index.settled) &&
		isObject(index.pending) &&
		isObject(index.parks) &&
		Array.isArray(index.models) &&
		Array.isArray(index.assistants)
	);
}

/** Custom entries outside the branch state whose positions or records the upgrade derives again. */
const UPGRADED_CUSTOM_TYPES = new Set(["subagent-child", "workflow.run.start", "workflow.run.end"]);

/**
 * The entries a version-5 upgrade reads: every entry outside the conversation (`!isSessionHistoryEntry`: these
 * types, system messages, and the custom types of branch state) and the child and workflow-run records, which are
 * the other custom types here. A store may select a superset; the upgrade ignores the rest.
 */
export const RESUME_UPGRADE_SOURCES = {
	types: [...SESSION_STATE_TYPES],
	omittedCustomTypes: [...ATOMIC_CUSTOM_TYPES].filter(
		(key) => !BRANCH_CUSTOM_STATE_TYPES.has(key) && !UPGRADED_CUSTOM_TYPES.has(key),
	),
} as const;

function upgradeSource(entry: SessionEntry): boolean {
	return !isSessionHistoryEntry(entry) || (entry.type === "custom" && UPGRADED_CUSTOM_TYPES.has(entry.customType));
}

/**
 * Convert a version-5 index to this format from its sources (`RESUME_UPGRADE_SOURCES`) alone, as the first resume
 * after an upgrade; the result equals the index a fold of every entry builds. The conversation fields (topology,
 * totals, models, assistants, compactions) and the recovery protocols this version folds as version 5 did carry
 * over, and admission keys become digests. The rest is derived again from the sources: the child records and
 * aliases, open workflow runs, the active branch's settings and checkout snapshots, and the state positions.
 * Add the sources in sequence order, on any branch.
 */
export function sessionResumeUpgrade(previous: UpgradableSessionResumeIndex): {
	add(entry: SessionEntry, seq: number): void;
	finish(): SessionResumeIndex;
} {
	// A rebuild folds again with the final topology whenever the session has branched, as here.
	const ranges = previous.jumps.length === 0 ? undefined : branchRanges(previous, previous.leafSeq);
	const admissions = new SessionKeyDigests();
	for (const key of previous.admissions) admissions.add(key);
	const protocols = new ResumeProtocols({
		...previous,
		latest: Object.fromEntries(
			Object.entries(previous.latest).filter(([key]) => !/^(run|setting|snapshot-capture):/.test(key)),
		),
		fields: {},
		firstChildren: {},
		childAliases: {},
		workflowStarts: {},
		admissions: admissions.serialize(),
		snapshotHeads: {},
		snapshotPins: [],
	});
	const positions = statePositions();
	const extensionState: number[] = [];
	let lastSeq = 0;
	return {
		add(entry, seq) {
			if (seq <= lastSeq || seq > previous.seq) throw new RangeError(`Resume upgrade source ${seq} out of order`);
			lastSeq = seq;
			if (entry.type === "custom" && isExtensionCustomState(entry.customType)) extensionState.push(seq);
			if (!upgradeSource(entry)) return;
			// None of the sources is an assistant message or a protocol record the carried fields fold.
			applyBranchState(protocols, [], entry, seq, ranges === undefined || onBranch(ranges, seq), false);
			addStatePosition(positions, entry, seq);
		},
		finish() {
			return {
				version: RESUME_INDEX_VERSION,
				epoch: previous.epoch,
				...protocols.serialize(),
				models: previous.models,
				assistants: previous.assistants,
				seq: previous.seq,
				lastId: previous.lastId,
				leafSeq: previous.leafSeq,
				jumps: previous.jumps,
				compactions: previous.compactions,
				...(previous.nameSeq !== undefined ? { nameSeq: previous.nameSeq } : {}),
				...(previous.summarySeq !== undefined ? { summarySeq: previous.summarySeq } : {}),
				...positions,
				extensionState,
				totals: previous.totals,
				...(previous.latestAssistantSeq !== undefined ? { latestAssistantSeq: previous.latestAssistantSeq } : {}),
			};
		},
	};
}

export function isSessionResumeIndex(value: unknown, lastSeq: number): value is SessionResumeIndex {
	if (value === null || typeof value !== "object") return false;
	const index = value as Partial<SessionResumeIndex>;
	return (
		index.version === RESUME_INDEX_VERSION &&
		index.childAliases != null &&
		typeof index.childAliases === "object" &&
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
		typeof index.snapshotHeads === "object" &&
		index.snapshotHeads !== null &&
		Array.isArray(index.snapshotPins) &&
		typeof index.snapshotRecords === "object" &&
		index.snapshotRecords !== null &&
		typeof index.totals === "object" &&
		index.totals !== null &&
		Array.isArray(index.extensionState) &&
		index.extensionState.every((seq) => Number.isSafeInteger(seq) && seq > 0 && seq <= lastSeq)
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

/** Compatibility for the synchronous workflow resume scan: an in-flight run launched on an abandoned
 * branch still belongs to this session. Its end removes the position. Remove with the workflow extension. */
function legacyOffBranchWorkflowStarts(
	index: SessionResumeIndex,
	ranges: readonly (readonly [number, number])[],
): number[] {
	return Object.values(index.workflowStarts).filter((seq) => !onBranch(ranges, seq));
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
		...legacyOffBranchWorkflowStarts(index, ranges),
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
		...snapshotSeqs(index),
	];
	const seqs = new Set(retained.filter((seq): seq is number => seq !== undefined && seq < fromSeq));
	for (const at of index.extensionState ?? []) {
		if (at >= fromSeq) break;
		if (onBranch(ranges, at)) seqs.add(at);
	}
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
	if (!windowOnly) includeHistory(index.snapshotRefs);
	for (const [intentSeq, ackSeq] of index.acks) if (seqs.has(intentSeq) && ackSeq < fromSeq) seqs.add(ackSeq);
	return [...seqs].sort((left, right) => left - right);
}

/** The plain snapshot entries each checkout root keeps, and the entries holding the records they and the restore
 * history name. Every other snapshot record stays in the store, read on demand (#5554). */
function snapshotSeqs(index: SessionResumeIndex): number[] {
	const seqs: number[] = [];
	const ids = new Set(index.snapshotPins);
	for (const { first, latest, other } of Object.values(index.snapshotHeads)) {
		for (const [seq, id] of other ? [first, latest, other] : [first, latest]) {
			seqs.push(seq);
			ids.add(id);
		}
	}
	for (const id of ids) if (Object.hasOwn(index.snapshotRecords, id)) seqs.push(index.snapshotRecords[id]!);
	return seqs;
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
	if (store.readTail) return store.readTail(sessionId, fromSeq);
	const { header, entries, epoch } = await store.load(sessionId);
	return { ...sessionTailOf(header, entries, fromSeq), epoch };
}

export async function readSessionRange(
	store: SessionStore,
	sessionId: string,
	startSeq: number,
	endSeq: number,
	expectedEpoch?: string,
): Promise<SessionEntryRange> {
	if (store.readRange)
		return expectedEpoch === undefined
			? store.readRange(sessionId, startSeq, endSeq)
			: store.readRange(sessionId, startSeq, endSeq, expectedEpoch);
	const snapshot = await store.load(sessionId);
	const { assertSnapshotCut } = await import("./snapshot-history.js");
	assertSnapshotCut(snapshot, expectedEpoch, Math.min(endSeq, snapshot.lastSeq));
	return { ...sessionRangeOf(snapshot.entries, startSeq, endSeq), epoch: expectedEpoch ?? snapshot.epoch };
}

export async function findSessionCompaction(
	store: SessionStore,
	sessionId: string,
	leafId?: string,
): Promise<SessionCompactionPoint | undefined> {
	if (store.findLatestCompaction) return store.findLatestCompaction(sessionId, leafId);
	if (leafId !== undefined) validateSessionText("entry.id", leafId);
	const snapshot = await store.load(sessionId);
	return sessionCompactionOf(snapshot.entries, leafId);
}

export function childCatalogCut(index: SessionResumeIndex) {
	return {
		epoch: index.epoch,
		lastSeq: index.seq,
		aliases: index.childAliases,
		seqs: [
			...new Set([
				...Object.values(index.firstChildren),
				...Object.values(index.fields).flatMap((rows) => rows.map(([seq]) => seq)),
			]),
		].sort((a, b) => a - b),
	};
}

/**
 * Where the index locates the session's snapshot entries (#5554): its plain snapshot entries and its state entries, among
 * them every restore, unrestored or degraded snapshot entry, on the branch from `leafSeq` when one is given.
 */
export function snapshotCutOf(index: SessionResumeIndex, leafSeq?: number): SessionSnapshotCut {
	const ranges = leafSeq === undefined ? undefined : branchRanges(index, leafSeq);
	const positions = (deltas: string): number[] => {
		const seqs: number[] = [];
		let at = 0;
		if (deltas !== "")
			for (const delta of deltas.split(".")) {
				at += Number.parseInt(delta, 36);
				if (ranges === undefined || onBranch(ranges, at)) seqs.push(at);
			}
		return seqs;
	};
	const plain = positions(index.snapshotRefs);
	const state = positions(index.state);
	const seqs: number[] = [];
	for (let p = 0, s = 0; p < plain.length || s < state.length; ) {
		if (s === state.length || (p < plain.length && plain[p]! < state[s]!)) seqs.push(plain[p++]!);
		else seqs.push(state[s++]!);
	}
	return { epoch: index.epoch, lastSeq: index.seq, records: index.snapshotRecords, seqs };
}

/**
 * Which of `seqs` one `readSelectedPage` reads: the longest prefix (with `backward`, suffix) within
 * {@link SESSION_HISTORY_PAGE_BYTES}, or its first (last) entry alone, by reference, when that is larger. Rejects with
 * `SessionConflictError` when `seqs` are not ascending or name an entry past `lastSeq`, as a store finds when it holds
 * no entry there.
 */
export function selectedPagePlan(
	sessionId: string,
	seqs: readonly number[],
	lastSeq: number,
	bytesOf: (seq: number) => number,
	backward = false,
): { readonly seqs: readonly number[] } | { readonly oversized: { readonly seq: number; readonly bytes: number } } {
	for (const [position, seq] of seqs.entries())
		if (!Number.isSafeInteger(seq) || seq < 1 || seq > lastSeq || (position > 0 && seq <= seqs[position - 1]!))
			throw new SessionConflictError(sessionId, seqs.at(-1)!, lastSeq);
	const selected: number[] = [];
	let total = 0;
	for (let step = 0; step < seqs.length; step++) {
		const seq = seqs[backward ? seqs.length - 1 - step : step]!;
		const bytes = bytesOf(seq);
		if (selected.length === 0 && bytes > SESSION_HISTORY_PAGE_BYTES) return { oversized: { seq, bytes } };
		if (total + bytes > SESSION_HISTORY_PAGE_BYTES) break;
		total += bytes;
		selected.push(seq);
	}
	return { seqs: backward ? selected.reverse() : selected };
}

export function sessionResumePlan(index: SessionResumeIndex, leafSeq = index.leafSeq, deferChildren = false) {
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
	const candidates = deferChildren ? new Set(childCatalogCut(index).seqs) : undefined;
	const children = candidates ? state.filter((seq) => candidates.has(seq)) : [];
	return {
		leafSeq,
		compaction,
		branch,
		state: children.length ? state.filter((seq) => !candidates!.has(seq)) : state,
		children,
	};
}

/** The resume fold appends these pairs in acknowledgement sequence order. */
export function intentForAcknowledgement(index: SessionResumeIndex, ack: number): number | undefined {
	let low = 0;
	let high = index.acks.length - 1;
	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		const [intentSeq, ackSeq] = index.acks[mid]!;
		if (ackSeq === ack) return intentSeq;
		if (ackSeq < ack) low = mid + 1;
		else high = mid - 1;
	}
	return undefined;
}

/** A compaction can fall between intent and delivery. Keep just a display hint for the visible card, never bring an
 * acknowledged intent back into outbox recovery. The existing index pairs intent/ack positions across branches. */
function* earlierCompletionBatches(
	index: SessionResumeIndex,
	resume: SessionResume,
	isProxy?: CompletionProxyCheck,
): Generator<number[], void, readonly SessionStoredEntry[]> {
	const { branch, state, compaction } = resume;
	const first = branch[0]?.seq ?? 1;
	if (!compaction || first <= 1 || index.acks.length === 0) return;
	const wanted = new Map<string, { entry: SessionEntry; target: LegacyCompletionTarget }[]>();
	let visited = 0;
	for (const { entry, seq } of branch) {
		if (++visited % 1024 === 0) yield [];
		if (seq < compaction.retainedStartSeq || entry.type !== "custom_message") continue;
		const target = legacyCompletionTarget(entry, isProxy);
		if (target) {
			const group = wanted.get(target.id) ?? [];
			group.push({ entry, target });
			wanted.set(target.id, group);
		}
	}
	if (!wanted.size) return;
	const ranges = branchRanges(index, index.leafSeq);
	const knownAcks = new Map<number, string>();
	for (const rows of [branch, state])
		for (const { entry, seq } of rows) {
			if (++visited % 1024 === 0) yield [];
			if (entry.type !== "custom") continue;
			const id = completionIdOf(entry);
			if (id === undefined || !wanted.has(id)) continue;
			if (entry.customType === TASK_COMPLETION_INTENT_TYPE && onBranch(ranges, seq)) wanted.delete(id);
			if (entry.customType === TASK_COMPLETION_ACK_TYPE) knownAcks.set(seq, id);
		}
	// Only a loaded acknowledgement identifies which earlier intent to read. Don't search other receipts.
	if (!wanted.size || !knownAcks.size) return;
	let batch: number[] = [];
	let remaining = knownAcks.size;
	for (const [ack, id] of knownAcks) {
		const intent = wanted.has(id) ? intentForAcknowledgement(index, ack) : undefined;
		if (intent !== undefined && intent < first && onBranch(ranges, intent)) batch.push(intent);
		remaining--;
		if (batch.length < 16 && remaining % 1024 !== 0) continue;
		if (!batch.length && !remaining) return;
		for (const { entry } of yield batch) {
			if (entry.type !== "custom" || entry.customType !== TASK_COMPLETION_INTENT_TYPE) continue;
			const id = completionIdOf(entry);
			if (id === undefined) continue;
			for (const card of wanted.get(id) ?? [])
				rememberEarlierCompletion(resume.recovery, card.entry, card.target, entry.data, isProxy);
			wanted.delete(id);
		}
		if (!wanted.size) return;
		batch = [];
	}
}

/** Resolve old display evidence in the same store revision as the branch, without reading any intervening messages. */
export async function readEarlierCompletionIntents(
	index: SessionResumeIndex,
	resume: SessionResume,
	read: (seqs: number[]) => Promise<readonly SessionStoredEntry[] | undefined>,
): Promise<boolean> {
	const batches = earlierCompletionBatches(index, resume);
	let batch = batches.next();
	while (!batch.done) {
		// A damaged or unreadable old receipt must not make an otherwise readable conversation fail to open.
		const rows = batch.value.length ? await read(batch.value).catch(() => []) : [];
		if (!rows) return false;
		await yieldTurn();
		batch = batches.next(rows);
	}
	return true;
}

export function sessionResumeFrom(
	index: SessionResumeIndex,
	header: SessionRecordHeader,
	branch: readonly SessionStoredEntry[],
	state: readonly SessionStoredEntry[],
	leafId: string | null,
	deferred: readonly number[] = [],
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
		...(deferred.length
			? {
					deferredChildren: {
						positions: deferred.map((seq) => ({ seq, onBranch: onBranch(ranges, seq) })),
						aliases: index.childAliases,
					},
				}
			: {}),
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
	isProxy?: CompletionProxyCheck,
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
	const resume = sessionResumeFrom(selected, header, branch, state, leafSeq > 0 ? entries[leafSeq - 1]!.id : null);
	if (resume.compaction) {
		const batches = earlierCompletionBatches(selected, resume, isProxy);
		for (let batch = batches.next(); !batch.done; )
			batch = batches.next(batch.value.map((seq) => ({ seq, entry: entries[seq - 1]! })));
	}
	return resume;
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
