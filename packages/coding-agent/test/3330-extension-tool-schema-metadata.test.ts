import assert from "node:assert/strict";
import { Type } from "typebox";
import { test } from "vitest";
import { createEventBus } from "../src/core/event-bus.js";
import {
	createExtensionRuntime,
	instantiateExtensions,
	loadExtensionFromFactory,
} from "../src/core/extensions/loader.js";
import { copyRegistrations } from "../src/core/extensions/loader-bindings.js";
import type { ExtensionContext, ToolDefinition } from "../src/core/extensions/types.js";

function createTool(): ToolDefinition {
	return {
		name: "metadata_probe",
		label: "Metadata probe",
		description: "fixture",
		parameters: Type.Object({
			input: Type.Unknown(),
			note: Type.Optional(Type.String()),
			extra: Type.Record(Type.String(), Type.Unknown()),
		}),
		execute: async () => ({ content: [{ type: "text", text: "probed" }], details: undefined }),
	};
}

function assertSchemaCopied(tool: ToolDefinition): void {
	const json = JSON.stringify(tool.parameters);
	assert.doesNotMatch(json, /~kind/);
	assert.doesNotMatch(json, /~optional/);
	assert.equal(json, JSON.stringify(createTool().parameters));
	assert.equal(tool.name, "metadata_probe");
}

async function assertExecutes(tool: ToolDefinition): Promise<void> {
	const result = await tool.execute("call", { input: 1, extra: {} }, undefined, undefined, {} as ExtensionContext);
	assert.deepEqual(result.content, [{ type: "text", text: "probed" }]);
}

test("copied extension tool schemas keep TypeBox metadata out of JSON (#3330)", async () => {
	const original = createTool();
	assert.equal(JSON.stringify(original.parameters).includes("~kind"), false);

	let wrappedCalls = 0;
	const copied = copyRegistrations(original, (fn) => (...args: never[]) => {
		wrappedCalls++;
		return fn(...args);
	});
	assertSchemaCopied(copied);
	await assertExecutes(copied);
	assert.equal(wrappedCalls, 1);

	const runtime = createExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		(pi) => pi.registerTool(createTool()),
		process.cwd(),
		createEventBus(),
		runtime,
		"<inline:3330>",
	);
	const loaded = extension.tools.get("metadata_probe")?.definition;
	assert.ok(loaded);
	assertSchemaCopied(loaded);
	await assertExecutes(loaded);

	const reloaded = await instantiateExtensions({ extensions: [extension], runtime, errors: [] }, process.cwd());
	const replayed = reloaded.extensions[0]?.tools.get("metadata_probe")?.definition;
	assert.ok(replayed);
	assertSchemaCopied(replayed);
	await assertExecutes(replayed);
});
