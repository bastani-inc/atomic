import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { APP_NAME } from "../../src/config.js";
import type { SessionManager } from "../../src/core/session-manager.js";
import type { HerdrEnvironment } from "../../src/extensions/herdr/environment.js";

// Each fake Herdr call spawns a real Node child process. On a loaded Windows runner its startup
// alone can exceed the product's 5 s kill timeout, so fixtures that run beside real SDK reloads
// pass FAKE_HERDR_CHILD_TIMEOUT_MS as `timeoutMs`, and waits outlast that kill budget.
export const FAKE_HERDR_CHILD_TIMEOUT_MS = 15_000;
/** How long a test waits for a fake Herdr call: past the kill budget of the slowest one. */
export const FAKE_HERDR_WAIT_MS = FAKE_HERDR_CHILD_TIMEOUT_MS + 5_000;
/**
 * Safety kill budget for tests that expire a hanging fake Herdr call via `expireInFlight()` once
 * the child has started: strictly above {@link FAKE_HERDR_WAIT_MS} so the hang cannot expire
 * before `waitForStarted()` observes it.
 */
export const FAKE_HERDR_EXPLICIT_TIMEOUT_MS = FAKE_HERDR_WAIT_MS + 10_000;

export interface HerdrCall {
	phase: "start" | "end";
	args: string[];
	socket: string;
}

interface ActiveFakeChild {
	child: childProcess.ChildProcess;
	timeoutMs: number;
	killSignal: NodeJS.Signals | number;
	closed: boolean;
}

interface RegisteredFixture {
	script: string;
	active?: ActiveFakeChild;
}

const fixtures = new Map<string, RegisteredFixture>();
const realExecFile = childProcess.execFile;
let launcher: ReturnType<typeof vi.spyOn> | undefined;

function extractExecFileOptions(args: Parameters<typeof realExecFile>): childProcess.ExecFileOptions | undefined {
	if (args[1] && !Array.isArray(args[1]) && typeof args[1] === "object") return args[1];
	if (args[2] && typeof args[2] === "object") return args[2];
	return undefined;
}

function registerScript(bin: string, script: string): RegisteredFixture {
	const fixture: RegisteredFixture = { script };
	fixtures.set(bin, fixture);
	if (launcher) return fixture;
	// Only registered fixtures are redirected. Keep real children, argv arrays, and
	// transport options; missing/invalid executables still reach the real execFile.
	launcher = vi.spyOn(childProcess, "execFile").mockImplementation((...args: Parameters<typeof realExecFile>) => {
		const registered = fixtures.get(args[0]);
		const options = registered ? extractExecFileOptions(args) : undefined;
		if (registered) {
			args[0] = process.execPath;
			args[1] = [registered.script, ...(args[1] ?? [])];
		}
		const child = realExecFile(...args);
		if (registered) {
			const entry: ActiveFakeChild = {
				child,
				timeoutMs: typeof options?.timeout === "number" ? options.timeout : 0,
				killSignal: options?.killSignal ?? "SIGTERM",
				closed: false,
			};
			registered.active = entry;
			const clear = () => {
				entry.closed = true;
				if (registered.active === entry) registered.active = undefined;
			};
			child.once("close", clear);
			child.once("error", clear);
		}
		return child;
	});
	syncBuiltinESMExports();
	return fixture;
}

// A disposable executable records its own lifetime, not just spawn requests.
export async function fakeHerdr(body = "finish();") {
	const dir = await mkdtemp(join(tmpdir(), "atomic-herdr-"));
	const log = join(dir, "calls.jsonl");
	const script = join(dir, "fake.cjs");
	const bin = join(dir, "fake.exe");
	await writeFile(log, "");
	await writeFile(
		script,
		`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const record = phase => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({phase, args, socket: process.env.HERDR_SOCKET_PATH}) + "\\n");
const finish = (code = 0) => { record("end"); process.exit(code); };
record("start");
${body}
`,
	);
	const fixture = registerScript(bin, script);
	const environment: HerdrEnvironment = { bin, paneId: dir, socketPath: " socket path " };
	const env = { HERDR_ENV: "1", HERDR_BIN_PATH: bin, HERDR_PANE_ID: dir, HERDR_SOCKET_PATH: environment.socketPath };
	async function calls(): Promise<HerdrCall[]> {
		// A fake child may be mid-append: only newline-terminated records are complete.
		return (await readFile(log, "utf8"))
			.split("\n")
			.slice(0, -1)
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	}
	async function waitForPhase(phase: HerdrCall["phase"], count: number, label: string): Promise<HerdrCall[]> {
		const deadline = Date.now() + FAKE_HERDR_WAIT_MS;
		while (Date.now() < deadline) {
			const entries = (await calls()).filter((call) => call.phase === phase);
			if (entries.length >= count) return entries;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.fail(`Expected ${count} ${label} fake Herdr calls: ${JSON.stringify(await calls())}`);
	}
	return {
		dir,
		bin,
		env,
		environment,
		calls,
		async waitFor(count: number) {
			return waitForPhase("end", count, "completed");
		},
		/**
		 * Wait for `count` fake Herdr invocations to have started, including ones
		 * deliberately held open by the script body (for example a "working" report
		 * polling for an `allow-release` marker). Spawning the fake child is real
		 * process work, so this shares `waitFor`'s deadline rather than
		 * `vi.waitFor`'s 1 s default.
		 */
		async waitForStarted(count: number) {
			return waitForPhase("start", count, "started");
		},
		/**
		 * Expire the currently in-flight fake Herdr child the same way Node's `execFile`
		 * timeout kills it, after checking that the transport armed a positive timeout
		 * (matching `expectedTimeoutMs` when supplied). Lets tests trigger a timeout
		 * deterministically after `waitForStarted()` instead of racing child startup.
		 */
		expireInFlight(expectedTimeoutMs?: number) {
			const active = fixture.active;
			assert.ok(active && !active.closed, "Expected an in-flight fake Herdr child to expire");
			assert.ok(active.timeoutMs > 0, `Expected a positive execFile timeout, got ${active.timeoutMs}`);
			if (expectedTimeoutMs !== undefined) {
				assert.equal(active.timeoutMs, expectedTimeoutMs);
			}
			active.child.stdout?.destroy();
			active.child.stderr?.destroy();
			assert.equal(active.child.kill(active.killSignal), true, "Expected in-flight fake Herdr child to be killed");
		},
		async dispose() {
			fixtures.delete(bin);
			if (fixtures.size === 0) {
				launcher?.mockRestore();
				syncBuiltinESMExports();
				launcher = undefined;
			}
			await rm(dir, { recursive: true, force: true });
		},
	};
}

export function arg(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	return index < 0 ? undefined : args[index + 1];
}

/** The resume argv Herdr is given for a session, after the `--` separator of a report. */
export function resumeArgs(session: SessionManager): string[] {
	const sessionDir =
		session.getSessionStore().descriptor.adapter === "jsonl" ? ["--session-dir", session.getSessionDir()] : [];
	return ["--", APP_NAME, ...sessionDir, "--session", session.getSessionId()];
}
