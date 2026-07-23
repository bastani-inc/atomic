import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const RPC_ENTRY_SOURCE = readFileSync(new URL("../src/rpc-entry.ts", import.meta.url), "utf-8");

describe("rpc-entry env marker and forced RPC mode", () => {
	it("uses APP_NAME-based env marker (not hard-coded PI_CODING_AGENT)", () => {
		expect(RPC_ENTRY_SOURCE).not.toContain("PI_CODING_AGENT");
		expect(RPC_ENTRY_SOURCE).toContain("APP_NAME.toUpperCase()");
	});

	it("forces --mode rpc via terminator-aware insertion so it cannot be overridden", () => {
		// The forced --mode rpc must be inserted before any `--` end-of-options
		// terminator (never appended blindly after caller argv, where a caller
		// `--` would demote it to literal message text). Caller --mode flags can
		// only appear before the terminator, so last-option-wins is preserved.
		expect(RPC_ENTRY_SOURCE).toMatch(
			/main\(\s*insertForcedOptionsBeforeTerminator\(\s*process\.argv\.slice\(2\),\s*\["--mode",\s*"rpc"\]\s*\)\s*\)/,
		);
		expect(RPC_ENTRY_SOURCE).toContain(
			'import { insertForcedOptionsBeforeTerminator } from "./cli/args.ts";',
		);
	});
});
