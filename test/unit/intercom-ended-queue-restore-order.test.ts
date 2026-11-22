import assert from "node:assert/strict";
import type net from "node:net";
import { afterEach, test, vi } from "vitest";
import { DeliveredMessageCache } from "../../packages/intercom/broker/delivered-message-cache.js";
import {
	DurableEndedQueue,
	ENDED_QUEUE_LOAD_WAIT_MS,
	ENDED_QUEUE_OPEN_WAIT_MS,
	type RestoredEndedQueues,
	shouldHoldSendForEndedQueueRestore,
} from "../../packages/intercom/broker/durable-ended-queue.js";
import { EndedChildWakeBudget } from "../../packages/intercom/broker/ended-child-wakes.js";
import {
	type BrokerConnectedSession,
	detachSend,
	handleBrokerSend,
	retargetSendToSessionId,
	type SendClientMessage,
} from "../../packages/intercom/broker/send-handler.js";
import type {
	EndedChildQueueStore,
	EndedQueueRow,
} from "../../packages/intercom/broker/sql-ended-child-queue-store.js";
import type { BrokerMessage } from "../../packages/intercom/types.js";

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
		false,
		"non-subagent peer in another group is never held during target identification",
	);
	assert.equal(
		shouldHoldSendForEndedQueueRestore(queue, "unregistered-subagent", sender, sessions, aliasTarget),
		false,
		"unknown/unregistered target passes dispatchSend during target identification",
	);
	for (const addressing of [
		keptChild.info.id,
		"12345678",
		"renamed-kept-worker",
		"host-kept-1",
		"alias-for-kept",
		cleanName,
		cleanChild.info.id,
	]) {
		assert.equal(
			shouldHoldSendForEndedQueueRestore(queue, addressing, sender, sessions, aliasTarget),
			true,
			`identifying_targets must hold visible live subagent addressed as ${addressing}`,
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

test("preserves FIFO order between a wake send deferred during target identification and a later live send after the subagent registers", async () => {
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
	assert.equal(queue.restorePhase, "identifying_targets");

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

	// First send: wake send while `cleanName` is not live yet (deferred during `identifying_targets`).
	dispatch(cleanName, "first-wake", true);
	assert.deepEqual(delivered, []);

	// `cleanName` now registers with a new session ID while `store.targets()` is still in flight.
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

	// Once `store.targets()` resolves (without waiting for `store.load()`), both clean sends deliver in FIFO order!
	targetsGate.resolve([keptName]);
	await vi.waitFor(() => assert.equal(queue.restorePhase, "loading"));
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

test("bounds the entire restore (targets + load) to one ENDED_QUEUE_LOAD_WAIT_MS and releases held sends past it", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	cleanups.push(() => {
		vi.useRealTimers();
	});

	// 1. store.targets() hangs past ENDED_QUEUE_LOAD_WAIT_MS
	{
		const child = "subagent-worker-hang-targets-1";
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
					page?.([row(1, "k1", child, "late-kept")]);
				},
			}),
		);
		const restoredTexts: string[] = [];
		await queue.decide((restored) => {
			for (const q of restored.queues) {
				for (const entry of q.sends) {
					restoredTexts.push((entry.held.clientMessage.message as { content: { text: string } }).content.text);
				}
			}
		});
		assert.equal(queue.restorePhase, "identifying_targets");
		const ran: string[] = [];
		queue.whenRestored(() => ran.push("released-at-bound"));

		await vi.advanceTimersByTimeAsync(ENDED_QUEUE_LOAD_WAIT_MS - 1);
		assert.equal(queue.restorePhase, "identifying_targets");
		assert.deepEqual(ran, []);

		await vi.advanceTimersByTimeAsync(1);
		assert.equal(queue.restorePhase, "ready");
		assert.equal(queue.loaded, true);
		assert.equal(queue.holds(child), false);
		assert.deepEqual(ran, ["released-at-bound"]);

		// Late targets() + load() completion still restores kept rows without re-entering loading.
		targetsGate.resolve([child]);
		loadGate.resolve();
		await vi.advanceTimersByTimeAsync(0);
		assert.deepEqual(restoredTexts, ["late-kept"]);
		assert.equal(queue.restorePhase, "ready");
		assert.equal(queue.holds(child), false);
	}

	// 2. ONE shared bound across targets() + load(): 2 s in targets() leaves 3 s for load()
	{
		const child = "subagent-worker-hang-load-1";
		const targetsGate = deferred<string[]>();
		const loadGate = deferred<void>();
		cleanups.unshift(() => {
			targetsGate.resolve([child]);
			loadGate.resolve();
		});
		const { queue } = createQueue(async () =>
			stubStore({
				targets: () => targetsGate.promise,
				load: () => loadGate.promise,
			}),
		);
		await queue.decide(() => {});
		const ran: string[] = [];
		queue.whenRestored(() => ran.push("released-from-loading"));

		await vi.advanceTimersByTimeAsync(2_000);
		targetsGate.resolve([child]);
		await vi.advanceTimersByTimeAsync(0);
		assert.equal(queue.restorePhase, "loading");
		// Re-defer after transition to loading, as dispatchSend does for a pending target.
		queue.whenRestored(() => ran.push("still-pending-in-loading"));

		await vi.advanceTimersByTimeAsync(ENDED_QUEUE_LOAD_WAIT_MS - 2_000 - 1);
		assert.equal(queue.restorePhase, "loading");

		await vi.advanceTimersByTimeAsync(1);
		assert.equal(queue.restorePhase, "ready");
		assert.equal(queue.loaded, true);
		assert.deepEqual(ran, ["released-from-loading", "still-pending-in-loading"]);
	}
});

test("during identifying_targets, never holds remote peers, missing sessions, alias/return-path peers, or peers colliding with invisible cross-group subagents", async () => {
	const targetsGate = deferred<string[]>();
	const loadGate = deferred<void>();
	cleanups.unshift(() => {
		targetsGate.resolve(["subagent-worker-kept-1"]);
		loadGate.resolve();
	});
	const { queue } = createQueue(async () =>
		stubStore({
			targets: () => targetsGate.promise,
			load: () => loadGate.promise,
		}),
	);
	await queue.decide(() => {});
	assert.equal(queue.restorePhase, "identifying_targets");

	const sender = connectedSession({ id: "aaaaaaaa-1111-2222-3333-444444444444", name: "sender", groups: ["team-a"] });
	const localPeer = connectedSession({
		id: "bbbbbbbb-1111-2222-3333-444444444444",
		name: "shared-name",
		groups: ["team-a"],
		returnAddress: "host-local-peer",
	});
	const returnPathPeer = connectedSession({
		id: "cccccccc-1111-2222-3333-444444444444",
		name: "return-path-peer",
		groups: ["team-b"],
		returnAddress: "host-return-peer",
	});
	const invisibleSubagent = connectedSession({
		id: "dddddddd-1111-2222-3333-444444444444",
		name: "shared-name",
		registrationName: "shared-name",
		groups: ["team-b"],
		supervisorId: "owner-b",
		returnAddress: "host-invisible-subagent",
	});
	const visibleSubagent = connectedSession({
		id: "eeeeeeee-1111-2222-3333-444444444444",
		name: "visible-worker",
		registrationName: "subagent-worker-kept-1",
		groups: ["team-a"],
		supervisorId: "owner-a",
		returnAddress: "host-visible-subagent",
	});
	const sessions = new Map<string, BrokerConnectedSession>([
		[sender.info.id, sender],
		[localPeer.info.id, localPeer],
		[returnPathPeer.info.id, returnPathPeer],
		[invisibleSubagent.info.id, invisibleSubagent],
		[visibleSubagent.info.id, visibleSubagent],
	]);
	const aliasTarget = (target: string) => (target === "alias-for-local-peer" ? localPeer : undefined);

	// None of these may be held during identifying_targets:
	for (const [label, target] of [
		["live peer exact ID", localPeer.info.id],
		["live peer 8-hex prefix", "bbbbbbbb"],
		["live peer host ID", "host-local-peer"],
		["live peer multi-node alias", "alias-for-local-peer"],
		["live peer colliding with invisible cross-group subagent", "shared-name"],
		["cross-group return-path peer by name", "return-path-peer"],
		["cross-group return-path peer by exact ID", returnPathPeer.info.id],
		["cross-group return-path peer by host ID", "host-return-peer"],
		["invisible cross-group subagent by exact ID", invisibleSubagent.info.id],
		["invisible cross-group subagent by prefix", "dddddddd"],
		["remote peer on another broker", "ffffffff-1111-2222-3333-444444444444"],
		["missing session", "no-such-session"],
	] as const) {
		assert.equal(
			shouldHoldSendForEndedQueueRestore(queue, target, sender, sessions, aliasTarget),
			false,
			`identifying_targets must not hold ${label} (${target})`,
		);
	}

	// A visible live subagent IS held during identifying_targets (across every addressing form).
	for (const addressing of [visibleSubagent.info.id, "eeeeeeee", "visible-worker", "host-visible-subagent"]) {
		assert.equal(
			shouldHoldSendForEndedQueueRestore(queue, addressing, sender, sessions, aliasTarget),
			true,
			`identifying_targets must hold visible live subagent addressed as ${addressing}`,
		);
	}
});

test("during loading, clean subagents never mutate pending or stall live sends even if store.load() hangs", async () => {
	const keptName = "subagent-worker-kept-1";
	const cleanName = "subagent-worker-clean-1";
	const loadGate = deferred<void>();
	cleanups.unshift(() => loadGate.resolve());
	const { queue } = createQueue(async () =>
		stubStore({
			targets: async () => [keptName],
			load: () => loadGate.promise,
		}),
	);
	await queue.decide(() => {});
	await vi.waitFor(() => assert.equal(queue.restorePhase, "loading"));

	// A wake send to a clean subagent during loading defers under the shared 5 s restore bound WITHOUT mutating pending,
	// so live sends to the clean subagent still never stall on store.load().
	const ran: string[] = [];
	const deferredWake = queue.deferForTarget(cleanName, () => ran.push("deferred"));
	assert.equal(deferredWake, true, "wake send during loading waits under the shared restore bound");
	assert.equal(queue.holds(cleanName), false, "deferForTarget must never mutate pending");
	const sender = connectedSession({ id: "sender-1", name: "sender" });
	const cleanChild = connectedSession({
		id: "99999999-aaaa-bbbb-cccc-dddddddddddd",
		name: cleanName,
		registrationName: cleanName,
		supervisorId: "owner-1",
		returnAddress: "host-clean-1",
	});
	const sessions = new Map<string, BrokerConnectedSession>([
		[sender.info.id, sender],
		[cleanChild.info.id, cleanChild],
	]);
	assert.equal(shouldHoldSendForEndedQueueRestore(queue, cleanChild.info.id, sender, sessions), false);
	assert.equal(shouldHoldSendForEndedQueueRestore(queue, cleanName, sender, sessions), false);
	assert.equal(shouldHoldSendForEndedQueueRestore(queue, "host-clean-1", sender, sessions), false);
	loadGate.resolve();
	await queue.untilLoaded();
	assert.deepEqual(ran, ["deferred"]);
});

test("a wake send to a clean ended subagent during a 3.5 s store.load() waits under the 5 s restore bound instead of failing at the 2 s count wait", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	cleanups.push(() => {
		vi.useRealTimers();
	});
	const keptName = "subagent-worker-kept-1";
	const cleanName = "subagent-worker-clean-1";
	const loadGate = deferred<void>();
	cleanups.unshift(() => loadGate.resolve());
	let counted = false;
	const { queue } = createQueue(async () =>
		stubStore({
			targets: async () => [keptName],
			load: async () => {
				await loadGate.promise;
				counted = true;
			},
		}),
	);
	await queue.decide(() => {});
	await vi.advanceTimersByTimeAsync(0);
	assert.equal(queue.restorePhase, "loading");

	// Simulates broker.queueForEndedChildWake -> DepartedChildren.admitWake: while store.load() is still running
	// (3.5 s > ENDED_QUEUE_OPEN_WAIT_MS=2 s, < ENDED_QUEUE_LOAD_WAIT_MS=5 s), deferForTarget defers under the 5 s
	// restore bound rather than entering admitWake while uncounted and failing at 2 s.
	let outcome: "queued" | "failed_still_counting" | undefined;
	const dispatchWake = (): void => {
		if (queue.deferForTarget(cleanName, dispatchWake)) return;
		if (counted) {
			outcome = "queued";
			return;
		}
		setTimeout(() => {
			outcome = counted ? "queued" : "failed_still_counting";
		}, ENDED_QUEUE_OPEN_WAIT_MS);
	};

	dispatchWake();
	await vi.advanceTimersByTimeAsync(ENDED_QUEUE_OPEN_WAIT_MS + 1_500);
	assert.equal(outcome, undefined, "must still wait under the 5 s restore bound past the 2 s open wait");
	assert.equal(queue.holds(cleanName), false, "pending remains immutable while wake waits");

	loadGate.resolve();
	await vi.advanceTimersByTimeAsync(0);
	assert.equal(queue.restorePhase, "ready");
	assert.equal(outcome, "queued");
});

test("resolves host-ID / alias targets canonically so a later live send to a new session ID never overtakes an earlier wake send", async () => {
	const keptName = "subagent-worker-kept-1";
	const targetsGate = deferred<string[]>();
	const loadGate = deferred<void>();
	cleanups.unshift(() => {
		targetsGate.resolve([keptName, "host-kept-1"]);
		loadGate.resolve();
	});
	const { queue } = createQueue(async () =>
		stubStore({
			targets: () => targetsGate.promise,
			load: async (page) => {
				await loadGate.promise;
				page?.([row(1, "k1", keptName, "kept 0")]);
			},
		}),
	);

	const delivered: string[] = [];
	await queue.decide((restored) => {
		for (const q of restored.queues) {
			for (const entry of q.sends) {
				delivered.push((entry.held.clientMessage.message as { content: { text: string } }).content.text);
			}
		}
	});
	assert.equal(queue.restorePhase, "identifying_targets");

	const sender = connectedSession({ id: "sender-1", name: "sender" });
	const sessions = new Map<string, BrokerConnectedSession>([[sender.info.id, sender]]);
	const dispatch = (target: string, text: string, wake: boolean): void => {
		if (shouldHoldSendForEndedQueueRestore(queue, target, sender, sessions)) {
			queue.whenRestored(() => dispatch(target, text, wake));
			return;
		}
		const liveTarget = [...sessions.values()].find(
			(s) => s.info.id === target || s.info.name === target || s.registrationReturnAddress === target,
		);
		if (liveTarget !== undefined) {
			delivered.push(text);
			return;
		}
		if (wake && queue.restorePhase === "identifying_targets") {
			queue.whenRestored(() => dispatch(target, text, wake));
		}
	};

	// Wake send #1 addressed by host ID during identifying_targets, before cleanChild registers.
	dispatch("host-clean-1", "first-wake-by-host-id", true);
	const cleanChild = connectedSession({
		id: "88888888-aaaa-bbbb-cccc-dddddddddddd",
		name: "subagent-clean",
		registrationName: "subagent-clean",
		supervisorId: "owner-1",
		returnAddress: "host-clean-1",
	});
	sessions.set(cleanChild.info.id, cleanChild);

	// Live send #2 addressed by new session ID while still in identifying_targets.
	dispatch(cleanChild.info.id, "second-live-by-new-id", false);
	assert.deepEqual(delivered, []);

	// Once targets() resolves (cleanChild is NOT in pending), both clean sends drain immediately in FIFO order!
	targetsGate.resolve([keptName, "host-kept-1"]);
	await vi.waitFor(() => assert.equal(queue.restorePhase, "loading"));
	assert.deepEqual(delivered, ["first-wake-by-host-id", "second-live-by-new-id"]);

	// Kept subagent: wake send by host ID during loading, then registers with new session ID, then live send by new ID.
	const keptDelivered: string[] = [];
	const dispatchKept = (target: string, text: string): void => {
		if (shouldHoldSendForEndedQueueRestore(queue, target, sender, sessions)) {
			queue.whenRestored(() => dispatchKept(target, text));
			return;
		}
		keptDelivered.push(text);
	};
	dispatchKept("host-kept-1", "kept-after-1-by-host");
	const keptChild = connectedSession({
		id: "77777777-aaaa-bbbb-cccc-dddddddddddd",
		name: "renamed-kept",
		registrationName: "different-reg-name",
		supervisorId: "owner-1",
		returnAddress: "host-kept-1",
	});
	sessions.set(keptChild.info.id, keptChild);
	dispatchKept(keptChild.info.id, "kept-after-2-by-new-id");
	assert.deepEqual(keptDelivered, [], "new session ID resolves via host-kept-1 in pending");

	loadGate.resolve();
	await queue.untilLoaded();
	assert.deepEqual(keptDelivered, ["kept-after-1-by-host", "kept-after-2-by-new-id"]);
});

test("holds cross-group vertical-bypass and return-path sends across all addressing forms without duplicate ambiguity or new non-subagent holds", async () => {
	const keptName = "subagent-worker-vb-1";
	const cleanName = "subagent-worker-vb-clean-1";
	const targetsGate = deferred<string[]>();
	const loadGate = deferred<void>();
	cleanups.unshift(() => {
		targetsGate.resolve([keptName]);
		loadGate.resolve();
	});
	const { queue } = createQueue(async () =>
		stubStore({
			targets: () => targetsGate.promise,
			load: () => loadGate.promise,
		}),
	);
	await queue.decide(() => {});
	assert.equal(queue.restorePhase, "identifying_targets");

	const supervisor = connectedSession({
		id: "aaaaaaaa-1111-2222-3333-444444444444",
		name: "supervisor",
		groups: ["default"],
	});
	const sameGroupPeer = connectedSession({
		id: "bbbbbbbb-1111-2222-3333-444444444444",
		name: "shared-peer-name",
		groups: ["default"],
		returnAddress: "host-same-group-peer",
	});
	const sameGroupCollidingPeer = connectedSession({
		id: "cccccccc-1111-2222-3333-444444444444",
		name: keptName,
		groups: ["default"],
		returnAddress: "host-colliding-peer",
	});
	const isolatedPeer = connectedSession({
		id: "dddddddd-1111-2222-3333-444444444444",
		name: "isolated-non-subagent",
		groups: ["isolated"],
		returnAddress: "host-isolated-peer",
	});
	const keptChild = connectedSession({
		id: "11223344-aaaa-bbbb-cccc-dddddddddddd",
		name: "renamed-vb-worker",
		registrationName: keptName,
		groups: ["isolated"],
		supervisorId: supervisor.info.id,
		returnAddress: "host-vb-kept-1",
	});
	const shadowedReturnChild = connectedSession({
		id: "55667788-aaaa-bbbb-cccc-dddddddddddd",
		name: "shared-peer-name",
		registrationName: "subagent-worker-shadowed-1",
		groups: ["isolated"],
		supervisorId: supervisor.info.id,
		returnAddress: "host-shadowed-1",
	});
	const cleanChild = connectedSession({
		id: "99aabbcc-aaaa-bbbb-cccc-dddddddddddd",
		name: cleanName,
		registrationName: cleanName,
		groups: ["isolated"],
		supervisorId: supervisor.info.id,
		returnAddress: "host-vb-clean-1",
	});
	const collidingNameChild = connectedSession({
		id: "ddeeff00-aaaa-bbbb-cccc-dddddddddddd",
		name: keptName,
		registrationName: keptName,
		groups: ["isolated"],
		supervisorId: supervisor.info.id,
		returnAddress: "host-colliding-child",
	});
	const sessions = new Map<string, BrokerConnectedSession>([
		[supervisor.info.id, supervisor],
		[sameGroupPeer.info.id, sameGroupPeer],
		[sameGroupCollidingPeer.info.id, sameGroupCollidingPeer],
		[isolatedPeer.info.id, isolatedPeer],
		[keptChild.info.id, keptChild],
		[shadowedReturnChild.info.id, shadowedReturnChild],
		[cleanChild.info.id, cleanChild],
		[collidingNameChild.info.id, collidingNameChild],
	]);

	// Both vertical-bypass (extraReachable) AND return path (returnPathReachable) contain keptChild (and duplicated in
	// extraReachable): every addressing form (ID, 8-hex prefix, renamed name, host session ID) MUST hold without
	// false ambiguity!
	const vbAndReturnOptions = {
		extraReachable: [keptChild, keptChild, isolatedPeer, cleanChild],
		returnPathReachable: [keptChild, isolatedPeer],
	};
	for (const addressing of [keptChild.info.id, "11223344", "renamed-vb-worker", "host-vb-kept-1"]) {
		assert.equal(
			shouldHoldSendForEndedQueueRestore(queue, addressing, supervisor, sessions, vbAndReturnOptions),
			true,
			`identifying_targets must hold vertical-bypass reply addressed by ${addressing}`,
		);
	}
	// Clean subagent in extraReachable waits during identifying_targets; non-subagent peer NEVER waits.
	assert.equal(
		shouldHoldSendForEndedQueueRestore(queue, "host-vb-clean-1", supervisor, sessions, vbAndReturnOptions),
		true,
	);
	for (const addressing of [isolatedPeer.info.id, "dddddddd", "isolated-non-subagent", "host-isolated-peer"]) {
		assert.equal(
			shouldHoldSendForEndedQueueRestore(queue, addressing, supervisor, sessions, vbAndReturnOptions),
			false,
			`non-subagent peer in extraReachable/returnPath must never hold (${addressing})`,
		);
	}

	// Return-path-only subagent: ID/name/prefix hold, but host session ID does NOT resolve via return path, and a
	// same-group peer with the same display name shadows the return-path fallback (matching handleBrokerSend).
	const returnOnlyOptions = { returnPathReachable: [keptChild, shadowedReturnChild] };
	assert.equal(
		shouldHoldSendForEndedQueueRestore(queue, keptChild.info.id, supervisor, sessions, returnOnlyOptions),
		true,
	);
	assert.equal(
		shouldHoldSendForEndedQueueRestore(queue, "renamed-vb-worker", supervisor, sessions, returnOnlyOptions),
		true,
	);
	assert.equal(shouldHoldSendForEndedQueueRestore(queue, "11223344", supervisor, sessions, returnOnlyOptions), true);
	assert.equal(
		shouldHoldSendForEndedQueueRestore(queue, "host-vb-kept-1", supervisor, sessions, returnOnlyOptions),
		false,
		"return-path-only session must not be held by host session ID (handleBrokerSend does not resolve return paths by host ID)",
	);
	assert.equal(
		shouldHoldSendForEndedQueueRestore(queue, "shared-peer-name", supervisor, sessions, returnOnlyOptions),
		false,
		"same-group non-subagent peer shadows return-path-only subagent with the same name",
	);

	// Ambiguous name between same-group peer and extraReachable subagent fails immediately in handleBrokerSend: never hold.
	const ambiguousOptions = { extraReachable: [collidingNameChild] };
	assert.equal(
		shouldHoldSendForEndedQueueRestore(queue, keptName, supervisor, sessions, ambiguousOptions),
		false,
		"ambiguous name in identifying_targets must not hold",
	);

	// Unreachable cross-group subagent (e.g. fabricated replyTo -> not in extraReachable/returnPathReachable): never hold.
	for (const addressing of [keptChild.info.id, "11223344", "renamed-vb-worker", "host-vb-kept-1"]) {
		assert.equal(
			shouldHoldSendForEndedQueueRestore(queue, addressing, supervisor, sessions),
			false,
			`unreachable cross-group subagent must not hold (${addressing})`,
		);
	}

	// Phase: loading (only keptName is pending)
	targetsGate.resolve([keptName]);
	await vi.waitFor(() => assert.equal(queue.restorePhase, "loading"));
	for (const addressing of [keptChild.info.id, "11223344", "renamed-vb-worker", "host-vb-kept-1"]) {
		assert.equal(
			shouldHoldSendForEndedQueueRestore(queue, addressing, supervisor, sessions, vbAndReturnOptions),
			true,
			`loading must hold pending vertical-bypass reply addressed by ${addressing}`,
		);
	}
	assert.equal(
		shouldHoldSendForEndedQueueRestore(queue, cleanChild.info.id, supervisor, sessions, vbAndReturnOptions),
		false,
		"loading must not hold clean subagent in extraReachable",
	);
	assert.equal(
		shouldHoldSendForEndedQueueRestore(queue, "host-vb-clean-1", supervisor, sessions, vbAndReturnOptions),
		false,
		"loading must not hold clean subagent host ID in extraReachable",
	);
	assert.equal(
		shouldHoldSendForEndedQueueRestore(queue, keptName, supervisor, sessions, ambiguousOptions),
		false,
		"ambiguous name collision in loading must not fall through to queue.holds(trimmed)",
	);

	loadGate.resolve();
	await queue.untilLoaded();
	assert.equal(queue.restorePhase, "ready");
	assert.equal(
		shouldHoldSendForEndedQueueRestore(queue, "host-vb-kept-1", supervisor, sessions, vbAndReturnOptions),
		false,
	);
});

test("retargetSendToSessionId delivers to the exact resumed session across renames, old IDs, colliding peers, and detached senders while preserving signatures and #2603 prefix checks", () => {
	const senderSocket = {} as net.Socket;
	const targetSocket = {} as net.Socket;
	const collidingSocket = {} as net.Socket;
	const sender = {
		...connectedSession({
			id: "11111111-1111-2222-3333-444444444444",
			name: "sender",
			returnAddress: "sender-host-1",
		}),
		socket: senderSocket,
	};
	const resumedChild = {
		...connectedSession({
			id: "22222222-1111-2222-3333-444444444444",
			name: "renamed-child",
			registrationName: "subagent-worker-orig",
			supervisorId: "owner-1",
			returnAddress: "child-host-1",
		}),
		socket: targetSocket,
	};
	const collidingPeer = {
		...connectedSession({
			id: "33333333-1111-2222-3333-444444444444",
			name: "subagent-worker-orig",
			returnAddress: "colliding-host-1",
		}),
		socket: collidingSocket,
	};
	const sessions = new Map<string, BrokerConnectedSession>([
		[resumedChild.info.id, resumedChild],
		[collidingPeer.info.id, collidingPeer],
	]);
	const deliveredMessages = new DeliveredMessageCache();
	const frames: Array<{ socket: net.Socket; frame: BrokerMessage }> = [];
	const write = (socket: net.Socket, frame: BrokerMessage): boolean => {
		frames.push({ socket, frame });
		return true;
	};

	// 1. Detached (disconnected) sender whose kept row originally targeted the old display name (now owned by
	// collidingPeer) delivers strictly to resumedChild with heldWhilePaused, leaving original frame untouched.
	const origNamed: SendClientMessage = {
		type: "send",
		to: "subagent-worker-orig",
		wakeEndedRecipient: true,
		message: { id: "msg-named", timestamp: 1, content: { text: "hello renamed" } },
	};
	detachSend(origNamed, sender);
	const retargetedNamed = retargetSendToSessionId(origNamed, resumedChild.info.id, {
		id: "msg-named",
		timestamp: 1,
		heldWhilePaused: true,
		content: { text: "hello renamed" },
	});
	handleBrokerSend(senderSocket, retargetedNamed, sender.info.id, sessions, deliveredMessages, write);
	assert.equal(origNamed.to, "subagent-worker-orig", "original SendClientMessage is never mutated");
	assert.equal(
		frames.some((f) => f.socket === targetSocket && f.frame.type === "message" && f.frame.message.id === "msg-named"),
		true,
		"delivered strictly to resumedChild",
	);
	assert.equal(
		frames.some((f) => f.socket === collidingSocket),
		false,
		"collidingPeer must never receive retargeted wake send",
	);
	assert.equal(
		frames.some(
			(f) => f.socket === senderSocket && f.frame.type === "delivered" && f.frame.messageId === "msg-named",
		),
		true,
	);

	// 2. Signature dedup: retrying msg-named with its original logical target matches DeliveredMessageCache instead of
	// raising message_id_conflict.
	frames.length = 0;
	const retrySameSig = retargetSendToSessionId(origNamed, resumedChild.info.id);
	handleBrokerSend(senderSocket, retrySameSig, sender.info.id, sessions, deliveredMessages, write);
	assert.deepEqual(
		frames.map((f) => [f.socket === senderSocket, f.frame.type]),
		[[true, "delivered"]],
		"retry with preserved logicalTarget deduplicates cleanly without conflict",
	);

	// 3. Kept row originally addressed by old session ID / 8-hex prefix delivers without hitting #2603 prefix rejection.
	frames.length = 0;
	const origOldId: SendClientMessage = {
		type: "send",
		to: "99999999-aaaa-bbbb-cccc-dddddddddddd",
		logicalTarget: "99999999",
		wakeEndedRecipient: true,
		message: { id: "msg-old-id", timestamp: 2, content: { text: "hello from old id" } },
	};
	detachSend(origOldId, sender);
	handleBrokerSend(
		senderSocket,
		retargetSendToSessionId(origOldId, resumedChild.info.id),
		sender.info.id,
		sessions,
		deliveredMessages,
		write,
	);
	assert.equal(
		frames.some(
			(f) => f.socket === targetSocket && f.frame.type === "message" && f.frame.message.id === "msg-old-id",
		),
		true,
	);

	// 4. Disconnected retargeted session fails with "Session not found" and NEVER falls back to collidingPeer.
	frames.length = 0;
	sessions.delete(resumedChild.info.id);
	const origForGone: SendClientMessage = {
		type: "send",
		to: "subagent-worker-orig",
		wakeEndedRecipient: true,
		message: { id: "msg-gone", timestamp: 3, content: { text: "target gone" } },
	};
	detachSend(origForGone, sender);
	handleBrokerSend(
		senderSocket,
		retargetSendToSessionId(origForGone, resumedChild.info.id),
		sender.info.id,
		sessions,
		deliveredMessages,
		write,
	);
	assert.equal(
		frames.some((f) => f.socket === collidingSocket),
		false,
		"never falls back to colliding peer",
	);
	assert.equal(
		frames.some(
			(f) =>
				f.socket === senderSocket &&
				f.frame.type === "delivery_failed" &&
				f.frame.messageId === "msg-gone" &&
				f.frame.reason === "Session not found",
		),
		true,
	);

	// 5. Ordinary non-retargeted client sends still enforce #2603 prefix revalidation.
	frames.length = 0;
	sessions.set(sender.info.id, sender);
	sessions.set(resumedChild.info.id, resumedChild);
	const clientPrefixSend: SendClientMessage = {
		type: "send",
		to: resumedChild.info.id,
		logicalTarget: "subagent-worker-orig",
		message: { id: "msg-2603", timestamp: 4, content: { text: "stale canonical target" } },
	};
	handleBrokerSend(senderSocket, clientPrefixSend, sender.info.id, sessions, deliveredMessages, write);
	assert.equal(
		frames.some(
			(f) => f.socket === senderSocket && f.frame.type === "delivery_failed" && f.frame.messageId === "msg-2603",
		),
		true,
		"non-retargeted client send must still fail #2603 canonical-target revalidation",
	);
	assert.equal(
		frames.some((f) => f.socket === targetSocket),
		false,
	);
});
