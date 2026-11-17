import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import { type Options, prepareBenchmarkState, runSample, type Target } from "../../scripts/perf/startup/benchmark.ts";
import { removeFixtureTree } from "../helpers/fixture-removal.js";
import { moduleDir } from "../helpers/runtime.js";

const repoRoot = join(moduleDir(import.meta.url), "../..");
const cli = join(repoRoot, "packages/coding-agent/dist/cli.js");

/**
 * The engine child is held until the host has painted (its first frame is in the startup trace), for at most this
 * long. A host that waited for its engine would deadlock until then, and its frame would come after the engine
 * started; the bound only has to outlast a host's own start on a loaded runner. On a Windows runner running three
 * copies of this test beside twelve busy loops the host's first frame took up to 164 s.
 */
const ENGINE_HOLD_MAX_MS = 240_000;
/** The held engine's own start and a provider round trip once it is released: up to 92 s on that runner. */
const ENGINE_START_MAX_MS = 150_000;
/** A real interactive start, its held engine and a provider round trip, on a loaded runner. */
const SAMPLE_TIMEOUT_MS = ENGINE_HOLD_MAX_MS + ENGINE_START_MAX_MS;
/**
 * The untimed start that fills a new agent directory's caches before the samples, as the benchmark's warm profile
 * does. Its engine compiles the whole builtin extension graph: 11-15 s on an idle machine, up to 177 s on that runner.
 */
const WARM_UP_TIMEOUT_MS = 270_000;
/** The warm-up, then two real starts (interactive and RPC) plus their teardown. */
const TEST_TIMEOUT_MS = WARM_UP_TIMEOUT_MS + 3 * SAMPLE_TIMEOUT_MS;

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close(() =>
				typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port")),
			);
		});
	});
}

/** A bin directory whose `atomic` runs this checkout's built CLI under the Node running the tests. */
function writeAtomicShim(directory: string): void {
	mkdirSync(directory, { recursive: true });
	if (process.platform === "win32") {
		writeFileSync(join(directory, "atomic.cmd"), `@"${process.execPath}" "${cli}" %*\r\n`);
		return;
	}
	const shim = join(directory, "atomic");
	writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`);
	chmodSync(shim, 0o755);
}

function removeSampleTree(root: string): void {
	removeFixtureTree(root);
}

test(
	"an interactive start paints without waiting for its engine, and a prompt typed at launch reaches the provider once, with the tools an RPC start sends",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-startup-overlap-"));
		// The native PTY starts Atomic with this process's environment underneath the sample's: the test runner's own
		// Atomic variables must not reach it, and on Windows the command line cannot unset them.
		const runnerVariables = Object.entries(process.env).filter(([name]) => /^(?:ATOMIC|PI)_/i.test(name));
		for (const [name] of runnerVariables) delete process.env[name];
		try {
			const extension = join(root, "probe-extension.mjs");
			writeFileSync(
				extension,
				`export default function (pi) {
	pi.registerTool({
		name: "startup_probe",
		label: "Startup probe",
		description: "Registered by an extension the engine loads",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	});
}
`,
			);
			// Only an engine child (prewarmed, or started with its bootstrap) is held, before it runs any of Atomic, until
			// its host's first frame is in the trace both of them write.
			const engineHold = join(root, "engine-hold.mjs");
			writeFileSync(
				engineHold,
				`import { readFileSync } from "node:fs";
if (process.argv.some((arg) => arg === "--internal-engine-prewarm" || arg === "--internal-engine-bootstrap")) {
	const deadline = Date.now() + ${ENGINE_HOLD_MAX_MS};
	const cell = new Int32Array(new SharedArrayBuffer(4));
	while (Date.now() < deadline) {
		let trace = "";
		try {
			trace = readFileSync(process.env.ATOMIC_STARTUP_TRACE ?? "", "utf8");
		} catch {}
		if (trace.includes('"label":"startup-coherent"')) break;
		Atomics.wait(cell, 0, 0, 25);
	}
}
`,
			);
			const binDirectory = join(root, "bin");
			writeAtomicShim(binDirectory);
			const target: Target = { name: "checkout", binDirectory };
			const options: Options = {
				output: join(root, "out"),
				state: join(root, "state"),
				cwd: join(root, "cwd"),
				version: "0.0.0",
				targets: [target],
				modes: ["typeahead", "rpc"],
				profiles: ["warm"],
				repeats: 1,
				port: await freePort(),
				timeoutMs: SAMPLE_TIMEOUT_MS,
				dropCaches: false,
				extraArgs: ["--extension", extension],
				extraEnv: { NODE_OPTIONS: `--import=${pathToFileURL(engineHold).href}` },
			};
			await prepareBenchmarkState(options);
			// The samples below use the warm profile, which the benchmark measures only after one untimed start has filled
			// the caches. Without it the typed-ahead sample would wait for that one-time compile.
			const warmUp = await runSample({ ...options, timeoutMs: WARM_UP_TIMEOUT_MS }, target, "rpc", "warm", 0, false);
			assert.equal(warmUp.state, "success", warmUp.failures.join("; "));

			const typeahead = await runSample(options, target, "typeahead", "warm", 1, true);
			assert.equal(typeahead.state, "success", typeahead.failures.join("; "));
			const rpc = await runSample(options, target, "rpc", "warm", 2, true);
			assert.equal(rpc.state, "success", rpc.failures.join("; "));

			// The prompt typed before the first frame was sent once (runSample fails on a second request), with the
			// delayed extension's tool: the same tools a start that loads everything before it reads input sends.
			assert.ok(typeahead.toolNames?.includes("startup_probe"), JSON.stringify(typeahead.toolNames));
			assert.deepEqual(typeahead.toolNames, rpc.toolNames);

			// The host painted while its engine was held, before the engine ran any of Atomic.
			const trace = typeahead.traceMs ?? {};
			assert.ok(
				trace["0:startup-coherent"]! < trace["1:process-entry"]!,
				`the host painted after its engine started: ${JSON.stringify(trace)}`,
			);
		} finally {
			for (const [name, value] of runnerVariables) process.env[name] = value;
			removeSampleTree(root);
		}
	},
	TEST_TIMEOUT_MS,
);

test("removes the sample tree once a process that was still running in its working directory exits (#5250)", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-startup-overlap-"));
	const cwd = join(root, "cwd");
	mkdirSync(cwd);
	const holder = spawn(process.execPath, ["-e", "process.stdout.write('ready'); setTimeout(() => {}, 300);"], {
		cwd,
		stdio: ["ignore", "pipe", "ignore"],
	});
	const exited = once(holder, "exit");
	await once(holder.stdout!, "data");
	removeSampleTree(root);
	assert.equal(existsSync(root), false);
	assert.deepEqual(await exited, [0, null]);
});
