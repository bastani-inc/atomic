import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { headlessHeapRelaunchArgs, isHeadlessInvocation } from "../src/utils/heap-relaunch.js";
import { INTERACTIVE_ENGINE_BOOTSTRAP_FLAG } from "../src/utils/interactive-engine-bootstrap.js";

const terminal = { stdinIsTTY: true, stdoutIsTTY: true };

describe("headless heap relaunch detection", () => {
	it("treats print, json and rpc runs as headless", () => {
		for (const args of [
			["-p", "hi"],
			["--print", "hi"],
			["--mode", "json", "-p", "hi"],
			["--mode", "rpc"],
		]) {
			assert.equal(isHeadlessInvocation(args, terminal), true, args.join(" "));
		}
	});

	it("treats runs with piped input or output as headless print runs, as resolveAppMode does", () => {
		assert.equal(isHeadlessInvocation([], { stdinIsTTY: false, stdoutIsTTY: true }), true);
		assert.equal(isHeadlessInvocation(["hi"], { stdinIsTTY: true, stdoutIsTTY: false }), true);
	});

	it("leaves interactive sessions, text mode and help alone", () => {
		for (const args of [[], ["--session", "abc"], ["--mode", "text"], ["--mode"]]) {
			assert.equal(isHeadlessInvocation(args, terminal), false, args.join(" "));
		}
		assert.equal(isHeadlessInvocation(["--help"], { stdinIsTTY: true, stdoutIsTTY: false }), false);
	});

	it("never relaunches the interactive engine child, whose host already sized it", () => {
		const engineArgs = ["--mode", "rpc", INTERACTIVE_ENGINE_BOOTSTRAP_FLAG, "/tmp/bootstrap"];
		assert.equal(isHeadlessInvocation(engineArgs, { stdinIsTTY: false, stdoutIsTTY: false }), false);
	});
});

const RELAUNCH_ENV = ["ATOMIC_HEAP_MB", "NODE_OPTIONS", "ATOMIC_INTERNAL_HEAP_RELAUNCHED"];

describe("headless heap relaunch", () => {
	function relaunchArgsWith(execArgv: readonly string[]): string[] {
		const savedExecArgv = process.execArgv;
		const savedEnv = Object.fromEntries(
			RELAUNCH_ENV.map((name): [string, string | undefined] => [name, process.env[name]]),
		);
		process.execArgv = [...execArgv];
		// A size of its own makes a run without a heap size on its command line relaunch on any machine, unless
		// NODE_OPTIONS sets one or the run is itself the relaunch.
		process.env.ATOMIC_HEAP_MB = "1234";
		delete process.env.NODE_OPTIONS;
		delete process.env.ATOMIC_INTERNAL_HEAP_RELAUNCHED;
		try {
			return headlessHeapRelaunchArgs(["--print", "hi"]);
		} finally {
			process.execArgv = savedExecArgv;
			for (const [name, value] of Object.entries(savedEnv)) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	}

	it("relaunches a run whose command line sets no heap size", () => {
		assert.deepEqual(relaunchArgsWith([]), ["--max-old-space-size=1234"]);
		assert.deepEqual(relaunchArgsWith(["--max-semi-space-size=64"]), ["--max-old-space-size=1234"]);
	});

	it("keeps any heap size the run's command line sets, without starting a second process", () => {
		for (const execArgv of [
			["--max-old-space-size=4096"],
			["--max-old-space-size-percentage=25"],
			["--max_old_space_size_percentage", "25"],
			["--max-heap-size=4096"],
		]) {
			assert.deepEqual(relaunchArgsWith(execArgv), [], execArgv.join(" "));
		}
	});
});
