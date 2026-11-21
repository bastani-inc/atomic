import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, test } from "vitest";
import { cliImports, markerPlace, readModule } from "../../packages/coding-agent/scripts/startup-stages-source.mjs";
import {
	bunExecutable,
	makeTempDirectory,
	moduleDir,
	removeTempDirectory,
	spawnSyncCollect,
} from "../helpers/runtime.js";

const DIST = join(moduleDir(import.meta.url), "../../packages/coding-agent/dist");
/** Each run is a child process that loads the whole application: structural, not a slow test. */
const WHOLE_APPLICATION_LOAD_TIMEOUT_MS = 120_000;

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDirectory(dir);
});

/**
 * A child that loads what `cli.js` and the early editor load, then the session's entry modules as `cli.js` does, with or
 * without the stages first, and reports the order the modules after that ran in (a marker prepended to each module's
 * source), and how many had run when a timer set before the stages fired.
 */
const CHILD = `
import { registerHooks } from "node:module";
import { writeFileSync } from "node:fs";
const [imports, staged, reportFile] = [JSON.parse(process.argv[2]), process.argv[3] === "staged", process.argv[4]];
const ran = [];
globalThis.__startupStagesTest = ran;
registerHooks({
	load(url, context, nextLoad) {
		const result = nextLoad(url, context);
		if (!url.startsWith("file:") || (result.format !== "module" && result.format !== "commonjs") || result.source == null) return result;
		const source = typeof result.source === "string" ? result.source : Buffer.from(result.source).toString("utf8");
		const lineEnd = source.startsWith("#!") ? source.indexOf("\\n") + 1 : 0;
		const marker = "globalThis.__startupStagesTest.push(" + JSON.stringify(url) + ");";
		return { ...result, source: source.slice(0, lineEnd) + marker + source.slice(lineEnd) };
	},
});
for (const url of imports.before) await import(url);
const { loadStartupStages } = await import(imports.loader);
ran.length = 0;
let ranWhenTimerFired;
setTimeout(() => { ranWhenTimerFired = ran.length; }, 0);
if (staged) await loadStartupStages();
await Promise.all(imports.entries.map((url) => import(url)));
await new Promise((resolve) => setTimeout(resolve, 0));
const order = ran.filter((url) => !url.includes("/startup-stages/"));
writeFileSync(reportFile, JSON.stringify({ order, ranWhenTimerFired, total: ran.length }));
process.exit(0);
`;

interface ChildReport {
	readonly order: string[];
	readonly ranWhenTimerFired: number;
	readonly total: number;
}

function runChild(mode: "staged" | "natural", nodeOptions = "", nodeFlags: readonly string[] = []): ChildReport {
	const dir = makeTempDirectory("atomic-startup-stages-");
	dirs.push(dir);
	const script = join(dir, "child.mjs");
	writeFileSync(script, CHILD);
	const report = join(dir, "report.json");
	const result = spawnSyncCollect(
		[process.execPath, ...nodeFlags, script, JSON.stringify(cliImports(DIST)), mode, report],
		{
			env: { ...process.env, NODE_OPTIONS: nodeOptions },
			timeout: WHOLE_APPLICATION_LOAD_TIMEOUT_MS,
		},
	);
	assert.equal(result.exitCode, 0, result.stderr.toString());
	return JSON.parse(readFileSync(report, "utf8")) as ChildReport;
}

describe("startup stages", () => {
	test("the build wrote stages", () => {
		const stages = JSON.parse(readFileSync(join(DIST, "startup-stages", "stages.json"), "utf8")) as {
			stages: number;
		};
		assert.ok(stages.stages > 1, "more than one stage");
		for (let stage = 0; stage < stages.stages; stage++)
			assert.ok(existsSync(join(DIST, "startup-stages", `${stage}.js`)), `stage ${stage}`);
	});

	test(
		"loading the stages and then the session's entry modules runs every module once, in the order the entry modules alone run them, with turns of the event loop between",
		() => {
			const natural = runChild("natural");
			const staged = runChild("staged");
			assert.ok(natural.order.length > 100, "the session's modules ran");
			assert.deepEqual(staged.order, natural.order);
			assert.equal(new Set(staged.order).size, staged.order.length, "no module ran twice");
			// Loading the entry modules alone gives a timer no turn until every module has run; the stages do.
			assert.equal(natural.ranWhenTimerFired, natural.total);
			assert.ok(staged.ranWhenTimerFired < staged.total, "a timer ran while the modules loaded");
		},
		2 * WHOLE_APPLICATION_LOAD_TIMEOUT_MS,
	);

	test(
		"no stages load in a process with a preload, which could resolve each importer's modules its own way",
		() => {
			const dir = makeTempDirectory("atomic-startup-stages-preload-");
			dirs.push(dir);
			const preload = join(dir, "preload.mjs");
			writeFileSync(preload, "");
			const staged = runChild("staged", `--import ${JSON.stringify(pathToFileURL(preload).href)}`);
			assert.equal(staged.ranWhenTimerFired, staged.total, "no turn of the event loop while the modules loaded");
		},
		WHOLE_APPLICATION_LOAD_TIMEOUT_MS,
	);

	test(
		"a stage that has not run in full by the turn after it, as one awaiting another stage would, ends the stages",
		() => {
			// The stage loader with two stages of its own: the first awaits what the second releases.
			const dir = makeTempDirectory("atomic-startup-stages-await-");
			dirs.push(dir);
			const dist = join(dir, "dist");
			mkdirSync(join(dist, "startup-stages"), { recursive: true });
			// The build's stage loader, with the modules of this build it imports, at the same places under `dist`.
			const loader = fileURLToPath(cliImports(DIST).loader);
			const copy = (path: string) => {
				const target = join(dist, relative(DIST, path));
				if (existsSync(target)) return;
				mkdirSync(dirname(target), { recursive: true });
				copyFileSync(path, target);
				for (const specifier of readModule(readFileSync(path, "utf8")).specifiers)
					if (specifier.startsWith(".")) copy(join(dirname(path), specifier));
			};
			copy(loader);
			symlinkSync(join(DIST, "..", "..", "..", "node_modules"), join(dir, "node_modules"), "junction");
			writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
			writeFileSync(
				join(dist, "startup-stages", "0.js"),
				'globalThis.ran.push("awaits");\nawait globalThis.released;\nglobalThis.ran.push("released");\n',
			);
			writeFileSync(
				join(dist, "startup-stages", "1.js"),
				'globalThis.ran.push("releases");\nglobalThis.release();\n',
			);
			writeFileSync(join(dist, "startup-stages", "stages.json"), JSON.stringify({ version: 1, stages: 2 }));
			const script = join(dir, "child.mjs");
			writeFileSync(
				script,
				`globalThis.ran = [];
globalThis.released = new Promise((resolve) => { globalThis.release = resolve; });
const { loadStartupStages } = await import(${JSON.stringify(pathToFileURL(join(dist, relative(DIST, loader))).href)});
await loadStartupStages();
const afterStages = [...globalThis.ran];
// What the session's own imports then do: they reach the second stage's module, which releases the first.
await import(${JSON.stringify(pathToFileURL(join(dist, "startup-stages", "1.js")).href)});
await import(${JSON.stringify(pathToFileURL(join(dist, "startup-stages", "0.js")).href)});
process.stdout.write(JSON.stringify({ afterStages, ran: globalThis.ran }));
process.exit(0);
`,
			);
			const result = spawnSyncCollect([process.execPath, script], {
				env: { ...process.env, NODE_OPTIONS: "" },
				timeout: WHOLE_APPLICATION_LOAD_TIMEOUT_MS,
			});
			assert.equal(result.exitCode, 0, result.stderr.toString());
			assert.deepEqual(JSON.parse(result.stdout.toString()), {
				afterStages: ["awaits"],
				ran: ["awaits", "releases", "released"],
			});
		},
		WHOLE_APPLICATION_LOAD_TIMEOUT_MS,
	);

	test(
		"no stages load with a Node configuration file, which can hold a preload or conditions",
		() => {
			const dir = makeTempDirectory("atomic-startup-stages-config-");
			dirs.push(dir);
			const config = join(dir, "node.config.json");
			writeFileSync(config, JSON.stringify({ nodeOptions: {} }));
			const staged = runChild("staged", "", [`--experimental-config-file=${config}`]);
			assert.equal(staged.ranWhenTimerFired, staged.total, "no turn of the event loop while the modules loaded");
		},
		WHOLE_APPLICATION_LOAD_TIMEOUT_MS,
	);

	test(
		"no stages load with custom package conditions, which can choose other files for the same names",
		() => {
			const staged = runChild("staged", "--conditions=atomic-test-condition");
			assert.equal(staged.ranWhenTimerFired, staged.total, "no turn of the event loop while the modules loaded");
		},
		WHOLE_APPLICATION_LOAD_TIMEOUT_MS,
	);

	test(
		"under Bun, which turns the event loop while it loads modules itself, the session's modules load as before",
		() => {
			const dir = makeTempDirectory("atomic-startup-stages-bun-");
			dirs.push(dir);
			const script = join(dir, "child.mjs");
			writeFileSync(
				script,
				`const imports = ${JSON.stringify(cliImports(DIST))};
const { loadStartupStages } = await import(imports.loader);
await loadStartupStages();
const stagesLoaded = Object.keys(require.cache).some((path) => /[\\/]startup-stages[\\/]/.test(path));
const loaded = await Promise.all(imports.entries.map((url) => import(url)));
process.stdout.write(JSON.stringify({ stagesLoaded, main: typeof loaded.find((entry) => typeof entry.main === "function")?.main }));
process.exit(0);
`,
			);
			const result = spawnSyncCollect([bunExecutable(), script], { timeout: WHOLE_APPLICATION_LOAD_TIMEOUT_MS });
			assert.equal(result.exitCode, 0, result.stderr.toString());
			assert.deepEqual(JSON.parse(result.stdout.toString()), { stagesLoaded: false, main: "function" });
		},
		WHOLE_APPLICATION_LOAD_TIMEOUT_MS,
	);
});

describe("how the stages build reads a module", () => {
	test("anything that awaits while the module runs counts as a top-level await", () => {
		for (const source of [
			"await gate;",
			"const value = await gate;",
			"for await (const item of items) {}",
			"await using resource = open();",
			"class Child extends (await gate) {}",
			"class Child { [await gate]() {} }",
			"class Child { [await gate] = 1; }",
			"export default class extends (await gate) {}",
			"label: { await gate; }",
		])
			assert.equal(readModule(source).topLevelAwait, true, source);
	});

	test("an await that runs later, in a function or a method, does not", () => {
		for (const source of [
			"async function load() { await gate; }",
			"const load = async () => await gate;",
			"class Child { async load() { await gate; } }",
			"class Child { static { const value = 1; } static field = 1; }",
			"export const value = 1;",
		])
			assert.equal(readModule(source).topLevelAwait, false, source);
	});

	test("the trace's marker goes after a CommonJS module's directives, which then still apply", () => {
		const strict = "'use strict'\nmodule.exports = 1;";
		const { at, before } = markerPlace(strict, "commonjs");
		assert.equal(`${strict.slice(0, at)}${before}MARK${strict.slice(at)}`, "'use strict';MARK\nmodule.exports = 1;");
		assert.deepEqual(markerPlace("#!/usr/bin/env node\nexport {};", "module"), { at: 20, before: "" });
		assert.deepEqual(markerPlace("module.exports = 1;", "commonjs"), { at: 0, before: "" });
	});
});
