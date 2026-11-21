import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, test } from "vitest";
import { markerPlace, readModule } from "../../packages/coding-agent/scripts/startup-stages-source.mjs";
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
const [dist, staged, reportFile] = [process.argv[2], process.argv[3] === "staged", process.argv[4]];
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
const at = (path) => new URL(path, dist).href;
for (const path of ["config.js", "core/lifecycle-timings.js", "utils/agent-attribution.js", "utils/compile-cache.js", "utils/heap-relaunch.js", "utils/inherited-hangup.js", "utils/interactive-engine-bootstrap.js", "utils/interactive-invocation.js", "modes/interactive-engine/engine-prewarm.js", "modes/interactive/startup-shell-eligibility.js", "modes/interactive/startup-shell.js"]) await import(at(path));
const { loadStartupStages } = await import(at("utils/startup-stages.js"));
ran.length = 0;
let ranWhenTimerFired;
setTimeout(() => { ranWhenTimerFired = ran.length; }, 0);
if (staged) await loadStartupStages();
await Promise.all([import(at("core/http-dispatcher.js")), import(at("main.js")), import(at("cli/settings-startup.js"))]);
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

function runChild(mode: "staged" | "natural", nodeOptions = ""): ChildReport {
	const dir = makeTempDirectory("atomic-startup-stages-");
	dirs.push(dir);
	const script = join(dir, "child.mjs");
	writeFileSync(script, CHILD);
	const report = join(dir, "report.json");
	const result = spawnSyncCollect([process.execPath, script, pathToFileURL(`${DIST}/`).href, mode, report], {
		env: { ...process.env, NODE_OPTIONS: nodeOptions },
		timeout: WHOLE_APPLICATION_LOAD_TIMEOUT_MS,
	});
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
		"Bun loads the stages and then the session's entry modules",
		() => {
			const dir = makeTempDirectory("atomic-startup-stages-bun-");
			dirs.push(dir);
			const script = join(dir, "child.mjs");
			writeFileSync(
				script,
				`const dist = ${JSON.stringify(pathToFileURL(`${DIST}/`).href)};
const { loadStartupStages } = await import(new URL("utils/startup-stages.js", dist).href);
await loadStartupStages();
const [, main] = await Promise.all([import(new URL("core/http-dispatcher.js", dist).href), import(new URL("main.js", dist).href), import(new URL("cli/settings-startup.js", dist).href)]);
process.stdout.write(typeof main.main);
process.exit(0);
`,
			);
			const result = spawnSyncCollect([bunExecutable(), script], { timeout: WHOLE_APPLICATION_LOAD_TIMEOUT_MS });
			assert.equal(result.exitCode, 0, result.stderr.toString());
			assert.equal(result.stdout.toString(), "function");
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
