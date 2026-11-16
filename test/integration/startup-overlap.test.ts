import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import { type Options, prepareBenchmarkState, runSample, type Target } from "../../scripts/perf/startup/benchmark.ts";
import { moduleDir } from "../helpers/runtime.js";

const repoRoot = join(moduleDir(import.meta.url), "../..");
const cli = join(repoRoot, "packages/coding-agent/dist/cli.js");

/**
 * How long the engine child takes to load before it runs anything, as a slow disk or a virus scanner can make it. The
 * host must paint its first frame without waiting for its engine, so the frame comes before the engine has even
 * started; half of the delay is the margin the assertions keep for a loaded runner.
 */
const ENGINE_LOAD_DELAY_MS = 3_000;
/** A real interactive start, its delayed engine and a provider round trip, on a loaded runner. */
const SAMPLE_TIMEOUT_MS = 60_000;
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
	"an interactive start paints before its engine has loaded, and a prompt typed at launch reaches the provider once, with the tools an RPC start sends",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-startup-overlap-"));
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
			// Only an engine child (prewarmed, or started with its bootstrap) loads slowly; the host does not.
			const engineDelay = join(root, "engine-delay.mjs");
			writeFileSync(
				engineDelay,
				`if (process.argv.some((arg) => arg === "--internal-engine-prewarm" || arg === "--internal-engine-bootstrap"))
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${ENGINE_LOAD_DELAY_MS});
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
				extraEnv: { NODE_OPTIONS: `--import=${pathToFileURL(engineDelay).href}` },
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

			// The host painted before its engine had even started, and the prompt went out once the engine had loaded.
			const frame = typeahead.metricsMs!.firstFrameMs!;
			const dispatch = typeahead.metricsMs!.typeaheadDispatchMs!;
			assert.ok(
				frame < dispatch - ENGINE_LOAD_DELAY_MS / 2,
				`first frame at ${frame} ms, typed prompt sent at ${dispatch} ms`,
			);
			const trace = typeahead.traceMs ?? {};
			assert.ok(
				trace["0:startup-coherent"]! < trace["1:process-entry"]!,
				`the host painted after its engine started: ${JSON.stringify(trace)}`,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
	TEST_TIMEOUT_MS,
);
