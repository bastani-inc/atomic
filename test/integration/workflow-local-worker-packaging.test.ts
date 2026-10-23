import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { WORKFLOWS_LOCAL_WORKER_ENTRIES } from "../../packages/coding-agent/src/core/builtin-install-layout.ts";
import {
	assertWorkerCompletedUnderRoot,
	PACKAGED_WORKER_TIMEOUT_MS,
	runPackagedWorkerRoot,
	stageChildWorkflow,
} from "../helpers/packaged-worker.js";
import {
	copyFileSync,
	makeDirectorySync,
	makeTempDirectory,
	moduleDir,
	removeTempDirectory,
	symlinkSync,
} from "../helpers/runtime.js";

const repoRoot = resolve(moduleDir(import.meta.url), "../..");
const workflowsDist = resolve(repoRoot, "packages/coding-agent/dist/builtin/workflows");
const WORKER_READY_TIMEOUT_MS = 60_000;

const requireBuild = process.env.ATOMIC_REQUIRE_INSTALLED_NODE_SMOKE === "1";
const built = existsSync(join(workflowsDist, "package.json"));
if (requireBuild) assert.ok(built, "packages/coding-agent/dist/builtin/workflows missing; run the build first");
const packaged = built
	? test.each([...WORKFLOWS_LOCAL_WORKER_ENTRIES])
	: test.skip.each([...WORKFLOWS_LOCAL_WORKER_ENTRIES]);

packaged(
	"packaged local worker entry %s starts without workflow sources under Node (#3869)",
	async (entry) => {
		const bundle = join(workflowsDist, entry);
		assert.ok(existsSync(bundle), `missing ${entry}`);
		assert.equal(existsSync(join(workflowsDist, "src", "workers", "local-worker.ts")), false);
		const directory = makeTempDirectory("packaged-worker-");
		const child = fork(
			bundle,
			[JSON.stringify({ journalPath: join(directory, "journal.sqlite"), root: "packaged-root", definitions: [] })],
			{ stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: [] },
		);
		let stderr = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString()).slice(-4096);
		});
		try {
			const message = await new Promise<{ kind?: string }>((resolveMessage, reject) => {
				const timeout = setTimeout(
					() => reject(new Error(`worker never became ready: ${stderr}`)),
					WORKER_READY_TIMEOUT_MS,
				);
				child.once("message", (value: { kind?: string }) => {
					clearTimeout(timeout);
					resolveMessage(value);
				});
				child.once("exit", (code) => {
					clearTimeout(timeout);
					reject(new Error(`worker exited ${code} before ready: ${stderr}`));
				});
			});
			assert.equal(message.kind, "ready");
		} finally {
			child.removeAllListeners("exit");
			child.kill("SIGKILL");
			await new Promise<void>((done) =>
				child.exitCode !== null || child.signalCode !== null ? done() : child.once("exit", () => done()),
			);
			removeTempDirectory(directory);
		}
	},
	WORKER_READY_TIMEOUT_MS + 10_000,
);

const packagedWork =
	built && process.platform !== "win32"
		? test.each([...WORKFLOWS_LOCAL_WORKER_ENTRIES])
		: test.skip.each([...WORKFLOWS_LOCAL_WORKER_ENTRIES]);

packagedWork(
	"packaged local worker entry %s completes authored child work under the original root without workflow sources (#3869)",
	(entry) => {
		const directory = makeTempDirectory("packaged-worker-work-");
		try {
			const staged = join(directory, "package");
			makeDirectorySync(staged, { recursive: true });
			copyFileSync(join(workflowsDist, "src", "index.js"), join(staged, "sdk.mjs"));
			copyFileSync(join(workflowsDist, entry), join(staged, "local-worker-entry.mjs"));
			symlinkSync(join(repoRoot, "node_modules"), join(staged, "node_modules"), "dir");
			assert.deepEqual(readdirSync(staged).sort(), ["local-worker-entry.mjs", "node_modules", "sdk.mjs"]);
			const work = join(directory, "work");
			makeDirectorySync(work, { recursive: true });
			const token = `packaged-${entry}`;
			const output = runPackagedWorkerRoot({
				sdkBundle: join(staged, "sdk.mjs"),
				directory: work,
				childPath: stageChildWorkflow(work),
				token,
			});
			assertWorkerCompletedUnderRoot(work, output, token);
		} finally {
			removeTempDirectory(directory);
		}
	},
	PACKAGED_WORKER_TIMEOUT_MS + 30_000,
);
