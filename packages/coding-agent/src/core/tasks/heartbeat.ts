import { taskOutputText } from "./command-output.js";
import type { NativeEvent, OwnerSnapshot, TaskId, TaskRecord } from "./contracts.js";
import {
	DEFAULT_TASK_HEARTBEAT_MS,
	formatTaskHeartbeat,
	isValidTaskHeartbeatMs,
	singleLine,
	TASK_HEARTBEAT_MESSAGE_TYPE,
	type TaskHeartbeatDetails,
	type TaskHeartbeatMessage,
	type TaskHeartbeatTask,
} from "./heartbeat-notice.js";
import {
	type OwnerLease,
	type TaskLease,
	type TaskSubscription,
	type TaskSupervisor,
	taskOwnTranscriptEntries,
} from "./supervisor.js";

export * from "./heartbeat-notice.js";

/** Tasks described in full by one notice; further due tasks are only listed. */
export const TASK_HEARTBEAT_DETAIL_LIMIT = 8;
/** Further due tasks listed by name in one notice; the rest are counted. */
export const TASK_HEARTBEAT_LIST_LIMIT = 20;
/** Boundaries due within this window (capped at a quarter cadence) join the notice that is going out. */
export const TASK_HEARTBEAT_COALESCE_MS = 60_000;
/** While the owner has not read the previous notice, due tasks wait and are rechecked this often. */
export const TASK_HEARTBEAT_RECHECK_MS = 30_000;
/** How often a running shell's output is sampled to date its last output. */
export const TASK_HEARTBEAT_OUTPUT_SAMPLE_MS = 30_000;
const OUTPUT_TAIL_BYTES = 2048;
const OUTPUT_TAIL_LINES = 6;
const LINE_CHARS = 160;
const TITLE_CHARS = 120;
/** Longest delay a host timer accepts before it overflows to an immediate fire. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Where an owner's heartbeats go. The host binds its own chat; nothing here is model-provided. */
export interface TaskHeartbeatDelivery {
	/** Cadence for tasks launched without their own `heartbeatMs`; `0` disables. */
	defaultIntervalMs(): number;
	/** Whether a heartbeat this owner already sent is still waiting, unread, in its chat. */
	hasUnreadHeartbeat(): boolean;
	deliver(message: TaskHeartbeatMessage): Promise<void>;
}

export interface TaskHeartbeatClock {
	now(): number;
	setTimeout(run: () => void, delayMs: number): object;
	clearTimeout(handle: object): void;
}

const systemClock: TaskHeartbeatClock = {
	now: () => Date.now(),
	setTimeout: (run, delayMs) => {
		const handle = setTimeout(run, delayMs);
		handle.unref();
		return handle;
	},
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface TaskHeartbeatMonitorOptions {
	supervisor: TaskSupervisor;
	owner: OwnerLease;
	/** Read on every use, so a replaced session's binding takes over the same owner. */
	delivery: () => TaskHeartbeatDelivery | undefined;
	clock?: TaskHeartbeatClock;
}

type Tracked = {
	taskId: TaskId;
	record: TaskRecord;
	/** First observed running: the anchor of the cadence. */
	startedAt: number;
	/** Frozen when the task is first observed; `0` disables. */
	intervalMs: number;
	/** Next boundary `startedAt + n × intervalMs`; absent when disabled. */
	nextAt?: number;
	lastActivityAt?: number;
	activityKey: string;
	/** Shells: retained output bytes observed so far. */
	outputEnd: bigint;
};

function activityKey(task: TaskRecord): string {
	return JSON.stringify([task.currentAction, task.metrics, task.attention, task.model]);
}

/** Whether the newest message in a child's history is an assistant turn whose tool calls have not returned yet. */
function endsInToolCall(entries: NonNullable<ReturnType<typeof taskOwnTranscriptEntries>>): boolean {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "message") continue;
		const message = entry.message;
		return message.role === "assistant" && message.content.some((block) => block.type === "toolCall");
	}
	return false;
}

/** First boundary on the `startedAt + n × intervalMs` series strictly after `after`. */
function nextBoundary(startedAt: number, intervalMs: number, after: number): number {
	const n = Math.max(1, Math.floor((after - startedAt) / intervalMs) + 1);
	const boundary = startedAt + n * intervalMs;
	return boundary > after ? boundary : startedAt + (n + 1) * intervalMs;
}

function byBoundary(a: Tracked, b: Tracked): number {
	const left = a.nextAt ?? Number.POSITIVE_INFINITY;
	const right = b.nextAt ?? Number.POSITIVE_INFINITY;
	if (left !== right) return left - right;
	return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
}

/**
 * Periodic "is this still making progress?" notices for one task owner's running shells and subagents.
 *
 * It follows the workflow heartbeat rules: boundaries are anchored at the task's start and never at the previous
 * delivery, missed boundaries are skipped rather than replayed, and only one notice per owner is outstanding. Unlike
 * a workflow run, an owner can have many tasks, so tasks due together share one bounded notice, and a task due while
 * the owner has not read the previous notice waits for it rather than losing its turn.
 */
export class TaskHeartbeatMonitor {
	private readonly options: TaskHeartbeatMonitorOptions;
	private readonly clock: TaskHeartbeatClock;
	private readonly tracked = new Map<TaskId, Tracked>();
	private subscription?: TaskSubscription;
	private timer?: object;
	/** The time the current timer wakes for, so an unchanged schedule keeps its timer. */
	private timerAt?: number;
	private busy = false;
	private disposed = false;
	private recheckAt?: number;
	private nextSampleAt?: number;

	constructor(options: TaskHeartbeatMonitorOptions) {
		this.options = options;
		this.clock = options.clock ?? systemClock;
	}

	/** Begin watching the owner. Idempotent. */
	start(): void {
		if (this.subscription || this.disposed) return;
		const watched = this.options.supervisor.watchOwnerTasks(this.options.owner);
		if (!watched.ok) return;
		this.subscription = watched.value;
		this.subscription.onReconcile = (snapshot, events) => this.reconcile(snapshot, events);
		this.reconcile(this.subscription.snapshot, []);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.subscription?.dispose();
		this.subscription = undefined;
		this.tracked.clear();
		this.disarm();
	}

	private reconcile(snapshot: OwnerSnapshot, events: readonly NativeEvent[]): void {
		if (this.disposed) return;
		if (snapshot.state !== "open") {
			if (snapshot.state === "closed") this.dispose();
			else {
				this.tracked.clear();
				this.disarm();
			}
			return;
		}
		const at = this.clock.now();
		const reported = new Set<TaskId>();
		for (const event of events) if (event.payload.kind === "task-activity") reported.add(event.payload.ref.taskId);
		const running = new Set<TaskId>();
		for (const task of snapshot.tasks) {
			// Queued, stopping, paused and finished tasks do not heartbeat.
			if (task.execution.kind !== "running") continue;
			const id = task.ref.taskId;
			running.add(id);
			const key = activityKey(task);
			const entry = this.tracked.get(id);
			if (entry) {
				entry.record = task;
				if (key !== entry.activityKey || reported.has(id)) {
					entry.activityKey = key;
					entry.lastActivityAt = at;
				}
				continue;
			}
			const intervalMs = this.resolveInterval(task);
			this.tracked.set(id, {
				taskId: id,
				record: task,
				startedAt: at,
				intervalMs,
				...(intervalMs > 0 ? { nextAt: at + intervalMs } : {}),
				...(reported.has(id) ? { lastActivityAt: at } : {}),
				activityKey: key,
				outputEnd: 0n,
			});
		}
		for (const id of [...this.tracked.keys()]) if (!running.has(id)) this.tracked.delete(id);
		if (!this.hasSampledShells()) this.nextSampleAt = undefined;
		else this.nextSampleAt ??= at + TASK_HEARTBEAT_OUTPUT_SAMPLE_MS;
		this.arm();
	}

	private resolveInterval(task: TaskRecord): number {
		if (task.heartbeatMs !== undefined) return isValidTaskHeartbeatMs(task.heartbeatMs) ? task.heartbeatMs : 0;
		try {
			const fallback = this.options.delivery()?.defaultIntervalMs();
			return isValidTaskHeartbeatMs(fallback) ? fallback : DEFAULT_TASK_HEARTBEAT_MS;
		} catch {
			return DEFAULT_TASK_HEARTBEAT_MS;
		}
	}

	private hasSampledShells(): boolean {
		for (const entry of this.tracked.values())
			if (entry.record.kind === "command" && entry.intervalMs > 0) return true;
		return false;
	}

	private disarm(): void {
		if (this.timer === undefined) return;
		this.clock.clearTimeout(this.timer);
		this.timer = undefined;
		this.timerAt = undefined;
	}

	private arm(): void {
		if (this.disposed || this.busy) {
			this.disarm();
			return;
		}
		// A blocked owner cannot receive anything before its recheck, however many tasks come due meanwhile.
		let wakeAt = this.recheckAt ?? Number.POSITIVE_INFINITY;
		if (this.recheckAt === undefined)
			for (const entry of this.tracked.values())
				if (entry.nextAt !== undefined && entry.nextAt < wakeAt) wakeAt = entry.nextAt;
		if (this.nextSampleAt !== undefined && this.nextSampleAt < wakeAt) wakeAt = this.nextSampleAt;
		// Activity reconciles many times a second; it rarely moves the next wake-up.
		if (this.timer !== undefined && this.timerAt === wakeAt) return;
		this.disarm();
		if (!Number.isFinite(wakeAt)) return;
		const delay = Math.min(Math.max(1, Math.ceil(wakeAt - this.clock.now())), MAX_TIMER_DELAY_MS);
		this.timerAt = wakeAt;
		this.timer = this.clock.setTimeout(() => {
			this.timer = undefined;
			this.timerAt = undefined;
			void this.wake();
		}, delay);
	}

	private async wake(): Promise<void> {
		if (this.disposed || this.busy) return;
		this.busy = true;
		try {
			const at = this.clock.now();
			if (this.nextSampleAt !== undefined && this.nextSampleAt <= at) {
				await this.sampleShellOutput(at);
				this.nextSampleAt = this.hasSampledShells() ? at + TASK_HEARTBEAT_OUTPUT_SAMPLE_MS : undefined;
			}
			await this.beat(at);
		} catch {
			// A failed check skips this boundary; the next one is already scheduled.
		} finally {
			this.busy = false;
			this.arm();
		}
	}

	private async beat(at: number): Promise<void> {
		if (this.recheckAt !== undefined && this.recheckAt > at) return;
		this.recheckAt = undefined;
		const entries = [...this.tracked.values()];
		if (!entries.some((entry) => entry.nextAt !== undefined && entry.nextAt <= at)) return;
		const delivery = this.options.delivery();
		let unread = false;
		try {
			unread = delivery?.hasUnreadHeartbeat() === true;
		} catch {
			unread = false;
		}
		if (unread) {
			// One outstanding notice per owner: due tasks stay owed and join the next notice instead of stacking.
			this.recheckAt = at + TASK_HEARTBEAT_RECHECK_MS;
			return;
		}
		const batch = entries
			.filter(
				(entry) =>
					entry.nextAt !== undefined &&
					entry.nextAt <= at + Math.min(TASK_HEARTBEAT_COALESCE_MS, entry.intervalMs / 4),
			)
			.sort(byBoundary);
		for (const entry of batch)
			entry.nextAt = nextBoundary(entry.startedAt, entry.intervalMs, Math.max(at, entry.nextAt ?? at));
		if (!delivery) return;
		const details = await this.describe(batch, at);
		// A task that finished while its notice was being prepared is no longer mentioned.
		const live = (taskId: string) => this.tracked.has(taskId as TaskId);
		details.tasks = details.tasks.filter((task) => live(task.taskId));
		details.more = details.more.filter((task) => live(task.taskId));
		details.moreCount = batch.slice(TASK_HEARTBEAT_DETAIL_LIMIT).filter((entry) => live(entry.taskId)).length;
		if (details.tasks.length === 0 || this.disposed) return;
		await delivery.deliver({
			customType: TASK_HEARTBEAT_MESSAGE_TYPE,
			content: formatTaskHeartbeat(details),
			display: true,
			details,
		});
	}

	private async describe(batch: readonly Tracked[], at: number): Promise<TaskHeartbeatDetails> {
		const detailed = batch.slice(0, TASK_HEARTBEAT_DETAIL_LIMIT);
		const rest = batch.slice(TASK_HEARTBEAT_DETAIL_LIMIT);
		const tasks: TaskHeartbeatTask[] = [];
		for (const entry of detailed) tasks.push(await this.describeTask(entry, at));
		return {
			scheduledAt: at,
			tasks,
			more: rest.slice(0, TASK_HEARTBEAT_LIST_LIMIT).map((entry) => ({
				taskId: entry.taskId,
				kind: entry.record.kind,
				title: singleLine(entry.record.title, TITLE_CHARS),
			})),
			moreCount: rest.length,
		};
	}

	private async describeTask(entry: Tracked, at: number): Promise<TaskHeartbeatTask> {
		const task = entry.record;
		const lease = this.lease(entry.taskId);
		const described: TaskHeartbeatTask = {
			taskId: entry.taskId,
			kind: task.kind,
			title: singleLine(task.title, TITLE_CHARS),
			...(task.agentName === undefined ? {} : { agentName: singleLine(task.agentName, TITLE_CHARS) }),
			...(task.kind === "agent" && task.model !== undefined ? { model: task.model } : {}),
			elapsedMs: Math.max(0, at - entry.startedAt),
			intervalMs: entry.intervalMs,
		};
		if (task.kind === "command" && lease) {
			const end = await this.observeOutput(entry, lease, at);
			if (end !== undefined) described.output = { bytes: Number(end), tail: await this.outputTail(lease, end) };
		}
		if (entry.lastActivityAt !== undefined) described.lastActivityAgoMs = Math.max(0, at - entry.lastActivityAt);
		if (task.kind === "agent") {
			const entries = lease ? taskOwnTranscriptEntries(lease) : undefined;
			if (task.currentAction)
				described.currentAction = {
					tool: singleLine(task.currentAction.tool, 60),
					text: singleLine(task.currentAction.text, LINE_CHARS),
					// The record keeps the last reported action after its tool returns. The child's own history says
					// whether a call is still outstanding: its last message is an assistant turn that called tools.
					running: entries !== undefined && endsInToolCall(entries),
				};
			if (task.metrics?.toolCount !== undefined) described.toolCount = task.metrics.toolCount;
			if (task.metrics?.tokenCount !== undefined) described.tokenCount = task.metrics.tokenCount;
			if (entries)
				described.turnCount = entries.filter(
					(item) => item.type === "message" && item.message.role === "assistant",
				).length;
		}
		if (task.attention.kind === "input-needed")
			described.attention = `waiting for input: ${singleLine(task.attention.prompt, LINE_CHARS)}`;
		else if (task.attention.kind === "no-recent-activity") described.attention = "no recent activity";
		return described;
	}

	private lease(taskId: TaskId): TaskLease | undefined {
		const found = this.options.supervisor.lookupTask(this.options.owner, taskId);
		return found.ok ? found.value : undefined;
	}

	private async sampleShellOutput(at: number): Promise<void> {
		for (const entry of [...this.tracked.values()]) {
			if (entry.record.kind !== "command" || entry.intervalMs === 0) continue;
			const lease = this.lease(entry.taskId);
			if (lease) await this.observeOutput(entry, lease, at);
		}
	}

	/** Current retained output size; growth since the last look dates the shell's last output. */
	private async observeOutput(entry: Tracked, lease: TaskLease, at: number): Promise<bigint | undefined> {
		const end = await findOutputEnd(this.options.supervisor, lease, entry.outputEnd);
		if (end === undefined) return undefined;
		if (end > entry.outputEnd) {
			entry.outputEnd = end;
			entry.lastActivityAt = at;
		}
		return end;
	}

	private async outputTail(lease: TaskLease, end: bigint): Promise<string[]> {
		if (end === 0n) return [];
		const start = end > BigInt(OUTPUT_TAIL_BYTES) ? end - BigInt(OUTPUT_TAIL_BYTES) : 0n;
		const page = await this.options.supervisor.readTaskOutput(lease, {
			start: String(start),
			maximumBytes: OUTPUT_TAIL_BYTES,
		});
		if (!page.ok) return [];
		const lines = taskOutputText(page.value).split("\n");
		// The window can open mid-line; that fragment is not a line of output.
		if (start > 0n) lines.shift();
		return lines
			.map((line) => singleLine(line.slice(line.lastIndexOf("\r") + 1), LINE_CHARS).trimEnd())
			.filter((line) => line.trim().length > 0)
			.slice(-OUTPUT_TAIL_LINES);
	}
}

/**
 * Retained output size of a running shell, found with one-byte reads: a read past the end returns nothing. Gallops
 * from the last known size, then bisects, so a large burst of output costs a few dozen tiny reads, not a full scan.
 */
async function findOutputEnd(supervisor: TaskSupervisor, lease: TaskLease, from: bigint): Promise<bigint | undefined> {
	const probe = async (offset: bigint): Promise<{ before: boolean; end: bigint } | undefined> => {
		const page = await supervisor.readTaskOutput(lease, { start: String(offset), maximumBytes: 1 });
		if (!page.ok) return undefined;
		if (page.value.nextOffset !== undefined) return { before: true, end: BigInt(page.value.nextOffset) };
		let end = offset;
		for (const chunk of page.value.chunks) if (BigInt(chunk.offsets.end) > end) end = BigInt(chunk.offsets.end);
		for (const range of page.value.omittedRanges) if (BigInt(range.end) > end) end = BigInt(range.end);
		// No byte beyond this page: the output ends at its last byte, or at or before `offset` when it is empty.
		return { before: end > offset, end };
	};
	let low = from;
	const first = await probe(low);
	if (!first) return undefined;
	if (!first.before) return first.end > from ? first.end : from;
	let step = 65_536n;
	let high = low + step;
	for (;;) {
		const result = await probe(high);
		if (!result) return undefined;
		if (!result.before) {
			if (result.end > high) return result.end;
			break;
		}
		low = high;
		step *= 2n;
		high = low + step;
	}
	// The output ends after `low` and at or before `high`.
	while (high - low > 1n) {
		const middle = low + (high - low) / 2n;
		const result = await probe(middle);
		if (!result) return undefined;
		if (result.before) low = middle;
		else if (result.end > middle) return result.end;
		else high = middle;
	}
	return high;
}
