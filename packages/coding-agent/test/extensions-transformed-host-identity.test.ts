import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "@bastani/atomic-schema/typebox";
import { Text } from "@bastani/atomic-tui";
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

// Forked packages ship as shared files behind a re-exporting file per module: package roots, legacy names and deep
// paths must keep reaching one instance of each module, before and after a reload.
it(
	"extensions reach the host's forked-package instances by package and legacy names, before and after a reload",
	async () => {
		const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "atomic-forked-identity-"));
		const entry = path.join(root, "extension.ts");
		fs.writeFileSync(
			entry,
			`import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@bastani/atomic-tui";
import { getKeybindings as legacyGetKeybindings } from "@earendil-works/pi-tui";
import { Type, validateToolArguments } from "@bastani/atomic-ai";
import { validateToolArguments as legacyValidate } from "@mariozechner/pi-ai";
import { Agent } from "@bastani/atomic-agent-core";
import { Agent as legacyAgent } from "@earendil-works/pi-agent-core";
export default function (pi) {
	const installed = new KeybindingsManager(TUI_KEYBINDINGS);
	setKeybindings(installed);
	pi.events.emit("forked-probe", {
		KeybindingsManager,
		setKeybindings,
		installed,
		seenByRoot: getKeybindings(),
		seenByLegacy: legacyGetKeybindings(),
		Type,
		validateToolArguments,
		legacyValidate,
		Agent,
		legacyAgent,
	});
}
`,
		);
		const tui = await import("@bastani/atomic-tui");
		const deepTui = await import("@bastani/atomic-tui/dist/keybindings.js");
		const ai = await import("@bastani/atomic-ai");
		const deepRetry = await import("@bastani/atomic-ai/utils/retry");
		const agentCore = await import("@bastani/atomic-agent-core");
		const original = tui.getKeybindings();
		const bus = createEventBus();
		const observations: Array<Record<string, unknown>> = [];
		bus.on("forked-probe", (value) => observations.push(value as Record<string, unknown>));
		try {
			for (const load of ["first", "reload"]) {
				clearExtensionCache();
				const factory =
					load === "first"
						? await extensionLoaderTestHooks.loadExtensionModuleTransformed(entry)
						: await extensionLoaderTestHooks.loadTransformedExtensionModule(entry);
				expect(factory).toBeTypeOf("function");
				await loadExtensionFromFactory(factory!, root, bus, createExtensionRuntime(), entry);
				const observed = observations.at(-1)!;
				expect.soft(observed.KeybindingsManager).toBe(tui.KeybindingsManager);
				expect.soft(deepTui.KeybindingsManager).toBe(tui.KeybindingsManager);
				expect.soft(observed.setKeybindings).toBe(tui.setKeybindings);
				// The table an extension installs is the one every other specifier sees.
				expect.soft(observed.seenByRoot).toBe(observed.installed);
				expect.soft(observed.seenByLegacy).toBe(observed.installed);
				expect.soft(tui.getKeybindings()).toBe(observed.installed);
				expect.soft(observed.Type).toBe(ai.Type);
				expect.soft(observed.validateToolArguments).toBe(ai.validateToolArguments);
				expect.soft(observed.legacyValidate).toBe(ai.validateToolArguments);
				expect.soft(deepRetry.retryDelayMs).toBe(ai.retryDelayMs);
				expect.soft(observed.Agent).toBe(agentCore.Agent);
				expect.soft(observed.legacyAgent).toBe(agentCore.Agent);
			}
			expect(observations).toHaveLength(2);
		} finally {
			tui.setKeybindings(original);
			fs.rmSync(root, { recursive: true, force: true });
			clearExtensionCache();
		}
	},
	REAL_EXTENSION_LOADER_TEST_TIMEOUT_MS,
);

// The loader evaluates an extension's transformed code, but each module's `import.meta` still describes its own file,
// as when the module is imported natively.
it(
	"an extension's import.meta names its own file, on its first load and after a reload",
	async () => {
		const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "atomic-import-meta-"));
		const entry = path.join(root, "extension.ts");
		fs.writeFileSync(
			entry,
			`export default function (pi) {
	const meta = import.meta;
	const { filename } = import.meta;
	pi.events.emit("meta-probe", {
		url: import.meta.url,
		filename: import.meta.filename,
		dirname: import.meta.dirname,
		aliasedDirname: meta.dirname,
		destructuredFilename: filename,
		resolved: meta.resolve("./extension.ts"),
		// As a native import.meta.resolve answers.
		builtins: [import.meta.resolve("node:fs"), meta.resolve("fs"), meta.resolve("fs/promises")],
		missingFile: meta.resolve("./missing.js"),
		missingPackage: (() => {
			try {
				return meta.resolve("atomic-no-such-package");
			} catch (error) {
				return error.code;
			}
		})(),
		bunDir: meta.dir,
	});
}
`,
		);
		const bus = createEventBus();
		const observations: object[] = [];
		bus.on("meta-probe", (value) => observations.push(value as object));
		try {
			for (const load of ["first", "reload"]) {
				clearExtensionCache();
				const factory =
					load === "first"
						? await extensionLoaderTestHooks.loadExtensionModuleTransformed(entry)
						: await extensionLoaderTestHooks.loadTransformedExtensionModule(entry);
				expect(factory).toBeTypeOf("function");
				await loadExtensionFromFactory(factory!, root, bus, createExtensionRuntime(), entry);
				expect(observations.at(-1)).toEqual({
					url: pathToFileURL(entry).href,
					filename: entry,
					dirname: root,
					aliasedDirname: root,
					destructuredFilename: entry,
					resolved: pathToFileURL(entry).href,
					builtins: ["node:fs", "node:fs", "node:fs/promises"],
					missingFile: pathToFileURL(path.join(root, "missing.js")).href,
					missingPackage: "ERR_MODULE_NOT_FOUND",
					// Node's `import.meta` has no Bun properties.
					bunDir: undefined,
				});
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			clearExtensionCache();
		}
	},
	REAL_EXTENSION_LOADER_TEST_TIMEOUT_MS,
);

// What the loader adds to an extension's code reads none of the extension's own bindings, whatever their names, and
// works while an import cycle runs the extension's code before its own top level has run.
it(
	"an extension's own bindings never stand in for its import.meta or file globals",
	async () => {
		const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "atomic-import-meta-hygiene-"));
		const write = (name: string, source: string) => fs.writeFileSync(path.join(root, name), source);
		write(
			"process-const.ts",
			`const process = { label: "mine" };
export const probe = () => ({ label: process.label, dirname: __dirname, filename: import.meta.filename });
`,
		);
		write(
			"process-var.ts",
			`var process = { versions: {} };
export const probe = () => ({ hasVersion: process.versions.node !== undefined, filename: __filename });
`,
		);
		write(
			"own-names.ts",
			`const _importMeta = "mine";
const __atomicImportMeta = "also mine";
const jitiESMResolve = (specifier) => "mine:" + specifier;
const load = (jitiImport) => import("./helper.ts").then((helper) => [jitiImport, helper.value]);
export const probe = async () => ({
	own: [_importMeta, __atomicImportMeta, jitiESMResolve("x")],
	nested: ((_importMeta) => [_importMeta, import.meta.filename])("nested"),
	resolved: import.meta.resolve("./helper.ts"),
	loaded: await load("mine"),
});
`,
		);
		write("helper.ts", `export const value = "helper";\n`);
		write(
			"cycle.ts",
			`import { seen } from "./cycle-back.ts";
export function ownFile() {
	return import.meta.filename;
}
export const probe = () => ({ seen });
`,
		);
		write("cycle-back.ts", `import { ownFile } from "./cycle.ts";\nexport const seen = ownFile();\n`);
		const entry = path.join(root, "extension.ts");
		write(
			"extension.ts",
			`import * as processConst from "./process-const.ts";
import * as processVar from "./process-var.ts";
import * as ownNames from "./own-names.ts";
import * as cycle from "./cycle.ts";
export default async function (pi) {
	pi.events.emit("hygiene-probe", {
		processConst: processConst.probe(),
		processVar: processVar.probe(),
		ownNames: await ownNames.probe(),
		cycle: cycle.probe(),
	});
}
`,
		);
		const file = (name: string) => path.join(root, name);
		const bus = createEventBus();
		const observations: object[] = [];
		bus.on("hygiene-probe", (value) => observations.push(value as object));
		try {
			for (const load of ["first", "reload"]) {
				clearExtensionCache();
				const factory =
					load === "first"
						? await extensionLoaderTestHooks.loadExtensionModuleTransformed(entry)
						: await extensionLoaderTestHooks.loadTransformedExtensionModule(entry);
				expect(factory).toBeTypeOf("function");
				await loadExtensionFromFactory(factory!, root, bus, createExtensionRuntime(), entry);
				expect(observations.at(-1)).toEqual({
					processConst: { label: "mine", dirname: root, filename: file("process-const.ts") },
					processVar: { hasVersion: false, filename: file("process-var.ts") },
					ownNames: {
						own: ["mine", "also mine", "mine:x"],
						nested: ["nested", file("own-names.ts")],
						resolved: pathToFileURL(file("helper.ts")).href,
						loaded: ["mine", "helper"],
					},
					cycle: { seen: file("cycle.ts") },
				});
			}
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
