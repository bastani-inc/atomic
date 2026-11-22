/**
 * The gates the build writes at the paths an earlier release imports on demand
 * (`packages/coding-agent/scripts/in-place-update-gate.mjs`): a process of an earlier release that imports one after an
 * in-place update is told to restart before any of this build's code loads, and a process of this build gets the
 * module's code. Each case runs in a process of its own, whose module loader holds what it loaded before.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "vitest";
import {
	gateSource,
	RELEASE_MODULE_STUB,
	releaseVersionModules,
} from "../../packages/coding-agent/scripts/in-place-update-gate.mjs";
import { bunExecutable, makeTempDirectory, removeTempDirectory, spawnSyncCollect } from "../helpers/runtime.js";

/** One Node or Bun child process per case: structural, not a slow test. */
const CHILD_TIMEOUT_MS = 60_000;

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDirectory(dir);
});

/** A release record whose processes all loaded `holder` (in `dist`), which names that release's version. */
const record = (version: string, holder: string) => ({
	version,
	packages: {
		"@bastani/atomic": {
			files: { [`dist/${holder}`]: ["APP_NAME", "VERSION"], "dist/index.js": ["APP_NAME", "VERSION"] },
			startup: [`dist/${holder}`],
			running: ["dist/index.js", `dist/${holder}`],
		},
	},
});

/** This build (2.0.0) writes `index.js` and `_shared/own.js`; 1.0.0's process held `_shared/old.js`, 1.5.0's `own.js`. */
const RECORDS = [record("1.0.0", "_shared/old.js"), record("1.5.0", "_shared/own.js")];
const BUILD_FILES = new Set(["index.js", "_shared/own.js"]);

interface Outcome {
	readonly message?: string;
	readonly exported?: string;
	readonly defaultExport?: number;
	readonly implementationLoaded: boolean;
	readonly ownLoaded: boolean;
}

/**
 * A process that first loads what a process of `held` loaded (`{ "_shared/old.js": "1.0.0" }`: that file, of that
 * version), then has its installation updated to this build, then imports the gated `/export` module.
 */
function importAfterUpdate(runtime: "node" | "bun", held: Record<string, string>): Outcome {
	const dir = makeTempDirectory("atomic-in-place-gate-");
	dirs.push(dir);
	const dist = join(dir, "dist");
	const write = (path: string, contents: string) => {
		mkdirSync(dirname(join(dist, path)), { recursive: true });
		writeFileSync(join(dist, path), contents);
	};
	const holder = (version: string) =>
		`export const VERSION = ${JSON.stringify(version)};\nexport const APP_NAME = "atomic";\n`;
	for (const [path, version] of Object.entries(held)) write(path, holder(version));
	const { probes, stubs } = releaseVersionModules(RECORDS, (path: string) => BUILD_FILES.has(path));
	const update = [
		...stubs.map((path: string) => [path, RELEASE_MODULE_STUB]),
		["_shared/own.js", `globalThis.ownLoaded = true;\n${holder("2.0.0")}`],
		["index.js", `export * from "./_shared/own.js";\n`],
		[
			"core/export-html/index.js",
			gateSource({
				path: "core/export-html/index.js",
				exports: ["exportSessionToHtml", "default"],
				probes,
				version: "2.0.0",
			}),
		],
		[
			"core/export-html/index.impl.js",
			'globalThis.implementationLoaded = true;\nexport const exportSessionToHtml = () => "html";\nexport default 42;\n',
		],
	];
	const script = join(dir, "process.mjs");
	writeFileSync(
		script,
		[
			'import { mkdirSync, rmSync, writeFileSync } from "node:fs";',
			'import { dirname, join } from "node:path";',
			"const dist = process.argv[2];",
			`for (const path of ${JSON.stringify(Object.keys(held))}) await import(new URL("./dist/" + path, import.meta.url).href);`,
			// The update removes the files the build does not write, and writes its own.
			`for (const path of ${JSON.stringify(Object.keys(held))}) rmSync(join(dist, path));`,
			`for (const [path, contents] of ${JSON.stringify(update)}) {`,
			"\tmkdirSync(dirname(join(dist, path)), { recursive: true });",
			"\twriteFileSync(join(dist, path), contents);",
			"}",
			"const outcome = {};",
			"try {",
			'\tconst module = await import(new URL("./dist/core/export-html/index.js", import.meta.url).href);',
			"\toutcome.exported = module.exportSessionToHtml();",
			"\toutcome.defaultExport = module.default;",
			"} catch (error) {",
			"\toutcome.message = error.message;",
			"}",
			"outcome.implementationLoaded = globalThis.implementationLoaded === true;",
			"outcome.ownLoaded = globalThis.ownLoaded === true;",
			"console.log(JSON.stringify(outcome));",
		].join("\n"),
	);
	const executable = runtime === "bun" ? bunExecutable() : process.execPath;
	const result = spawnSyncCollect([executable, script, dist], { cwd: dir, timeout: CHILD_TIMEOUT_MS });
	assert.equal(result.exitCode, 0, result.stderr.toString());
	return JSON.parse(result.stdout.toString().trim().split("\n").at(-1) ?? "{}") as Outcome;
}

const RESTART = "atomic was updated to 2.0.0 while this session was running; restart it to keep using session export.";

describe.each(["node", "bun"] as const)("a gated module under %s", (runtime) => {
	test(
		"tells a process of an earlier release whose module the update removed to restart, loading none of the build's code",
		() => {
			const outcome = importAfterUpdate(runtime, { "_shared/old.js": "1.0.0" });
			assert.deepEqual(outcome, { message: RESTART, implementationLoaded: false, ownLoaded: false });
		},
		CHILD_TIMEOUT_MS,
	);

	test(
		"tells a process of an earlier release that holds a module at a path of this build's to restart",
		() => {
			const outcome = importAfterUpdate(runtime, { "_shared/own.js": "1.5.0" });
			assert.deepEqual(outcome, { message: RESTART, implementationLoaded: false, ownLoaded: false });
		},
		CHILD_TIMEOUT_MS,
	);

	test(
		"gives a process of this build the module's exports",
		() => {
			const outcome = importAfterUpdate(runtime, { "_shared/own.js": "2.0.0" });
			assert.deepEqual(outcome, {
				exported: "html",
				defaultExport: 42,
				implementationLoaded: true,
				ownLoaded: false,
			});
		},
		CHILD_TIMEOUT_MS,
	);
});

describe("the modules that tell which release a process runs", () => {
	test("are the earlier releases' own files, as stubs where this build writes none, before this build's files", () => {
		assert.deepEqual(
			releaseVersionModules(RECORDS, (path: string) => BUILD_FILES.has(path)),
			{ probes: ["_shared/old.js", "_shared/own.js"], stubs: ["_shared/old.js"] },
		);
	});

	test("may be a file of this build for one release only: a second would load in a process holding the first", () => {
		assert.throws(
			() =>
				releaseVersionModules(
					[...RECORDS, record("1.6.0", "_shared/own2.js")],
					(path: string) => path === "_shared/own.js" || path === "_shared/own2.js" || path === "index.js",
				),
			/more than one recorded release tells its version only through a file this build writes/,
		);
	});
});
