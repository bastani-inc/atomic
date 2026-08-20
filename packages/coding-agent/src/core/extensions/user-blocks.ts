/**
 * The user-decision block door.
 *
 * An extension opens a block when it starts waiting on a person and releases it
 * through the handle it was given. There is deliberately no release-by-id,
 * release-by-label, or clear-all entry point: a block can only be ended by its
 * opener, so one caller can never end another caller's wait.
 *
 * Block state and listeners are scoped to the owning session's canonical event
 * bus. A successor session created by `/reload` therefore shares its predecessor's
 * open-block set, while concurrent sessions with distinct buses stay isolated.
 */

import type {
	UserBlock,
	UserBlockChange,
	UserBlockListener,
	UserBlockReason,
	UserBlockSnapshot,
} from "./block-types.js";

interface OpenBlock {
	readonly id: number;
	readonly label: string;
	readonly reason: UserBlockReason;
	released: boolean;
}

interface UserBlockState {
	readonly openBlocks: OpenBlock[];
	readonly listeners: Set<UserBlockListener>;
	readonly bufferedChanges: UserBlockChange[];
	runnerAttached: boolean;
}

type UserBlockStateByScope = WeakMap<object, UserBlockState>;

/**
 * The loader passes each session's canonical bus as the scope. Keep the map on
 * globalThis so duplicate host-module instances share the same per-bus state.
 */
const USER_BLOCK_STATE_KEY = Symbol.for("atomic-coding-agent/user-blocks@1");
const USER_BLOCK_ID_KEY = Symbol.for("atomic-coding-agent/user-block-id@1");

interface UserBlockIdState {
	nextBlockId: number;
}

function idState(): UserBlockIdState {
	const bag = globalThis as typeof globalThis & Record<symbol, UserBlockIdState | undefined>;
	const existing = bag[USER_BLOCK_ID_KEY];
	if (existing !== undefined) return existing;
	const created = { nextBlockId: 1 };
	bag[USER_BLOCK_ID_KEY] = created;
	return created;
}

function stateBag(): Record<symbol, UserBlockStateByScope | undefined> {
	return globalThis as typeof globalThis & Record<symbol, UserBlockStateByScope | undefined>;
}

function stateByScope(): UserBlockStateByScope {
	const bag = stateBag();
	const existing = bag[USER_BLOCK_STATE_KEY];
	if (existing !== undefined) return existing;
	const created = new WeakMap<object, UserBlockState>();
	bag[USER_BLOCK_STATE_KEY] = created;
	return created;
}

function getState(scope: object): UserBlockState {
	const states = stateByScope();
	const existing = states.get(scope);
	if (existing !== undefined) return existing;
	const created: UserBlockState = {
		openBlocks: [],
		listeners: new Set<UserBlockListener>(),
		bufferedChanges: [],
		runnerAttached: false,
	};
	states.set(scope, created);
	return created;
}

function activeLabel(state: UserBlockState): string | undefined {
	return state.openBlocks[0]?.label;
}

function notifyListener(listener: UserBlockListener, change: UserBlockChange): void {
	try {
		listener(change);
	} catch {
		// Intentionally ignored: block bookkeeping is not a subscriber's concern.
	}
}

function notify(state: UserBlockState, change: UserBlockChange): void {
	// A subscriber must never be able to break the dialog it is observing, so a
	// throwing listener is contained here rather than surfacing in the caller's
	// `finally`.
	for (const listener of [...state.listeners]) notifyListener(listener, change);
}

/**
 * Open a user-decision block.
 *
 * Returns the only handle that can end it. Prefer `try { ... } finally {
 * block.release(); }` so an abort or a thrown error cannot strand the block.
 */
export function openUserBlock(scope: object, label: string, reason: UserBlockReason): UserBlock {
	const state = getState(scope);
	const record: OpenBlock = { id: idState().nextBlockId++, label, reason, released: false };
	state.openBlocks.push(record);
	const change: UserBlockChange = {
		type: "agent_blocked",
		blockId: record.id,
		label: record.label,
		reason: record.reason,
		openBlocks: state.openBlocks.length,
		activeLabel: activeLabel(state) ?? record.label,
	};
	if (!state.runnerAttached) state.bufferedChanges.push(change);
	notify(state, change);

	return {
		id: record.id,
		label: record.label,
		reason: record.reason,
		get released(): boolean {
			return record.released;
		},
		release(): void {
			if (record.released) return;
			record.released = true;
			const index = state.openBlocks.indexOf(record);
			if (index >= 0) state.openBlocks.splice(index, 1);
			const change: UserBlockChange = {
				type: "agent_unblocked",
				blockId: record.id,
				label: record.label,
				reason: record.reason,
				openBlocks: state.openBlocks.length,
				activeLabel: activeLabel(state),
			};
			if (!state.runnerAttached) state.bufferedChanges.push(change);
			notify(state, change);
		},
	};
}

/** Subscribe to block open/close notifications. Returns an unsubscribe function. */
export function subscribeUserBlocks(scope: object, listener: UserBlockListener): () => void {
	const state = getState(scope);
	state.listeners.add(listener);
	state.runnerAttached = true;
	const bufferedChanges = state.bufferedChanges.splice(0);
	if (bufferedChanges.length > 0) {
		for (const change of bufferedChanges) notifyListener(listener, change);
	} else {
		const currentActiveLabel = activeLabel(state);
		for (const block of [...state.openBlocks]) {
			notifyListener(listener, {
				type: "agent_blocked",
				blockId: block.id,
				label: block.label,
				reason: block.reason,
				openBlocks: state.openBlocks.length,
				activeLabel: currentActiveLabel ?? block.label,
			});
		}
	}
	return () => {
		state.listeners.delete(listener);
	};
}

/** Snapshot of the currently open blocks, oldest first. */
export function getOpenUserBlocks(scope: object): readonly UserBlockSnapshot[] {
	return getState(scope).openBlocks.map((block) => ({ id: block.id, label: block.label, reason: block.reason }));
}

/** Label of the oldest open block, or undefined when nothing is blocked. */
export function getActiveUserBlockLabel(scope: object): string | undefined {
	return activeLabel(getState(scope));
}
