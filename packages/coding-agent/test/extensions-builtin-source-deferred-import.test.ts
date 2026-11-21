import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, test, vi } from "vitest";
import { getExtensionTranspileCacheDir } from "../src/config.ts";
import { clearExtensionCache, loadExtensionModule } from "../src/core/extensions/loader-virtual-modules.ts";
import { resetNativeBuiltinExtensionEntriesForTest } from "../src/core/extensions/native-builtin-entries.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";

/**
 * Events the fixture modules record, in the order they happen. A module takes the test's list when it is evaluated,
 * so a task it queued for later records into its own test's list even if that test has ended.
 */
const EVENTS_KEY = "__atomicDeferredImportEvents";
const eventsGlobal = globalThis as typeof globalThis & { [EVENTS_KEY]?: string[] };
const EVENTS = `(globalThis as { ${EVENTS_KEY}?: string[] }).${EVENTS_KEY}`;

// Each test loads extensions through the real loader; the first load in a test process also builds the host's
// virtual modules.
const REAL_EXTENSION_LOADER_TEST_TIMEOUT_MS = 120_000;
// The main thread stores a transform after the import that needed it has settled.
const STORED_TRANSFORM_TIMEOUT_MS = 30_000;

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	clearExtensionCache();
	resetNativeBuiltinExtensionEntriesForTest();
});

function replaceEnvironmentVariable(name: string, value: string): void {
	const previous = process.env[name];
	process.env[name] = value;
	cleanups.push(() => {
		if (previous === undefined) delete process.env[name];
		else process.env[name] = previous;
	});
}

function recordEvents(): string[] {
	const events: string[] = [];
	eventsGlobal[EVENTS_KEY] = events;
	cleanups.push(() => {
		delete eventsGlobal[EVENTS_KEY];
	});
	return events;
}

function writeFile(file: string, content: string): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
}

/** Rewrites a file with content of the same length and gives it back its modification time. */
function replaceKeepingSizeAndTime(file: string, from: string, to: string): void {
	assert.equal(from.length, to.length);
	const { atime, mtime, size } = statSync(file);
	const content = fs.readFileSync(file, "utf8");
	assert.ok(content.includes(from), `${file} does not contain ${from}`);
	writeFileSync(file, content.replace(from, to));
	utimesSync(file, atime, mtime);
	assert.equal(statSync(file).size, size);
}

/**
 * A source checkout as Atomic finds one: the app package has `src/main.ts`, and Intercom's sources sit beside it.
 * `files` are the Intercom package's files, relative to its directory.
 */
function sourceCheckout(files: Record<string, string>) {
	const root = mkdtempSync(join(tmpdir(), "atomic-builtin-deferred-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const packageDir = join(root, "coding-agent");
	writeFile(join(packageDir, "src", "main.ts"), "");
	const intercomDir = join(root, "intercom");
	writeFile(
		join(intercomDir, "package.json"),
		JSON.stringify({ name: "@bastani/intercom", type: "module", atomic: { extensions: ["./index.ts"] } }),
	);
	for (const [file, content] of Object.entries(files)) writeFile(join(intercomDir, file), content);
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	replaceEnvironmentVariable("ATOMIC_PACKAGE_DIR", packageDir);
	resetNativeBuiltinExtensionEntriesForTest();
	return { root, agentDir, dir: intercomDir, entry: resolve(intercomDir, "index.ts") };
}

/** The same files as an extension the user installed in the agent directory. */
function userExtension(files: Record<string, string>) {
	const root = mkdtempSync(join(tmpdir(), "atomic-user-deferred-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	const dir = join(agentDir, "extensions", "probe");
	for (const [file, content] of Object.entries(files)) writeFile(join(dir, file), content);
	return { root, agentDir, dir, entry: resolve(dir, "index.ts") };
}

/**
 * An entry whose factory returns a function that imports `heavy` later, the way Intercom's deferred join imports its
 * heavy module after the extension has started.
 */
const DEFERRED_GRAPH: Record<string, string> = {
	"index.ts": `export default function start() {
	return { load: () => import("./heavy.js") };
}
`,
	"heavy.ts": `import { first } from "./lib/first.js";
import { second } from "./lib/second.js";
${EVENTS}?.push("heavy");
export const value: string = first + " " + second;
`,
	"lib/first.ts": `const events = ${EVENTS};
setImmediate(() => events?.push("task queued by first"));
export const first: string = "first-1";
`,
	"lib/second.ts": `export const second: string = "second-1";
`,
};

type DeferredLoad = () => Promise<{ value: string }>;

/** Loads the extension and starts it, returning its deferred import. */
async function loadFactory(entry: string, agentDir: string): Promise<DeferredLoad> {
	const factory: ExtensionFactory | undefined = await loadExtensionModule(entry, undefined, agentDir);
	assert.equal(typeof factory, "function");
	const start = factory as unknown as () => { load: DeferredLoad } | Promise<{ load: DeferredLoad }>;
	return (await start()).load;
}

/** Starts the deferred import and notes which events happened by the time it settled. */
function importNoting(load: DeferredLoad, events: string[]) {
	let atSettle: string[] = [];
	const imported = load().then((module) => {
		atSettle = [...events];
		return module;
	});
	setImmediate(() => events.push("event loop"));
	return { imported, eventsAtSettle: () => atSettle };
}

/** Transforms the main thread stored in the transpile cache while `run` ran. */
async function mainThreadTransforms<T>(
	agentDir: string,
	run: () => Promise<T>,
): Promise<{ result: T; files: string[] }> {
	const cacheDir = resolve(getExtensionTranspileCacheDir(agentDir));
	const writes = vi.spyOn(fs.promises, "writeFile");
	try {
		const result = await run();
		const files = writes.mock.calls
			.map(([file]) => resolve(String(file)))
			.filter((file) => dirname(file) === cacheDir)
			.map((file) => file.slice(cacheDir.length + 1).split(".ts.")[0]);
		return { result, files };
	} finally {
		writes.mockRestore();
	}
}

/** Waits until the transforms of `modules` are stored, so removing the test's folder does not race their writes. */
async function storedTransforms(agentDir: string, modules: string[]): Promise<void> {
	await vi.waitFor(
		() => {
			const stored = cachedModules(agentDir);
			for (const module of modules) assert.ok(stored.includes(module), `${module} is not stored yet`);
		},
		{ timeout: STORED_TRANSFORM_TIMEOUT_MS, interval: 10 },
	);
}

function cachedModules(agentDir: string): string[] {
	return readdirSync(getExtensionTranspileCacheDir(agentDir))
		.filter((name) => name.endsWith(".mjs"))
		.map((name) => name.split(".ts.")[0])
		.sort();
}

describe("deferred imports of a source checkout's builtin packages", {
	timeout: REAL_EXTENSION_LOADER_TEST_TIMEOUT_MS,
}, () => {
	test("a deferred import transforms its modules off the main thread while the event loop keeps running (#6118)", async () => {
		const events = recordEvents();
		const { agentDir, entry } = sourceCheckout(DEFERRED_GRAPH);
		const load = await loadFactory(entry, agentDir);

		const deferred = importNoting(load, events);
		const { result, files } = await mainThreadTransforms(agentDir, () => deferred.imported);

		assert.equal(result.value, "first-1 second-1");
		assert.deepEqual(files, []);
		assert.deepEqual(cachedModules(agentDir), ["first", "heavy", "index", "second"]);
		assert.deepEqual(deferred.eventsAtSettle(), ["event loop", "heavy"]);
	});

	test("the deferred module graph still evaluates without yielding to other tasks (#6118)", async () => {
		const events = recordEvents();
		const { agentDir, entry } = sourceCheckout(DEFERRED_GRAPH);
		const load = await loadFactory(entry, agentDir);

		await load();
		await new Promise((settle) => setImmediate(settle));

		assert.deepEqual(events, ["heavy", "task queued by first"]);
	});

	test("an import awaited by a module's own evaluation still evaluates without yielding (#6118)", async () => {
		const events = recordEvents();
		const { agentDir, entry } = sourceCheckout({
			...DEFERRED_GRAPH,
			"index.ts": `export { loadHeavy } from "./loader.js";
export default function start() {
	return { load: () => import("./outer.js") };
}
`,
			"loader.ts": `export function loadHeavy() {
	return import("./heavy.js");
}
`,
			"outer.ts": `import { loadHeavy } from "./loader.js";
const events = ${EVENTS};
setImmediate(() => events?.push("task queued by outer"));
const heavy = await loadHeavy();
events?.push("outer");
export const value: string = heavy.value;
`,
		});
		const load = await loadFactory(entry, agentDir);

		assert.equal((await load()).value, "first-1 second-1");
		await new Promise((settle) => setImmediate(settle));

		assert.deepEqual(events, ["heavy", "outer", "task queued by outer", "task queued by first"]);
		await storedTransforms(agentDir, ["first", "heavy", "second"]);
	});

	test("importing a module the extension already loaded starts no preparation (#6118)", async () => {
		const events = recordEvents();
		const { agentDir, entry } = sourceCheckout(DEFERRED_GRAPH);
		const load = await loadFactory(entry, agentDir);
		await load();
		await new Promise((settle) => setImmediate(settle));
		events.length = 0;

		const again = load();
		setImmediate(() => events.push("event loop"));
		await again;
		events.push("imported again");
		await new Promise((settle) => setImmediate(settle));

		assert.deepEqual(events, ["imported again", "event loop"]);
	});

	test("an import of a module that another import is still preparing gets the evaluated module (#6118)", async () => {
		// `heavy` declares `late` after twenty imports, so its body runs only once their evaluations have settled.
		const parts = Array.from({ length: 20 }, (_, index) => `part${index}`);
		const { agentDir, entry } = sourceCheckout({
			...DEFERRED_GRAPH,
			...Object.fromEntries(parts.map((part) => [`lib/${part}.ts`, `export const ${part}: string = "${part}";\n`])),
			"heavy.ts": `import { first } from "./lib/first.js";
${parts.map((part) => `import { ${part} } from "./lib/${part}.js";`).join("\n")}
export function read(): string {
	return late + first + " " + [${parts.join(", ")}].length;
}
const late: string = "late ";
`,
		});
		const load = (await loadFactory(entry, agentDir)) as unknown as () => Promise<{ read: () => string }>;

		const earlier = load().then((module) => module.read());
		await new Promise((settle) => setImmediate(settle));
		const later = load().then((module) => module.read());

		assert.deepEqual(await Promise.all([earlier, later]), ["late first-1 20", "late first-1 20"]);
	});

	test("a deferred import still loads when its transforms cannot be stored (#6118)", async () => {
		const { agentDir, entry } = sourceCheckout(DEFERRED_GRAPH);
		const load = await loadFactory(entry, agentDir);
		rmSync(getExtensionTranspileCacheDir(agentDir), { recursive: true, force: true });

		assert.equal((await load()).value, "first-1 second-1");
	});

	// A FIFO blocks a reader until something writes to it. The deferred import never evaluates `ghost.ts`.
	test.skipIf(process.platform === "win32")(
		"a deferred import does not wait on a file its modules name but never import (#6118)",
		async () => {
			const { agentDir, dir, entry } = sourceCheckout({
				...DEFERRED_GRAPH,
				"lib/second.ts": `// ; await jitiImport("./ghost.ts");
// require("./ghost.ts")
export function unused() {
	return import("./ghost.ts");
}
export const second: string = "second-1";
`,
			});
			execFileSync("mkfifo", [join(dir, "lib", "ghost.ts")]);
			const load = await loadFactory(entry, agentDir);

			assert.equal((await load()).value, "first-1 second-1");
		},
	);

	test("a deferred import reports a syntax error in a module it imports (#6118)", async () => {
		const { agentDir, entry } = sourceCheckout({
			...DEFERRED_GRAPH,
			"lib/second.ts": `export const second: string = ;
`,
		});
		const load = await loadFactory(entry, agentDir);

		await assert.rejects(load(), /second\.ts/);
	});

	test("a reload evaluates the current bytes of a module a deferred import loaded (#4986)", async () => {
		const { agentDir, dir, entry } = sourceCheckout(DEFERRED_GRAPH);
		assert.equal((await (await loadFactory(entry, agentDir))()).value, "first-1 second-1");

		replaceKeepingSizeAndTime(join(dir, "lib", "second.ts"), "second-1", "second-2");
		clearExtensionCache();

		assert.equal((await (await loadFactory(entry, agentDir))()).value, "first-1 second-2");
	});
});

describe("deferred imports of other extensions", { timeout: REAL_EXTENSION_LOADER_TEST_TIMEOUT_MS }, () => {
	test("an extension outside the builtin packages keeps transforming its deferred import in place (#6118)", async () => {
		const events = recordEvents();
		const { agentDir, entry } = userExtension(DEFERRED_GRAPH);
		const load = await loadFactory(entry, agentDir);

		const deferred = importNoting(load, events);
		const { result, files } = await mainThreadTransforms(agentDir, () => deferred.imported);

		assert.equal(result.value, "first-1 second-1");
		assert.deepEqual(files.sort(), ["first", "heavy", "second"]);
		assert.deepEqual(deferred.eventsAtSettle(), ["heavy"]);
		await storedTransforms(agentDir, ["first", "heavy", "second"]);
	});
});

/** Lazily imported modules, named with their TypeScript extension so a native first import can load them. */
const LAZY_GRAPH: Record<string, string> = {
	"index.ts": `export default function start() {
	return { load: () => import("./late.ts") };
}
`,
	"late.ts": `export { leaf as value } from "./leaf.ts";
`,
	"leaf.ts": `export const leaf: string = "AAA";
`,
};

// The first load is a native import under Bun, and under Node when jiti is asked for one; on Windows every load is
// transformed. A reload of either reuses the transformed evaluation while the files it read are unchanged.
describe.each([
	["after a native first import", "true"],
	["after a transformed first import", "false"],
])(
	"reloads of a source checkout's builtin package %s",
	{ timeout: REAL_EXTENSION_LOADER_TEST_TIMEOUT_MS },
	(_route, tryNative) => {
		test("a reload evaluates an edited module that the previous evaluation imported lazily (#6118)", async () => {
			replaceEnvironmentVariable("JITI_TRY_NATIVE", tryNative);
			const { agentDir, dir, entry } = sourceCheckout(LAZY_GRAPH);
			const leaf = join(dir, "leaf.ts");
			const values: string[] = [];

			for (const [from, to] of [
				["AAA", "AAA"],
				["AAA", "BBB"],
				["BBB", "CCC"],
			]) {
				replaceKeepingSizeAndTime(leaf, from, to);
				clearExtensionCache();
				values.push((await (await loadFactory(entry, agentDir))()).value);
			}

			assert.deepEqual(values, ["AAA", "BBB", "CCC"]);
		});

		test("a lazy import by a replaced evaluation does not make a reload keep the current one (#6118)", async () => {
			replaceEnvironmentVariable("JITI_TRY_NATIVE", tryNative);
			const { agentDir, dir, entry } = sourceCheckout(LAZY_GRAPH);
			const leaf = join(dir, "leaf.ts");
			await loadFactory(entry, agentDir);
			clearExtensionCache();
			const replaced = await loadFactory(entry, agentDir);
			fs.appendFileSync(entry, "// edited\n");
			clearExtensionCache();
			const current = await loadFactory(entry, agentDir);

			replaceKeepingSizeAndTime(leaf, "AAA", "BBB");
			assert.equal((await current()).value, "BBB");
			replaceKeepingSizeAndTime(leaf, "BBB", "AAA");
			assert.equal((await replaced()).value, "AAA");
			clearExtensionCache();

			assert.equal((await (await loadFactory(entry, agentDir))()).value, "AAA");
		});
	},
);
