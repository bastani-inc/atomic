import { childOfAttempt, latestSubagentAttempt } from "../../../core/tasks/completion.js";
import type { TaskId, TaskRecord } from "../../../core/tasks/contracts.js";
import type { OwnerTaskStore } from "../../../core/tasks/owner-store.js";

/** One selectable list row: its current row `id` and its stable identity `key` across resumes/wakes. */
export interface ListEntry {
	readonly id: string;
	readonly key: string;
}

/**
 * Snapshot of a task list's selection and viewport when leaving the list for a detail view,
 * shell output, waited shell, stdin sheet, external item view, or single-screen subagent.
 */
export interface ListSelectionAnchor {
	/** Stable identity key of the selected row when leaving (`child:<op>` for subagents, else row id). */
	readonly selectedKey: string;
	/** Ordered stable keys of the list at the moment of leaving, used for nearest-neighbour fallback if gone. */
	readonly orderKeys: readonly string[];
	/** Viewport scroll offset when leaving, restored and clamped so the resolved selection stays visible. */
	readonly scroll: number;
}

/**
 * Explicit typed state machine for selection and scroll across list <-> away transitions.
 * - `browsing`: the list is active and owns `scroll`.
 * - `away`: the reader navigated into a detail/transcript/waited-shell/stdin view from `anchor`;
 *   store ticks while away must not clobber `anchor`, and returning resolves selection from `anchor`.
 */
export type ListSelectionPhase =
	| { readonly kind: "browsing"; readonly scroll: number }
	| { readonly kind: "away"; readonly anchor: ListSelectionAnchor };

/** Why a `/tasks` inspector closed: navigation keeps the return anchor; dismissal clears it. */
export type InspectorCloseReason = "dismissed" | "navigated-agent" | "navigated-item" | "back-to-caller";

/** Stable identity of a `TaskRecord`: `child:<op>` for launchable subagents (survives resume/wake), else `taskId`. */
export function taskStableKey(task: TaskRecord): string {
	if (task.kind === "agent" && typeof task.launchOperationId === "string") {
		return `child:${childOfAttempt(task)}`;
	}
	return task.ref.taskId;
}

/**
 * Resolve which entry in `nextEntries` should be selected for `targetKey`:
 * 1. Exact stable-key match anywhere in `nextEntries` (survives re-sort and resumed/woken attempts).
 * 2. Nearest surviving neighbour in `previousKeys` (next key first, else previous key — neighbours match
 *    woken/resumed attempts automatically because both use stable keys).
 * 3. First entry in `nextEntries` (or undefined when empty).
 */
export function resolveListEntry(
	targetKey: string | undefined,
	previousKeys: readonly string[],
	nextEntries: readonly ListEntry[],
): ListEntry | undefined {
	if (nextEntries.length === 0) return undefined;
	if (targetKey === undefined) return nextEntries[0];
	const exact = nextEntries.find((entry) => entry.key === targetKey);
	if (exact !== undefined) return exact;
	const index = previousKeys.indexOf(targetKey);
	if (index >= 0) {
		const byKey = new Map<string, ListEntry>();
		for (const entry of nextEntries) {
			if (!byKey.has(entry.key)) byKey.set(entry.key, entry);
		}
		for (let after = index + 1; after < previousKeys.length; after++) {
			const hit = byKey.get(previousKeys[after]!);
			if (hit !== undefined) return hit;
		}
		for (let before = index - 1; before >= 0; before--) {
			const hit = byKey.get(previousKeys[before]!);
			if (hit !== undefined) return hit;
		}
	}
	return nextEntries[0];
}

/**
 * Keep the selected span `[selStart, selEnd]` (and an optional preceding header row `topNeeded <= selStart`)
 * visible inside a viewport of `room` lines over `total` lines, preserving `scroll` when already visible
 * and never scrolling past `Math.max(0, total - room)`.
 */
export function keepSpanInView(
	scroll: number,
	topNeeded: number,
	selStart: number,
	selEnd: number,
	room: number,
	total: number,
): number {
	const safeRoom = Math.max(1, room);
	const maxStart = Math.max(0, total - safeRoom);
	if (selStart < 0 || selEnd < selStart || total <= 0) return 0;
	const clamped = Math.max(0, Math.min(scroll, maxStart));
	const span = selEnd - selStart + 1;
	if (span > safeRoom) {
		return Math.max(0, Math.min(selEnd + 1 - safeRoom, maxStart));
	}
	const safeTop = Math.max(0, Math.min(topNeeded, selStart));
	const topTarget = selEnd - safeTop + 1 <= safeRoom ? safeTop : selStart;
	let next = topTarget < clamped ? topTarget : clamped;
	if (selEnd >= next + safeRoom) {
		next = selEnd + 1 - safeRoom;
	}
	return Math.max(0, Math.min(next, maxStart));
}

/** Keep single row `selIndex` visible in a viewport of `room` rows over `total` rows without unnecessary scrolling. */
export function keepRowInView(scroll: number, selIndex: number, room: number, total: number): number {
	return keepSpanInView(scroll, selIndex, selIndex, selIndex, room, total);
}

/** Per-owner `/tasks` return anchor across inspector disposal (plain data only; zero bridge listeners). */
export interface TasksReturnRecord {
	/** Settled return anchor (restored when returning to `/tasks` from a viewed subagent or external item). */
	readonly anchor?: ListSelectionAnchor;
	/** Task id currently associated with the settled `anchor`, so settlement matches even after eviction. */
	readonly anchorTaskId?: TaskId;
	/**
	 * In-flight subagent open requested from `/tasks`, awaiting synchronous view settlement (`AgentViewSwitcher`
	 * or `handleSetViewedAgent`): promotes to `anchor` when the target lands, and is discarded (preserving any
	 * prior settled `anchor`) when the open fails or another view takes over.
	 */
	readonly pending?: {
		readonly targetId: TaskId;
		readonly anchor: ListSelectionAnchor;
	};
}

const tasksReturnRecords = new WeakMap<object, TasksReturnRecord>();

export function saveTasksReturnAnchor(owner: object, anchor: ListSelectionAnchor, anchorTaskId?: TaskId): void {
	tasksReturnRecords.set(owner, {
		anchor,
		...(anchorTaskId === undefined ? {} : { anchorTaskId }),
	});
}

export function stagePendingTasksReturn(
	owner: object,
	targetId: TaskId,
	anchor: ListSelectionAnchor,
	fallbackAnchor?: ListSelectionAnchor,
	fallbackTaskId?: TaskId,
): void {
	tasksReturnRecords.set(owner, {
		...(fallbackAnchor === undefined ? {} : { anchor: fallbackAnchor }),
		...(fallbackAnchor !== undefined && fallbackTaskId !== undefined ? { anchorTaskId: fallbackTaskId } : {}),
		pending: { targetId, anchor },
	});
}

export function resolveStoreTaskKey(store: OwnerTaskStore, taskId: TaskId): string {
	const task = latestSubagentAttempt(store.backgroundTasks, taskId) ?? store.taskRecord?.(taskId);
	return task === undefined ? taskId : taskStableKey(task);
}

/**
 * Settle any pending `/tasks` subagent open (and clear stale anchors on external switches to another subagent)
 * without registering any listener on `AgentViewBridge`.
 */
export function settleTasksReturnAnchor(
	owner: object,
	viewedTaskId: TaskId | undefined,
	resolveKey: (taskId: TaskId) => string,
): void {
	const record = tasksReturnRecords.get(owner);
	if (record === undefined) return;
	if (viewedTaskId === undefined) {
		if (record.anchor === undefined) {
			tasksReturnRecords.delete(owner);
		} else if (record.pending !== undefined) {
			tasksReturnRecords.set(owner, {
				anchor: record.anchor,
				...(record.anchorTaskId === undefined ? {} : { anchorTaskId: record.anchorTaskId }),
			});
		}
		return;
	}
	let resolvedKey: string | undefined;
	const viewedKey = (): string => {
		resolvedKey ??= resolveKey(viewedTaskId);
		return resolvedKey;
	};
	if (
		record.pending !== undefined &&
		(viewedTaskId === record.pending.targetId || viewedKey() === record.pending.anchor.selectedKey)
	) {
		tasksReturnRecords.set(owner, { anchor: record.pending.anchor, anchorTaskId: viewedTaskId });
		return;
	}
	if (
		record.anchor !== undefined &&
		(viewedTaskId === record.anchorTaskId || viewedKey() === record.anchor.selectedKey)
	) {
		if (record.pending !== undefined || record.anchorTaskId !== viewedTaskId) {
			tasksReturnRecords.set(owner, { anchor: record.anchor, anchorTaskId: viewedTaskId });
		}
		return;
	}
	tasksReturnRecords.delete(owner);
}

export function settleStoreTasksReturn(store: OwnerTaskStore | undefined, viewedTaskId: TaskId | undefined): void {
	if (store === undefined || !tasksReturnRecords.has(store)) return;
	settleTasksReturnAnchor(store, viewedTaskId, (id) => resolveStoreTaskKey(store, id));
}

export function tasksReturnRecord(owner: object): TasksReturnRecord | undefined {
	return tasksReturnRecords.get(owner);
}

export function tasksReturnAnchor(owner: object): ListSelectionAnchor | undefined {
	const record = tasksReturnRecords.get(owner);
	return record?.pending?.anchor ?? record?.anchor;
}

export function clearTasksReturnAnchor(owner: object, options: { readonly keepPending?: boolean } = {}): void {
	if (options.keepPending === true) {
		const record = tasksReturnRecords.get(owner);
		if (record?.pending !== undefined) {
			tasksReturnRecords.set(owner, { pending: record.pending });
			return;
		}
	}
	tasksReturnRecords.delete(owner);
}
