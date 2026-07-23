import { test } from "bun:test";
import assert from "node:assert/strict";
import { InteractiveEngineMonitor } from "../../packages/coding-agent/src/modes/interactive-engine/engine-monitor.ts";

function createMonitor(): InteractiveEngineMonitor {
	return new InteractiveEngineMonitor(() => {}, () => {});
}

test("waitUntilReady resolves once the engine reports ready", async () => {
	const monitor = createMonitor();
	assert.equal(monitor.handleLine(JSON.stringify({ type: "engine_ready", protocolVersion: 1, pid: 123 })), true);
	await monitor.waitUntilReady();
	monitor.stop();
});

test("waitUntilReady has no deadline: it stays pending during a slow start", async () => {
	const monitor = createMonitor();
	let settled = false;
	const wait = monitor.waitUntilReady().then(() => { settled = true; });
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(settled, false);
	monitor.handleLine(JSON.stringify({ type: "engine_ready", protocolVersion: 1, pid: 123 }));
	await wait;
	assert.equal(settled, true);
	monitor.stop();
});

test("waitUntilReady rejects when the engine fails before becoming ready", async () => {
	const monitor = createMonitor();
	const wait = monitor.waitUntilReady();
	monitor.fail(new Error("engine exited"));
	await assert.rejects(wait, /engine exited/);
	monitor.stop();
});

test("fail after ready does not affect a completed waitUntilReady", async () => {
	const monitor = createMonitor();
	monitor.handleLine(JSON.stringify({ type: "engine_ready", protocolVersion: 1, pid: 123 }));
	await monitor.waitUntilReady();
	monitor.fail(new Error("late failure"));
	await monitor.waitUntilReady();
	monitor.stop();
});
