import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import type { ExecResult } from "../src/core/exec.ts";

/** Directories whose file system never answers, as a network share that stopped responding. */
const held = vi.hoisted(() => new Set<string>());

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof FsPromises>();
	const answer = <T>(path: unknown, read: () => Promise<T>): Promise<T> =>
		held.has(String(path)) ? new Promise<T>(() => {}) : read();
	const stat = ((path: string, options?: { bigint?: boolean }) =>
		answer(path, () => actual.stat(path, options))) as typeof actual.stat;
	const access = ((path: string, mode?: number) =>
		answer(path, () => actual.access(path, mode))) as typeof actual.access;
	return { ...actual, stat, access, default: { ...actual, stat, access } };
});

const { execCommand } = await import("../src/core/exec.ts");

/** What a command stopped as it starts returns: nothing it printed, and the code of SIGTERM. */
const STOPPED: ExecResult = { stdout: "", stderr: "", code: 143, killed: true, truncated: false };

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "atomic-exec-lookup-"));
	const bin = join(root, "bin");
	mkdirSync(bin);
	held.add(bin);
	vi.stubEnv("PATH", bin);
});

afterEach(() => {
	held.clear();
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

/** `execCommand` as it runs on Windows, where a command named without a path is looked up before it starts. */
function execOnWindows(...call: Parameters<typeof execCommand>): Promise<ExecResult> {
	const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
	Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
	try {
		return execCommand(...call);
	} finally {
		Object.defineProperty(process, "platform", platform);
	}
}

describe("a pi.exec command whose program is still being looked up", () => {
	test("ends when its signal aborts, starting nothing", async () => {
		const controller = new AbortController();
		const result = execOnWindows("atomic-test-program", [], root, { signal: controller.signal });
		controller.abort();
		assert.deepEqual(await result, STOPPED);
	});

	test("ends with a signal that already aborted", async () => {
		assert.deepEqual(await execOnWindows("atomic-test-program", [], root, { signal: AbortSignal.abort() }), STOPPED);
	});

	test("ends when its timeout passes", async () => {
		assert.deepEqual(await execOnWindows("atomic-test-program", [], root, { timeout: 50 }), STOPPED);
	});

	test("ends when its session quits, and is no longer stopped by the quit afterwards", async () => {
		let quit: (() => void) | undefined;
		let unregistered = false;
		const result = execOnWindows("atomic-test-program", [], root, undefined, (stop) => {
			quit = stop;
			return () => {
				unregistered = true;
			};
		});
		assert.ok(quit);
		quit();
		assert.deepEqual(await result, STOPPED);
		assert.equal(unregistered, true);
	});
});
