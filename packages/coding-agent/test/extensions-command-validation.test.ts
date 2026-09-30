import assert from "node:assert/strict";
import { test } from "vitest";
import { createEventBus } from "../src/core/event-bus.js";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.js";

for (const name of [undefined, null, 42, ""]) {
	test(`rejects an invalid extension command name ${JSON.stringify(name)} (#10054)`, async () => {
		await assert.rejects(
			loadExtensionFromFactory(
				(pi) => {
					Reflect.apply(pi.registerCommand, pi, [name, { handler: async () => {} }]);
				},
				process.cwd(),
				createEventBus(),
				createExtensionRuntime(),
				"<inline:invalid-command>",
			),
			/non-empty string name/,
		);
	});
}

for (const options of [undefined, null, {}, { handler: "not a function" }]) {
	test(`rejects invalid extension command options ${JSON.stringify(options)} (#10054)`, async () => {
		await assert.rejects(
			loadExtensionFromFactory(
				(pi) => {
					Reflect.apply(pi.registerCommand, pi, ["invalid", options]);
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
		(pi) => {
			pi.registerCommand("valid", { description: "fixture", handler: async () => {} });
		},
		process.cwd(),
		createEventBus(),
		createExtensionRuntime(),
		"<inline:valid-command>",
	);
	assert(extension.commands.has("valid"));
});
