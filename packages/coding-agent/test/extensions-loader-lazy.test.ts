import assert from "node:assert/strict";
import { test, vi } from "vitest";

vi.mock("jiti", () => {
	throw new Error("eager jiti load");
});
vi.mock("jiti/static", () => {
	throw new Error("eager static transform load");
});

// Upstream #9540: inline extensions do not require the TypeScript transformer.
test("loads an inline factory without importing either jiti entry", async () => {
	const { createExtensionRuntime, loadExtensionFromFactory } = await import("../src/core/extensions/loader.js");
	const { createEventBus } = await import("../src/core/event-bus.js");
	const extension = await loadExtensionFromFactory(
		(atomic) => {
			atomic.registerCommand("lazy", { description: "fixture", handler: async () => {} });
		},
		process.cwd(),
		createEventBus(),
		createExtensionRuntime(),
		"<inline:lazy>",
	);
	assert.ok(extension.commands.has("lazy"));
});
