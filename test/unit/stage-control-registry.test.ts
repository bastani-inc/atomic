/**
 * Unit tests for `createStageControlRegistry`.
 *
 * Verifies:
 *  - register/unregister keyed by runId + stageId
 *  - detachControl keeps chat resolvable while dropping run-level control
 *  - run-level aggregate fans pause to currently-pausable stages
 *  - resume only releases paused stages
 *  - cleared/unknown handles are no-ops, not errors
 *
 * cross-ref: src/runs/foreground/stage-control-registry.ts
 */

import assert from "node:assert/strict";
import type { AgentSession, SessionStore } from "@bastani/atomic";
import { describe, test, vi } from "vitest";
import {
	createStageControlRegistry,
	type StageControlHandle,
	type StageControlStatus,
} from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";

interface MockHandleState {
	pauseCalls: number;
	resumeCalls: number;
	lastResumeMessage?: string;
}

function makeHandle(
	runId: string,
	stageId: string,
	opts: { status?: StageControlStatus; state?: MockHandleState } = {},
): StageControlHandle {
	const state = opts.state ?? { pauseCalls: 0, resumeCalls: 0 };
	let status: StageControlStatus = opts.status ?? "running";
	return {
		runId,
		stageId,
		stageName: `stage-${stageId}`,
		get status() {
			return status;
		},
		sessionId: undefined,
		sessionFile: undefined,
		isStreaming: false,
		messages: [] as AgentSession["messages"],
		async ensureAttached() {},
		async prompt() {},
		async steer() {},
		async followUp() {},
		async pause() {
			state.pauseCalls += 1;
			status = "paused";
		},
		async resume(message?: string) {
			state.resumeCalls += 1;
			state.lastResumeMessage = message;
			status = "running";
		},
		subscribe() {
			return () => {};
		},
	};
}

// #3105: host close must await every stage, even after a sibling cleanup fails.
test("clear awaits all stage disposals and reports partial failures", async () => {
	const registry = createStageControlRegistry();
	let finish!: () => void;
	let finished = false;
	const pending = new Promise<void>((resolve) => {
		finish = resolve;
	});
	registry.register({
		...makeHandle("root", "slow"),
		dispose: async () => {
			await pending;
			finished = true;
		},
	});
	registry.register({
		...makeHandle("root", "failed"),
		dispose: async () => {
			throw new Error("stage cleanup failed");
		},
	});
	const closing = registry.clear();
	assert.ok(closing instanceof Promise);
	const rejected = assert.rejects(closing, /stage cleanup failed/);
	assert.equal(finished, false);
	finish();
	await rejected;
	assert.equal(finished, true);
	assert.equal(registry.has("root"), false);
});

describe("stageControlRegistry — register/get/forRun/run", () => {
	test("register makes the handle resolvable by runId + stageId", () => {
		const r = createStageControlRegistry();
		const h = makeHandle("run-1", "stage-a");
		r.register(h);
		assert.equal(r.get("run-1", "stage-a"), h);
		assert.equal(r.forRun("run-1").length, 1);
	});

	test("unregister callback removes only the registered handle", () => {
		const r = createStageControlRegistry();
		const h1 = makeHandle("run-1", "stage-a");
		const h2 = makeHandle("run-1", "stage-b");
		const off = r.register(h1);
		r.register(h2);
		off();
		assert.equal(r.get("run-1", "stage-a"), undefined);
		assert.equal(r.get("run-1", "stage-b"), h2);
	});

	test("detachControl keeps chat attachment resolvable but removes run-level control", async () => {
		const r = createStageControlRegistry();
		const state = { pauseCalls: 0, resumeCalls: 0 };
		const h = makeHandle("run-1", "stage-a", { status: "running", state });
		r.register(h);

		assert.equal(r.detachControl("run-1", "stage-a", h), true);
		assert.equal(r.get("run-1", "stage-a"), h);
		assert.equal(r.forRun("run-1")[0], h);
		assert.deepEqual(r.run("run-1").stages(), []);

		const paused = await r.run("run-1").pause("stage-a");
		assert.deepEqual(paused, []);
		assert.equal(state.pauseCalls, 0);
	});

	test("forRun returns empty for unknown run", () => {
		const r = createStageControlRegistry();
		assert.deepEqual(r.forRun("nope"), []);
	});

	test("clear drops every registration", () => {
		const r = createStageControlRegistry();
		r.register(makeHandle("run-1", "stage-a"));
		r.register(makeHandle("run-2", "stage-b"));
		r.clear();
		assert.equal(r.get("run-1", "stage-a"), undefined);
		assert.equal(r.get("run-2", "stage-b"), undefined);
	});

	test("clear disposes retained direct chat handles", () => {
		const r = createStageControlRegistry();
		let disposeCalls = 0;
		r.register({
			...makeHandle("run-1", "stage-a"),
			dispose() {
				disposeCalls += 1;
			},
		});
		r.clear();
		assert.equal(disposeCalls, 1);
	});

	test("clear disposes detached direct chat handles", () => {
		const r = createStageControlRegistry();
		let disposeCalls = 0;
		const handle = {
			...makeHandle("run-1", "stage-a"),
			dispose() {
				disposeCalls += 1;
			},
		};
		r.register(handle);
		assert.equal(r.detachControl("run-1", "stage-a", handle), true);

		r.clear();

		assert.equal(disposeCalls, 1);
		assert.equal(r.get("run-1", "stage-a"), undefined);
	});

	test("clear reports asynchronous dispose failures to its owner", async () => {
		const r = createStageControlRegistry();
		r.register({
			...makeHandle("run-1", "stage-a"),
			async dispose() {
				throw new Error("dispose failed");
			},
		});
		await assert.rejects(r.clear(), /dispose failed/);
		assert.equal(r.get("run-1", "stage-a"), undefined);
	});
});

describe("stageControlRegistry — pause fan-out", () => {
	test("run.pause() pauses every running/pending stage", async () => {
		const r = createStageControlRegistry();
		const s1 = { pauseCalls: 0, resumeCalls: 0 };
		const s2 = { pauseCalls: 0, resumeCalls: 0 };
		r.register(makeHandle("run-1", "a", { status: "running", state: s1 }));
		r.register(makeHandle("run-1", "b", { status: "pending", state: s2 }));
		const paused = await r.run("run-1").pause();
		assert.equal(paused.length, 2);
		assert.equal(s1.pauseCalls, 1);
		assert.equal(s2.pauseCalls, 1);
	});

	test("run.pause(stageId) targets a single stage", async () => {
		const r = createStageControlRegistry();
		const s1 = { pauseCalls: 0, resumeCalls: 0 };
		const s2 = { pauseCalls: 0, resumeCalls: 0 };
		r.register(makeHandle("run-1", "a", { status: "running", state: s1 }));
		r.register(makeHandle("run-1", "b", { status: "running", state: s2 }));
		const paused = await r.run("run-1").pause("a");
		assert.equal(paused.length, 1);
		assert.equal(s1.pauseCalls, 1);
		assert.equal(s2.pauseCalls, 0);
	});

	test("run.pause() skips already-paused / settled stages", async () => {
		const r = createStageControlRegistry();
		const settled = { pauseCalls: 0, resumeCalls: 0 };
		const paused = { pauseCalls: 0, resumeCalls: 0 };
		r.register(
			makeHandle("run-1", "done", {
				status: "completed",
				state: settled,
			}),
		);
		r.register(makeHandle("run-1", "stopped", { status: "paused", state: paused }));
		const result = await r.run("run-1").pause();
		assert.equal(result.length, 0);
		assert.equal(settled.pauseCalls, 0);
		assert.equal(paused.pauseCalls, 0);
	});
});

describe("stageControlRegistry — resume fan-out", () => {
	test("run.resume() resumes only paused stages and forwards message", async () => {
		const r = createStageControlRegistry();
		const running: MockHandleState = { pauseCalls: 0, resumeCalls: 0 };
		const paused: MockHandleState = { pauseCalls: 0, resumeCalls: 0 };
		r.register(makeHandle("run-1", "a", { status: "running", state: running }));
		r.register(makeHandle("run-1", "b", { status: "paused", state: paused }));
		const resumed = await r.run("run-1").resume(undefined, "go on");
		assert.equal(resumed.length, 1);
		assert.equal(running.resumeCalls, 0);
		assert.equal(paused.resumeCalls, 1);
		assert.equal(paused.lastResumeMessage, "go on");
	});

	test("run.resume() targeting unknown stage is a no-op", async () => {
		const r = createStageControlRegistry();
		r.register(makeHandle("run-1", "a", { status: "paused" }));
		const resumed = await r.run("run-1").resume("missing");
		assert.equal(resumed.length, 0);
	});

	test("pausedStages() returns only paused entries", () => {
		const r = createStageControlRegistry();
		r.register(makeHandle("run-1", "a", { status: "running" }));
		r.register(makeHandle("run-1", "b", { status: "paused" }));
		const stages = r.run("run-1").pausedStages();
		assert.equal(stages.length, 1);
		assert.equal(stages[0]!.stageId, "b");
	});
});

describe("stageControlRegistry — getOrCreateDetached", () => {
	test("creates a detached handle excluded from run-level control", () => {
		const r = createStageControlRegistry();
		let creates = 0;
		const handle = r.getOrCreateDetached("run-1", "a", () => {
			creates += 1;
			return makeHandle("run-1", "a", { status: "completed" });
		});
		assert.equal(creates, 1);
		assert.equal(r.get("run-1", "a"), handle);
		assert.deepEqual(r.run("run-1").stages(), []);
	});

	test("reuses an existing non-disposed handle without re-invoking the factory", () => {
		const r = createStageControlRegistry();
		let creates = 0;
		const factory = (): StageControlHandle => {
			creates += 1;
			return makeHandle("run-1", "a", { status: "completed" });
		};
		const first = r.getOrCreateDetached("run-1", "a", factory);
		const second = r.getOrCreateDetached("run-1", "a", factory);
		assert.equal(creates, 1);
		assert.equal(first, second);
	});

	test("replaces and disposes a disposed handle", () => {
		const r = createStageControlRegistry();
		let disposed = false;
		const stale: StageControlHandle = {
			...makeHandle("run-1", "a", { status: "completed" }),
			get isDisposed() {
				return true;
			},
			dispose() {
				disposed = true;
			},
		};
		r.register(stale);
		const fresh = r.getOrCreateDetached("run-1", "a", () => makeHandle("run-1", "a", { status: "completed" }));
		assert.notEqual(fresh, stale);
		assert.equal(disposed, true);
		assert.equal(r.get("run-1", "a"), fresh);
	});
});

describe("stageControlRegistry — provisional detached leases", () => {
	test("disposes an uncommitted provisional handle after its final lease releases", async () => {
		const r = createStageControlRegistry();
		let disposes = 0;
		const handle = {
			...makeHandle("run-1", "a", { status: "completed" }),
			async dispose() {
				disposes += 1;
			},
		};
		const first = r.acquireDetached("run-1", "a", () => handle);
		const second = r.acquireDetached("run-1", "a", () => {
			throw new Error("must reuse");
		});

		await first.release();
		assert.equal(r.peek("run-1", "a"), handle);
		await second.release();

		assert.equal(r.peek("run-1", "a"), undefined);
		assert.equal(disposes, 1);
	});

	// #3105: an entry removed by lease release still belongs to the closing registry.
	test("clear joins disposal already started by a released stage lease", async () => {
		const r = createStageControlRegistry();
		const pending = Promise.withResolvers<void>();
		const lease = r.acquireDetached("root", "stage", () => ({
			...makeHandle("root", "stage"),
			dispose: () => pending.promise,
		}));
		const release = lease.release();
		let closed = false;
		const closing = r.clear().then(() => {
			closed = true;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(closed, false);
		pending.resolve();
		await Promise.all([release, closing]);
		assert.equal(closed, true);
	});

	test("commit retains a provisionally-created detached handle", async () => {
		const r = createStageControlRegistry();
		let disposes = 0;
		const handle = {
			...makeHandle("run-1", "a", { status: "completed" }),
			async dispose() {
				disposes += 1;
			},
		};
		const lease = r.acquireDetached("run-1", "a", () => handle);

		lease.commit();
		await lease.release();

		assert.equal(r.peek("run-1", "a"), handle);
		assert.equal(disposes, 0);
	});

	test("replacement disposes a provisional handle and settles every lease", async () => {
		const r = createStageControlRegistry();
		const disposeStarted = Promise.withResolvers<void>();
		const finishDispose = Promise.withResolvers<void>();
		let disposes = 0;
		const provisional = {
			...makeHandle("run-1", "a", { status: "completed" }),
			async dispose() {
				disposes += 1;
				disposeStarted.resolve();
				await finishDispose.promise;
			},
		};
		const first = r.acquireDetached("run-1", "a", () => provisional);
		const second = r.acquireDetached("run-1", "a", () => {
			throw new Error("must reuse");
		});
		const live = makeHandle("run-1", "a");

		r.register(live);
		await disposeStarted.promise;
		let firstSettled = false;
		let secondSettled = false;
		const firstRelease = first.release().then(() => {
			firstSettled = true;
		});
		const secondRelease = second.release().then(() => {
			secondSettled = true;
		});
		await Promise.resolve();

		assert.equal(firstSettled, false);
		assert.equal(secondSettled, false);
		assert.equal(r.get("run-1", "a"), live);
		finishDispose.resolve();
		await Promise.all([firstRelease, secondRelease]);

		assert.equal(disposes, 1);
		assert.equal(r.get("run-1", "a"), live);
	});

	test("a displaced provisional lease cannot commit and release joins disposal", async () => {
		const r = createStageControlRegistry();
		const disposeStarted = Promise.withResolvers<void>();
		const finishDispose = Promise.withResolvers<void>();
		const provisional = {
			...makeHandle("run-1", "a", { status: "completed" }),
			async dispose() {
				disposeStarted.resolve();
				await finishDispose.promise;
			},
		};
		const lease = r.acquireDetached("run-1", "a", () => provisional);
		const live = makeHandle("run-1", "a");

		r.register(live);
		await disposeStarted.promise;
		assert.equal(lease.commit(), false);
		let released = false;
		const release = lease.release().then(() => {
			released = true;
		});
		await Promise.resolve();

		assert.equal(released, false);
		finishDispose.resolve();
		await release;
		assert.equal(r.get("run-1", "a"), live);
	});

	test("ordinary get does not claim a provisional handle", async () => {
		const r = createStageControlRegistry();
		let disposes = 0;
		const handle = {
			...makeHandle("run-1", "a", { status: "completed" }),
			async dispose() {
				disposes += 1;
			},
		};
		const lease = r.acquireDetached("run-1", "a", () => handle);

		assert.equal(r.get("run-1", "a"), handle);
		await lease.release();

		assert.equal(r.peek("run-1", "a"), undefined);
		assert.equal(disposes, 1);
	});

	test("ordinary claim keeps a provisional handle for attach or Intercom", async () => {
		const r = createStageControlRegistry();
		let disposes = 0;
		const handle = {
			...makeHandle("run-1", "a", { status: "completed" }),
			async dispose() {
				disposes += 1;
			},
		};
		const lease = r.acquireDetached("run-1", "a", () => handle);

		assert.equal(r.claim("run-1", "a"), handle);
		await lease.release();

		assert.equal(r.peek("run-1", "a"), handle);
		assert.equal(disposes, 0);
	});
});

describe("stageControlRegistry — releaseIdle", () => {
	function gatedHandle(
		stageId: string,
		gate: { saved?: boolean; idle?: boolean; store?: SessionStore },
		counters: { disposals: number } = { disposals: 0 },
	): StageControlHandle {
		return {
			...makeHandle("run-1", stageId, { status: "completed" }),
			async dispose() {
				counters.disposals += 1;
			},
			releaseGate: {
				async savedForReopen() {
					return gate.saved === false ? undefined : (gate.store ?? ({} as SessionStore));
				},
				idle() {
					return gate.idle ?? true;
				},
			},
		};
	}

	test("releases a gated handle that is saved and idle, and nothing else (#3622)", async () => {
		const r = createStageControlRegistry();
		const releasedCounters = { disposals: 0 };
		const ungated = { disposals: 0 };
		const unsaved = { disposals: 0 };
		const busy = { disposals: 0 };
		r.register(gatedHandle("saved", {}, releasedCounters));
		r.register({
			...makeHandle("run-1", "ungated", { status: "completed" }),
			dispose() {
				ungated.disposals += 1;
			},
		});
		r.register(gatedHandle("unsaved", { saved: false }, unsaved));
		r.register(gatedHandle("busy", { idle: false }, busy));

		await r.releaseIdle("run-1");

		assert.equal(r.get("run-1", "saved"), undefined);
		assert.deepEqual(
			r.forRun("run-1").map((handle) => handle.stageId),
			["ungated", "unsaved", "busy"],
		);
		assert.deepEqual(
			[releasedCounters, ungated, unsaved, busy].map((c) => c.disposals),
			[1, 0, 0, 0],
		);
	});

	test("a lease held on the handle keeps it registered (#3622)", async () => {
		const r = createStageControlRegistry();
		const counters = { disposals: 0 };
		const handle = gatedHandle("a", {}, counters);
		const lease = r.acquireDetached("run-1", "a", () => handle);

		await r.releaseIdle("run-1");
		assert.equal(r.get("run-1", "a"), handle);
		assert.equal(counters.disposals, 0);

		lease.commit();
		await r.releaseIdle("run-1");
		assert.equal(r.get("run-1", "a"), undefined);
		assert.equal(counters.disposals, 1);
	});

	test("keeps the owning session store so the stage can be reopened (#3622)", async () => {
		const r = createStageControlRegistry();
		const store = {} as SessionStore;
		r.register(gatedHandle("a", { store }));

		await r.releaseIdle("run-1");

		assert.equal(r.get("run-1", "a"), undefined);
		assert.equal(r.getSessionStore("run-1", "a"), store);
	});

	test("a failed release is reported and does not stop the sweep (#3622)", async () => {
		const r = createStageControlRegistry();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const counters = { disposals: 0 };
			r.register({
				...gatedHandle("broken", {}),
				async dispose() {
					throw new Error("dispose failed");
				},
			});
			r.register(gatedHandle("fine", {}, counters));

			await r.releaseIdle("run-1");

			assert.equal(counters.disposals, 1);
			assert.equal(warn.mock.calls.length, 1);
			assert.match(String(warn.mock.calls[0]?.[0]), /completed stage session release failed/);
		} finally {
			warn.mockRestore();
		}
	});

	test("a clear that races a release waits for the disposal (#3622)", async () => {
		const r = createStageControlRegistry();
		const disposing = Promise.withResolvers<void>();
		let finished = false;
		r.register({
			...gatedHandle("a", {}),
			async dispose() {
				await disposing.promise;
				finished = true;
			},
		});

		const releasing = r.releaseIdle("run-1");
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		const clearing = r.clear();
		disposing.resolve();
		await Promise.all([releasing, clearing]);

		assert.equal(finished, true);
	});
});
