/**
 * Two processes that resume one restored worktree at once (#4748, #5193): each settles other builds of it and then
 * builds it, and its lock is written only once a step starts a process. Real processes; the first build is held
 * between settling and its first step, the window in which no lock says it builds.
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, test } from "vitest";

const MODULE = (path: string) => fileURLToPath(new URL(`../src/core/${path}`, import.meta.url));
/** How long another process may take to start and report what it does. */
const CHILD_TIMEOUT_MS = 60_000;

let dir: string;
const children: ChildProcess[] = [];

beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "atomic-build-lock-race-")));
});

afterEach(() => {
	for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
	rmSync(dir, { recursive: true, force: true });
});

const root = () => join(dir, "worktrees", "repo-0");
const log = () => join(dir, "events.log");
const events = () => (existsSync(log()) ? readFileSync(log(), "utf8").trim().split("\n") : []);

/**
 * Another process that resumes the worktree as a resume does: settles other builds of it, builds it under its lock,
 * and lets it go. Its build logs `<name> builds`, waits until the file `gate` exists, runs one step process, and logs
 * `<name> built`; a wait for another build logs `<name> waits`.
 */
function builder(name: string, gate: string): { readonly child: ChildProcess; readonly exit: Promise<number | null> } {
	const script = `
		const { appendFileSync, existsSync, openSync } = await import("node:fs");
		const { settleOtherBuilds, withBuildLocks } = await import(${JSON.stringify(MODULE("resume/blueprint/build-lock.ts"))});
		const { runLoggedProcess } = await import(${JSON.stringify(MODULE("resume/blueprint/process.ts"))});
		const event = (what) => appendFileSync(${JSON.stringify(log())}, ${JSON.stringify(name)} + " " + what + "\\n");
		const dir = ${JSON.stringify(dir)};
		const root = ${JSON.stringify(root())};
		const settled = await settleOtherBuilds(dir, [root], { onWait: () => event("waits") });
		try {
			await withBuildLocks(dir, [root], async () => {
				event("builds");
				while (!existsSync(${JSON.stringify(gate)})) await new Promise((resolve) => setTimeout(resolve, 20));
				const path = ${JSON.stringify(join(dir, `${name}-step.log`))};
				const step = { command: process.execPath, args: ["-e", ""], cwd: dir, env: process.env };
				await runLoggedProcess(step, { fd: openSync(path, "a"), path }, { timeoutMs: 30_000 });
				event("built");
			});
		} finally {
			settled.release();
		}
	`;
	const child = spawn("bun", ["--eval", script], { stdio: "ignore" });
	children.push(child);
	const exit = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
	return { child, exit };
}

async function until(condition: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + CHILD_TIMEOUT_MS;
	while (!condition()) {
		assert.ok(Date.now() < deadline, `${what}; events: ${JSON.stringify(events())}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe("two processes resuming one worktree (#5193)", () => {
	test(
		"a process that looks while another is between settling and its first step waits until that build settled",
		async () => {
			const gate = join(dir, "gate-a");
			const first = builder("a", gate);
			await until(() => events().includes("a builds"), "the first build started");
			// Its lock is not written yet: no step has started.
			const second = builder("b", join(dir, "gate-b"));
			writeFileSync(join(dir, "gate-b"), "");
			await until(
				() => events().some((event) => event === "b waits" || event === "b builds"),
				"the second process waited or built",
			);
			writeFileSync(gate, "");
			const exits = await Promise.all([first.exit, second.exit]);
			assert.deepEqual(events(), ["a builds", "b waits", "a built", "b builds", "b built"]);
			assert.deepEqual(exits, [0, 0]);
		},
		2 * CHILD_TIMEOUT_MS,
	);

	test(
		"a process killed during its build lets the waiting process build at once",
		async () => {
			const first = builder("a", join(dir, "gate-a"));
			await until(() => events().includes("a builds"), "the first build started");
			const second = builder("b", join(dir, "gate-b"));
			writeFileSync(join(dir, "gate-b"), "");
			await until(
				() => events().some((event) => event === "b waits" || event === "b builds"),
				"the second process waited or built",
			);
			assert.deepEqual(events(), ["a builds", "b waits"], "the second process waits while the first builds");
			first.child.kill("SIGKILL");
			await first.exit;
			const exit = await second.exit;
			assert.deepEqual(events(), ["a builds", "b waits", "b builds", "b built"]);
			assert.equal(exit, 0);
		},
		2 * CHILD_TIMEOUT_MS,
	);
});
