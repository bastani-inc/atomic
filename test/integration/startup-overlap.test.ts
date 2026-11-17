import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import { type Options, prepareBenchmarkState, runSample, type Target } from "../../scripts/perf/startup/benchmark.ts";
import { removeTempRootReleasingBroker } from "../helpers/detached-broker.js";
import { moduleDir } from "../helpers/runtime.js";

const repoRoot = join(moduleDir(import.meta.url), "../..");
const cli = join(repoRoot, "packages/coding-agent/dist/cli.js");

/**
 * The engine child is held until the host has painted (its first frame is in the startup trace), for at most this
 * long. A host that waited for its engine would deadlock until then, and its frame would come after the engine
 * started; the bound only has to outlast a host's own start on a loaded runner.
 */
const ENGINE_HOLD_MAX_MS = 45_000;
/** A real interactive start, its held engine and a provider round trip, on a loaded runner. */
const SAMPLE_TIMEOUT_MS = ENGINE_HOLD_MAX_MS + 30_000;
/** Two real starts (interactive and RPC) plus their teardown. */
const TEST_TIMEOUT_MS = 3 * SAMPLE_TIMEOUT_MS;

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
			await removeTempRootReleasingBroker(root, join(root, "state", "checkout", "warm-agent"));
		}
	},
	TEST_TIMEOUT_MS,
);
