import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const SANDBOX_MODULE = JSON.stringify(pathToFileURL(fileURLToPath(new URL("../src/index.ts", import.meta.url))).href);
/** Each child ends within seconds; the bound ends one that would not, so its test fails instead of stalling the run. */
const CHILD_TIMEOUT_MS = 60_000;
/**
 * Each test below starts one Node child, which loads the sandbox from its source and starts a worker: that is the
 * structural cost of these tests, about a second on an idle machine and several on a loaded Windows machine. A test
 * fails on its child's own bound, not on the runner's 5 s default.
 */
const CHILD_TEST_TIMEOUT_MS = CHILD_TIMEOUT_MS + 5_000;
// A preload that records the thread it runs on, as a host's loader or instrumentation would.
const RECORDING_PRELOAD = `import { appendFileSync } from "node:fs";
import { isMainThread } from "node:worker_threads";
appendFileSync(process.env.CODEMODE_TEST_PRELOAD_LOG, isMainThread ? "main\\n" : "worker\\n");`;

const STARTS: [where: string, flags: string[], env: Record<string, string>][] = [
	["on the command line", ["--input-type=module"], {}],
	["in NODE_OPTIONS", [], { NODE_OPTIONS: "--input-type=module" }],
];
// Other spellings Node accepts for the same option.
const SPELLINGS: [where: string, flags: string[], env: Record<string, string>][] = [
	["on the command line as --input_type", ["--input_type=module"], {}],
	["in NODE_OPTIONS as --input_type", [], { NODE_OPTIONS: "--input_type=module" }],
	["in NODE_OPTIONS in quotes", [], { NODE_OPTIONS: '"--input-type=module"' }],
	["in NODE_OPTIONS in quotes with an escape", [], { NODE_OPTIONS: '"--input\\-type=module"' }],
	["in NODE_OPTIONS after an option's value", [], { NODE_OPTIONS: "--title codemode --input-type module" }],
];

function runsWithPreloads(flags: string[], env: Record<string, string>): void {
	const dir = mkdtempSync(join(tmpdir(), "codemode-flags-"));
	try {
		const log = join(dir, "preload.log");
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				`data:text/javascript,${encodeURIComponent(RECORDING_PRELOAD)}`,
				...flags,
				"--eval",
				`import { CodemodeSandbox } from ${SANDBOX_MODULE};
				const result = await new CodemodeSandbox().execute("return 6 * 7");
				process.stdout.write(JSON.stringify(result));`,
			],
			{
				encoding: "utf-8",
				env: { ...process.env, NODE_OPTIONS: "", ...env, CODEMODE_TEST_PRELOAD_LOG: log },
				timeout: CHILD_TIMEOUT_MS,
			},
		);
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, value: 42 });
		// The worker starts with the process's flags, such as a loader its module may need, as without --input-type.
		expect(readFileSync(log, "utf-8")).toBe("main\nworker\n");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

it.each(STARTS)(
	"runs a script in a process started with --input-type=module %s, with the process's preloads (#6079)",
	(_where, flags, env) => runsWithPreloads(flags, env),
	CHILD_TEST_TIMEOUT_MS,
);

it.each(SPELLINGS)(
	"runs a script in a process started with --input-type=module %s, with the process's preloads",
	(_where, flags, env) => runsWithPreloads(flags, env),
	CHILD_TEST_TIMEOUT_MS,
);

// Records how a worker thread imports the sandbox's worker module: as its entry, or from another module.
const RECORDING_ENTRY_PRELOAD = `import { appendFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { isMainThread } from "node:worker_threads";
if (!isMainThread) registerHooks({ resolve(specifier, context, nextResolve) {
	if (/[\\\\/]runtime[\\\\/]worker\\.ts$/.test(specifier)) {
		appendFileSync(process.env.CODEMODE_TEST_PRELOAD_LOG, context.parentURL === undefined ? "entry\\n" : "imported\\n");
	}
	return nextResolve(specifier, context);
} });`;

it.each([
	["in a quoted option value", '--title "codemode --input-type=module"'],
	["after a word that ends Node's reading", "codemode --input-type=module"],
])(
	"starts the sandbox's worker from its module file when NODE_OPTIONS names --input-type %s",
	(_where, nodeOptions) => {
		const dir = mkdtempSync(join(tmpdir(), "codemode-flags-"));
		try {
			const log = join(dir, "entry.log");
			const result = spawnSync(
				process.execPath,
				[
					"--import",
					`data:text/javascript,${encodeURIComponent(RECORDING_ENTRY_PRELOAD)}`,
					"--eval",
					`import { CodemodeSandbox } from ${SANDBOX_MODULE};
				process.stdout.write(JSON.stringify(await new CodemodeSandbox().execute("return 6 * 7")));`,
				],
				{
					encoding: "utf-8",
					env: { ...process.env, NODE_OPTIONS: nodeOptions, CODEMODE_TEST_PRELOAD_LOG: log },
					timeout: CHILD_TIMEOUT_MS,
				},
			);
			expect(result.error).toBeUndefined();
			expect(result.status, result.stderr).toBe(0);
			expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, value: 42 });
			expect(existsSync(log) ? readFileSync(log, "utf-8") : "").toBe("entry\n");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
	CHILD_TEST_TIMEOUT_MS,
);

it(
	"runs a script in a process started with --input-type=module in NODE_OPTIONS that it later removes",
	() => {
		// A worker keeps the options the process started with, whatever NODE_OPTIONS holds by the time it starts.
		const result = spawnSync(
			process.execPath,
			[
				"--eval",
				`import { CodemodeSandbox } from ${SANDBOX_MODULE};
			delete process.env.NODE_OPTIONS;
			process.stdout.write(JSON.stringify(await new CodemodeSandbox().execute("return 6 * 7")));`,
			],
			{ encoding: "utf-8", env: { ...process.env, NODE_OPTIONS: "--input-type=module" }, timeout: CHILD_TIMEOUT_MS },
		);
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, value: 42 });
	},
	CHILD_TEST_TIMEOUT_MS,
);

it(
	"starts a custom CommonJS workerUrl as its own main module in a process started with --input-type=module (#6079)",
	() => {
		const entry = JSON.stringify(
			pathToFileURL(fileURLToPath(new URL("./fixtures/main-only-worker.cjs", import.meta.url))).href,
		);
		const result = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"--eval",
				`import { CodemodeSandbox } from ${SANDBOX_MODULE};
			const sandbox = new CodemodeSandbox({ workerUrl: new URL(${entry}), timeoutMs: 10_000 });
			process.stdout.write(JSON.stringify(await sandbox.execute("return 6 * 7")));`,
			],
			{ encoding: "utf-8", timeout: CHILD_TIMEOUT_MS },
		);
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, value: 42 });
	},
	CHILD_TEST_TIMEOUT_MS,
);
