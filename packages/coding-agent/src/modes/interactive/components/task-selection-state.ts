import { childOfAttempt } from "../../../core/tasks/completion.js";
import type { TaskId, TaskRecord } from "../../../core/tasks/contracts.js";
import type { AgentViewBridge } from "../agent-view/agent-view-bridge.ts";

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

/** Per-owner `/tasks` return anchor across inspector disposal (subagent view or external extension view). */
interface TasksReturnSlot {
	saved?: ListSelectionAnchor;
	unwatch?: () => void;
}

const tasksReturnSlots = new WeakMap<object, TasksReturnSlot>();

function returnSlot(owner: object): TasksReturnSlot {
	let slot = tasksReturnSlots.get(owner);
	if (slot === undefined) {
		slot = {};
		tasksReturnSlots.set(owner, slot);
	}
	return slot;
}

function stopReturnWatch(slot: TasksReturnSlot): void {
	slot.unwatch?.();
	slot.unwatch = undefined;
}

export function saveTasksReturnAnchor(owner: object, anchor: ListSelectionAnchor): void {
	const slot = returnSlot(owner);
	stopReturnWatch(slot);
	slot.saved = anchor;
}

export function tasksReturnAnchor(owner: object): ListSelectionAnchor | undefined {
	return tasksReturnSlots.get(owner)?.saved;
}

/**
 * Consume the saved return anchor on dismissal (`Esc`/`←`/`Ctrl+C`) on `main`.
 * If `keepPendingWatch` is true (first dismissal of a restored anchor while an async view request may still
 * be in flight), keep any active `bridge.subscribe` watcher alive so the anchor promotes if the requested
 * subagent finishes opening; otherwise cancel any watcher too.
 */
export function clearTasksReturnAnchor(owner: object, options: { readonly keepPendingWatch?: boolean } = {}): void {
	const slot = tasksReturnSlots.get(owner);
	if (slot === undefined) return;
	slot.saved = undefined;
	if (!options.keepPendingWatch) {
		stopReturnWatch(slot);
		tasksReturnSlots.delete(owner);
	}
}

/**
 * Watch `bridge` after `/tasks` requested a subagent view (without adding an `opening` state to `AgentViewBridge`):
 * - If `Esc` consumed `saved` before an isolated engine's `set_viewed_agent(target)` arrived, seeing the
 *   requested subagent appear restores `saved` (and stops watching).
 * - If the user was already viewing `fromViewed` and switching to `requested` failed (so the screen stayed on
 *   `fromViewed` and later returned to `main` without ever showing `requested`), rolls `saved` back to `rollback`.
 */
export function watchPendingAgentReturn(
	owner: object,
	bridge: AgentViewBridge,
	params: {
		readonly anchor: ListSelectionAnchor;
		readonly requestedId: TaskId;
		readonly resolveKey: (taskId: TaskId) => string;
		readonly fromViewed?: TaskId;
		readonly rollback?: ListSelectionAnchor;
	},
): void {
	const slot = returnSlot(owner);
	stopReturnWatch(slot);
	slot.saved = params.anchor;
	const currentViewed = bridge.viewedTaskId();
	if (currentViewed !== undefined && params.resolveKey(currentViewed) === params.anchor.selectedKey) {
		return;
	}
	const unwatch = bridge.subscribe(() => {
		const viewed = bridge.viewedTaskId();
		if (viewed !== undefined && params.resolveKey(viewed) === params.anchor.selectedKey) {
			slot.saved = params.anchor;
			stopReturnWatch(slot);
			return;
		}
		if (viewed === undefined && params.fromViewed !== undefined) {
			slot.saved = params.rollback;
			stopReturnWatch(slot);
		}
	});
	slot.unwatch = unwatch;
}
