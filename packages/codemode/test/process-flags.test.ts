import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const SANDBOX_MODULE = JSON.stringify(pathToFileURL(fileURLToPath(new URL("../src/index.ts", import.meta.url))).href);
// A preload that records the thread it runs on, as a host's loader or instrumentation would.
const RECORDING_PRELOAD = `import { appendFileSync } from "node:fs";
import { isMainThread } from "node:worker_threads";
appendFileSync(process.env.CODEMODE_TEST_PRELOAD_LOG, isMainThread ? "main\\n" : "worker\\n");`;

const STARTS: [where: string, flags: string[], env: Record<string, string>][] = [
	["on the command line", ["--input-type=module"], {}],
	["in NODE_OPTIONS", [], { NODE_OPTIONS: "--input-type=module" }],
];

it.each(STARTS)(
	"runs a script in a process started with --input-type=module %s, with the process's preloads (#6079)",
	(_where, flags, env) => {
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
				{ encoding: "utf-8", env: { ...process.env, ...env, CODEMODE_TEST_PRELOAD_LOG: log } },
			);
			expect(result.status, result.stderr).toBe(0);
			expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, value: 42 });
			// The worker starts with the process's flags, such as a loader its module may need, as without --input-type.
			expect(readFileSync(log, "utf-8")).toBe("main\nworker\n");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
);

it("starts a custom CommonJS workerUrl as its own main module in a process started with --input-type=module (#6079)", () => {
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
		{ encoding: "utf-8" },
	);
	expect(result.status, result.stderr).toBe(0);
	expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, value: 42 });
});
