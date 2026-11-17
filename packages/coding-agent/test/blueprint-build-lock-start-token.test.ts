import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import * as startTokens from "../src/core/process-start-token.ts";
import { buildLockPath, withBuildLocks } from "../src/core/resume/blueprint/build-lock.ts";
import { stepProcessWatcher } from "../src/core/resume/blueprint/process.ts";

vi.mock("../src/core/process-start-token.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/process-start-token.ts")>();
	return {
		...actual,
		processStartToken: vi.fn(actual.processStartToken),
		processStartTokenAsync: vi.fn(actual.processStartTokenAsync),
	};
});

interface RecordedStep {
	readonly pid: number;
	readonly start?: string;
	readonly at?: number;
}

let dir: string;
const children: ChildProcess[] = [];
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "atomic-build-lock-start-"));
	vi.mocked(startTokens.processStartToken).mockClear();
	vi.mocked(startTokens.processStartTokenAsync).mockClear();
});
afterEach(() => {
	for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
	rmSync(dir, { recursive: true, force: true });
});

const root = () => join(dir, "worktrees", "repo-0");
const stepsOf = (): RecordedStep[] =>
	(JSON.parse(readFileSync(buildLockPath(dir, root()), "utf8")) as { steps: RecordedStep[] }).steps;

function sleeper(): ChildProcess {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	children.push(child);
	return child;
}

async function until(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 500 && !condition(); attempt++)
		await new Promise((resolve) => setTimeout(resolve, 10));
	assert.ok(condition());
}

function watcher(): (pid: number, running: boolean) => void {
	const watch = stepProcessWatcher.getStore();
	assert.ok(watch);
	return watch;
}

describe("blueprint build lock step starts (#4748)", () => {
	test("records a step at once without reading its start synchronously, then adds the start once read", async () => {
		const step = sleeper();
		const expected = await startTokens.processStartTokenAsync(step.pid!);
		vi.mocked(startTokens.processStartTokenAsync).mockClear();
		await withBuildLocks(dir, [root()], async () => {
			watcher()(step.pid!, true);
			const [recorded] = stepsOf();
			assert.equal(recorded?.pid, step.pid, "the step is on disk before control returns to what spawned it");
			assert.equal(typeof recorded?.at, "number");
			assert.equal(vi.mocked(startTokens.processStartToken).mock.calls.length, 0);
			if (expected !== undefined) {
				await until(() => stepsOf()[0]?.start !== undefined);
				assert.equal(stepsOf()[0]?.start, expected);
			}
			watcher()(step.pid!, false);
		});
		assert.equal(existsSync(buildLockPath(dir, root())), false);
	});

	test("a step that ended before its start was read is not written back", async () => {
		const step = sleeper();
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const actual = vi.mocked(startTokens.processStartTokenAsync).getMockImplementation()!;
		await withBuildLocks(dir, [root()], async () => {
			vi.mocked(startTokens.processStartTokenAsync).mockImplementationOnce(async (pid) => {
				await held;
				return actual(pid);
			});
			watcher()(step.pid!, true);
			watcher()(step.pid!, false);
			assert.deepEqual(stepsOf(), []);
			release();
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.deepEqual(stepsOf(), [], "the ended step stays ended");
		});
	});

	test("a start read for an earlier step of a reused id does not overwrite the later step", async () => {
		const step = sleeper();
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		await withBuildLocks(dir, [root()], async () => {
			vi.mocked(startTokens.processStartTokenAsync)
				.mockImplementationOnce(async () => {
					await held;
					return "earlier-step";
				})
				.mockImplementationOnce(async () => "later-step");
			watcher()(step.pid!, true);
			watcher()(step.pid!, false);
			watcher()(step.pid!, true);
			await until(() => stepsOf()[0]?.start === "later-step");
			release();
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.deepEqual(
				stepsOf().map((recorded) => recorded.start),
				["later-step"],
			);
			watcher()(step.pid!, false);
		});
	});
});
