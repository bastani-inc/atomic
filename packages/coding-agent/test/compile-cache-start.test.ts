import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, test } from "vitest";
import { NODE_TS_SOURCE_HOOK } from "../../../test/helpers/node-ts-sources.js";
import {
	type CompileCacheStartInput,
	compileCacheHelperRuntime,
	compileCacheSharedHeapFlag,
	compileCacheStartMode,
	compileCacheWarmMarker,
	isCiValue,
	startsCompileCacheHelper,
} from "../src/utils/compile-cache.ts";
import { compileCacheWarmupRuntimes } from "../src/utils/compile-cache-warmup-host.ts";

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

describe("a CI run, which starts no compile-cache helper", () => {
	test("still leaves a cold cache alone but starts no helper to write it (#6132)", () => {
		assert.equal(startsCompileCacheHelper({ CI: "true" }), false);
		assert.equal(startsCompileCacheHelper({ CI: "0" }), true);
		assert.equal(startsCompileCacheHelper({}), true);
	});

	test("is any CI value but empty, 0 and false (#6132)", () => {
		for (const value of ["true", "1", "github-actions", " TRUE "]) assert.equal(isCiValue(value), true, value);
		for (const value of [undefined, "", " ", "0", "false", "FALSE"])
			assert.equal(isCiValue(value), false, String(value));
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

	test("is refused for a NODE_OPTIONS value Node would refuse, so no helper starts (#6132)", () => {
		// Node does not start with a quote left open in NODE_OPTIONS, so a helper given this value would never run.
		for (const nodeOptions of ['"--max-old-space-size=4096', '--max-old-space-size=4096 "--require ./a.cjs', '"\\']) {
			const runtime = compileCacheHelperRuntime([], { NODE_OPTIONS: nodeOptions });
			assert.equal(runtime, undefined, nodeOptions);
			assert.equal(
				compileCacheStartMode({
					...coldWindowsSession,
					helperRuntime: runtime !== undefined,
					warm: markerNeverRead,
				}),
				"enable",
				nodeOptions,
			);
		}
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
	test("includes an adopted engine heap flag so host and warmup helper share one runtime (#6222)", () => {
		const runtime = compileCacheHelperRuntime([], {}, ["--max-old-space-size=8192"]);
		assert.deepEqual(runtime, { execArgv: ["--max-old-space-size=8192"], nodeOptions: "" });
		assert.deepEqual(compileCacheWarmupRuntimes(runtime!, ["--max-old-space-size=8192"]), [runtime]);
		// Preloads are still dropped while keeping the adopted heap flag.
		assert.deepEqual(compileCacheHelperRuntime(["--require", "./hook.cjs"], {}, ["--max-old-space-size=8192"]), {
			execArgv: ["--max-old-space-size=8192"],
			nodeOptions: "",
		});
		// Unrepeatable host flags or non-V8 adopted flags still refuse helper deferral.
		assert.equal(compileCacheHelperRuntime(["--inspect"], {}, ["--max-old-space-size=8192"]), undefined);
		assert.equal(compileCacheHelperRuntime([], {}, ["--max-old-space-size-percentage=50"]), undefined);
	});
});

describe("aligning the host compile-cache heap flag with the engine (#6222)", () => {
	const baseInput = {
		runtimeIsBun: false,
		unsupported: false,
		alreadyEnabled: false,
		disabled: false,
		execArgv: [] as readonly string[],
		targetEngineHeapArgs: ["--max-old-space-size=16384"] as readonly string[],
	};

	test("adopts the single added --max-old-space-size flag when the cache is not pre-enabled", () => {
		assert.equal(compileCacheSharedHeapFlag(baseInput), "--max-old-space-size=16384");
		assert.equal(
			compileCacheSharedHeapFlag({
				...baseInput,
				execArgv: ["--max-semi-space-size=16"],
				targetEngineHeapArgs: ["--max-semi-space-size=16", "--max-old-space-size=16384"],
			}),
			"--max-old-space-size=16384",
		);
	});

	test("leaves V8 flags untouched when cache is pre-enabled, disabled, unsupported, on Bun, or already sized", () => {
		const skipped = [
			{ runtimeIsBun: true },
			{ unsupported: true },
			{ alreadyEnabled: true },
			{ disabled: true },
			{ targetEngineHeapArgs: [] },
			{ targetEngineHeapArgs: ["--max-old-space-size-percentage=50"] },
			{ execArgv: ["--max-old-space-size=4096"], targetEngineHeapArgs: ["--max-old-space-size=4096"] },
			{ execArgv: ["--max-old-space-size", "4096"], targetEngineHeapArgs: ["--max-old-space-size=16384"] },
			{ execArgv: ["--max_old_space_size=4096"], targetEngineHeapArgs: ["--max-old-space-size=16384"] },
			{ execArgv: ["--max-heap-size=4096"], targetEngineHeapArgs: ["--max-old-space-size=16384"] },
			{ execArgv: ["--max-old-space-size-percentage=50"], targetEngineHeapArgs: ["--max-old-space-size=16384"] },
		];
		for (const change of skipped) {
			assert.equal(compileCacheSharedHeapFlag({ ...baseInput, ...change }), undefined, JSON.stringify(change));
		}
	});
});

// It starts this runtime as Node; under Bun there is no Node directory to compare with.
describe.skipIf("bun" in process.versions)("the compile cache's warm marker", () => {
	test("host and engine share one compile-cache directory and accept each other's bytecode (#6222)", () => {
		const base = mkdtempSync(join(tmpdir(), "atomic-shared-cache-"));
		tempDirs.push(base);
		const compileCacheUrl = new URL("../src/utils/compile-cache.ts", import.meta.url).href;
		const samplePath = join(base, "sample-cached-module.mjs");
		writeFileSync(samplePath, "export const value = 42;\n");
		const sampleModuleUrl = pathToFileURL(samplePath).href;
		const sharedEnv = {
			...process.env,
			TMPDIR: base,
			TMP: base,
			TEMP: base,
			NODE_COMPILE_CACHE: "",
			NODE_OPTIONS: "",
		};
		const hostScript = [
			NODE_TS_SOURCE_HOOK,
			`import nodeModule from "node:module";`,
			`import { cachedDataVersionTag, getHeapStatistics } from "node:v8";`,
			`const { enablePersistentCompileCache, flushPersistentCompileCache } = await import(${JSON.stringify(compileCacheUrl)});`,
			`enablePersistentCompileCache({ interactive: false, build: "test", sharedHeapFlags: ["--max-old-space-size=8192"] });`,
			`await import(${JSON.stringify(sampleModuleUrl)});`,
			`flushPersistentCompileCache();`,
			`console.log(JSON.stringify({ dir: nodeModule.getCompileCacheDir(), tag: cachedDataVersionTag(), heapMb: Math.round(getHeapStatistics().heap_size_limit / 1048576) }));`,
		].join("\n");
		const host = spawnSync(process.execPath, ["--input-type=module", "-e", hostScript], {
			env: sharedEnv,
			encoding: "utf8",
		});
		assert.equal(host.status, 0, host.stderr);
		const hostInfo = JSON.parse(host.stdout) as { dir: string; tag: number; heapMb: number };

		const engineScript = [
			`import nodeModule from "node:module";`,
			`import { cachedDataVersionTag, getHeapStatistics } from "node:v8";`,
			`nodeModule.enableCompileCache();`,
			`await import(${JSON.stringify(sampleModuleUrl)});`,
			`console.log(JSON.stringify({ dir: nodeModule.getCompileCacheDir(), tag: cachedDataVersionTag(), heapMb: Math.round(getHeapStatistics().heap_size_limit / 1048576) }));`,
		].join("\n");
		const engine = spawnSync(
			process.execPath,
			["--max-old-space-size=8192", "--input-type=module", "-e", engineScript],
			{
				env: { ...sharedEnv, NODE_DEBUG_NATIVE: "compile_cache" },
				encoding: "utf8",
			},
		);
		assert.equal(engine.status, 0, engine.stderr);
		const engineInfo = JSON.parse(engine.stdout) as { dir: string; tag: number; heapMb: number };
		assert.equal(hostInfo.tag, engineInfo.tag);
		assert.equal(hostInfo.dir, engineInfo.dir);
		assert.ok(engineInfo.heapMb >= 8000, `engine heap limit must stay raised: ${engineInfo.heapMb}`);
		assert.match(engine.stderr, /sample-cached-module\.mjs was accepted/);
		assert.doesNotMatch(engine.stderr, /sample-cached-module\.mjs was rejected/);
	});

	test("does not mutate the V8 flag tag when NODE_COMPILE_CACHE is already enabled (#6222)", () => {
		const base = mkdtempSync(join(tmpdir(), "atomic-preenabled-cache-"));
		tempDirs.push(base);
		const compileCacheUrl = new URL("../src/utils/compile-cache.ts", import.meta.url).href;
		const script = [
			NODE_TS_SOURCE_HOOK,
			`import { cachedDataVersionTag } from "node:v8";`,
			`const { enablePersistentCompileCache } = await import(${JSON.stringify(compileCacheUrl)});`,
			`const before = cachedDataVersionTag();`,
			`enablePersistentCompileCache({ interactive: false, build: "test", sharedHeapFlags: ["--max-old-space-size=8192"] });`,
			`const after = cachedDataVersionTag();`,
			`console.log(JSON.stringify({ before, after }));`,
		].join("\n");
		const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
			env: { ...process.env, NODE_COMPILE_CACHE: base, NODE_OPTIONS: "" },
			encoding: "utf8",
		});
		assert.equal(result.status, 0, result.stderr);
		const { before, after } = JSON.parse(result.stdout) as { before: number; after: number };
		assert.equal(after, before);
	});
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
