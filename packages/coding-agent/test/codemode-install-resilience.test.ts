import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { test } from "vitest";
import { bunExecutable, spawnSyncCollect } from "../../../test/helpers/runtime.js";

const REAL_WORKER_RUNTIME_TIMEOUT_MS = 120_000;

test(
	"Node and Bun codemode keep running after cached worker and wasm assets disappear (#3429)",
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-codemode-install-"));
		const root = fileURLToPath(new URL("../../../", import.meta.url));
		try {
			const worker = join(dir, "codemode-worker.js");
			const wasm = join(dir, "quickjs.wasm");
			const script = join(dir, "scenario.mjs");
			writeFileSync(
				script,
				`
import assert from 'node:assert/strict';
import { unlinkSync } from 'node:fs';
process.env.ATOMIC_BUNDLED_BUILD = '1';
const config = await import(${JSON.stringify(pathToFileURL(join(root, "packages/coding-agent/src/config.ts")).href)});
const { CodemodeSandbox, loadQuickJSWasm } = await import(${JSON.stringify(pathToFileURL(join(root, "node_modules/@earendil-works/pi-codemode/dist/index.js")).href)});
const worker = config.getCodemodeWorkerUrl();
assert.equal(worker.protocol, 'data:');
const wasmPath = config.getQuickJSWasmPath();
const run = async () => {
 const sandbox = new CodemodeSandbox({ workerUrl: config.getCodemodeWorkerUrl(), wasm: loadQuickJSWasm(config.getQuickJSWasmPath()) });
 try { const result = await sandbox.execute('return 3429;'); assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.value, 3429); } finally { await sandbox.close(); }
};
await run();
unlinkSync(${JSON.stringify(worker)}); unlinkSync(${JSON.stringify(wasm)});
assert.equal(config.getCodemodeWorkerUrl(), worker);
assert.equal(config.getQuickJSWasmPath(), wasmPath);
await run();
console.log('cached codemode survives removed worker and wasm');
`,
			);
			for (const runtime of [process.execPath, bunExecutable()]) {
				if (runtime === process.execPath) {
					await build({
						entryPoints: [join(root, "packages/coding-agent/src/extensions/codemode/worker.ts")],
						outfile: worker,
						bundle: true,
						platform: "node",
						format: "esm",
					});
				} else {
					const built = spawnSyncCollect(
						[
							runtime,
							"build",
							"--target=bun",
							"--format=esm",
							join(root, "packages/coding-agent/src/extensions/codemode/worker.ts"),
							"--outfile",
							worker,
						],
						{ cwd: root },
					);
					assert.equal(built.exitCode, 0, built.stderr.toString());
				}
				copyFileSync(join(root, "node_modules/quickjs-wasi/quickjs.wasm"), wasm);
				const result = spawnSyncCollect([runtime, script], { cwd: root });
				assert.equal(result.exitCode, 0, `${runtime}: ${result.stderr}\n${result.stdout}`);
				assert.match(result.stdout.toString(), /cached codemode survives removed worker and wasm/);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
	REAL_WORKER_RUNTIME_TIMEOUT_MS,
);
