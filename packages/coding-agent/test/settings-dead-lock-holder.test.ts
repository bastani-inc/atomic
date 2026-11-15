import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "vitest";
import { bunExecutable, readStreamText, type SpawnedProcess, spawnProcess } from "../../../test/helpers/runtime.js";

/**
 * A process killed while it holds a settings file's lock (#5161): the next process reads the settings at once, since
 * reads never take the write lock, and a save takes over the lock once the holder is proven dead by its pid and start,
 * without waiting for the lock to go stale. A live holder still excludes.
 */

const CHILD_PROCESS_TEST_TIMEOUT_MS = 120_000;
const STORAGE_MODULE = fileURLToPath(new URL("../src/core/settings-storage.ts", import.meta.url));
const MANAGER_MODULE = fileURLToPath(new URL("../src/core/settings-manager.ts", import.meta.url));

function spawnBun(script: string): SpawnedProcess {
	return spawnProcess([bunExecutable(), "--eval", script], { stdout: "pipe", stderr: "pipe" });
}

/** Takes the global settings lock through a save and blocks inside it, after creating `enteredPath`. */
function holderScript(cwd: string, agentDir: string, enteredPath: string): string {
	return `
		import { writeFileSync } from "node:fs";
		import { FileSettingsStorage } from ${JSON.stringify(STORAGE_MODULE)};
		const storage = new FileSettingsStorage(${JSON.stringify(cwd)}, ${JSON.stringify(agentDir)});
		storage.withPrimaryWriteLock("global", () => {
			writeFileSync(${JSON.stringify(enteredPath)}, "entered");
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
			return undefined;
		});
	`;
}

/** Loads the settings as a new process starting up does, and prints what it read, its errors and how long it took. */
function readerScript(cwd: string, agentDir: string): string {
	return `
		import { SettingsManager } from ${JSON.stringify(MANAGER_MODULE)};
		const started = performance.now();
		const manager = SettingsManager.create(${JSON.stringify(cwd)}, ${JSON.stringify(agentDir)}, { projectTrusted: false });
		const trust = manager.getDefaultProjectTrust();
		const elapsedMs = performance.now() - started;
		const errors = manager.drainErrors().map(({ error }) => error.message);
		console.log(JSON.stringify({ trust, errors, elapsedMs }));
	`;
}

/** Saves a setting as a new process does, and prints the errors the save recorded. */
function writerScript(cwd: string, agentDir: string): string {
	return `
		import { SettingsManager } from ${JSON.stringify(MANAGER_MODULE)};
		const manager = SettingsManager.create(${JSON.stringify(cwd)}, ${JSON.stringify(agentDir)}, { projectTrusted: false });
		manager.setDefaultProjectTrust("never");
		await manager.flush();
		console.log(JSON.stringify({ errors: manager.drainErrors().map(({ error }) => error.message) }));
	`;
}

async function runToEnd<T>(child: SpawnedProcess): Promise<T> {
	const [stdout, stderr, code] = await Promise.all([
		readStreamText(child.stdout),
		readStreamText(child.stderr),
		child.exited,
	]);
	assert.equal(code, 0, `child failed: ${stderr}`);
	return JSON.parse(stdout.trim().split("\n").at(-1)!) as T;
}

async function waitForFile(path: string, holder: SpawnedProcess): Promise<void> {
	const deadline = Date.now() + 60_000;
	let exited = false;
	void holder.exited.then(() => {
		exited = true;
	});
	while (!existsSync(path)) {
		if (exited || Date.now() > deadline)
			throw new Error(`holder never took the lock: ${await readStreamText(holder.stderr)}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe("settings lock left by a killed process (#5161)", () => {
	let directory: string;
	let cwd: string;
	let agentDir: string;
	const children: SpawnedProcess[] = [];

	beforeEach(() => {
		directory = realpathSync(mkdtempSync(join(tmpdir(), "atomic-settings-dead-lock-")));
		cwd = join(directory, "project");
		agentDir = join(directory, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
	});

	afterEach(async () => {
		for (const child of children.splice(0)) {
			child.kill("SIGKILL");
			await child.exited;
		}
		rmSync(directory, { recursive: true, force: true });
	});

	async function killHolder(): Promise<void> {
		const entered = join(directory, "entered");
		const holder = spawnBun(holderScript(cwd, agentDir, entered));
		children.push(holder);
		await waitForFile(entered, holder);
		holder.kill("SIGKILL");
		await holder.exited;
		assert.ok(existsSync(join(agentDir, "settings.json.lock")), "the killed holder left its lock behind");
	}

	it(
		"reads the settings correctly at once in the next process after the holder is SIGKILLed (#5161)",
		async () => {
			await killHolder();
			const read = await runToEnd<{ trust: string; errors: string[]; elapsedMs: number }>(
				spawnBun(readerScript(cwd, agentDir)),
			);
			assert.deepEqual(read.errors, []);
			assert.equal(read.trust, "always");
		},
		CHILD_PROCESS_TEST_TIMEOUT_MS,
	);

	it(
		"takes over the lock of a SIGKILLed holder at once to save, without waiting for it to go stale (#5161)",
		async () => {
			await killHolder();
			const written = await runToEnd<{ errors: string[] }>(spawnBun(writerScript(cwd, agentDir)));
			assert.deepEqual(written.errors, []);
			assert.equal(
				(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as { defaultProjectTrust?: string })
					.defaultProjectTrust,
				"never",
			);
			assert.equal(existsSync(join(agentDir, "settings.json.lock")), false);
			assert.equal(existsSync(join(agentDir, "settings.json.lock.holder")), false);
		},
		CHILD_PROCESS_TEST_TIMEOUT_MS,
	);

	it(
		"still excludes a save while the holder is alive, though reads go on (#5161)",
		async () => {
			const entered = join(directory, "entered");
			const holder = spawnBun(holderScript(cwd, agentDir, entered));
			children.push(holder);
			await waitForFile(entered, holder);

			const read = await runToEnd<{ trust: string; errors: string[] }>(spawnBun(readerScript(cwd, agentDir)));
			assert.deepEqual(read.errors, []);
			assert.equal(read.trust, "always");

			const written = await runToEnd<{ errors: string[] }>(spawnBun(writerScript(cwd, agentDir)));
			assert.equal(written.errors.length, 1);
			assert.match(written.errors[0]!, /already being held/);
			assert.equal(
				(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as { defaultProjectTrust?: string })
					.defaultProjectTrust,
				"always",
			);
		},
		CHILD_PROCESS_TEST_TIMEOUT_MS,
	);
});
