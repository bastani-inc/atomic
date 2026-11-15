import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, test } from "vitest";
import { collectEverythingTracked, collectGarbage, trackCollection } from "../../../test/helpers/collect-garbage.js";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { clearExtensionCache, loadExtensionsCached } from "../src/core/extensions/loader.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const COMMAND = "probe-4988";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	clearExtensionCache();
});

/** A workspace whose agent settings load the extension file `entry` from `extensionDir`. */
function workspace(entry: string) {
	const root = mkdtempSync(join(tmpdir(), "atomic-reload-javascript-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	// Outside the auto-discovered directories, which find only index.ts and index.js.
	const extensionDir = join(root, "probe");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(extensionDir, "lib"), { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [join(extensionDir, entry)] }));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	return { cwd, agentDir, extensionDir };
}

async function startRuntime(cwd: string, agentDir: string) {
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			resourceLoaderOptions: { builtinPackagePaths: [], noSkills: true, noThemes: true, noPromptTemplates: true },
		});
		return {
			...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
			services,
			diagnostics: services.diagnostics,
		};
	};
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir,
		sessionManager: SessionManager.inMemory(cwd),
	});
	cleanups.push(() => runtime.dispose());
	return runtime;
}

type Runtime = Awaited<ReturnType<typeof startRuntime>>;

function probeDescription(runtime: Runtime): string | undefined {
	return runtime.session.extensionRunner.getRegisteredCommands().find((command) => command.name === COMMAND)
		?.description;
}

function extensionProblems(runtime: Runtime) {
	const { errors, warnings } = runtime.session.resourceLoader.getExtensions();
	return [...errors.map((error) => error.error), ...(warnings ?? []).map((warning) => warning.warning)];
}

/** A plain JavaScript extension kind the runtime would otherwise load and keep itself. */
interface JavaScriptKind {
	name: string;
	entry: string;
	helper: string;
	packageType?: "module";
	entrySource(version: string): string;
	helperSource(version: string): string;
}

const esmEntry = (helper: string) => (version: string) =>
	`import { helperVersion } from "./lib/${helper}";
export default function (pi) {
	pi.registerCommand(${JSON.stringify(COMMAND)}, { description: "entry-${version} helper-" + helperVersion, handler: async () => {} });
}
`;
const esmHelper = (version: string) => `export const helperVersion = "${version}";\n`;
const cjsEntry = (helper: string) => (version: string) =>
	`const { helperVersion } = require("./lib/${helper}");
module.exports = function (pi) {
	pi.registerCommand(${JSON.stringify(COMMAND)}, { description: "entry-${version} helper-" + helperVersion, handler: async () => {} });
};
`;
const cjsHelper = (version: string) => `exports.helperVersion = "${version}";\n`;

const kinds: JavaScriptKind[] = [
	{
		name: ".mjs",
		entry: "index.mjs",
		helper: "helper.mjs",
		entrySource: esmEntry("helper.mjs"),
		helperSource: esmHelper,
	},
	{
		name: ".cjs",
		entry: "index.cjs",
		helper: "helper.cjs",
		entrySource: cjsEntry("helper.cjs"),
		helperSource: cjsHelper,
	},
	{
		name: '.js in a "type": "module" package',
		entry: "index.js",
		helper: "helper.js",
		packageType: "module",
		entrySource: esmEntry("helper.js"),
		helperSource: esmHelper,
	},
	{
		name: "CommonJS .js",
		entry: "index.js",
		helper: "helper.js",
		entrySource: cjsEntry("helper.js"),
		helperSource: cjsHelper,
	},
];

describe("/reload runs the current code of edited JavaScript extensions", () => {
	test.each(kinds)("a reload runs an edited $name extension and an edited module it imports (#4988)", async (kind) => {
		const { cwd, agentDir, extensionDir } = workspace(kind.entry);
		if (kind.packageType)
			writeFileSync(join(extensionDir, "package.json"), JSON.stringify({ type: kind.packageType }));
		const writeEntry = (version: string) => writeFileSync(join(extensionDir, kind.entry), kind.entrySource(version));
		const writeHelper = (version: string) =>
			writeFileSync(join(extensionDir, "lib", kind.helper), kind.helperSource(version));
		writeEntry("1");
		writeHelper("1");
		const runtime = await startRuntime(cwd, agentDir);
		assert.equal(probeDescription(runtime), "entry-1 helper-1");

		writeEntry("2");
		await runtime.session.reload();
		assert.equal(probeDescription(runtime), "entry-2 helper-1");

		writeHelper("3");
		await runtime.session.reload();
		assert.equal(probeDescription(runtime), "entry-2 helper-3");
		assert.deepEqual(extensionProblems(runtime), []);
	});

	test("a reloaded .mjs extension keeps import.meta.url, top-level await and node builtin imports (#4988)", async () => {
		const { cwd, agentDir, extensionDir } = workspace("index.mjs");
		const entry = join(extensionDir, "index.mjs");
		const writeEntry = (version: string) =>
			writeFileSync(
				entry,
				`import { basename } from "node:path";
import { helperVersion } from "./lib/helper.mjs";
const awaited = await Promise.resolve("${version}");
export default function (pi) {
	pi.registerCommand(${JSON.stringify(COMMAND)}, {
		description: [awaited, helperVersion, import.meta.url, basename(new URL(import.meta.url).pathname)].join(" "),
		handler: async () => {},
	});
}
`,
			);
		writeFileSync(join(extensionDir, "lib", "helper.mjs"), esmHelper("h"));
		writeEntry("1");
		const runtime = await startRuntime(cwd, agentDir);
		const url = pathToFileURL(entry).href;
		assert.equal(probeDescription(runtime), `1 h ${url} index.mjs`);

		writeEntry("2");
		await runtime.session.reload();
		assert.equal(probeDescription(runtime), `2 h ${url} index.mjs`);
	});

	test("a reloaded .cjs extension keeps __dirname, __filename and require of node builtins (#4988)", async () => {
		const { cwd, agentDir, extensionDir } = workspace("index.cjs");
		const entry = join(extensionDir, "index.cjs");
		const writeEntry = (version: string) =>
			writeFileSync(
				entry,
				`const path = require("node:path");
module.exports = function (pi) {
	pi.registerCommand(${JSON.stringify(COMMAND)}, {
		description: ["${version}", __dirname === path.dirname(__filename), path.basename(__filename), typeof module.exports].join(" "),
		handler: async () => {},
	});
};
`,
			);
		writeEntry("1");
		const runtime = await startRuntime(cwd, agentDir);
		assert.equal(probeDescription(runtime), "1 true index.cjs function");

		writeEntry("2");
		await runtime.session.reload();
		assert.equal(probeDescription(runtime), "2 true index.cjs function");
	});

	test("fifty reloads of an edited .mjs extension keep memory bounded (#4988)", { timeout: 120_000 }, async () => {
		const tracked = trackCollection();
		const trackingGlobal = globalThis as typeof globalThis & { __trackReload4988?: (target: object) => void };
		trackingGlobal.__trackReload4988 = (target) => tracked.track(target);
		cleanups.push(() => {
			delete trackingGlobal.__trackReload4988;
		});
		const { cwd, agentDir, extensionDir } = workspace("index.mjs");
		// Each evaluation of the helper holds 4 MB, so a retained evaluation per reload shows in the heap too.
		const writeHeavyHelper = (version: number) =>
			writeFileSync(
				join(extensionDir, "lib", "helper.mjs"),
				`export const payload = { bytes: new Uint8Array(4 * 1024 * 1024).fill(${version % 255}) };
globalThis.__trackReload4988(payload);
export const helperVersion = "${version}";
`,
			);
		const writeEntry = (version: number) =>
			writeFileSync(
				join(extensionDir, "index.mjs"),
				`import { helperVersion, payload } from "./lib/helper.mjs";
export default function (pi) {
	pi.registerCommand(${JSON.stringify(COMMAND)}, {
		description: "entry-${version} helper-" + helperVersion + (payload.bytes.length > 0 ? "" : " empty"),
		handler: async () => {},
	});
}
`,
			);
		writeEntry(0);
		writeHeavyHelper(0);
		const runtime = await startRuntime(cwd, agentDir);

		const reloads = 50;
		let heapAfterWarmup = 0;
		for (let reload = 1; reload <= reloads; reload++) {
			writeEntry(reload);
			writeHeavyHelper(reload);
			await runtime.session.reload();
			assert.equal(probeDescription(runtime), `entry-${reload} helper-${reload}`);
			if (reload === 10) {
				await collectGarbage();
				heapAfterWarmup = process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;
			}
		}
		await collectEverythingTracked(tracked, 100);
		await collectGarbage();
		const heapAfterLoop = process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;

		assert.equal(tracked.created, reloads + 1);
		// Only the live evaluation (and at most one in flight) stays; every earlier evaluation is collected.
		assert.ok(tracked.uncollected().length <= 2, `uncollected evaluations: ${tracked.uncollected().join(", ")}`);
		// 40 retained evaluations would add 160 MB.
		const growthMb = (heapAfterLoop - heapAfterWarmup) / (1024 * 1024);
		assert.ok(growthMb < 40, `heap grew ${growthMb.toFixed(1)} MB over 40 reloads`);
	});
});

/** Loads one extension file as `/reload` does (a new cache generation, then a cached load) and returns its probe description. */
async function reloadProbe(entry: string, cwd: string, agentDir: string): Promise<string | undefined> {
	clearExtensionCache();
	const result = await loadExtensionsCached([entry], cwd, undefined, undefined, undefined, undefined, agentDir);
	assert.deepEqual(result.errors, []);
	return result.extensions[0]?.commands.get(COMMAND)?.description;
}

function writeFiles(root: string, files: Record<string, string>): void {
	for (const [file, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), content);
	}
}

const describeProbe = (expression: string) =>
	`export default function (pi) {\n\tpi.registerCommand(${JSON.stringify(COMMAND)}, { description: String(${expression}), handler: async () => {} });\n}\n`;
const describeProbeCjs = (expression: string) =>
	`module.exports = function (pi) {\n\tpi.registerCommand(${JSON.stringify(COMMAND)}, { description: String(${expression}), handler: async () => {} });\n};\n`;

describe("what a reload of a JavaScript extension evaluates again", () => {
	test("a reload re-evaluates the files of the node_modules package the extension is in, but not other packages (#4988)", async () => {
		const { cwd, agentDir, extensionDir } = workspace("unused.mjs");
		const packageDir = join(extensionDir, "node_modules", "@scope", "probe");
		const entry = join(packageDir, "index.mjs");
		const write = (version: string) =>
			writeFiles(extensionDir, {
				"node_modules/@scope/probe/lib/own.mjs": `export const own = "${version}";\n`,
				"node_modules/@scope/other/other.mjs": `export const other = "${version}";\n`,
				"node_modules/plain/plain.mjs": `export const plain = "${version}";\n`,
			});
		writeFiles(packageDir, {
			"index.mjs": `import { own } from "./lib/own.mjs";
import { other } from "../other/other.mjs";
import { plain } from "../../plain/plain.mjs";
${describeProbe("[own, other, plain].join(' ')")}`,
		});
		write("1");
		assert.equal(await reloadProbe(entry, cwd, agentDir), "1 1 1");

		write("2");
		assert.equal(await reloadProbe(entry, cwd, agentDir), "2 1 1");
	});

	test("a reload of an extension outside node_modules does not re-evaluate a package it imports by path (#4988)", async () => {
		const { cwd, agentDir, extensionDir } = workspace("unused.mjs");
		const entry = join(extensionDir, "index.mjs");
		const write = (version: string) =>
			writeFiles(extensionDir, { "node_modules/dep/dep.mjs": `export const dep = "${version}";\n` });
		writeFiles(extensionDir, {
			"index.mjs": `import { dep } from "./node_modules/dep/dep.mjs";\n${describeProbe("dep")}`,
		});
		write("1");
		assert.equal(await reloadProbe(entry, cwd, agentDir), "1");

		write("2");
		assert.equal(await reloadProbe(entry, cwd, agentDir), "1");
	});

	test("JavaScript imports an installed package by name as the runtime would, once per process (#4988)", async () => {
		const { cwd, agentDir, extensionDir } = workspace("unused.mjs");
		const write = (version: string) =>
			writeFiles(extensionDir, {
				"node_modules/probe-dep-4988/package.json": JSON.stringify({
					name: "probe-dep-4988",
					exports: { import: "./esm.mjs", require: "./cjs.cjs" },
				}),
				"node_modules/probe-dep-4988/esm.mjs": `export const dep = "esm-${version}";\n`,
				"node_modules/probe-dep-4988/cjs.cjs": `exports.dep = "cjs-${version}";\n`,
			});
		writeFiles(extensionDir, {
			"esm.mjs": `import { dep } from "probe-dep-4988";\n${describeProbe("dep")}`,
			"cjs.cjs": `const { dep } = require("probe-dep-4988");\n${describeProbeCjs("dep")}`,
		});
		write("1");
		assert.equal(await reloadProbe(join(extensionDir, "esm.mjs"), cwd, agentDir), "esm-1");
		assert.equal(await reloadProbe(join(extensionDir, "cjs.cjs"), cwd, agentDir), "cjs-1");

		write("2");
		assert.equal(await reloadProbe(join(extensionDir, "esm.mjs"), cwd, agentDir), "esm-1");
		assert.equal(await reloadProbe(join(extensionDir, "cjs.cjs"), cwd, agentDir), "cjs-1");
	});

	test("a package JavaScript cannot resolve itself comes from the host (#4988)", async () => {
		const { cwd, agentDir, extensionDir } = workspace("unused.mjs");
		writeFiles(extensionDir, {
			"esm.mjs": `import { Type } from "typebox";\n${describeProbe("typeof Type.Object")}`,
			"cjs.cjs": `const { Type } = require("typebox");\n${describeProbeCjs("typeof Type.Object")}`,
		});
		assert.equal(await reloadProbe(join(extensionDir, "esm.mjs"), cwd, agentDir), "function");
		assert.equal(await reloadProbe(join(extensionDir, "cjs.cjs"), cwd, agentDir), "function");
	});

	test("TypeScript still imports a host package by name from the host when the extension has its own copy (#4988)", async () => {
		const { cwd, agentDir, extensionDir } = workspace("unused.mjs");
		writeFiles(extensionDir, {
			"node_modules/@earendil-works/pi-coding-agent/package.json": JSON.stringify({
				name: "@earendil-works/pi-coding-agent",
				type: "module",
				exports: "./index.js",
			}),
			"node_modules/@earendil-works/pi-coding-agent/index.js": "export const physicalCopy = true;\n",
			"index.ts": `import * as host from "@earendil-works/pi-coding-agent";\n${describeProbe("'physicalCopy' in host")}`,
		});
		assert.equal(await reloadProbe(join(extensionDir, "index.ts"), cwd, agentDir), "false");
	});

	test("one load evaluates a JavaScript module that several modules import once, also under a TypeScript entry (#4988)", async () => {
		const { cwd, agentDir, extensionDir } = workspace("unused.mjs");
		const counter = globalThis as typeof globalThis & { __evaluations4988?: number };
		cleanups.push(() => {
			delete counter.__evaluations4988;
		});
		writeFiles(extensionDir, {
			"shared.mjs":
				"globalThis.__evaluations4988 = (globalThis.__evaluations4988 ?? 0) + 1;\nexport const shared = {};\n",
			"a.mjs": `import { shared } from "./shared.mjs";\nexport const a = shared;\n`,
			"b.cjs": `module.exports = require("./shared.mjs");\n`,
			"index.mjs": `import { a } from "./a.mjs";\nimport b from "./b.cjs";\n${describeProbe("a === b.shared")}`,
			"ts-a.ts": `export { shared as a } from "./shared.mjs";\n`,
			"ts-b.ts": `export { shared as b } from "./shared.mjs";\n`,
			"index.ts": `import { a } from "./ts-a.ts";\nimport { b } from "./ts-b.ts";\n${describeProbe("a === b")}`,
		});
		assert.equal(await reloadProbe(join(extensionDir, "index.mjs"), cwd, agentDir), "true");
		assert.equal(counter.__evaluations4988, 1);
		assert.equal(await reloadProbe(join(extensionDir, "index.mjs"), cwd, agentDir), "true");
		assert.equal(counter.__evaluations4988, 2);
		assert.equal(await reloadProbe(join(extensionDir, "index.ts"), cwd, agentDir), "true");
		assert.equal(counter.__evaluations4988, 3);
	});

	test("a reload re-evaluates JavaScript imported by a file URL or an absolute path (#4988)", async () => {
		const { cwd, agentDir, extensionDir } = workspace("unused.mjs");
		const write = (version: string) =>
			writeFiles(extensionDir, {
				"lib/esm.mjs": `export const v = "${version}";\n`,
				"lib/cjs.cjs": `exports.v = "${version}";\n`,
			});
		writeFiles(extensionDir, {
			"index.mjs": `const { v } = await import(new URL("./lib/esm.mjs", import.meta.url).href);\n${describeProbe("v")}`,
			"index.cjs": `const { v } = require(require("node:path").join(__dirname, "lib", "cjs.cjs"));\n${describeProbeCjs("v")}`,
		});
		write("1");
		assert.equal(await reloadProbe(join(extensionDir, "index.mjs"), cwd, agentDir), "1");
		assert.equal(await reloadProbe(join(extensionDir, "index.cjs"), cwd, agentDir), "1");

		write("2");
		assert.equal(await reloadProbe(join(extensionDir, "index.mjs"), cwd, agentDir), "2");
		assert.equal(await reloadProbe(join(extensionDir, "index.cjs"), cwd, agentDir), "2");
	});

	test("ESM extension code stays strict and CommonJS code stays sloppy unless it asks for strict mode (#4988)", async () => {
		const { cwd, agentDir, extensionDir } = workspace("unused.mjs");
		const thisIsUndefined = "(function () { return this === undefined; })()";
		writeFiles(extensionDir, {
			"esm.mjs": describeProbe(thisIsUndefined),
			"cjs.cjs": describeProbeCjs(thisIsUndefined),
			"strict.cjs": `"use strict";\n${describeProbeCjs(thisIsUndefined)}`,
			"commonjs/index.js": describeProbeCjs(thisIsUndefined),
			"esm-syntax/index.js": describeProbe(thisIsUndefined),
			"typed/package.json": JSON.stringify({ type: "module" }),
			// A module without ESM syntax is ESM too in a "type": "module" package.
			"typed/helper.js": `globalThis.__typedStrict4988 = ${thisIsUndefined};\n`,
			"typed/index.js": `import "./helper.js";\n${describeProbe("globalThis.__typedStrict4988")}`,
		});
		const probe = (file: string) => reloadProbe(join(extensionDir, file), cwd, agentDir);
		assert.equal(await probe("esm.mjs"), "true");
		assert.equal(await probe("cjs.cjs"), "false");
		assert.equal(await probe("strict.cjs"), "true");
		assert.equal(await probe("commonjs/index.js"), "false");
		assert.equal(await probe("esm-syntax/index.js"), "true");
		assert.equal(await probe("typed/index.js"), "true");
	});
});
