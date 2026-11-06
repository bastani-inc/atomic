import assert from "node:assert/strict";
import v8 from "node:v8";
import vm from "node:vm";
import { describe, test } from "vitest";
import {
	StageWakeDispatcher,
	stageWakeKey,
} from "../../packages/workflows/src/runs/foreground/stage-wake-dispatcher.js";
import { registerStageWakeKind, type StageWake } from "../../packages/workflows/src/sdk-surface.js";

declare module "@bastani/atomic/workflows" {
	interface StageWakeKinds {
		/** Registered with a handler that holds its stage until the test lets it finish. */
		"test-memory-held": { readonly note: string };
	}
}

const RUN = "run-dispatcher-memory";
const STAGE = { runId: RUN, stageId: "stage-1", wakeKey: stageWakeKey(RUN, "stage-1") };
/** Collections, each followed by a macrotask: a WeakRef target survives the job that created or read it. */
const COLLECTION_ROUNDS = 6;

function resolveCollect(): () => void {
	const existing = (globalThis as { gc?: () => void }).gc;
	if (typeof existing === "function") return existing;
	v8.setFlagsFromString("--expose-gc");
	try {
		return vm.runInNewContext("gc") as () => void;
	} finally {
		v8.setFlagsFromString("--no-expose-gc");
	}
}

async function collectGarbage(): Promise<void> {
	const collect = resolveCollect();
	for (let round = 0; round < COLLECTION_ROUNDS; round++) {
		collect();
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** Park the stage and keep only a weak reference to its wait; rejections are collected into `reasons`. */
function parkWeakly(dispatcher: StageWakeDispatcher, reasons: unknown[]): WeakRef<Promise<StageWake>> {
	const parked = dispatcher.park(STAGE.wakeKey, "tool-results");
	parked.catch((reason: unknown) => reasons.push(reason));
	return new WeakRef(parked);
}

describe("a stage's mailbox keeps no wait it already ended (#4309)", () => {
	test("a cancelled stage lets go of the wait it rejected while its mailbox stays open (#4309)", async () => {
		const dispatcher = new StageWakeDispatcher(RUN, undefined, { report: () => {} });
		dispatcher.open(STAGE);
		const reasons: unknown[] = [];
		const wait = parkWeakly(dispatcher, reasons);

		dispatcher.cancel(STAGE.wakeKey, "stage aborted");
		await collectGarbage();

		assert.deepEqual(reasons, ["stage aborted"]);
		assert.equal(wait.deref(), undefined, "the open mailbox still held the cancelled wait");
		dispatcher.dispose();
	});

	test("a stage that ends while one of its handlers runs lets go of its wait before the handler settles (#4309)", async () => {
		const handlerGate = Promise.withResolvers<void>();
		const handlerStarted = Promise.withResolvers<void>();
		const unregister = registerStageWakeKind("test-memory-held", async () => {
			handlerStarted.resolve();
			await handlerGate.promise;
		});
		try {
			const dispatcher = new StageWakeDispatcher(RUN, undefined, { report: () => {} });
			dispatcher.open(STAGE);
			assert.deepEqual(dispatcher.deliver(STAGE.wakeKey, { kind: "test-memory-held", note: "hold" }), {
				status: "handled",
			});
			await handlerStarted.promise;
			const reasons: unknown[] = [];
			const wait = parkWeakly(dispatcher, reasons);

			dispatcher.close(STAGE.wakeKey);
			await collectGarbage();

			assert.equal(reasons.length, 1);
			assert.equal((reasons[0] as DOMException).name, "AbortError");
			// The running handler still holds the closed mailbox; the wait must not be reachable through it.
			assert.equal(wait.deref(), undefined, "the closed mailbox still held the wait while its handler ran");
			handlerGate.resolve();
			dispatcher.dispose();
		} finally {
			unregister();
		}
	});
});
