import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "vitest";
import { bunExecutable, spawnSyncCollect } from "../helpers/runtime.js";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

test("on Bun a module worker starts from its file whatever NODE_OPTIONS says about --input-type", () => {
	// Bun ignores NODE_OPTIONS and never refuses a worker's module file for --input-type, so the worker keeps the
	// entry it has without either.
	const dir = mkdtempSync(join(tmpdir(), "atomic-module-worker-entry-"));
	try {
		const entry = join(dir, "entry-probe.mjs");
		writeFileSync(
			entry,
			'import { parentPort } from "node:worker_threads";\nparentPort.postMessage(process.argv[1] ?? "");\n',
		);
		const script = `
			const { startModuleWorker } = await import("./packages/coding-agent/src/utils/worker-threads.ts");
			const worker = startModuleWorker(new URL(${JSON.stringify(pathToFileURL(entry).href)}));
			worker.once("message", (argv1) => {
				console.log(JSON.stringify(argv1));
				void worker.terminate();
			});
		`;
		for (const nodeOptions of ["--input-type=module", '"--input-type=module"', "--input_type=module"]) {
			const result = spawnSyncCollect([bunExecutable(), "-e", script], {
				cwd: REPO_ROOT,
				env: { ...process.env, NODE_OPTIONS: nodeOptions },
			});
			assert.equal(result.exitCode, 0, `NODE_OPTIONS=${nodeOptions}: ${result.stderr.toString()}`);
			const argv1 = JSON.parse(result.stdout.toString().trim()) as string;
			assert.equal(
				argv1.replaceAll("\\", "/").endsWith("/entry-probe.mjs"),
				true,
				`NODE_OPTIONS=${nodeOptions}: ${argv1}`,
			);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
