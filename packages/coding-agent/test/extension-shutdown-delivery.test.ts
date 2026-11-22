import assert from "node:assert/strict";
import { test } from "vitest";
import { createEventBus } from "../src/core/event-bus.js";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.js";
import { ExtensionRunner } from "../src/core/extensions/runner.js";

test("shutdown delivers later handlers when the runner retires during an awaited handler", async () => {
	const runtime = createExtensionRuntime();
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	const calls: string[] = [];
	const extension = await loadExtensionFromFactory(
		(atomic) => {
			atomic.on("session_shutdown", async () => {
				calls.push("first started");
				await pending;
				calls.push("first finished");
			});
			atomic.on("session_shutdown", () => {
				calls.push("later started");
			});
		},
		process.cwd(),
		createEventBus(),
		runtime,
		"<shutdown>",
	);
	const runner = new ExtensionRunner([extension], runtime, process.cwd(), {} as never, {} as never);
	const delivery = runner.emit({ type: "session_shutdown", reason: "reload" });
	assert.deepEqual(calls, ["first started"]);
	runner.invalidate();
	release();
	await delivery;
	assert.deepEqual(calls, ["first started", "first finished", "later started"]);
});
