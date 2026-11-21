import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createJiti } from "jiti";
import { afterEach, describe, test, vi } from "vitest";
import { getExtensionTranspileCacheDir } from "../src/config.ts";
import { loadExtensionsCached } from "../src/core/extensions/loader.ts";
import { clearExtensionCache, loadExtensionModule } from "../src/core/extensions/loader-virtual-modules.ts";
import { resetNativeBuiltinExtensionEntriesForTest } from "../src/core/extensions/native-builtin-entries.ts";
import { transformTemplate } from "../src/core/extensions/source-builtin-imports.ts";
import { moduleTransformOptions } from "../src/core/extensions/transform-graph.ts";
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

/**
 * An installed Atomic as Atomic finds one: Intercom's prebuilt bundle sits in the app package's `dist/builtin`.
 * `files` are the Intercom package's files, relative to its directory; its entry is `index.bundle.mjs`.
 */
function installedLayout(files: Record<string, string>) {
	const root = mkdtempSync(join(tmpdir(), "atomic-builtin-installed-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const packageDir = join(root, "app");
	const intercomDir = join(packageDir, "dist", "builtin", "intercom");
	writeFile(
		join(intercomDir, "package.json"),
		JSON.stringify({ name: "@bastani/intercom", type: "module", atomic: { extensions: ["./index.bundle.mjs"] } }),
	);
	for (const [file, content] of Object.entries(files)) writeFile(join(intercomDir, file), content);
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	replaceEnvironmentVariable("ATOMIC_PACKAGE_DIR", packageDir);
	resetNativeBuiltinExtensionEntriesForTest();
	return { root, agentDir, dir: intercomDir, entry: resolve(intercomDir, "index.bundle.mjs") };
}

/** Counts the worker threads started from now on. */
function countWorkers(): () => number {
	let started = 0;
	const onWorker = (): void => {
		started += 1;
	};
	process.on("worker", onWorker);
	cleanups.push(() => process.off("worker", onWorker));
	return () => started;
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

	test("a deferred import prepares a module its graph imports as a namespace", async () => {
		const { agentDir, entry } = sourceCheckout({
			...DEFERRED_GRAPH,
			"heavy.ts": `import * as firstModule from "./lib/first.js";
import { second } from "./lib/second.js";
export const value: string = firstModule.first + " " + second;
`,
		});
		const load = await loadFactory(entry, agentDir);

		const { result, files } = await mainThreadTransforms(agentDir, () => load());

		assert.equal(result.value, "first-1 second-1");
		assert.deepEqual(files, []);
	});

	test("a deferred import prepares only the modules its graph imports", async () => {
		const { agentDir, entry } = sourceCheckout({
			...DEFERRED_GRAPH,
			"lib/second.ts": `// ; await jitiImport("./ghost.ts");
export const text: string = '; await jitiImport("./ghost.ts");';
export const second: string = "second-1";
`,
			"lib/ghost.ts": `export const ghost: string = "ghost";
`,
		});
		const load = await loadFactory(entry, agentDir);

		assert.equal((await load()).value, "first-1 second-1");
		await storedTransforms(agentDir, ["first", "heavy", "second"]);

		assert.deepEqual(cachedModules(agentDir), ["first", "heavy", "index", "second"]);
	});

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

/** An entry that imports its modules statically, as the builtin packages' entries do. */
const ENTRY_GRAPH: Record<string, string> = {
	...DEFERRED_GRAPH,
	"index.ts": `import { first } from "./lib/first.js";
import * as secondModule from "./lib/second.js";
export default function start() {
	return { load: async () => ({ value: first + " " + secondModule.second }) };
}
`,
};

describe("loads of a source checkout's builtin package entry", {
	timeout: REAL_EXTENSION_LOADER_TEST_TIMEOUT_MS,
}, () => {
	test("the first load with an empty transpile cache transforms the entry's graph off the main thread", async () => {
		const { agentDir, entry } = sourceCheckout(ENTRY_GRAPH);

		const { result: load, files } = await mainThreadTransforms(agentDir, () => loadFactory(entry, agentDir));

		assert.equal((await load()).value, "first-1 second-1");
		assert.deepEqual(files, []);
		assert.deepEqual(cachedModules(agentDir), ["first", "index", "second"]);
	});

	test("a load whose entry transform is stored starts no worker", async () => {
		const { agentDir, entry } = sourceCheckout(ENTRY_GRAPH);
		await loadFactory(entry, agentDir);
		clearExtensionCache();
		const workers = countWorkers();

		const load = await loadFactory(entry, agentDir);

		assert.equal((await load()).value, "first-1 second-1");
		assert.equal(workers(), 0);
	});

	test("a batch whose entry is already loaded in memory prepares nothing and leaves the cache alone", async () => {
		const { root, agentDir, entry } = sourceCheckout(ENTRY_GRAPH);
		assert.deepEqual(
			(await loadExtensionsCached([entry], root, undefined, undefined, undefined, undefined, agentDir)).errors,
			[],
		);
		rmSync(join(agentDir, "cache"), { recursive: true, force: true });
		const workers = countWorkers();

		const again = await loadExtensionsCached([entry], root, undefined, undefined, undefined, undefined, agentDir);

		assert.deepEqual(again.errors, []);
		assert.equal(workers(), 0);
		assert.equal(fs.existsSync(join(agentDir, "cache")), false);
	});

	test("a load whose entry changed prepares its graph and evaluates every module as it is now", async () => {
		const { agentDir, dir, entry } = sourceCheckout(ENTRY_GRAPH);
		await loadFactory(entry, agentDir);
		replaceKeepingSizeAndTime(join(dir, "lib", "second.ts"), "second-1", "second-2");
		fs.appendFileSync(entry, "// edited\n");
		clearExtensionCache();
		const workers = countWorkers();

		const { result: load, files } = await mainThreadTransforms(agentDir, () => loadFactory(entry, agentDir));

		assert.equal(workers(), 1);
		assert.deepEqual(files, []);
		assert.equal((await load()).value, "first-1 second-2");
	});
});

/** Lets a fixture module pause its evaluation until the test releases it, and report what it reached. */
interface EvaluationGate {
	entered: () => void;
	scheduledImportStarted: () => void;
	release: Promise<void>;
	scheduled?: Promise<string>;
}
const GATE_KEY = "__atomicDeferredImportGate";
const GATE = `(globalThis as { ${GATE_KEY}?: { entered: () => void; scheduledImportStarted: () => void; release: Promise<void>; scheduled?: Promise<string> } }).${GATE_KEY}!`;

function evaluationGate() {
	let entered!: () => void;
	let scheduledImportStarted!: () => void;
	let release!: () => void;
	const reached = {
		entered: new Promise<void>((resolve) => {
			entered = resolve;
		}),
		scheduledImportStarted: new Promise<void>((resolve) => {
			scheduledImportStarted = resolve;
		}),
	};
	const gate: EvaluationGate = {
		entered,
		scheduledImportStarted,
		release: new Promise<void>((resolve) => {
			release = resolve;
		}),
	};
	(globalThis as { [GATE_KEY]?: EvaluationGate })[GATE_KEY] = gate;
	cleanups.push(() => {
		release();
		delete (globalThis as { [GATE_KEY]?: EvaluationGate })[GATE_KEY];
	});
	return { gate, reached, release };
}

/**
 * \`heavy\` schedules a callback that imports it again through the entry, then waits at the gate with a top-level
 * await, so imports arrive while it is still evaluating. `extension` is the module file extension of the layout.
 */
function gatedGraph(extension: "ts" | "mjs", types: (annotation: string) => string): Record<string, string> {
	return {
		[`index.${extension === "ts" ? "ts" : "bundle.mjs"}`]: `export function lazy() {
	return import("./heavy.${extension === "ts" ? "js" : "mjs"}");
}
export default function start() {
	return { load: lazy };
}
`,
		[`heavy.${extension}`]: `import { lazy } from "./index.${extension === "ts" ? "js" : "bundle.mjs"}";
const gate = ${extension === "ts" ? GATE : `globalThis.${GATE_KEY}`};
gate.scheduled = new Promise${types("<string>")}((resolve) => {
	setImmediate(() => {
		const imported = lazy();
		gate.scheduledImportStarted();
		resolve(imported.then((module) => module.read()));
	});
});
gate.entered();
await gate.release;
const ready${types(": string")} = "ready";
export function read()${types(": string")} {
	return ready;
}
`,
	};
}

describe.each([
	["a source checkout", () => sourceCheckout(gatedGraph("ts", (annotation) => annotation))],
	["an installed Atomic", () => installedLayout(gatedGraph("mjs", () => ""))],
])(
	"imports of a builtin module that is still evaluating, in %s",
	{ timeout: REAL_EXTENSION_LOADER_TEST_TIMEOUT_MS },
	(_layout, layout) => {
		test("an import from outside the module and one its evaluation scheduled both get the evaluated module", async () => {
			const { gate, reached, release } = evaluationGate();
			const { agentDir, entry } = layout();
			const load = (await loadFactory(entry, agentDir)) as unknown as () => Promise<{ read: () => string }>;

			const first = load().then((module) => module.read());
			await reached.entered;
			const independent = load().then((module) => module.read());
			await reached.scheduledImportStarted;
			release();

			assert.deepEqual(await Promise.all([first, independent, gate.scheduled]), ["ready", "ready", "ready"]);
		});
	},
);

describe("an import of a module by its own evaluation", { timeout: REAL_EXTENSION_LOADER_TEST_TIMEOUT_MS }, () => {
	// Known limit shared with native ES modules: an evaluation that awaits its own import waits for itself.
	test("waits for the evaluation, as a native ES module's does", async () => {
		const { agentDir, entry } = sourceCheckout({
			"index.ts": `export function lazy() {
	return import("./heavy.js");
}
export default function start() {
	return { load: lazy };
}
`,
			"heavy.ts": `import { lazy } from "./index.js";
const events = ${EVENTS};
const self = lazy();
events?.push("self import started");
await self;
export const value: string = "never";
`,
		});
		const events = recordEvents();
		const load = (await loadFactory(entry, agentDir)) as unknown as () => Promise<unknown>;

		let settled = false;
		void load().then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await vi.waitFor(() => assert.deepEqual(events, ["self import started"]), {
			timeout: STORED_TRANSFORM_TIMEOUT_MS,
			interval: 10,
		});
		// Handing back the module mid-evaluation would settle within the turn that started the import.
		await new Promise((turn) => setImmediate(turn));
		await new Promise((turn) => setImmediate(turn));

		assert.equal(settled, false);
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

/** The same as {@link LAZY_GRAPH}, with JavaScript modules imported lazily. */
const LAZY_SCRIPT_GRAPH: Record<string, string> = {
	"index.ts": `export default function start() {
	return { load: () => import("./late.mjs") };
}
`,
	"late.mjs": `export { leaf as value } from "./leaf.mjs";
`,
	"leaf.mjs": `export const leaf = "AAA";
`,
};

// The first load is a native import under Bun, and under Node when jiti is asked for one; on Windows every load is
// transformed, as is every load in a compiled binary. A reload of either reuses the transformed evaluation while the
// files it read are unchanged.
describe.each([
	["a source checkout's builtin package", "after a native first import", sourceCheckout, "true"],
	["a source checkout's builtin package", "after a transformed first import", sourceCheckout, "false"],
	["an extension in the agent directory", "after a native first import", userExtension, "true"],
	["an extension in the agent directory", "after a transformed first import", userExtension, "false"],
])("reloads of %s %s", { timeout: REAL_EXTENSION_LOADER_TEST_TIMEOUT_MS }, (_kind, _route, layout, tryNative) => {
	test("a reload evaluates an edited module that the previous evaluation imported lazily (#6118)", async () => {
		replaceEnvironmentVariable("JITI_TRY_NATIVE", tryNative);
		const { agentDir, dir, entry } = layout(LAZY_GRAPH);
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
		const { agentDir, dir, entry } = layout(LAZY_GRAPH);
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

	test("a replaced evaluation's factory that runs later does not make a reload keep the current one", async () => {
		replaceEnvironmentVariable("JITI_TRY_NATIVE", tryNative);
		const { agentDir, dir, entry } = layout({
			...LAZY_GRAPH,
			"index.ts": `export default async function start() {
	return (await import("./late.ts")).value;
}
`,
		});
		const leaf = join(dir, "leaf.ts");
		const run = async (factory: ExtensionFactory | undefined) => (factory as unknown as () => Promise<string>)();
		await run(await loadExtensionModule(entry, undefined, agentDir));
		clearExtensionCache();
		const replaced = await loadExtensionModule(entry, undefined, agentDir);
		fs.appendFileSync(entry, "// edited\n");
		clearExtensionCache();
		assert.equal(await run(await loadExtensionModule(entry, undefined, agentDir)), "AAA");

		replaceKeepingSizeAndTime(leaf, "AAA", "BBB");
		assert.equal(await run(replaced), "BBB");
		clearExtensionCache();

		assert.equal(await run(await loadExtensionModule(entry, undefined, agentDir)), "BBB");
	});

	test("a reload evaluates an edited JavaScript module that the previous evaluation imported lazily", async () => {
		replaceEnvironmentVariable("JITI_TRY_NATIVE", tryNative);
		const { agentDir, dir, entry } = layout(LAZY_SCRIPT_GRAPH);
		const leaf = join(dir, "leaf.mjs");
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
});

describe("the transform options a preparation uses", () => {
	test.each([false, true])("are the options jiti hands its transform (source maps: %s)", async (sourceMaps) => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-transform-options-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const file = join(dir, "module.ts");
		writeFile(file, "export const value: string = 'value';\n");
		const received: Array<Parameters<typeof moduleTransformOptions>[0] & { filename?: string; source: string }> = [];
		const jiti = createJiti(import.meta.url, {
			fsCache: false,
			moduleCache: false,
			sourceMaps,
			transform: (options) => {
				received.push(options);
				return { code: "" };
			},
		});

		await jiti.import(file);

		assert.equal(received.length, 1);
		const named = jiti.resolve(file);
		assert.deepEqual(moduleTransformOptions(transformTemplate(jiti.options), named, received[0].source), received[0]);
	});
});
