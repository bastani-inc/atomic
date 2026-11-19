import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, it, vi } from "vitest";
import { getRuntimeCacheDir } from "../src/config.js";

let root: string;
let agent: string;
let systemTemp: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "runtime-storage-"));
	agent = join(root, "agent");
	systemTemp = join(root, "system");
	mkdirSync(systemTemp);
	env = { ...process.env, TMPDIR: systemTemp, TMP: systemTemp, TEMP: systemTemp, ATOMIC_CODING_AGENT_DIR: agent };
	delete env.NODE_COMPILE_CACHE;
	delete env.NODE_DISABLE_COMPILE_CACHE;
});
afterEach(() => rmSync(root, { force: true, recursive: true }));

it("the CLI enables its persistent compile cache without writing to the system temp directory", () => {
	const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
	const child = spawnSync(process.execPath, [cli, "--version"], { env, encoding: "utf8" });
	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(readdirSync(systemTemp), []);
	assert.ok(existsSync(join(agent, "cache", "node")));
});

it("prunes obsolete bytecode generations but keeps the current and previous generations and unrelated files", async () => {
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agent);
	vi.useFakeTimers();
	try {
		vi.setSystemTime(new Date(10 * 30 * 24 * 60 * 60 * 1000));
		const cache = join(agent, "cache", "node");
		for (const name of ["8", "9", "10", "unrelated"]) mkdirSync(join(cache, name), { recursive: true, mode: 0o700 });
		assert.equal(getRuntimeCacheDir("node"), cache);
		assert.ok(existsSync(join(cache, "8")), "no scan on the startup path");
		await vi.runOnlyPendingTimersAsync();
		vi.useRealTimers();
		await vi.waitFor(() =>
			assert.deepEqual(readdirSync(cache).sort(), [".gitignore", ".last-pruned", "10", "9", "unrelated"]),
		);
	} finally {
		vi.useRealTimers();
		vi.unstubAllEnvs();
	}
});

it("an unusable agent directory preserves both caches and private scratch with one notice", () => {
	writeFileSync(agent, "not a directory");
	env.LOCALAPPDATA = agent;
	delete env.XDG_RUNTIME_DIR;
	const compile = new URL("../dist/utils/compile-cache.js", import.meta.url).href;
	const config = new URL("../dist/config.js", import.meta.url).href;
	const child = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`
		import mod, { createRequire } from 'node:module';
		const { createJiti } = createRequire(${JSON.stringify(import.meta.url)})('jiti');
		import { existsSync } from 'node:fs';
		const { enablePersistentCompileCache } = await import(${JSON.stringify(compile)});
		const { getRuntimeScratchDir, withWorkflowTranspileCache } = await import(${JSON.stringify(config)});
		enablePersistentCompileCache();
		const loader = withWorkflowTranspileCache(fsCache => createJiti(import.meta.url, {fsCache}));
		const scratch = await getRuntimeScratchDir();
		console.log(JSON.stringify({compile: !!mod.getCompileCacheDir(), jiti: !!loader.options.fsCache, scratch, exists: existsSync(scratch)}));
	`,
		],
		{ env, encoding: "utf8", cwd: systemTemp },
	);
	assert.equal(child.status, 0, child.stderr);
	const result = JSON.parse(child.stdout);
	assert.ok(result.compile && result.jiti && result.exists);
	assert.ok(result.scratch.startsWith(systemTemp));
	assert.equal(existsSync(result.scratch), false);
	assert.equal(child.stderr.split("using temporary storage instead").length - 1, 1);
});

it("keeps bootstrap scratch private to the process and removes it on exit", () => {
	const bootstrap = new URL("../dist/utils/interactive-engine-bootstrap.js", import.meta.url).href;
	const child = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`
		const { writeInteractiveEngineBootstrapAsync } = await import(${JSON.stringify(bootstrap)});
		const { directory } = await writeInteractiveEngineBootstrapAsync({hostPid: process.pid, guardFile: 'guard'});
		console.log(directory);
	`,
		],
		{ env, encoding: "utf8" },
	);
	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(readdirSync(systemTemp), []);
	assert.ok(child.stdout.trim().startsWith(join(agent, "cache")));
	assert.equal(existsSync(child.stdout.trim()), false);
});

it("default tool output follows the process scratch root, even with an unusual system temp path", () => {
	const session = new URL("../dist/core/tools/session-temp-dir.js", import.meta.url).href;
	delete env.TMPDIR;
	const child = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`
		import os from 'node:os';
		import { syncBuiltinESMExports } from 'node:module';
		os.tmpdir = () => ${JSON.stringify(systemTemp)};
		syncBuiltinESMExports();
		const { getSessionTempDirAsync } = await import(${JSON.stringify(session)});
		console.log(await getSessionTempDirAsync('session'));
	`,
		],
		{ env, encoding: "utf8" },
	);
	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(readdirSync(systemTemp), []);
	assert.ok(child.stdout.trim().startsWith(join(agent, "cache")));
	assert.equal(existsSync(child.stdout.trim()), false);
});

it.each([false, true])(
	"startup collects crashed scratch but preserves live, recent and unrecognized directories (fallback: %s)",
	(fallback) => {
		delete env.XDG_RUNTIME_DIR;
		if (fallback) {
			writeFileSync(agent, "not writable");
			env.LOCALAPPDATA = agent;
		}
		const config = new URL("../dist/config.js", import.meta.url).href;
		const crash = () => {
			const child = spawnSync(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					`
			import { writeSync } from 'node:fs';
			const { getRuntimeScratchDir } = await import(${JSON.stringify(config)});
			writeSync(1, await getRuntimeScratchDir());
			process.reallyExit(23);
		`,
				],
				{ env, encoding: "utf8" },
			);
			assert.equal(child.status, 23, child.stderr);
			return child.stdout;
		};
		const abandoned = crash();
		const recent = crash();
		// Housekeeping must still find a fallback run after the agent directory becomes writable again.
		if (fallback) rmSync(agent);
		const parent = dirname(abandoned);
		const live = join(parent, `${basename(abandoned).split("-")[0]}-${process.pid}-abc123`);
		const unrelated = join(parent, "keep-me");
		mkdirSync(live, { mode: 0o700 });
		copyFileSync(join(abandoned, ".gitignore"), join(live, ".gitignore"));
		mkdirSync(unrelated, { mode: 0o700 });
		const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
		for (const path of [abandoned, live, unrelated]) utimesSync(path, old, old);
		const cleanup = new URL("../dist/core/tools/session-temp-cleanup.js", import.meta.url).href;
		const child = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`
		const { runSessionTempCleanup } = await import(${JSON.stringify(cleanup)});
		await runSessionTempCleanup({sessionsRoots: []});
	`,
			],
			{ env, encoding: "utf8" },
		);
		assert.equal(child.status, 0, child.stderr);
		assert.equal(existsSync(abandoned), false);
		for (const path of [recent, live, unrelated]) assert.ok(existsSync(path), path);
	},
);
