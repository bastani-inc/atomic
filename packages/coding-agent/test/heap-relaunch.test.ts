import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { isHeadlessInvocation } from "../src/utils/heap-relaunch.js";
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
