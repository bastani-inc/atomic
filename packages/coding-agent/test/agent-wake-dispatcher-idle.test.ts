import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { AgentWakeDispatcher, agentWakeDispatcher } from "../src/core/agent-wake-dispatcher.ts";

const flush = async (): Promise<void> => {
	for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setImmediate(resolve));
};

function busyDispatcher() {
	const dispatcher = new AgentWakeDispatcher();
	const gate = Promise.withResolvers<void>();
	const stopHandling = dispatcher.handle("t", async () => {
		await gate.promise;
	});
	return { dispatcher, gate, stopHandling };
}

describe("whenIdle waits for the work it names (#4326)", () => {
	test("the whole dispatcher is idle only when its last key is, and a key only when it is", async () => {
		const { dispatcher, gate } = busyDispatcher();
		const delivered = dispatcher.deliver("t:a", { id: "w", kind: "timer" });
		await flush();
		const idle: string[] = [];
		void dispatcher.whenIdle().then(() => idle.push("all"));
		void dispatcher.whenIdle("t:a").then(() => idle.push("t:a"));
		await dispatcher.whenIdle("t:other");
		await flush();
		assert.deepEqual(idle, [], "work is running, so neither has resolved");
		gate.resolve();
		await delivered;
		await dispatcher.whenIdle();
		assert.deepEqual(idle.sort(), ["all", "t:a"]);
	});

	test("every waiter on one key resolves, not only the last", async () => {
		const { dispatcher, gate } = busyDispatcher();
		const delivered = dispatcher.deliver("t:a", { id: "w", kind: "timer" });
		await flush();
		const resolved: number[] = [];
		const first = dispatcher.whenIdle("t:a").then(() => resolved.push(1));
		const second = dispatcher.whenIdle("t:a").then(() => resolved.push(2));
		const third = dispatcher.whenIdle("t:a").then(() => resolved.push(3));
		gate.resolve();
		await delivered;
		await Promise.all([first, second, third]);
		assert.deepEqual(resolved.sort(), [1, 2, 3]);
	});

	test("an idle key leaves no waiters behind", async () => {
		const { dispatcher, gate } = busyDispatcher();
		const delivered = dispatcher.deliver("t:a", { id: "w", kind: "timer" });
		await flush();
		const idle = dispatcher.whenIdle("t:a");
		assert.equal((Reflect.get(dispatcher, "keyIdleWaiters") as Map<string, object>).size, 1);
		gate.resolve();
		await delivered;
		await idle;
		assert.equal((Reflect.get(dispatcher, "keyIdleWaiters") as Map<string, object>).size, 0);
	});
});

describe("a namespace's slots outlive its handler while it still runs (#4326)", () => {
	test("removing the handler of a namespace with running work keeps its slot record until that work ends", async () => {
		const { dispatcher, gate, stopHandling } = busyDispatcher();
		const delivered = dispatcher.deliver("t:a", { id: "w", kind: "timer" });
		await flush();
		assert.equal(dispatcher.stats().namespaces, 1);
		stopHandling();
		assert.equal(dispatcher.stats().namespaces, 1, "its work is still running");
		gate.resolve();
		await delivered;
		await dispatcher.whenIdle();
		assert.equal(dispatcher.stats().namespaces, 0);
	});
});

describe("the process dispatcher (#4326)", () => {
	test("every caller gets the same dispatcher, created once", () => {
		const first = agentWakeDispatcher();
		assert.ok(first instanceof AgentWakeDispatcher);
		assert.equal(agentWakeDispatcher(), first);
	});
});
