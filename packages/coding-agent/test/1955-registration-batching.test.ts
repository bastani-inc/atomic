import { expect, test } from "vitest";
import { createExtensionRuntime } from "../src/core/extensions/loader-runtime.ts";
import { collectRegisteredTools } from "../src/core/extensions/runner-registries.ts";
import type { Extension, RegisteredTool } from "../src/core/extensions/types.ts";

function extension(path: string, origin: "atomic" | "inherited-pi"): Extension {
	return {
		path,
		resolvedPath: path,
		sourceInfo: { path, source: "test", scope: "user", origin: "top-level", configurationOrigin: origin },
		handlers: new Map(),
		tools: new Map(),
		messageRenderers: new Map(),
		entryRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}

function tool(name: string): RegisteredTool {
	return { definition: { name } as never, extensionPath: "test", sourceInfo: {} as never };
}

test("explicit refreshes hide pending inherited tools across nested registration batches", () => {
	const runtime = createExtensionRuntime();
	const inherited = extension("inherited", "inherited-pi");
	const atomic = extension("atomic", "atomic");
	const extensions = [inherited, atomic];
	const snapshots: string[][] = [];
	runtime.refreshTools = () => snapshots.push(collectRegisteredTools(extensions).map((entry) => entry.definition.name));

	runtime.beginResourceRegistrationBatch?.();
	inherited.tools.set("pending-inherited", tool("pending-inherited"));
	runtime.refreshToolsAfterRegistration?.(inherited, "pending-inherited", true);
	runtime.beginResourceRegistrationBatch?.();
	atomic.tools.set("atomic-now", tool("atomic-now"));
	runtime.refreshToolsAfterRegistration?.(atomic, "atomic-now", false);
	runtime.endResourceRegistrationBatch?.();

	expect(snapshots).toEqual([["atomic-now"]]);
	runtime.endResourceRegistrationBatch?.();
	expect(snapshots).toEqual([["atomic-now"], ["pending-inherited", "atomic-now"]]);
});
