import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import type { ExecResult } from "../src/core/exec.ts";

/** Directories whose file system never answers, as a network share that stopped responding. */
const held = vi.hoisted(() => new Set<string>());
/** Directories where a file's status comes only after this many milliseconds, as on a slow network share. */
const slow = vi.hoisted(() => new Map<string, number>());

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof FsPromises>();
	const { dirname } = await import("node:path");
	const answer = <T>(path: unknown, read: () => Promise<T>): Promise<T> =>
		held.has(String(path)) || held.has(dirname(String(path))) ? new Promise<T>(() => {}) : read();
	const stat = ((path: string, options?: { bigint?: boolean }) =>
		answer(path, () => {
			const delay = slow.get(dirname(path));
			const read = () => actual.stat(path, options);
			return delay === undefined ? read() : new Promise((resolve) => setTimeout(resolve, delay)).then(read);
		})) as typeof actual.stat;
	const access = ((path: string, mode?: number) =>
		answer(path, () => actual.access(path, mode))) as typeof actual.access;
	return { ...actual, stat, access, default: { ...actual, stat, access } };
});

/** How long starting a process holds the thread, as a host with much memory or a busy machine can. */
const spawnSetup = vi.hoisted(() => ({ ms: 0 }));

vi.mock("../src/utils/host-spawn.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/host-spawn.ts")>();
	const spawnHostProcess: typeof actual.spawnHostProcess = (...start) => {
		const until = performance.now() + spawnSetup.ms;
		while (performance.now() < until) {
			/* the start holds the thread */
		}
		return actual.spawnHostProcess(...start);
	};
	return { ...actual, spawnHostProcess };
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
	// Something the working directory holds under the name, so the program is looked up in PATH before it starts.
	writeFileSync(join(root, "atomic-test-program.exe"), "");
});

afterEach(() => {
	spawnSetup.ms = 0;
	held.clear();
	slow.clear();
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

/** How long starting the process holds the thread in the whole-timeout test: longer than its timeout. */
const SLOW_START_MS = 2_000;
/** The command's timeout there: ample for a command that answers after 100 ms once it runs. */
const START_TIMEOUT_MS = 1_500;
/** How long the PATH directory takes to answer while the caller changes its arguments. */
const SLOW_ARGUMENTS_LOOKUP_MS = 200;
/** How long the PATH directory takes to answer in the timeout budget test. */
const SLOW_LOOKUP_MS = 2_000;
/** The command's timeout there: longer than the lookup, so the command starts. */
const BUDGET_MS = 2_500;

describe.skipIf(process.platform === "win32")("a pi.exec command whose lookup took a while", () => {
	test("gets what its timeout leaves after the lookup, not a whole timeout more", async () => {
		const bin = join(root, "bin");
		held.delete(bin);
		slow.set(bin, SLOW_LOOKUP_MS);
		const program = join(bin, "atomic-test-program");
		// Runs until it is stopped; PATH holds nothing else, so it names Node by its path.
		writeFileSync(program, `#!/bin/sh\nexec '${process.execPath}' -e 'setTimeout(() => {}, 30000)'\n`, {
			mode: 0o755,
		});

		const started = performance.now();
		const result = await execOnWindows("atomic-test-program", [], root, { timeout: BUDGET_MS });
		const elapsed = performance.now() - started;

		assert.equal(result.killed, true);
		assert.equal(result.code, 143);
		// A second whole timeout after the lookup would end it after SLOW_LOOKUP_MS + BUDGET_MS.
		assert.ok(elapsed < SLOW_LOOKUP_MS + BUDGET_MS - 500, `ended after ${Math.round(elapsed)} ms`);
	});
});

describe("a pi.exec command looked up by nothing", () => {
	test("gets its whole timeout from its start, however long the start took", async () => {
		spawnSetup.ms = SLOW_START_MS;
		const result = await execCommand(
			process.execPath,
			["-e", 'setTimeout(() => process.stdout.write("ready"), 100)'],
			root,
			{ timeout: START_TIMEOUT_MS },
		);

		assert.deepEqual([result.stdout, result.code, result.killed], ["ready", 0, false]);
	});
});

describe.skipIf(process.platform === "win32")("a pi.exec command whose arguments change while it is looked up", () => {
	test("runs with the arguments it was called with", async () => {
		const bin = join(root, "bin");
		held.delete(bin);
		slow.set(bin, SLOW_ARGUMENTS_LOOKUP_MS);
		writeFileSync(
			join(bin, "atomic-test-program"),
			`#!/bin/sh\nexec '${process.execPath}' -e 'process.stdout.write(process.argv.slice(1).join(" "))' "$@"\n`,
			{ mode: 0o755 },
		);
		const args = ["first"];

		const result = execOnWindows("atomic-test-program", args, root);
		args[0] = "second";
		args.push("third");

		assert.equal((await result).stdout, "first");
	});
});

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
