// GC-based measurements for cost guards and leak tests: bytes a function allocates, and collecting garbage on demand.
import { GCProfiler, getHeapStatistics, setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

/** Run a full garbage collection a few times, yielding in between so finalizers and weak references settle. */
export async function collectGarbage(): Promise<void> {
	for (let round = 0; round < 4; round++) {
		await new Promise((resolve) => setImmediate(resolve));
		gc();
	}
}

/**
 * Collect garbage until `released()` holds or `rounds` collections have run. A platform can keep the last references
 * a little longer (a pending timer or I/O callback), so a fixed number of collections races it; a real leak still
 * fails once the rounds run out.
 */
export async function collectGarbageUntil(released: () => boolean, rounds = 40): Promise<void> {
	for (let round = 0; round < rounds; round++) {
		await new Promise((resolve) => setTimeout(resolve, round < 4 ? 0 : 10));
		gc();
		if (released()) return;
	}
}

/**
 * Bytes `run` allocates on the JavaScript heap, including garbage collected while it ran: the heap growth plus what
 * every collection during the run freed.
 */
export async function allocatedBytes(run: () => unknown): Promise<number> {
	gc();
	const profiler = new GCProfiler();
	profiler.start();
	const before = getHeapStatistics().used_heap_size;
	await run();
	const after = getHeapStatistics().used_heap_size;
	const { statistics } = profiler.stop();
	let freed = 0;
	for (const collection of statistics) {
		freed += collection.beforeGC.heapStatistics.usedHeapSize - collection.afterGC.heapStatistics.usedHeapSize;
	}
	return after - before + freed;
}

/** Whether `reference` is collected once nothing else holds its target. */
export async function isCollected(reference: WeakRef<object>): Promise<boolean> {
	await collectGarbage();
	return reference.deref() === undefined;
}
