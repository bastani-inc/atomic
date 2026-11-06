import type { AgentWake } from "./agent-wake-dispatcher.ts";

/** A timed wake waiting for its time. */
export interface ScheduledWake {
	readonly at: number;
	readonly wakeKey: string;
	readonly wake: AgentWake;
}

interface DeadlineNode extends ScheduledWake {
	/** Arrival order, so wakes due at the same time fire in the order they were scheduled. */
	readonly seq: number;
	/** False once cancelled or replaced: the node stays in the heap until it reaches the top or a compaction. */
	live: boolean;
}

/** Below this many dead nodes the heap is never rebuilt: a rebuild costs more than the nodes do. */
const COMPACT_MIN_DEAD = 64;

/**
 * The deadlines of timed wakes: a binary min-heap on time, with an index by (wake key, wake id). Scheduling, cancelling
 * and taking the earliest are O(log n) or better, and taking the wakes that are due costs only those wakes, so
 * 75,000 waiting agents do not make each new deadline walk the others. A cancelled or replaced deadline is only
 * marked, and leaves the heap when it reaches the top or when the dead nodes outnumber the live ones.
 */
export class WakeDeadlines {
	private heap: DeadlineNode[] = [];
	private readonly index = new Map<string, Map<string, DeadlineNode>>();
	private live = 0;
	private nextSeq = 0;
	/** Comparisons between deadlines so far, counted by tests to show the work stays O(n log n) in total. */
	comparisons = 0;

	/** Deadlines waiting, not counting cancelled ones. */
	get size(): number {
		return this.live;
	}

	/** Nodes the heap holds, cancelled ones included: bounded by twice the live deadlines plus a small constant. */
	get stored(): number {
		return this.heap.length;
	}

	/** Schedule `wake` for `wakeKey` at `at`, replacing the deadline with the same key and id. */
	set(wakeKey: string, wake: AgentWake, at: number): void {
		this.delete(wakeKey, wake.id);
		const node: DeadlineNode = { at, wakeKey, wake, seq: this.nextSeq++, live: true };
		let ids = this.index.get(wakeKey);
		if (ids === undefined) {
			ids = new Map();
			this.index.set(wakeKey, ids);
		}
		ids.set(wake.id, node);
		this.live += 1;
		this.heap.push(node);
		this.siftUp(this.heap.length - 1);
	}

	/** Cancel a deadline. Returns whether one was waiting. */
	delete(wakeKey: string, wakeId: string): boolean {
		const ids = this.index.get(wakeKey);
		const node = ids?.get(wakeId);
		if (ids === undefined || node === undefined) return false;
		node.live = false;
		ids.delete(wakeId);
		if (ids.size === 0) this.index.delete(wakeKey);
		this.live -= 1;
		this.compactWhenMostlyDead();
		return true;
	}

	/** The time of the earliest live deadline, or `Infinity` when none waits. */
	earliest(): number {
		this.dropDeadTop();
		return this.heap[0]?.at ?? Number.POSITIVE_INFINITY;
	}

	/** Remove and return every live deadline at or before `now`, earliest first. */
	takeDue(now: number): ScheduledWake[] {
		const due: ScheduledWake[] = [];
		for (;;) {
			this.dropDeadTop();
			const top = this.heap[0];
			if (top === undefined || top.at > now) return due;
			this.popTop();
			this.forget(top);
			due.push({ at: top.at, wakeKey: top.wakeKey, wake: top.wake });
		}
	}

	private forget(node: DeadlineNode): void {
		const ids = this.index.get(node.wakeKey);
		ids?.delete(node.wake.id);
		if (ids?.size === 0) this.index.delete(node.wakeKey);
		node.live = false;
		this.live -= 1;
	}

	private dropDeadTop(): void {
		while (this.heap[0] !== undefined && !this.heap[0].live) this.popTop();
	}

	private compactWhenMostlyDead(): void {
		const dead = this.heap.length - this.live;
		if (dead < COMPACT_MIN_DEAD || dead <= this.live) return;
		this.heap = this.heap.filter((node) => node.live);
		for (let at = (this.heap.length >> 1) - 1; at >= 0; at--) this.siftDown(at);
	}

	private before(a: DeadlineNode, b: DeadlineNode): boolean {
		this.comparisons += 1;
		return a.at < b.at || (a.at === b.at && a.seq < b.seq);
	}

	private popTop(): void {
		const last = this.heap.pop();
		if (last === undefined || this.heap.length === 0) return;
		this.heap[0] = last;
		this.siftDown(0);
	}

	private siftUp(from: number): void {
		const heap = this.heap;
		const node = heap[from] as DeadlineNode;
		let at = from;
		while (at > 0) {
			const parent = (at - 1) >> 1;
			const above = heap[parent] as DeadlineNode;
			if (!this.before(node, above)) break;
			heap[at] = above;
			at = parent;
		}
		heap[at] = node;
	}

	private siftDown(from: number): void {
		const heap = this.heap;
		const node = heap[from] as DeadlineNode;
		let at = from;
		for (;;) {
			let child = 2 * at + 1;
			if (child >= heap.length) break;
			const right = child + 1;
			if (right < heap.length && this.before(heap[right] as DeadlineNode, heap[child] as DeadlineNode))
				child = right;
			if (!this.before(heap[child] as DeadlineNode, node)) break;
			heap[at] = heap[child] as DeadlineNode;
			at = child;
		}
		heap[at] = node;
	}
}
