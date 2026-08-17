/**
 * The user-decision block door.
 *
 * An extension opens a block when it starts waiting on a person and releases it
 * through the handle it was given. There is deliberately no release-by-id,
 * release-by-label, or clear-all entry point: a block can only be ended by its
 * opener, so one caller can never end another caller's wait.
 *
 * The registry is module scope on purpose so all extension runners in one
 * process observe the same open-block set. A per-runner registry would not
 * preserve the reference count when more than one runner is active.
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

let nextBlockId = 1;

/** Open blocks in the order they were opened; the oldest is index 0. */
const openBlocks: OpenBlock[] = [];

const listeners = new Set<UserBlockListener>();

function notify(change: UserBlockChange): void {
	// A subscriber must never be able to break the dialog it is observing, so a
	// throwing listener is contained here rather than surfacing in the caller's
	// `finally`.
	for (const listener of [...listeners]) {
		try {
			listener(change);
		} catch {
			// Intentionally ignored: block bookkeeping is not a subscriber's concern.
		}
	}
}

function activeLabel(): string | undefined {
	return openBlocks[0]?.label;
}

/**
 * Open a user-decision block.
 *
 * Returns the only handle that can end it. Prefer `try { ... } finally {
 * block.release(); }` so an abort or a thrown error cannot strand the block.
 */
export function openUserBlock(label: string, reason: UserBlockReason): UserBlock {
	const record: OpenBlock = { id: nextBlockId++, label, reason, released: false };
	openBlocks.push(record);
	notify({
		type: "agent_blocked",
		blockId: record.id,
		label: record.label,
		reason: record.reason,
		openBlocks: openBlocks.length,
		activeLabel: activeLabel() ?? record.label,
	});

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
			const index = openBlocks.indexOf(record);
			if (index >= 0) openBlocks.splice(index, 1);
			notify({
				type: "agent_unblocked",
				blockId: record.id,
				label: record.label,
				reason: record.reason,
				openBlocks: openBlocks.length,
				activeLabel: activeLabel(),
			});
		},
	};
}

/** Subscribe to block open/close notifications. Returns an unsubscribe function. */
export function subscribeUserBlocks(listener: UserBlockListener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Snapshot of the currently open blocks, oldest first. */
export function getOpenUserBlocks(): readonly UserBlockSnapshot[] {
	return openBlocks.map((block) => ({ id: block.id, label: block.label, reason: block.reason }));
}

/** Label of the oldest open block, or undefined when nothing is blocked. */
export function getActiveUserBlockLabel(): string | undefined {
	return activeLabel();
}
