import { setTimeout as realSleep } from "node:timers/promises";
import { vi } from "vitest";

/** Bound on the fake-time steps a test gives real file I/O to land while it waits for a condition. */
const FILE_IO_STEPS = 2_000;

/**
 * Advances fake time by `stepMs`, then lets a real millisecond pass: real file I/O lands between fake-time steps
 * instead of fake time running ahead of it.
 */
export async function advanceFakeStep(stepMs: number): Promise<void> {
	await vi.advanceTimersByTimeAsync(stepMs);
	await realSleep(1);
}

/** Waits, without moving fake time, until `predicate` holds while real file I/O finishes. */
export async function untilObserved(predicate: () => boolean): Promise<void> {
	for (let step = 0; step < FILE_IO_STEPS && !predicate(); step++) await advanceFakeStep(0);
}

/**
 * Waits, without moving fake time, until a run in `store` is registered in `backend`: a fresh launch reads its
 * checkout's Git HEAD from disk before it records the run.
 */
export async function untilRunRegistered(
	store: { runs(): readonly { readonly id: string }[] },
	backend: { getWorkflow(runId: string): unknown },
): Promise<void> {
	await untilObserved(() => store.runs().some((candidate) => backend.getWorkflow(candidate.id) !== undefined));
}
