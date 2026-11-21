import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";

/** File checks under this directory never answer, as on a network directory that stopped responding. */
const held = vi.hoisted(() => ({ directory: "", checks: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const hold =
		<A extends unknown[], R>(check: (path: string, ...rest: A) => Promise<R>) =>
		(path: string, ...rest: A): Promise<R> => {
			if (held.directory !== "" && String(path).startsWith(held.directory)) {
				held.checks++;
				return new Promise<R>(() => {});
			}
			return check(path, ...rest);
		};
	return {
		...actual,
		access: hold(actual.access as (path: string, mode?: number) => Promise<void>),
		stat: hold(actual.stat as (path: string) => Promise<import("node:fs").Stats>),
		lstat: hold(actual.lstat as (path: string) => Promise<import("node:fs").Stats>),
	};
});

const { runBunSubprocess } = await import("../../packages/web-access/subprocess.ts");

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "atomic-lookup-bounds-"));
	held.directory = join(root, "unanswering");
	held.checks = 0;
	mkdirSync(held.directory);
	vi.stubEnv("PATH", held.directory);
});

afterEach(() => {
	vi.unstubAllEnvs();
	held.directory = "";
	rmSync(root, { recursive: true, force: true });
});

/** A bound the lookup's held check can never meet; the call must end long before it. */
const NEVER_MS = 600_000;

test("a cancellation while the command is looked up ends the run at once and starts nothing", async () => {
	const controller = new AbortController();
	const run = runBunSubprocess("tool", ["--version"], {
		timeoutMs: NEVER_MS,
		maxStdoutBytes: 1024,
		signal: controller.signal,
	});
	await vi.waitFor(() => assert.ok(held.checks > 0, "the lookup has reached the held directory"));
	controller.abort();
	await assert.rejects(run, { code: "ABORT_ERR", killed: true });
});

test("the run's time limit covers looking the command up", async () => {
	const run = runBunSubprocess("tool", ["--version"], {
		timeoutMs: 200,
		maxStdoutBytes: 1024,
	});
	await assert.rejects(run, { code: "ETIMEDOUT", killed: true });
	assert.ok(held.checks > 0);
});

test("a cancellation that comes as the lookup finishes still starts nothing", async () => {
	const controller = new AbortController();
	const run = runBunSubprocess(process.execPath, ["-e", "setTimeout(() => {}, 150)"], {
		timeoutMs: NEVER_MS,
		maxStdoutBytes: 1024,
		signal: controller.signal,
	});
	queueMicrotask(() => controller.abort());
	await assert.rejects(run, { code: "ABORT_ERR", killed: true });
});
