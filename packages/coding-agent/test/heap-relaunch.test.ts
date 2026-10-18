import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { isHeadlessInvocation } from "../src/utils/heap-relaunch.js";
import { INTERACTIVE_ENGINE_BOOTSTRAP_FLAG } from "../src/utils/interactive-engine-bootstrap.js";

describe("headless heap relaunch detection", () => {
	it("treats print, json and rpc runs as headless", () => {
		for (const args of [
			["-p", "hi"],
			["--print", "hi"],
			["--mode", "json", "-p", "hi"],
			["--mode", "rpc"],
		]) {
			assert.equal(isHeadlessInvocation(args), true, args.join(" "));
		}
	});

	it("leaves interactive sessions and text mode alone", () => {
		for (const args of [[], ["--session", "abc"], ["--mode", "text"], ["--mode"]]) {
			assert.equal(isHeadlessInvocation(args), false, args.join(" "));
		}
	});

	it("never relaunches the interactive engine child, whose host already sized it", () => {
		assert.equal(isHeadlessInvocation(["--mode", "rpc", INTERACTIVE_ENGINE_BOOTSTRAP_FLAG, "/tmp/bootstrap"]), false);
	});
});
