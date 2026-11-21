import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expectedShadowedNames, writeShadowedNamesExtension } from "./extension-shadowed-names.ts";

// Under Bun, an extension module that declares a name the loader's or jiti's code also reads loads as it does natively,
// on its first load and after a reload.
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "atomic-bun-shadowed-"));
process.env.ATOMIC_CODING_AGENT_DIR = path.join(root, "agent");
fs.mkdirSync(process.env.ATOMIC_CODING_AGENT_DIR);
try {
	const { loadExtensionModule, clearExtensionCache, extensionLoaderTestHooks } = await import(
		"../../src/core/extensions/loader-virtual-modules.ts"
	);
	const { loadExtensionFromFactory, createExtensionRuntime } = await import("../../src/core/extensions/loader.ts");
	const { createEventBus } = await import("../../src/index.ts");
	const extensionDir = path.join(root, "extension");
	fs.mkdirSync(extensionDir);
	const entry = writeShadowedNamesExtension(extensionDir);
	const bus = createEventBus();
	const observations: unknown[] = [];
	bus.on("shadowed-names", (value) => observations.push(value));
	try {
		for (const load of ["first", "reload"]) {
			const factory =
				load === "first"
					? await loadExtensionModule(entry)
					: await extensionLoaderTestHooks.loadTransformedExtensionModule(entry);
			assert.equal(typeof factory, "function", load);
			await loadExtensionFromFactory(factory!, root, bus, createExtensionRuntime(), entry);
			assert.deepEqual(observations.at(-1), expectedShadowedNames(extensionDir), load);
		}
	} finally {
		clearExtensionCache();
	}
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
