import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.js";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.js";
import { extensionLoaderTestHooks } from "../src/core/extensions/loader-virtual-modules.js";

const fsModule = createRequire(import.meta.url)("node:fs") as typeof fs;
const PROBE_CHANNEL = "ts-source-specifier-probe";

/**
 * Each failed resolution probe throws a native ENOENT, which costs tens of
 * microseconds on Windows. Before TypeScript source specifiers were rewritten,
 * one `./x.js` import of `x.ts` threw roughly 250 of them.
 */
const MAX_FAILED_STATS_PER_IMPORT = 10;

function probeExtension(valueExpression: string): string {
	return `export default function (pi) {\n\tpi.events.emit(${JSON.stringify(PROBE_CHANNEL)}, ${valueExpression});\n}\n`;
}

async function loadValue(entry: string): Promise<string> {
	const factory = await extensionLoaderTestHooks.loadExtensionModuleTransformed(entry);
	assert.ok(factory, "extension factory did not load");
	const bus = createEventBus();
	const observed: string[] = [];
	bus.on(PROBE_CHANNEL, (value) => {
		if (typeof value === "string") observed.push(value);
	});
	await loadExtensionFromFactory(factory, path.dirname(entry), bus, createExtensionRuntime(), entry);
	assert.equal(observed.length, 1, "the extension must report exactly one value");
	return observed[0]!;
}

async function countFailedStats(load: () => Promise<string>): Promise<{ value: string; failedStats: number }> {
	const original = fsModule.statSync;
	let failedStats = 0;
	fsModule.statSync = ((...args: Parameters<typeof fs.statSync>) => {
		try {
			return original(...args);
		} catch (error) {
			failedStats += 1;
			throw error;
		}
	}) as typeof fs.statSync;
	try {
		return { value: await load(), failedStats };
	} finally {
		fsModule.statSync = original;
	}
}

describe("transformed extension TypeScript source specifiers", () => {
	const roots: string[] = [];

	afterEach(() => {
		while (roots.length > 0) {
			const root = roots.pop();
			if (root) fs.rmSync(root, { recursive: true, force: true });
		}
	});

	function fixtureRoot(): string {
		const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "atomic-ts-specifiers-"));
		roots.push(root);
		return root;
	}

	function writeImporter(root: string, specifier: string): string {
		const entry = path.join(root, "extension.ts");
		fs.writeFileSync(entry, `import { value } from "${specifier}";\n${probeExtension("value")}`);
		return entry;
	}

	function writeChain(root: string): { entry: string; leaf: string } {
		const entry = writeImporter(root, "./chain-a.js");
		fs.writeFileSync(
			path.join(root, "chain-a.ts"),
			`import { valueB } from "./chain-b.js";\nexport const value = valueB + ":a";\n`,
		);
		fs.writeFileSync(
			path.join(root, "chain-b.ts"),
			`import { valueC } from "./chain-c.js";\nexport const valueB = valueC + ":b";\n`,
		);
		const leaf = path.join(root, "chain-c.ts");
		fs.writeFileSync(leaf, `export const valueC = "ts";\n`);
		return { entry, leaf };
	}

	it("resolves .js specifiers of TypeScript sources without a failed probe per candidate", async () => {
		const { entry } = writeChain(fixtureRoot());

		const { value, failedStats } = await countFailedStats(() => loadValue(entry));

		assert.equal(value, "ts:b:a");
		assert.ok(
			failedStats <= 3 * MAX_FAILED_STATS_PER_IMPORT,
			`${failedStats} failed stat probes for three TypeScript imports`,
		);
	});

	it("keeps an existing JavaScript file ahead of its TypeScript sibling", async () => {
		const root = fixtureRoot();
		const entry = writeImporter(root, "./dual.js");
		fs.writeFileSync(path.join(root, "dual.js"), `export const value = "js";\n`);
		fs.writeFileSync(path.join(root, "dual.ts"), `export const value = "ts";\n`);

		assert.equal(await loadValue(entry), "js");
	});

	it("loads a cached importer after its TypeScript dependency becomes JavaScript", async () => {
		const { entry, leaf } = writeChain(fixtureRoot());
		assert.equal(await loadValue(entry), "ts:b:a");

		fs.rmSync(leaf);
		fs.writeFileSync(leaf.replace(/\.ts$/, ".js"), `export const valueC = "js";\n`);

		assert.equal(await loadValue(entry), "js:b:a");
	});

	it("loads the TypeScript source a .mjs specifier names, not another extension's sibling", async () => {
		const root = fixtureRoot();
		const entry = writeImporter(root, "./helper.mjs");
		fs.writeFileSync(path.join(root, "helper.mts"), `export const value = "mts";\n`);
		fs.writeFileSync(path.join(root, "helper.js"), `export const value = "js";\n`);

		assert.equal(await loadValue(entry), "mts");
	});

	it("loads the TypeScript source a .js specifier names, not a .mjs sibling", async () => {
		const root = fixtureRoot();
		const entry = writeImporter(root, "./helper.js");
		fs.writeFileSync(path.join(root, "helper.ts"), `export const value = "ts";\n`);
		fs.writeFileSync(path.join(root, "helper.mjs"), `export const value = "mjs";\n`);

		assert.equal(await loadValue(entry), "ts");
	});

	it("loads a JavaScript file created after its importer was cached", async () => {
		const root = fixtureRoot();
		const entry = writeImporter(root, "./helper.js");
		fs.writeFileSync(path.join(root, "helper.ts"), `export const value = "ts";\n`);
		assert.equal(await loadValue(entry), "ts");

		fs.writeFileSync(path.join(root, "helper.js"), `export const value = "js";\n`);

		assert.equal(await loadValue(entry), "js");
	});

	it("leaves a locally bound require to resolve against its own base", async () => {
		const root = fixtureRoot();
		const entry = path.join(root, "extension.ts");
		fs.writeFileSync(
			entry,
			[
				`import { createRequire } from "node:module";`,
				`import { dirname, join } from "node:path";`,
				`import { fileURLToPath } from "node:url";`,
				`function load(require: (id: string) => string): string {`,
				`\treturn require("./helper.js");`,
				`}`,
				`const value = load(createRequire(join(dirname(fileURLToPath(import.meta.url)), "other", "anchor.js")));`,
				probeExtension("value"),
			].join("\n"),
		);
		fs.writeFileSync(path.join(root, "helper.ts"), `export default "local-ts";\n`);
		fs.mkdirSync(path.join(root, "other"));
		fs.writeFileSync(path.join(root, "other", "helper.js"), `module.exports = "other-js";\n`);

		assert.equal(await loadValue(entry), "other-js");
	});
});
