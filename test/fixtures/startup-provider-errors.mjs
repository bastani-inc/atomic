import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { createEventBus } from "../../packages/coding-agent/dist/core/event-bus.js";
import {
	createExtensionRuntime,
	loadExtensionFromFactory,
} from "../../packages/coding-agent/dist/core/extensions/loader.js";
import llamaExtension from "../../packages/coding-agent/dist/extensions/llama/index.js";

const independent = process.argv[2] === "independent";
const providerError = new Error("bad provider metadata");
const commandError = new Error("command name reserved");
const unhandled = [];
if (independent) process.on("unhandledRejection", (error) => unhandled.push(error));
const calls = [];
const fulfilled = Promise.resolve();
fulfilled.then = (...args) => {
	calls.push("then");
	return Promise.prototype.then.call(fulfilled, ...args).finally(() => {
		throw new Error("observer cleanup failed");
	});
};
const factory = (pi) => llamaExtension({
	...pi,
	registerProvider() {
		calls.push("provider");
		return independent ? Promise.reject(providerError) : fulfilled;
	},
	registerCommand() {
		calls.push("command");
		throw commandError;
	},
});
await assert.rejects(
	loadExtensionFromFactory(factory, process.cwd(), createEventBus(), createExtensionRuntime()),
	(error) => error === commandError,
);
await setImmediate();
assert.deepEqual(calls, ["provider", "command"]);
if (independent) assert.deepEqual(unhandled, [providerError]);
