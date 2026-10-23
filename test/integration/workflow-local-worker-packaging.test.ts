import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { WORKFLOWS_LOCAL_WORKER_ENTRIES } from "../../packages/coding-agent/src/core/builtin-install-layout.ts";
import { makeTempDirectory, moduleDir, removeTempDirectory } from "../helpers/runtime.js";

const workflowsDist = resolve(moduleDir(import.meta.url), "../../packages/coding-agent/dist/builtin/workflows");
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
