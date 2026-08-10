import { expect, test } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionAPI } from "../src/core/extensions/loader-api.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader-runtime.ts";
import type { Extension } from "../src/core/extensions/types.ts";
import { isStaleExtensionContextError } from "../src/index.ts";

function extension(): Extension {
	return {
		path: "/tmp/stale-context-extension.ts",
		resolvedPath: "/tmp/stale-context-extension.ts",
		sourceInfo: {
			path: "/tmp/stale-context-extension.ts",
			source: "test",
			scope: "user",
			origin: "top-level",
			configurationOrigin: "bundled",
		},
		handlers: new Map(),
		tools: new Map(),
		messageRenderers: new Map(),
		entryRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}

test("exported predicate recognizes a real stale extension API error", () => {
	const runtime = createExtensionRuntime();
	const pi = createExtensionAPI(extension(), runtime, "/tmp", createEventBus());

	pi.registerMarkdownTransformer((markdown) => markdown);
	runtime.invalidate();

	let caught: unknown;
	try {
		pi.registerMarkdownTransformer((markdown) => markdown);
	} catch (error) {
		caught = error;
	}

	expect(caught).toBeInstanceOf(Error);
	expect(isStaleExtensionContextError(caught)).toBe(true);
});
