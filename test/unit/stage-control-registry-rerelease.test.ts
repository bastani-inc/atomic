import assert from "node:assert/strict";
import type { AgentSession, SessionStore } from "@bastani/atomic";
import { describe, test, vi } from "vitest";
import {
	CLAIM_GRACE_MS,
	createStageControlRegistry,
	type ReleasedStage,
	type StageControlHandle,
} from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";

const RUN = "run-4642";

/** What a fake stage handle's release gate answers, set by each test. */
interface FakeGate {
	saved: boolean;
	idle: boolean;
	holds: number;
	saveFails?: Error;
	pendingSave?: PromiseWithResolvers<void>;
	savedCalls: number;
	readonly listeners: Set<() => void>;
	readonly store: SessionStore;
	/** Something that held the session let go of it. */
	lift(): void;
}

function fakeGate(overrides: Partial<Pick<FakeGate, "saved" | "idle" | "holds">> = {}): FakeGate {
	const listeners = new Set<() => void>();
	return {
		saved: true,
		idle: true,
		holds: 0,
		savedCalls: 0,
		listeners,
		store: {} as SessionStore,
		lift() {
			for (const listener of [...listeners]) listener();
		},
		...overrides,
	};
}

interface FakeHandle {
	readonly handle: StageControlHandle;
	readonly disposals: () => number;
	pendingDispose?: PromiseWithResolvers<void>;
}

function gatedHandle(stageId: string, gate: FakeGate): FakeHandle {
	let disposals = 0;
	const fake: FakeHandle = {
		disposals: () => disposals,
		handle: {
			runId: RUN,
			stageId,
			stageName: `stage-${stageId}`,
			status: "completed",
			sessionId: `session-${stageId}`,
			sessionFile: undefined,
			isStreaming: false,
			get isDisposed() {
				return disposals > 0;
			},
			messages: [] as AgentSession["messages"],
			async ensureAttached() {},
			async prompt() {},
			async steer() {},
			async followUp() {},
			async pause() {},
			async resume() {
				return undefined;
			},
			subscribe: () => () => {},
			async dispose() {
				disposals += 1;
				await fake.pendingDispose?.promise;
			},
			releaseGate: {
				async savedForReopen() {
					gate.savedCalls += 1;
					await gate.pendingSave?.promise;
					if (gate.saveFails !== undefined) throw gate.saveFails;
					return gate.saved ? gate.store : undefined;
				},
				idle: () => gate.idle,
				holdsTaken: () => gate.holds,
				onHoldLifted(listener) {
					gate.listeners.add(listener);
					return () => {
						gate.listeners.delete(listener);
					};
				},
			},
		},
	};
	return fake;
}

async function settled(): Promise<void> {
	for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("a stage is released when its last hold ends, once its release was asked for (#4642)", () => {
	test("a hold that lifts releases the stage only after its owner asked for the release", async () => {
		const registry = createStageControlRegistry();
		const released: ReleasedStage[] = [];
		registry.onStageReleased((stage) => released.push(stage));
		const gate = fakeGate({ idle: false });
		const fake = gatedHandle("a", gate);
		registry.register(fake.handle);

		gate.idle = true;
		gate.lift();
		await settled();
		assert.equal(registry.get(RUN, "a"), fake.handle, "the workflow still holds the stage");
		assert.equal(gate.savedCalls, 0);

		gate.idle = false;
		await registry.releaseIdle(RUN);
		assert.equal(registry.get(RUN, "a"), fake.handle, "a chat still holds it");
		gate.lift();
		await settled();
		assert.equal(gate.savedCalls, 1, "a lift while the chat holds it checks nothing");

		gate.idle = true;
		gate.lift();
		await settled();
		assert.equal(registry.get(RUN, "a"), undefined);
		assert.equal(fake.disposals(), 1);
		assert.equal(gate.listeners.size, 0, "a released stage is no longer watched");
		assert.deepEqual(released, [{ runId: RUN, stageId: "a", stageName: "stage-a", sessionId: "session-a" }]);
	});

	test("a release a hold's end started is joined by releaseIdle, which waits until the session is gone", async () => {
		const registry = createStageControlRegistry();
		const gate = fakeGate({ idle: false });
		const fake = gatedHandle("a", gate);
		registry.register(fake.handle);
		await registry.releaseIdle(RUN);

		gate.pendingSave = Promise.withResolvers<void>();
		fake.pendingDispose = Promise.withResolvers<void>();
		gate.idle = true;
		gate.lift();
		let done = false;
		const joined = registry.releaseIdle(RUN).then(() => {
			done = true;
		});
		await settled();
		assert.equal(done, false, "the transcript check is still running");

		gate.pendingSave.resolve();
		await settled();
		assert.equal(registry.get(RUN, "a"), undefined, "the stage left the registry");
		assert.equal(done, false, "its session is still being disposed");

		fake.pendingDispose.resolve();
		await joined;
		assert.equal(fake.disposals(), 1);
		assert.equal(gate.savedCalls, 2, "the first releaseIdle checked once, the hold's end once, and the join none");
	});

	test("releaseIdle waits for a release that already unregistered its stage to dispose the session", async () => {
		const registry = createStageControlRegistry();
		const gate = fakeGate({ idle: false });
		const fake = gatedHandle("a", gate);
		registry.register(fake.handle);
		await registry.releaseIdle(RUN);
		fake.pendingDispose = Promise.withResolvers<void>();
		gate.idle = true;
		gate.lift();
		await settled();
		assert.equal(registry.get(RUN, "a"), undefined, "the stage left the registry");

		let done = false;
		const waiting = registry.releaseIdle(RUN).then(() => {
			done = true;
		});
		await settled();
		assert.equal(done, false, "its session is still being disposed");
		fake.pendingDispose.resolve();
		await waiting;
		assert.equal(fake.disposals(), 1);
	});

	test("a stage that became busy during the transcript check is kept", async () => {
		const registry = createStageControlRegistry();
		const gate = fakeGate();
		const fake = gatedHandle("a", gate);
		registry.register(fake.handle);
		gate.pendingSave = Promise.withResolvers<void>();

		const releasing = registry.releaseIdle(RUN);
		await settled();
		gate.idle = false;
		gate.pendingSave.resolve();
		await releasing;

		assert.equal(registry.get(RUN, "a"), fake.handle);
		assert.equal(fake.disposals(), 0);
	});

	test("a handle claimed before the release and not used since stays until its claimer used it", async () => {
		const registry = createStageControlRegistry();
		const gate = fakeGate({ holds: 3 });
		const fake = gatedHandle("a", gate);
		registry.register(fake.handle);
		assert.equal(registry.claim(RUN, "a"), fake.handle);

		await registry.releaseIdle(RUN);
		const checked = gate.savedCalls;
		gate.lift();
		await settled();
		assert.equal(registry.get(RUN, "a"), fake.handle, "the claimer has not used the handle yet");
		assert.equal(gate.savedCalls, checked, "an unused claim is not even checked");

		gate.holds = 4;
		gate.lift();
		await settled();
		assert.equal(registry.get(RUN, "a"), undefined, "released once the claimer used it and let go");
	});

	test("a claim nothing follows with a hold stops pinning the handle after the grace, and the sweep then releases it (#4642)", async () => {
		vi.useFakeTimers();
		try {
			const registry = createStageControlRegistry();
			const gate = fakeGate({ holds: 3, idle: false });
			const fake = gatedHandle("a", gate);
			registry.register(fake.handle);
			await registry.releaseIdle(RUN);

			assert.equal(registry.claim(RUN, "a"), fake.handle);
			gate.idle = true;
			gate.lift();
			await vi.advanceTimersByTimeAsync(CLAIM_GRACE_MS - 1);
			assert.equal(registry.get(RUN, "a"), fake.handle, "the claimer still has time to take its hold");
			assert.equal(fake.disposals(), 0);

			await vi.advanceTimersByTimeAsync(1);
			assert.equal(registry.get(RUN, "a"), undefined, "no hold followed the claim");
			assert.equal(fake.disposals(), 1);
		} finally {
			vi.useRealTimers();
		}
	});

	test("a claimer that takes its hold in time keeps the handle however long it holds it, and a second claim restarts the wait (#4642)", async () => {
		vi.useFakeTimers();
		try {
			const registry = createStageControlRegistry();
			const gate = fakeGate({ holds: 0, idle: false });
			const fake = gatedHandle("a", gate);
			registry.register(fake.handle);
			await registry.releaseIdle(RUN);
			registry.claim(RUN, "a");
			await vi.advanceTimersByTimeAsync(CLAIM_GRACE_MS - 1);
			registry.claim(RUN, "a");
			gate.idle = true;
			await vi.advanceTimersByTimeAsync(CLAIM_GRACE_MS - 1);
			assert.equal(registry.get(RUN, "a"), fake.handle, "the second claim restarted the wait");

			gate.holds = 1;
			gate.idle = false;
			await vi.advanceTimersByTimeAsync(CLAIM_GRACE_MS * 5);
			assert.equal(registry.get(RUN, "a"), fake.handle, "a held handle is not released whatever time passes");
			await registry.clear();
			assert.equal(vi.getTimerCount(), 0, "clearing the registry leaves no claim timer behind");
		} finally {
			vi.useRealTimers();
		}
	});

	test("a claim's grace timer does not keep an idle process alive (#4642)", () => {
		const registry = createStageControlRegistry();
		const fake = gatedHandle("a", fakeGate());
		const unregister = registry.register(fake.handle);
		const referencedTimers = () => process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;
		const before = referencedTimers();
		try {
			assert.equal(registry.claim(RUN, "a"), fake.handle);
			assert.equal(referencedTimers(), before);
		} finally {
			unregister();
		}
	});

	test("a claim's wait ends with its handle: unregistering clears it, and a handle that cannot be released again starts none (#4642)", async () => {
		vi.useFakeTimers();
		try {
			const registry = createStageControlRegistry();
			const fake = gatedHandle("a", fakeGate());
			const unregister = registry.register(fake.handle);
			registry.claim(RUN, "a");
			assert.equal(vi.getTimerCount(), 1, "a claim waits for its holder to take a hold");
			unregister();
			assert.equal(vi.getTimerCount(), 0, "the wait ends with the handle");

			const { releaseGate: _gate, ...withoutGate } = gatedHandle("b", fakeGate()).handle;
			registry.register(withoutGate as StageControlHandle);
			registry.claim(RUN, "b");
			assert.equal(vi.getTimerCount(), 0, "a handle with no release gate is never released, so nothing waits");
		} finally {
			vi.useRealTimers();
		}
	});

	test("a handle the registry created for a reopened stage is released when its holds lift, unasked", async () => {
		const registry = createStageControlRegistry();
		const gate = fakeGate();
		const fake = gatedHandle("a", gate);
		const handle = registry.getOrCreateDetached(RUN, "a", () => fake.handle);
		assert.equal(handle, fake.handle);

		gate.lift();
		await settled();
		assert.equal(registry.get(RUN, "a"), fake.handle, "nothing used the reopened handle yet");

		gate.holds = 1;
		gate.lift();
		await settled();
		assert.equal(registry.get(RUN, "a"), undefined);
		assert.equal(fake.disposals(), 1);
	});

	test("a committed lease's handle is released once its holds lift, and a held lease defers it to its end", async () => {
		const registry = createStageControlRegistry();
		const gate = fakeGate();
		const fake = gatedHandle("a", gate);
		const committed = registry.acquireDetached(RUN, "a", () => fake.handle);
		assert.equal(committed.commit(), true);
		const held = registry.acquireDetached(RUN, "a", () => fake.handle);

		gate.lift();
		await settled();
		assert.equal(registry.get(RUN, "a"), fake.handle, "a lease still holds the handle");
		assert.equal(gate.savedCalls, 0, "a held lease is not even checked");

		await held.release();
		await settled();
		assert.equal(registry.get(RUN, "a"), undefined, "the lease's end released the handle");
		assert.equal(fake.disposals(), 1);
	});

	test("claiming a provisional detached handle makes it outlive the lease that created it", async () => {
		const registry = createStageControlRegistry();
		const gate = fakeGate({ idle: false });
		const fake = gatedHandle("a", gate);
		const lease = registry.acquireDetached(RUN, "a", () => fake.handle);
		const claimed = registry.getOrCreateDetached(RUN, "a", () => gatedHandle("other", fakeGate()).handle);

		await lease.release();

		assert.equal(claimed, fake.handle);
		assert.equal(registry.get(RUN, "a"), fake.handle);
		assert.equal(fake.disposals(), 0);
	});

	test("a registered stage outlives a lease taken on it", async () => {
		const registry = createStageControlRegistry();
		const gate = fakeGate({ idle: false });
		const fake = gatedHandle("a", gate);
		registry.register(fake.handle);
		const lease = registry.acquireDetached(RUN, "a", () => gatedHandle("other", fakeGate()).handle);

		await lease.release();

		assert.equal(lease.handle, fake.handle);
		assert.equal(registry.get(RUN, "a"), fake.handle);
		assert.equal(fake.disposals(), 0);
	});

	test("a stage that is displaced, unregistered or cleared is no longer watched", async () => {
		const registry = createStageControlRegistry();
		const first = fakeGate();
		const second = fakeGate();
		const third = fakeGate();
		registry.register(gatedHandle("a", first).handle);
		const unregister = registry.register(gatedHandle("a", second).handle);
		assert.equal(first.listeners.size, 0, "the displaced handle is no longer watched");
		assert.equal(second.listeners.size, 1);

		unregister();
		assert.equal(second.listeners.size, 0);

		registry.register(gatedHandle("b", third).handle);
		await registry.clear();
		assert.equal(third.listeners.size, 0);
	});

	test("a release that fails is reported and leaves the stage registered", async () => {
		const registry = createStageControlRegistry();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const gate = fakeGate({ idle: false });
			const fake = gatedHandle("a", gate);
			registry.register(fake.handle);
			await registry.releaseIdle(RUN);
			gate.saveFails = new Error("store unreachable");
			gate.idle = true;
			gate.lift();
			await settled();

			assert.equal(registry.get(RUN, "a"), fake.handle);
			assert.equal(warn.mock.calls.length, 1);
			assert.match(String(warn.mock.calls[0]![0]), /completed stage session release failed/);
			assert.equal(warn.mock.calls[0]![1], gate.saveFails);
		} finally {
			warn.mockRestore();
		}
	});
});
