import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bunExecutable } from "../../../../../test/helpers/runtime.ts";

/**
 * Regression test for https://github.com/earendil-works/pi-mono/issues/2791
 *
 * fs.watch() returns an FSWatcher (EventEmitter). If the watcher emits an
 * 'error' event after creation and no error handler is attached, Node.js
 * treats it as an uncaught exception and terminates the process.
 *
 * We test this by spawning a child process that:
 * 1. Wraps node:fs.watch to capture the watcher returned by the theme code
 * 2. Sets up a custom theme with the watcher enabled
 * 3. Emits a synthetic 'error' event on the captured watcher
 * 4. If the watcher has no error handler -> crash (exit != 0) -> bug present
 * 5. If the watcher has an error handler -> clean exit (exit 0) -> bug fixed
 */

/**
 * Structural: this test spawns a real Bun child process that imports the theme
 * module graph. The budget covers child startup, not test logic. Keep it well
 * below the suite-wide per-test budget so a hang still fails as a test timeout.
 */
const WATCHER_CHILD_TIMEOUT_MS = 10_000;
describe("issue #2791 fs.watch error event crashes process", () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-2791-"));
		const agentDir = join(tempRoot, "agent");
		const themesDir = join(agentDir, "themes");
		mkdirSync(themesDir, { recursive: true });

		// Copy dark.json as "custom-test" theme
		const darkThemePath = join(__dirname, "../../../src/modes/interactive/theme/dark.json");
		const darkTheme = JSON.parse(readFileSync(darkThemePath, "utf-8"));
		darkTheme.name = "custom-test";
		writeFileSync(join(themesDir, "custom-test.json"), JSON.stringify(darkTheme, null, 2));
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it("process should survive an error event on the theme FSWatcher", () => {
		const themeModuleUrl = pathToFileURL(join(__dirname, "../../../src/modes/interactive/theme/theme.ts")).href;
		const agentDir = join(tempRoot, "agent");

		// Script that sets up the watcher and emits a synthetic error on it.
		// If no .on('error') handler is attached, EventEmitter.emit('error')
		// throws, which either crashes the process or gets caught by our try/catch.
		const script = `

import { mock } from "bun:test";
import * as realFs from "node:fs";

const realWatch = realFs.watch;
let fsWatcher;

mock.module("node:fs", () => ({
	...realFs,
	watch: (...args) => {
		fsWatcher = realWatch(...args);
		return fsWatcher;
	},
}));

process.env.ATOMIC_CODING_AGENT_DIR = ${JSON.stringify(agentDir)};

const { setTheme, stopThemeWatcher } = await import(${JSON.stringify(themeModuleUrl)});
setTheme("custom-test", true);

if (!fsWatcher) {
	process.stderr.write("theme fs.watch was not called\\n");
	process.exit(2);
}

const errorListenerCount = fsWatcher.listenerCount("error");
if (errorListenerCount === 0) {
	process.stderr.write("BUG: FSWatcher has no error handler (issue #2791)\\n");
}

// Emitting 'error' on an EventEmitter with no error listener throws.
// This simulates an async OS error (e.g. ReadDirectoryChangesW invalidation).
try {
	fsWatcher.emit("error", new Error("simulated OS watcher failure"));
} catch {
	process.stderr.write("error event was unhandled and threw\\n");
	process.exit(1);
}

stopThemeWatcher();
process.exit(0);
		`;

		let _stdout = "";
		let stderr = "";
		let exitCode: number;
		let signal: NodeJS.Signals | null = null;
		try {
			_stdout = execFileSync(bunExecutable(), ["-e", script], {
				timeout: WATCHER_CHILD_TIMEOUT_MS,
				encoding: "utf-8",
				env: { ...process.env, ATOMIC_CODING_AGENT_DIR: agentDir },
				stdio: ["pipe", "pipe", "pipe"],
			});
			exitCode = 0;
		} catch (err: unknown) {
			// `code` distinguishes a starved child from a crashed one. Without it a
			// timeout surfaces as `status: null` -> exit 1 -> "Child crashed", which
			// is the exact failure this test exists to detect, so a loaded machine
			// reads as the #2791 regression returning.
			const e = err as {
				status: number | null;
				code?: string;
				stdout?: string;
				stderr?: string;
				signal?: NodeJS.Signals | null;
			};
			expect(
				e.code,
				`Theme watcher child timed out after ${WATCHER_CHILD_TIMEOUT_MS} ms; it never reached the watcher assertion. This is starvation, not the #2791 crash.`,
			).not.toBe("ETIMEDOUT");
			_stdout = e.stdout ?? "";
			stderr = e.stderr ?? "";
			signal = e.signal ?? null;
			exitCode = e.status ?? 1;
		}

		expect(
			signal,
			`Child was killed by ${signal} after ${WATCHER_CHILD_TIMEOUT_MS} ms without reaching the watcher assertion.`,
		).toBeNull();
		expect(exitCode, `Child crashed (exit ${exitCode}). stderr: ${stderr.trim()}`).toBe(0);
	});
});
