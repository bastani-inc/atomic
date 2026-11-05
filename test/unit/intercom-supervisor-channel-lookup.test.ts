import assert from "node:assert/strict";
import { test } from "vitest";
import { SupervisorChannelCache } from "../../packages/intercom/broker/supervisor-channel.js";

const trackedChildren = (cache: SupervisorChannelCache): string[] =>
	[...(Reflect.get(cache, "latestByChild") as Map<string, string>).keys()].sort();

test("the supervisor of a child is found by its name however it is cased or padded, and an unknown child has none (#4326)", () => {
	const cache = new SupervisorChannelCache();
	cache.authorize("supervisor-1", "token-1", "Subagent-Worker-1");
	assert.deepEqual(cache.supervisorOf("  subagent-worker-1 "), {
		supervisorId: "supervisor-1",
		ownerToken: "token-1",
	});
	assert.equal(cache.supervisorOf("subagent-worker-2"), undefined);
});

test("a dynamic slot names no child, until a child claims it, and then that child's supervisor is found (#4326)", () => {
	const cache = new SupervisorChannelCache();
	const capability = cache.authorize("supervisor-1", "token-1", "*");
	assert.equal(cache.supervisorOf("*"), undefined, "the wildcard is not a child");
	assert.equal(cache.claim(capability, "worker-9"), "supervisor-1");
	assert.deepEqual(cache.supervisorOf("worker-9"), { supervisorId: "supervisor-1", ownerToken: "token-1" });
});

test("the oldest authorization goes first once the cache is full, with the child it named (#4326)", () => {
	const cache = new SupervisorChannelCache(60_000, 2);
	cache.authorize("supervisor-1", "token-1", "worker-a");
	cache.authorize("supervisor-1", "token-1", "worker-b");
	cache.authorize("supervisor-1", "token-1", "worker-c");
	assert.equal(cache.supervisorOf("worker-a"), undefined);
	assert.deepEqual(trackedChildren(cache), ["worker-b", "worker-c"], "the evicted child is no longer tracked");
	assert.ok(cache.supervisorOf("worker-b"));
	assert.ok(cache.supervisorOf("worker-c"));
});

test("an evicted authorization takes the child a dynamic slot bound, but not a child a newer authorization names (#4326)", () => {
	const cache = new SupervisorChannelCache(60_000, 2);
	const dynamic = cache.authorize("supervisor-1", "token-1", "*");
	cache.claim(dynamic, "worker-x");
	assert.ok(cache.supervisorOf("worker-x"));
	cache.authorize("supervisor-2", "token-2", "worker-y");
	cache.authorize("supervisor-3", "token-3", "worker-z");
	assert.equal(cache.supervisorOf("worker-x"), undefined, "the slot that bound it was evicted");
	assert.deepEqual(
		trackedChildren(cache),
		["worker-y", "worker-z"],
		"neither the wildcard nor the bound child is tracked",
	);

	const newer = new SupervisorChannelCache(60_000, 2);
	newer.authorize("supervisor-1", "token-1", "worker-a");
	newer.authorize("supervisor-2", "token-2", "worker-a");
	newer.authorize("supervisor-3", "token-3", "worker-b");
	assert.equal(
		newer.supervisorOf("worker-a")?.supervisorId,
		"supervisor-2",
		"the older authorization left, the newer stays",
	);
	assert.deepEqual(
		trackedChildren(newer),
		["worker-a", "worker-b"],
		"the child a newer authorization names stays tracked",
	);
});
