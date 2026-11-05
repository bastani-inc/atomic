import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "vitest";
import { bunExecutable, readStreamText, type SpawnedProcess, spawnProcess } from "../../../test/helpers/runtime.ts";
import { FileAuthStorageBackend } from "../src/core/auth-storage.ts";

/**
 * Chaos coverage for the auth.json lock shared across symlinked paths (pi #11655): writer processes contend
 * through the real file and a symlink alias, a lock holder is killed or stopped mid-transaction, and the lock
 * directory's mtime is skewed. The invariants: no increment is lost, a crashed holder never leaves a partial
 * file, and a lock is taken over only once it is stale.
 */

// Each case runs real Bun child processes that import the TypeScript source.
const CHILD_PROCESS_TEST_TIMEOUT_MS = 120_000;
const WRITERS_PER_PATH = 4;
const INCREMENTS_PER_WRITER = 20;
const BACKEND_MODULE = fileURLToPath(new URL("../src/core/auth-storage.ts", import.meta.url));

const unixOnly = process.platform === "win32" ? it.skip : it;

function counterOf(path: string): number {
	const data = JSON.parse(readFileSync(path, "utf8")) as { counter?: { key?: string } };
	return Number(data.counter?.key ?? "0");
}

function increment(current: string | undefined): { result: undefined; next: string } {
	const data = JSON.parse(current ?? "{}") as Record<string, { type: string; key: string }>;
	data.counter = { type: "api_key", key: String(Number(data.counter?.key ?? "0") + 1) };
	return { result: undefined, next: JSON.stringify(data) };
}

function spawnBun(script: string): SpawnedProcess {
	return spawnProcess([bunExecutable(), "--eval", script], { stdout: "pipe", stderr: "pipe" });
}

/** A writer that alternates async and sync locked increments, retrying a sync attempt that meets a held lock. */
function writerScript(path: string): string {
	return `
		import { FileAuthStorageBackend } from ${JSON.stringify(BACKEND_MODULE)};
		const backend = new FileAuthStorageBackend(${JSON.stringify(path)}, [${JSON.stringify(path)}]);
		const step = (current) => {
			const data = JSON.parse(current ?? "{}");
			data.counter = { type: "api_key", key: String(Number(data.counter?.key ?? "0") + 1) };
			return { result: undefined, next: JSON.stringify(data) };
		};
		let done = 0;
		let elocked = 0;
		for (let i = 0; i < ${INCREMENTS_PER_WRITER}; i++) {
			if (i % 2 === 0) {
				await backend.withLockAsync(async (current) => step(current));
				done++;
				continue;
			}
			for (;;) {
				try {
					backend.withLock(step);
					done++;
					break;
				} catch (error) {
					if (error?.code !== "ELOCKED") throw error;
					elocked++;
					await Bun.sleep(5);
				}
			}
		}
		console.log(JSON.stringify({ done, elocked }));
	`;
}

/** Holds the lock through `path` inside withLockAsync until `releasePath` exists, then increments. */
function holderScript(path: string, releasePath: string): string {
	return `
		import { existsSync } from "node:fs";
		import { FileAuthStorageBackend } from ${JSON.stringify(BACKEND_MODULE)};
		const backend = new FileAuthStorageBackend(${JSON.stringify(path)}, [${JSON.stringify(path)}]);
		await backend.withLockAsync(async (current) => {
			console.log("entered");
			while (!existsSync(${JSON.stringify(releasePath)})) await Bun.sleep(10);
			const data = JSON.parse(current ?? "{}");
			data.counter = { type: "api_key", key: String(Number(data.counter?.key ?? "0") + 1) };
			return { result: undefined, next: JSON.stringify(data) };
		});
		console.log("done");
	`;
}

async function waitForLine(child: SpawnedProcess, expected: string): Promise<void> {
	const reader = child.stdout!.getReader();
	const decoder = new TextDecoder();
	let text = "";
	try {
		while (!text.includes(expected)) {
			const { done, value } = await reader.read();
			if (done) throw new Error(`child exited before printing ${expected}: ${text}`);
			text += decoder.decode(value, { stream: true });
		}
	} finally {
		reader.releaseLock();
	}
}

describe("auth.json lock chaos across symlinked paths (pi #11655)", () => {
	let directory: string;
	let realPath: string;
	let aliasPath: string;
	const children: SpawnedProcess[] = [];

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "atomic-auth-lock-chaos-"));
		realPath = join(directory, "auth.json");
		aliasPath = join(directory, "alias.json");
		writeFileSync(realPath, JSON.stringify({ counter: { type: "api_key", key: "0" } }));
		symlinkSync(realPath, aliasPath);
	});

	afterEach(async () => {
		for (const child of children.splice(0)) {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGCONT");
				child.kill("SIGKILL");
			}
			await child.exited;
		}
		rmSync(directory, { recursive: true, force: true });
	});

	unixOnly(
		"loses no increment when many writers contend through the real file and a symlink alias",
		async () => {
			const writers = Array.from({ length: WRITERS_PER_PATH * 2 }, (_, index) =>
				spawnBun(writerScript(index % 2 === 0 ? realPath : aliasPath)),
			);
			children.push(...writers);
			const reports = await Promise.all(
				writers.map(async (writer) => {
					const [stdout, stderr, exitCode] = await Promise.all([
						readStreamText(writer.stdout),
						readStreamText(writer.stderr),
						writer.exited,
					]);
					assert.equal(exitCode, 0, stderr);
					return JSON.parse(stdout.trim().split("\n").at(-1)!) as { done: number; elocked: number };
				}),
			);

			const done = reports.reduce((sum, report) => sum + report.done, 0);
			assert.equal(done, WRITERS_PER_PATH * 2 * INCREMENTS_PER_WRITER);
			assert.equal(counterOf(realPath), done);
		},
		CHILD_PROCESS_TEST_TIMEOUT_MS,
	);

	unixOnly(
		"keeps excluding after SIGKILL of a holder mid-transaction until the lock is stale, then recovers",
		async () => {
			const holder = spawnBun(holderScript(aliasPath, join(directory, "never")));
			children.push(holder);
			await waitForLine(holder, "entered");
			holder.kill("SIGKILL");
			await holder.exited;

			// The crashed holder never wrote: the file is the original, and its lock still excludes.
			assert.equal(counterOf(realPath), 0);
			const backend = new FileAuthStorageBackend(aliasPath, [aliasPath]);
			assert.throws(() => backend.withLock(increment), { code: "ELOCKED" });

			// A lock directory stamped by a clock running ahead still looks fresh and still excludes.
			const lockDirectory = `${realpathSync(realPath)}.lock`;
			const ahead = new Date(Date.now() + 60 * 60_000);
			utimesSync(lockDirectory, ahead, ahead);
			assert.throws(() => backend.withLock(increment), { code: "ELOCKED" });

			// Once its mtime is older than the stale window (a dead holder stops refreshing it), it is taken over.
			const behind = new Date(Date.now() - 10 * 60_000);
			utimesSync(lockDirectory, behind, behind);
			await backend.withLockAsync(async (current) => increment(current));
			assert.equal(counterOf(realPath), 1);
		},
		CHILD_PROCESS_TEST_TIMEOUT_MS,
	);

	unixOnly(
		"holds contenders on the alias while the holder on the real path is stopped, then serializes them",
		async () => {
			const releasePath = join(directory, "release");
			const holder = spawnBun(holderScript(realPath, releasePath));
			children.push(holder);
			await waitForLine(holder, "entered");
			holder.kill("SIGSTOP");

			const backend = new FileAuthStorageBackend(aliasPath, [aliasPath]);
			assert.throws(() => backend.withLock(increment), { code: "ELOCKED" });
			let entered = false;
			const pending = backend.withLockAsync(async (current) => {
				entered = true;
				return increment(current);
			});
			await new Promise((resolve) => setTimeout(resolve, 300));
			assert.equal(entered, false);

			writeFileSync(releasePath, "release");
			holder.kill("SIGCONT");
			assert.equal(await holder.exited, 0);
			await pending;
			assert.equal(entered, true);
			assert.equal(counterOf(realPath), 2);
		},
		CHILD_PROCESS_TEST_TIMEOUT_MS,
	);
});
