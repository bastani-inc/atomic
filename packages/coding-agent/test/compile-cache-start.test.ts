import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, test } from "vitest";
import {
	type CompileCacheStartInput,
	compileCacheHelperRuntime,
	compileCacheStartMode,
	compileCacheWarmMarker,
} from "../src/utils/compile-cache.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const coldWindowsSession: CompileCacheStartInput = {
	platform: "win32",
	runtimeIsBun: false,
	unsupported: false,
	alreadyEnabled: false,
	disabled: false,
	interactive: true,
	helperRuntime: true,
	warm: () => false,
};

function markerNeverRead(): boolean {
	throw new Error("the marker was read although an earlier condition already decided");
}

describe("how a process starts with the compile cache", () => {
	test("a Windows interactive session with a cold cache runs without it and leaves it to a helper (#6132)", () => {
		assert.equal(compileCacheStartMode(coldWindowsSession), "defer");
		assert.equal(compileCacheStartMode({ ...coldWindowsSession, warm: () => true }), "enable");
	});

	test("every other process uses the cache as before, without reading the marker (#6132)", () => {
		const others: Partial<CompileCacheStartInput>[] = [
			{ platform: "linux" },
			{ platform: "darwin" },
			{ runtimeIsBun: true },
			{ unsupported: true },
			// NODE_COMPILE_CACHE: Node enabled it before Atomic ran.
			{ alreadyEnabled: true },
			// NODE_DISABLE_COMPILE_CACHE, whatever its value.
			{ disabled: true },
			// print and RPC modes, subcommands, --help and --version, an engine whose host does not warm it
			{ interactive: false },
			// an inspector, a profiler, coverage or other V8 flags a helper cannot repeat
			{ helperRuntime: false },
		];
		for (const change of others) {
			assert.equal(
				compileCacheStartMode({ ...coldWindowsSession, ...change, warm: markerNeverRead }),
				"enable",
				JSON.stringify(change),
			);
		}
	});
});

describe("the runtime a compile-cache helper repeats", () => {
	test("keeps the heap size and drops preloads with their values (#6132)", () => {
		assert.deepEqual(compileCacheHelperRuntime([], {}), { execArgv: [], nodeOptions: "" });
		assert.deepEqual(compileCacheHelperRuntime(["--max-old-space-size=8192"], {}), {
			execArgv: ["--max-old-space-size=8192"],
			nodeOptions: "",
		});
		assert.deepEqual(
			compileCacheHelperRuntime(["--require", "./hook.cjs", "--max_old_space_size=4096"], {
				NODE_OPTIONS: "--import=tsx -r ./a.cjs --max-old-space-size=2048 --experimental-loader ./loader.mjs",
			}),
			{ execArgv: ["--max_old_space_size=4096"], nodeOptions: "--max-old-space-size=2048" },
		);
	});

	test("is refused for anything else a second process would repeat (#6132)", () => {
		for (const [execArgv, env] of [
			[["--inspect"], {}],
			[["--cpu-prof"], {}],
			[["--stack-size=2000"], {}],
			[[], { NODE_OPTIONS: "--inspect-brk" }],
			[[], { NODE_OPTIONS: "--prof" }],
			[[], { NODE_V8_COVERAGE: "/tmp/coverage" }],
		] as const) {
			assert.equal(compileCacheHelperRuntime(execArgv, env), undefined, JSON.stringify({ execArgv, env }));
		}
	});
});

// It starts this runtime as Node; under Bun there is no Node directory to compare with.
describe.skipIf("bun" in process.versions)("the compile cache's warm marker", () => {
	test("lies in the directory Node itself caches into for the same runtime flags (#6132)", () => {
		const probe = [
			"const m = require('node:module');",
			"m.enableCompileCache(process.env.CACHE_BASE);",
			"console.log(JSON.stringify({ dir: m.getCompileCacheDir(), version: process.version, arch: process.arch,",
			"  tag: require('node:v8').cachedDataVersionTag(), uid: process.getuid ? process.getuid() : undefined }));",
		].join("\n");
		for (const flags of [[], ["--max-old-space-size=4096"]]) {
			const base = mkdtempSync(join(tmpdir(), "atomic-cache-tag-"));
			tempDirs.push(base);
			const result = spawnSync(process.execPath, [...flags, "-e", probe], {
				env: { ...process.env, CACHE_BASE: base, NODE_COMPILE_CACHE: "", NODE_OPTIONS: "" },
				encoding: "utf8",
			});
			assert.equal(result.status, 0, result.stderr);
			const node = JSON.parse(result.stdout) as {
				dir: string;
				version: string;
				arch: string;
				tag: number;
				uid: number | undefined;
			};
			const marker = compileCacheWarmMarker({
				baseDir: base,
				nodeVersion: node.version,
				arch: node.arch,
				versionTag: node.tag,
				uid: node.uid,
				buildId: "build",
			});
			assert.equal(dirname(marker), node.dir, JSON.stringify(flags));
			assert.equal(basename(marker), "atomic-warm-build");
		}
	});
});
