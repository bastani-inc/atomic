import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import type { HerdrEnvironment } from "../../src/extensions/herdr/environment.js";

// Each fake Herdr call spawns a real child process; give it process-level headroom.
const FAKE_HERDR_WAIT_MS = 5_000;

export interface HerdrCall {
	phase: "start" | "end";
	args: string[];
	socket: string;
}

const scripts = new Map<string, string>();
const realExecFile = childProcess.execFile;
let launcher: ReturnType<typeof vi.spyOn> | undefined;

function registerScript(bin: string, script: string) {
	scripts.set(bin, script);
	if (launcher) return;
	// Only registered fixtures are redirected. Keep real children, argv arrays, and
	// transport options; missing/invalid executables still reach the real execFile.
	launcher = vi.spyOn(childProcess, "execFile").mockImplementation((...args: Parameters<typeof realExecFile>) => {
		const target = scripts.get(args[0]);
		if (target) {
			args[0] = process.execPath;
			args[1] = [target, ...(args[1] ?? [])];
		}
		return realExecFile(...args);
	});
	syncBuiltinESMExports();
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
	registerScript(bin, script);
	const environment: HerdrEnvironment = { bin, paneId: dir, socketPath: " socket path " };
	const env = { HERDR_ENV: "1", HERDR_BIN_PATH: bin, HERDR_PANE_ID: dir, HERDR_SOCKET_PATH: environment.socketPath };
	async function calls(): Promise<HerdrCall[]> {
		return (await readFile(log, "utf8"))
			.split("\n")
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
		async dispose() {
			scripts.delete(bin);
			if (scripts.size === 0) {
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
