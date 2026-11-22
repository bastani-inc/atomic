import assert from "node:assert/strict";
import { test } from "vitest";
import { createEventBus } from "../src/core/event-bus.js";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.js";

for (const name of [undefined, null, 42, ""]) {
	test(`rejects an invalid extension command name ${JSON.stringify(name)} (#10054)`, async () => {
		await assert.rejects(
			loadExtensionFromFactory(
				(atomic) => {
					Reflect.apply(atomic.registerCommand, atomic, [name, { handler: async () => {} }]);
				},
				process.cwd(),
				createEventBus(),
				createExtensionRuntime(),
				"<inline:invalid-command>",
			),
			/non-empty string name\. Use atomic\.registerCommand\(/,
		);
	});
}

for (const options of [undefined, null, {}, { handler: "not a function" }]) {
	test(`rejects invalid extension command options ${JSON.stringify(options)} (#10054)`, async () => {
		await assert.rejects(
			loadExtensionFromFactory(
				(atomic) => {
					Reflect.apply(atomic.registerCommand, atomic, ["invalid", options]);
				},
				process.cwd(),
				createEventBus(),
				createExtensionRuntime(),
				"<inline:invalid-command>",
			),
			/must define handler\(\)/,
		);
	});
}

test("accepts a named extension command with a handler (#10054)", async () => {
	const extension = await loadExtensionFromFactory(
		(atomic) => {
			atomic.registerCommand("valid", { description: "fixture", handler: async () => {} });
		},
		process.cwd(),
		createEventBus(),
		createExtensionRuntime(),
		"<inline:valid-command>",
	);
	assert(extension.commands.has("valid"));
});
