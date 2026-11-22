// Exercises the in-place update check on small packages: what an earlier release's process holds, what it loads after
// an update, and what of this build that breaks.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { checkRelease, recordRelease } from "./in-place-update-exports.mjs";

/** Writes a package of `files` (path -> source) with `manifest` into a new directory, and returns it. */
function writePackage(t, manifest, files) {
	const dir = mkdtempSync(join(tmpdir(), "atomic-in-place-update-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module", files: ["dist"], ...manifest }));
	for (const [path, source] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), source);
	}
	return dir;
}

const APPLICATION = {
	name: "@bastani/atomic",
	version: "1.0.0",
	bin: { atomic: "dist/cli.js" },
	exports: { ".": "./dist/index.js" },
};
const DEPENDENCY = {
	name: "@bastani/atomic-ai",
	version: "1.0.0",
	exports: { ".": "./dist/index.js", "./utils/*": "./dist/utils/*.js" },
};

/**
 * An application whose CLI imports `config.js` at start and its main module on demand, which imports a tool on demand;
 * its SDK entry exports the configuration. `changes` replaces files.
 */
function application(t, changes = {}, manifest = {}) {
	return writePackage(
		t,
		{ ...APPLICATION, ...manifest },
		{
			"dist/cli.js": 'import { NAME } from "./config.js";\nawait import("./main.js");\nexport {};\n',
			"dist/config.js": 'export const NAME = "atomic";\n',
			"dist/index.js": 'export { NAME } from "./config.js";\n',
			"dist/main.js": 'export async function main() { await import("./tool.js"); }\n',
			"dist/tool.js": 'import { load } from "./shared.js";\nexport const tool = load;\n',
			"dist/shared.js": "export function load() {}\n",
			...changes,
		},
	);
}

function dependency(t, changes = {}, manifest = {}) {
	return writePackage(
		t,
		{ ...DEPENDENCY, ...manifest },
		{
			"dist/index.js": "export const model = 1;\n",
			"dist/utils/proxy.js": "export const proxy = 1;\n",
			...changes,
		},
	);
}

/** What updating a process of the release in `earlier` to `current` breaks. */
function check(earlier, current, allowed) {
	return checkRelease(recordRelease(earlier), current, allowed);
}

test("an update that keeps every name and file an earlier process uses breaks nothing", (t) => {
	assert.deepEqual(check([application(t), dependency(t)], [application(t), dependency(t)]), []);
});

test("a file loaded on demand that names an export the earlier copy of its import lacks breaks", (t) => {
	const current = application(t, {
		"dist/tool.js": 'import { load, unload } from "./shared.js";\nexport const tool = [load, unload];\n',
		"dist/shared.js": "export function load() {}\nexport function unload() {}\n",
	});
	assert.deepEqual(check([application(t), dependency(t)], [current, dependency(t)]), [
		"@bastani/atomic/dist/tool.js imports unload from @bastani/atomic/dist/shared.js, which 1.0.0's copy lacks",
	]);
});

test("the main module a starting process loads after the update links against the configuration it loaded at start", (t) => {
	const current = application(t, {
		"dist/config.js": 'export const NAME = "atomic";\nexport const TITLE = "Atomic";\n',
		"dist/main.js":
			'import { TITLE } from "./config.js";\nexport async function main() { await import("./tool.js"); return TITLE; }\n',
	});
	assert.deepEqual(check([application(t), dependency(t)], [current, dependency(t)]), [
		"@bastani/atomic/dist/main.js imports TITLE from @bastani/atomic/dist/config.js, which 1.0.0's copy lacks",
	]);
});

test("a new CLI may name new exports: no process of the earlier release loads the update's copy", (t) => {
	const current = application(t, {
		"dist/cli.js":
			'import { NAME, TITLE } from "./config.js";\nawait import("./main.js");\nexport { NAME, TITLE };\n',
		"dist/config.js": 'export const NAME = "atomic";\nexport const TITLE = "Atomic";\n',
	});
	assert.deepEqual(check([application(t), dependency(t)], [current, dependency(t)]), []);
});

test("a file the earlier release loads on demand must stay, with the exports it had", (t) => {
	const removed = application(t);
	rmSync(join(removed, "dist/tool.js"));
	assert.deepEqual(check([application(t), dependency(t)], [removed, dependency(t)]), [
		"1.0.0's @bastani/atomic/dist/main.js imports @bastani/atomic/dist/tool.js: this build lacks it",
	]);
	const shrunk = application(t, { "dist/tool.js": "export const other = 1;\n" });
	assert.deepEqual(check([application(t), dependency(t)], [shrunk, dependency(t)]), [
		"1.0.0's @bastani/atomic/dist/main.js imports @bastani/atomic/dist/tool.js, which no longer exports tool",
	]);
});

test("a package subpath resolves through the exports map the earlier process read", (t) => {
	const current = application(t, {
		"dist/tool.js":
			'import { load } from "./shared.js";\nimport { pool } from "@bastani/atomic-ai/pool";\nexport const tool = [load, pool];\n',
	});
	const newer = dependency(
		t,
		{ "dist/pool.js": "export const pool = 1;\n" },
		{
			exports: { ...DEPENDENCY.exports, "./pool": "./dist/pool.js" },
		},
	);
	const earlier = [application(t), dependency(t)];
	assert.deepEqual(check(earlier, [current, newer]), [
		"@bastani/atomic/dist/tool.js imports @bastani/atomic-ai/pool, which 1.0.0 does not export",
	]);
	assert.deepEqual(
		check(earlier, [current, newer], { "@bastani/atomic-ai/pool": "no earlier process loads tool.js" }),
		[],
	);
});

test("a new file a pattern export reaches in a directory the earlier release had is one Bun cannot find", (t) => {
	const current = application(t, {
		"dist/tool.js":
			'import { load } from "./shared.js";\nimport { retry } from "@bastani/atomic-ai/utils/retry";\nexport const tool = [load, retry];\n',
	});
	const newer = dependency(t, { "dist/utils/retry.js": "export const retry = 1;\n" });
	assert.deepEqual(check([application(t), dependency(t)], [current, newer]), [
		"@bastani/atomic/dist/tool.js imports @bastani/atomic-ai/utils/retry: dist/utils/retry.js is new in a directory 1.0.0 had",
	]);
});

test("a record lists each file's export names through `export *`, and what the CLI loads at start", (t) => {
	const record = recordRelease([
		application(t, {
			"dist/index.js":
				'export * from "./config.js";\nexport * from "@bastani/atomic-ai";\nexport { load as default } from "./shared.js";\n',
		}),
		dependency(t),
	]);
	const atomic = record.packages["@bastani/atomic"];
	assert.deepEqual(atomic.files["dist/index.js"], ["NAME", "default", "model"]);
	assert.deepEqual(atomic.startup, ["dist/cli.js", "dist/config.js"]);
	assert.deepEqual(atomic.lazy, {
		"@bastani/atomic:dist/main.js": ["dist/cli.js"],
		"@bastani/atomic:dist/tool.js": ["dist/main.js"],
	});
});

test("a bundled module's own URL is not a file the release starts, and a worker it starts must stay", (t) => {
	const earlier = application(t, {
		// As a bundle keeps each module's own URL, naming its compiled file, which the package may not ship.
		"dist/shared.js":
			'var moduleUrl = new URL("./bundled-away.js", import.meta.url).href;\nvar keptUrl = new URL("./config.js", import.meta.url).href;\nexport function load() { return [moduleUrl, keptUrl]; }\n',
		"dist/tool.js":
			'import { load } from "./shared.js";\nexport const tool = () => new Worker(new URL("./worker.js", import.meta.url));\nexport { load };\n',
		"dist/worker.js": "export {};\n",
	});
	const record = recordRelease([earlier, dependency(t)]);
	assert.deepEqual(record.packages["@bastani/atomic"].workers, { "@bastani/atomic:dist/worker.js": ["dist/tool.js"] });
	assert.deepEqual(checkRelease(record, [earlier, dependency(t)]), []);
	const withoutWorker = application(t, {
		"dist/tool.js": 'import { load } from "./shared.js";\nexport const tool = load;\nexport { load };\n',
	});
	assert.deepEqual(checkRelease(record, [withoutWorker, dependency(t)]), [
		"1.0.0's @bastani/atomic/dist/tool.js starts @bastani/atomic/dist/worker.js: this build lacks it",
	]);
});
