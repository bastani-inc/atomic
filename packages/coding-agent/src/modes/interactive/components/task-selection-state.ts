import { childOfAttempt } from "../../../core/tasks/completion.js";
import type { TaskRecord } from "../../../core/tasks/contracts.js";

/**
 * Snapshot of a task list's selection and viewport when leaving the list for a detail view,
 * shell output, waited shell, stdin sheet, external item view, or single-screen subagent.
 */
export interface ListSelectionAnchor {
	/** Stable row id selected when leaving the list (task id or extension item id). */
	readonly selectedId: string;
	/** Stable subagent child key when `selectedId` is a subagent attempt, surviving supersession or eviction. */
	readonly childKey?: string;
	/** Ordered row ids of the list at the moment of leaving, used for nearest-neighbour fallback if gone. */
	readonly order: readonly string[];
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

/** Stable subagent child identity of `task`, when it belongs to a launchable subagent. */
export function subagentChildKey(task: TaskRecord | undefined): string | undefined {
	if (task?.kind !== "agent" || typeof task.launchOperationId !== "string") return undefined;
	return childOfAttempt(task);
}

/**
 * Latest listed attempt of subagent `childKey` present in `order`, or undefined when none is listed.
 */
export function resolveChildAttemptId(
	tasks: readonly TaskRecord[],
	order: readonly string[],
	childKey: string | undefined,
): string | undefined {
	if (childKey === undefined || order.length === 0) return undefined;
	const listed = new Set(order);
	let latest: TaskRecord | undefined;
	for (const task of tasks) {
		if (!listed.has(task.ref.taskId) || subagentChildKey(task) !== childKey) continue;
		if (latest === undefined || task.launchOrdinal >= latest.launchOrdinal) latest = task;
	}
	return latest?.ref.taskId;
}

/**
 * When `selected` is gone from `next`, pick its nearest survivor from `previous`:
 * the first surviving item after `selected`, else the last surviving item before it, else `next[0]`.
 */
export function nearestSurvivor(
	previous: readonly string[],
	next: readonly string[],
	selected: string | undefined,
): string | undefined {
	if (next.length === 0) return undefined;
	const index = selected === undefined ? -1 : previous.indexOf(selected);
	if (index >= 0) {
		const survivors = new Set(next);
		for (let after = index + 1; after < previous.length; after++) {
			const candidate = previous[after]!;
			if (survivors.has(candidate)) return candidate;
		}
		for (let before = index - 1; before >= 0; before--) {
			const candidate = previous[before]!;
			if (survivors.has(candidate)) return candidate;
		}
	}
	return next[0];
}

/**
 * Resolve which row id in `nextOrder` should be selected for `targetId`:
 * 1. Exact id match (survives any re-sort or section move).
 * 2. Alias match (e.g. a resumed or woken subagent attempt with the same child key).
 * 3. Nearest surviving neighbour in `previousOrder` (next item, else previous item).
 * 4. First row in `nextOrder` (or undefined when empty).
 */
export function resolveListSelection(
	targetId: string | undefined,
	previousOrder: readonly string[],
	nextOrder: readonly string[],
	resolveAlias?: (id: string, nextOrder: readonly string[]) => string | undefined,
): string | undefined {
	if (nextOrder.length === 0) return undefined;
	if (targetId !== undefined) {
		if (nextOrder.includes(targetId)) return targetId;
		const mapped = resolveAlias?.(targetId, nextOrder);
		if (mapped !== undefined && nextOrder.includes(mapped)) return mapped;
		return nearestSurvivor(previousOrder, nextOrder, targetId);
	}
	return nextOrder[0];
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

/** Per-owner `/tasks` return anchor across inspector disposal (subagent view or external extension view). */
const tasksReturnAnchors = new WeakMap<object, ListSelectionAnchor>();

export function saveTasksReturnAnchor(owner: object, anchor: ListSelectionAnchor): void {
	tasksReturnAnchors.set(owner, anchor);
}

export function tasksReturnAnchor(owner: object): ListSelectionAnchor | undefined {
	return tasksReturnAnchors.get(owner);
}

export function clearTasksReturnAnchor(owner: object): void {
	tasksReturnAnchors.delete(owner);
}
