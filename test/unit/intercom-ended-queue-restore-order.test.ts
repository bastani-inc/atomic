import assert from "node:assert/strict";
import type net from "node:net";
import { afterEach, test, vi } from "vitest";
import {
	DurableEndedQueue,
	ENDED_QUEUE_OPEN_WAIT_MS,
	type RestoredEndedQueues,
	shouldHoldSendForEndedQueueRestore,
} from "../../packages/intercom/broker/durable-ended-queue.js";
import { EndedChildWakeBudget } from "../../packages/intercom/broker/ended-child-wakes.js";
import type { BrokerConnectedSession } from "../../packages/intercom/broker/send-handler.js";
import type {
	EndedChildQueueStore,
	EndedQueueRow,
} from "../../packages/intercom/broker/sql-ended-child-queue-store.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function row(seq: number, messageId: string, childName: string, text: string): EndedQueueRow {
	return {
		seq,
		messageId,
		ownerSessionId: "owner-1",
		ownerHost: "owner-host",
		childKey: childName.toLowerCase(),
		child: {
			childName,
			group: "default",
			aliases: [],
			childId: `${childName}:0`,
			outcome: "stopped",
			messages: "hold",
		},
		sender: {
			info: {
				id: "sender-1",
				name: "order-sender",
				cwd: "/repo",
				model: "test",
				pid: 1,
				startedAt: 1,
				lastActivity: 1,
				groups: ["default"],
			},
			registrationReturnAddress: "sender-host",
		},
		request: {
			type: "send",
			to: childName,
			wakeEndedRecipient: true,
			message: { id: messageId, timestamp: 1, content: { text } },
		},
		bytes: text.length,
		queuedAt: seq,
	};
}

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function stubStore(options: {
	readonly targets: () => Promise<string[]>;
	readonly load: (page?: (rows: readonly EndedQueueRow[]) => void) => Promise<void>;
}): EndedChildQueueStore {
	return {
		id: "store-1",
		async targets() {
			return options.targets();
		},
		async load(page) {
			await options.load(page);
			return { rows: [], budget: [] };
		},
		counted: () => ({ child: 0, total: 0, counting: false }),
		whenCounted: () => Promise.resolve(),
		add: async () => "added",
		remove: async () => {},
		dispatched: async () => {},
		fail: async () => {},
		setWake: async () => {},
		setOwnerAway: async () => {},
		rekeyOwner: async () => {},
		recordBudget: async () => {},
		close: async () => {},
	};
}

function createQueue(openStore: () => Promise<EndedChildQueueStore | undefined>) {
	const logs: string[] = [];
	const queue = new DurableEndedQueue({
		openStore,
		routingStarted: () => undefined,
		retireStore: () => {},
		budget: new EndedChildWakeBudget(),
		delivered: () => "unknown",
		log: (text) => logs.push(text),
	});
	cleanups.push(() => queue.close());
	return { queue, logs };
}

test("a send arriving after decide() settles and before store.targets() resolves waits and arrives strictly after kept rows", async () => {
	const child = "subagent-worker-order-1";
	const targetsGate = deferred<string[]>();
	const loadGate = deferred<void>();
	cleanups.unshift(() => {
		targetsGate.resolve([child]);
		loadGate.resolve();
	});
	const { queue } = createQueue(async () =>
		stubStore({
			targets: () => targetsGate.promise,
			load: async (page) => {
				await loadGate.promise;
				page?.([row(1, "k1", child, "kept 0"), row(2, "k2", child, "kept 1")]);
			},
		}),
	);

	const delivered: string[] = [];
	const restore = (restored: RestoredEndedQueues): void => {
		for (const q of restored.queues) {
			for (const entry of q.sends) {
				const text = (entry.held.clientMessage.message as { content: { text: string } }).content.text;
				delivered.push(text);
			}
		}
	};

	// First registration settles without waiting for store.targets() or store.load().
	await queue.decide(restore);
	assert.equal(queue.decided, true);
	assert.equal(queue.loaded, false);

	// Right after decide() settles, store.targets() is still in flight: a send to the kept subagent must still be held.
	const dispatch = (target: string, text: string): void => {
		if (queue.holds(target)) {
			queue.whenRestored(() => dispatch(target, text));
			return;
		}
		delivered.push(text);
	};
	assert.equal(queue.holds(child), true, "holds before store.targets() resolves");
	dispatch(child, "after them");
	assert.deepEqual(delivered, [], "must not deliver ahead of kept rows while store.targets() is pending");

	// Once store.targets() resolves, the send to `child` must remain held while store.load() runs.
	targetsGate.resolve([child]);
	await vi.waitFor(() => assert.equal(queue.restorePhase, "loading"));
	assert.deepEqual(delivered, [], "must remain held while store.load() is reading rows");

	// Once store.load() finishes, kept rows are restored first and the deferred send follows them.
	loadGate.resolve();
	await queue.untilLoaded();
	assert.deepEqual(delivered, ["kept 0", "kept 1", "after them"]);
});

test("releases sends to non-pending subagents once store.targets() resolves, without waiting for store.load()", async () => {
	const keptChild = "subagent-worker-kept-1";
	const cleanChild = "subagent-worker-clean-1";
	const targetsGate = deferred<string[]>();
	const loadGate = deferred<void>();
	cleanups.unshift(() => {
		targetsGate.resolve([keptChild]);
		loadGate.resolve();
	});
	const { queue } = createQueue(async () =>
		stubStore({
			targets: () => targetsGate.promise,
			load: async (page) => {
				await loadGate.promise;
				page?.([row(1, "k1", keptChild, "kept 0")]);
			},
		}),
	);

	const delivered = new Map<string, string[]>();
	const push = (target: string, text: string): void => {
		const list = delivered.get(target) ?? [];
		list.push(text);
		delivered.set(target, list);
	};
	await queue.decide((restored) => {
		for (const q of restored.queues) {
			for (const entry of q.sends) {
				push(q.childName, (entry.held.clientMessage.message as { content: { text: string } }).content.text);
			}
		}
	});
	assert.equal(queue.restorePhase, "identifying_targets");

	const dispatch = (target: string, text: string): void => {
		if (queue.holds(target)) {
			queue.whenRestored(() => dispatch(target, text));
			return;
		}
		push(target, text);
	};
	dispatch(keptChild, "after kept 1");
	dispatch(cleanChild, "clean 1");
	dispatch(keptChild, "after kept 2");
	dispatch(cleanChild, "clean 2");
	assert.equal(delivered.size, 0, "all subagent sends wait while targets are being identified");

	// Resolving store.targets() transitions to `loading` and immediately dispatches non-pending sends in FIFO order.
	targetsGate.resolve([keptChild]);
	await vi.waitFor(() => assert.equal(queue.restorePhase, "loading"));
	assert.deepEqual(delivered.get(cleanChild), ["clean 1", "clean 2"], "clean subagent does not wait for store.load()");
	assert.equal(delivered.get(keptChild), undefined, "kept subagent still waits for store.load()");

	// A new send to the clean subagent during `loading` also proceeds immediately.
	dispatch(cleanChild, "clean 3");
	assert.deepEqual(delivered.get(cleanChild), ["clean 1", "clean 2", "clean 3"]);

	loadGate.resolve();
	await queue.untilLoaded();
	assert.equal(queue.restorePhase, "ready");
	assert.deepEqual(delivered.get(keptChild), ["kept 0", "after kept 1", "after kept 2"]);
});

function connectedSession(options: {
	readonly id: string;
	readonly name: string;
	readonly registrationName?: string;
	readonly groups?: string[];
	readonly supervisorId?: string;
	readonly returnAddress?: string;
}): BrokerConnectedSession {
	return {
		socket: {} as net.Socket,
		info: {
			id: options.id,
			name: options.name,
			cwd: "/repo",
			model: "test",
			pid: 1,
			startedAt: 1,
			lastActivity: 1,
			group: options.groups?.[0] ?? "default",
			groups: options.groups ?? ["default"],
		},
		registrationGroup: options.groups?.[0] ?? "default",
		registrationName: options.registrationName ?? options.name,
		...(options.returnAddress === undefined ? {} : { registrationReturnAddress: options.returnAddress }),
		...(options.supervisorId === undefined ? {} : { supervisorId: options.supervisorId }),
	};
}

test("does not hold live sends to non-subagent peers during target identification or loading, while holding every addressing form of a pending subagent", async () => {
	const keptName = "subagent-worker-kept-1";
	const cleanName = "subagent-worker-clean-1";
	const targetsGate = deferred<string[]>();
	const loadGate = deferred<void>();
	cleanups.unshift(() => {
		targetsGate.resolve([keptName]);
		loadGate.resolve();
	});
	const { queue } = createQueue(async () =>
		stubStore({
			targets: () => targetsGate.promise,
			load: async () => {
				await loadGate.promise;
			},
		}),
	);
	await queue.decide(() => {});

	const sender = connectedSession({ id: "aaaaaaaa-1111-2222-3333-444444444444", name: "sender" });
	const peer = connectedSession({ id: "bbbbbbbb-1111-2222-3333-444444444444", name: "peer-session" });
	const hiddenPeer = connectedSession({
		id: "cccccccc-1111-2222-3333-444444444444",
		name: "other-group-peer",
		groups: ["isolated"],
	});
	const keptChild = connectedSession({
		id: "12345678-aaaa-bbbb-cccc-dddddddddddd",
		name: "renamed-kept-worker",
		registrationName: keptName,
		supervisorId: "owner-1",
		returnAddress: "host-kept-1",
	});
	const cleanChild = connectedSession({
		id: "87654321-aaaa-bbbb-cccc-dddddddddddd",
		name: cleanName,
		registrationName: cleanName,
		supervisorId: "owner-1",
		returnAddress: "host-clean-1",
	});
	const sessions = new Map<string, BrokerConnectedSession>([
		[sender.info.id, sender],
		[peer.info.id, peer],
		[hiddenPeer.info.id, hiddenPeer],
		[keptChild.info.id, keptChild],
		[cleanChild.info.id, cleanChild],
	]);
	const aliasTarget = (target: string) => (target === "alias-for-kept" ? keptChild : undefined);

	// Phase: identifying_targets
	assert.equal(queue.restorePhase, "identifying_targets");
	assert.equal(shouldHoldSendForEndedQueueRestore(queue, peer.info.id, sender, sessions, aliasTarget), false);
	assert.equal(shouldHoldSendForEndedQueueRestore(queue, "peer-session", sender, sessions, aliasTarget), false);
	assert.equal(
		shouldHoldSendForEndedQueueRestore(queue, "other-group-peer", sender, sessions, aliasTarget),
		true,
		"hidden peer in another group does not bypass target identification",
	);
	for (const addressing of [
		keptName,
		keptChild.info.id,
		"12345678",
		"renamed-kept-worker",
		"host-kept-1",
		"alias-for-kept",
		cleanName,
		cleanChild.info.id,
		"unregistered-subagent",
	]) {
		assert.equal(
			shouldHoldSendForEndedQueueRestore(queue, addressing, sender, sessions, aliasTarget),
			true,
			`identifying_targets must hold ${addressing}`,
		);
	}

	// Phase: loading (only keptName is pending)
	targetsGate.resolve([keptName]);
	await vi.waitFor(() => assert.equal(queue.restorePhase, "loading"));
	assert.equal(shouldHoldSendForEndedQueueRestore(queue, peer.info.id, sender, sessions, aliasTarget), false);
	assert.equal(shouldHoldSendForEndedQueueRestore(queue, "peer-session", sender, sessions, aliasTarget), false);
	assert.equal(shouldHoldSendForEndedQueueRestore(queue, cleanName, sender, sessions, aliasTarget), false);
	assert.equal(shouldHoldSendForEndedQueueRestore(queue, cleanChild.info.id, sender, sessions, aliasTarget), false);
	assert.equal(
		shouldHoldSendForEndedQueueRestore(queue, "unregistered-subagent", sender, sessions, aliasTarget),
		false,
	);
	for (const addressing of [
		keptName,
		keptChild.info.id,
		"12345678",
		"renamed-kept-worker",
		"host-kept-1",
		"alias-for-kept",
	]) {
		assert.equal(
			shouldHoldSendForEndedQueueRestore(queue, addressing, sender, sessions, aliasTarget),
			true,
			`loading must hold pending subagent addressed as ${addressing}`,
		);
	}

	// Phase: ready
	loadGate.resolve();
	await queue.untilLoaded();
	assert.equal(queue.restorePhase, "ready");
	assert.equal(shouldHoldSendForEndedQueueRestore(queue, keptName, sender, sessions, aliasTarget), false);
	assert.equal(shouldHoldSendForEndedQueueRestore(queue, keptChild.info.id, sender, sessions, aliasTarget), false);
});

test("preserves FIFO order between a wake send deferred during loading and a later live send after the subagent registers", async () => {
	const keptName = "subagent-worker-kept-1";
	const cleanName = "subagent-worker-clean-1";
	const loadGate = deferred<void>();
	cleanups.unshift(() => loadGate.resolve());
	const { queue } = createQueue(async () =>
		stubStore({
			targets: async () => [keptName],
			load: async () => {
				await loadGate.promise;
			},
		}),
	);
	await queue.decide(() => {});
	await vi.waitFor(() => assert.equal(queue.restorePhase, "loading"));

	const sender = connectedSession({ id: "sender-1", name: "sender" });
	const sessions = new Map<string, BrokerConnectedSession>([[sender.info.id, sender]]);
	const delivered: string[] = [];

	const dispatch = (target: string, text: string, wake: boolean): void => {
		if (shouldHoldSendForEndedQueueRestore(queue, target, sender, sessions)) {
			queue.whenRestored(() => dispatch(target, text, wake));
			return;
		}
		const liveTarget = [...sessions.values()].find((s) => s.info.id === target || s.info.name === target);
		if (liveTarget !== undefined) {
			delivered.push(text);
			return;
		}
		if (wake && queue.deferForTarget(target, () => dispatch(target, text, wake))) {
			return;
		}
	};

	// First send: wake send while `cleanName` is not live yet (deferred during `loading`, marking `cleanName` pending).
	dispatch(cleanName, "first-wake", true);
	assert.deepEqual(delivered, []);

	// `cleanName` now registers with a new session ID while `store.load()` is still running.
	const cleanChild = connectedSession({
		id: "99999999-aaaa-bbbb-cccc-dddddddddddd",
		name: cleanName,
		registrationName: cleanName,
		supervisorId: "owner-1",
	});
	sessions.set(cleanChild.info.id, cleanChild);

	// Second send: live send addressed to the new session ID must not overtake `first-wake`.
	dispatch(cleanChild.info.id, "second-live", false);
	assert.deepEqual(delivered, [], "second send waits behind earlier deferred wake send");

	loadGate.resolve();
	await queue.untilLoaded();
	assert.deepEqual(delivered, ["first-wake", "second-live"]);
});

test("drains deferred sends once without hanging when store.targets(), store.load(), or openStore() fails or times out", async () => {
	// 1. store.targets() rejects
	{
		const targetsGate = deferred<string[]>();
		const { queue } = createQueue(async () =>
			stubStore({
				targets: () => targetsGate.promise,
				load: async () => {},
			}),
		);
		await queue.decide(() => {});
		const ran: string[] = [];
		queue.whenRestored(() => ran.push("after-targets-error"));
		assert.deepEqual(ran, []);
		targetsGate.reject(new Error("targets read failed"));
		await queue.untilLoaded();
		assert.equal(queue.restorePhase, "ready");
		assert.deepEqual(ran, ["after-targets-error"]);
	}

	// 2. store.load() rejects
	{
		const loadGate = deferred<void>();
		const { queue } = createQueue(async () =>
			stubStore({
				targets: async () => ["subagent-worker-err-1"],
				load: () => loadGate.promise,
			}),
		);
		await queue.decide(() => {});
		await vi.waitFor(() => assert.equal(queue.restorePhase, "loading"));
		const ran: string[] = [];
		queue.whenRestored(() => ran.push("after-load-error"));
		assert.deepEqual(ran, []);
		loadGate.reject(new Error("load read failed"));
		await queue.untilLoaded();
		assert.equal(queue.restorePhase, "ready");
		assert.deepEqual(ran, ["after-load-error"]);
	}

	// 3. openStore() times out while a send is deferred during `deciding`
	{
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		cleanups.push(() => {
			vi.useRealTimers();
		});
		const { queue } = createQueue(() => new Promise<never>(() => {}));
		const decided = queue.decide(() => {});
		assert.equal(queue.restorePhase, "deciding");
		const ran: string[] = [];
		queue.whenRestored(() => ran.push("after-open-timeout"));
		assert.deepEqual(ran, []);
		await vi.advanceTimersByTimeAsync(ENDED_QUEUE_OPEN_WAIT_MS);
		await decided;
		assert.equal(queue.restorePhase, "ready");
		assert.equal(queue.loaded, true);
		assert.deepEqual(ran, ["after-open-timeout"]);
	}
});
