import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, vi } from "vitest";
import setupTestDirectory from "../global-setup-test-directory.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { removeTestDirectory } from "../helpers/test-directory-removal.js";
import { workspaceSandbox } from "../helpers/workspace-repos.js";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

const PROCESS_HOLD_MS = 4_000;
const DISPOSE_BUDGET_MS = PROCESS_HOLD_MS / 2;
const REMOVAL_AFTER_EXIT_MS = 6_000;

const windows = vi.hoisted(() => ({
	held: new Set<string>(),
	refusal: (path: string) =>
		Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${path}'`), { code: "EBUSY", path }),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const rmSync: typeof actual.rmSync = (path, options) => {
		if (windows.held.has(String(path))) throw windows.refusal(String(path));
		actual.rmSync(path, options);
	};
	return { ...actual, default: { ...actual, rmSync }, rmSync };
});

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const rm: typeof actual.rm = async (path, options) => {
		if (windows.held.has(String(path))) throw windows.refusal(String(path));
		return actual.rm(path, options);
	};
	return { ...actual, default: { ...actual, rm }, rm };
});

test("disposing a sandbox Windows still holds returns at once, and the sandbox is removed once it is let go", async () => {
	const sandbox = new GitSandbox();
	windows.held.add(sandbox.root);
	sandbox.dispose();
	assert.equal(existsSync(sandbox.root), true);
	windows.held.delete(sandbox.root);
	await vi.waitFor(() => assert.equal(existsSync(sandbox.root), false), { timeout: 5_000, interval: 20 });
});

test("disposing a sandbox a running process works in returns while the process runs, and the sandbox is gone once it ends", async () => {
	const sandbox = new GitSandbox();
	const workDirectory = join(sandbox.root, "work");
	mkdirSync(workDirectory);
	const holder = spawn(process.execPath, ["-e", `setTimeout(() => {}, ${PROCESS_HOLD_MS})`], {
		cwd: workDirectory,
		stdio: "ignore",
	});
	await once(holder, "spawn");
	try {
		const started = performance.now();
		sandbox.dispose();
		const elapsed = performance.now() - started;
		assert.ok(
			elapsed < DISPOSE_BUDGET_MS,
			`dispose took ${Math.round(elapsed)} ms while a process worked in the sandbox`,
		);
		await vi.waitFor(() => assert.equal(existsSync(sandbox.root), false), {
			timeout: PROCESS_HOLD_MS + REMOVAL_AFTER_EXIT_MS,
			interval: 50,
		});
	} finally {
		holder.kill();
	}
});

test.skipIf(process.platform !== "win32")(
	"disposing a sandbox with a file another process holds without delete sharing returns while it is held",
	async () => {
		const sandbox = new GitSandbox();
		const heldFile = join(sandbox.root, "held.txt");
		writeFileSync(heldFile, "held");
		const holder = spawn(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`$file = [System.IO.File]::Open('${heldFile}', 'Open', 'Read', 'None'); [Console]::Out.WriteLine('held'); [Console]::Out.Flush(); Start-Sleep -Milliseconds ${PROCESS_HOLD_MS}; $file.Close()`,
			],
			{ stdio: ["ignore", "pipe", "ignore"] },
		);
		try {
			const [output] = (await once(holder.stdout, "data")) as [Buffer];
			assert.match(output.toString(), /held/);
			const started = performance.now();
			sandbox.dispose();
			const elapsed = performance.now() - started;
			assert.ok(elapsed < DISPOSE_BUDGET_MS, `dispose took ${Math.round(elapsed)} ms while a file was held`);
			await vi.waitFor(() => assert.equal(existsSync(sandbox.root), false), {
				timeout: PROCESS_HOLD_MS + REMOVAL_AFTER_EXIT_MS,
				interval: 50,
			});
		} finally {
			holder.kill();
		}
	},
);

test("cleaning up a workspace sandbox Windows still holds returns at once, and the sandbox is removed once it is let go", async () => {
	const sandbox = workspaceSandbox("atomic-held-workspace-");
	windows.held.add(sandbox.root);
	sandbox.cleanup();
	assert.equal(existsSync(sandbox.root), true);
	windows.held.delete(sandbox.root);
	await vi.waitFor(() => assert.equal(existsSync(sandbox.root), false), { timeout: 5_000, interval: 20 });
});

test("a directory still held when its retries run out is removed by the run's teardown once it is let go", async () => {
	const inherited = process.env.ATOMIC_TEST_RUN_DIR;
	delete process.env.ATOMIC_TEST_RUN_DIR;
	const directory = makeTempDirectory("atomic-held-test-directory-");
	try {
		const teardown = setupTestDirectory();
		windows.held.add(directory);
		removeTestDirectory(directory, { retries: 0, retryDelayMs: 0 });
		windows.held.delete(directory);
		assert.equal(existsSync(directory), true);
		await teardown?.();
		assert.equal(existsSync(directory), false);
	} finally {
		windows.held.delete(directory);
		removeTempDirectory(directory);
		if (inherited === undefined) delete process.env.ATOMIC_TEST_RUN_DIR;
		else process.env.ATOMIC_TEST_RUN_DIR = inherited;
	}
});
