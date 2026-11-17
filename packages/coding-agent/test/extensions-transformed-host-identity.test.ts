import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Text } from "@bastani/atomic-tui";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { bunExecutable, moduleDir, spawnSyncCollect } from "../../../test/helpers/runtime.js";
import { createEventBus } from "../src/core/event-bus.js";
import { createExtensionRuntime, loadExtensionFromFactory, loadExtensions } from "../src/core/extensions/loader.js";
import { clearExtensionCache, extensionLoaderTestHooks } from "../src/core/extensions/loader-virtual-modules.js";
import { SessionManager } from "../src/core/session-manager.js";

const REAL_EXTENSION_LOADER_TEST_TIMEOUT_MS = 120_000;

// PR #2973: a first-load native-import fallback must not evaluate the host again.
it("first-load transformed extensions share the live host exports", async () => {
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "atomic-first-load-host-"));
	const entry = path.join(root, "extension.ts");
	fs.writeFileSync(
		entry,
		`import { SessionManager } from "@bastani/atomic";
import { Text } from "@bastani/atomic-tui";
import { Type } from "typebox";
enum Mode { First }
export default function (pi) {
	pi.events.emit("first-load-host", { SessionManager, Text, Type, mode: Mode.First });
}
`,
	);
	const bus = createEventBus();
	const observations: Array<{ SessionManager: object; Text: object; Type: object; mode: number }> = [];
	bus.on("first-load-host", (value) => observations.push(value as (typeof observations)[number]));
	try {
		const loaded = await loadExtensions([entry], root, bus);
		assert.deepEqual(loaded.errors, []);
		assert.equal(observations.length, 1);
		assert.equal(observations[0]!.SessionManager, SessionManager);
		assert.equal(observations[0]!.Text, Text);
		assert.equal(observations[0]!.Type, Type);
		assert.equal(observations[0]!.mode, 0);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		clearExtensionCache();
	}
});

// #2963: Windows reload must not re-evaluate the live host through development aliases.
it(
	"transformed extensions share live host exports while transitive edits reload",
	async () => {
		const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "atomic-host-identity-"));
		const entry = path.join(root, "extension.ts");
		const leaf = path.join(root, "leaf.ts");
		fs.writeFileSync(
			entry,
			`import { SessionManager } from "@bastani/atomic";
import { Text } from "@bastani/atomic-tui";
import { Type } from "typebox";
import { value } from "./helper.js";
export default function (pi) {
	pi.events.emit("host-probe", { SessionManager, Text, Type, value });
}
`,
		);
		fs.writeFileSync(path.join(root, "helper.ts"), 'export { value } from "./leaf.js";\n');
		fs.writeFileSync(leaf, 'export const value = "before";\n');
		const bus = createEventBus();
		const observations: Array<{ SessionManager: object; Text: object; Type: object; value: string }> = [];
		bus.on("host-probe", (value) => observations.push(value as (typeof observations)[number]));
		try {
			for (const value of ["before", "after"]) {
				fs.writeFileSync(leaf, `export const value = ${JSON.stringify(value)};\n`);
				clearExtensionCache();
				// Exercise the same transformed path as Windows reload on every CI platform.
				const factory = await extensionLoaderTestHooks.loadTransformedExtensionModule(entry);
				expect(factory).toBeTypeOf("function");
				await loadExtensionFromFactory(factory!, root, bus, createExtensionRuntime(), entry);
				const observed = observations.at(-1)!;
				expect.soft(observed.SessionManager).toBe(SessionManager);
				expect.soft(observed.Text).toBe(Text);
				expect.soft(observed.Type).toBe(Type);
				expect(observed.value).toBe(value);
				// Deterministic cost guard: host sources must not join the editable graph.
				const files = Object.keys((await extensionLoaderTestHooks.readExtensionGraphManifest(entry))!.files);
				expect.soft(files.filter((file) => /[/\\]coding-agent[/\\]src[/\\]/.test(file))).toEqual([]);
			}
			expect(observations).toHaveLength(2);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			clearExtensionCache();
		}
	},
	REAL_EXTENSION_LOADER_TEST_TIMEOUT_MS,
);

// #2963: supported aliases must stay interchangeable when native first load becomes a transformed reload.
it(
	"keeps coding-agent aliases interchangeable when first load becomes an edited reload",
	() => {
		const result = spawnSyncCollect(
			[bunExecutable(), path.join(moduleDir(import.meta.url), "fixtures/extensions-host-alias-transition.ts")],
			{ timeout: REAL_EXTENSION_LOADER_TEST_TIMEOUT_MS },
		);
		expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
	},
	REAL_EXTENSION_LOADER_TEST_TIMEOUT_MS,
);
