import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const RPC_ENTRY_SOURCE = readFileSync(new URL("../src/rpc-entry.ts", import.meta.url), "utf-8");

describe("rpc-entry env marker and forced RPC mode", () => {
	it("uses APP_NAME-based env marker (not hard-coded PI_CODING_AGENT)", () => {
		expect(RPC_ENTRY_SOURCE).not.toContain("PI_CODING_AGENT");
		expect(RPC_ENTRY_SOURCE).toContain("APP_NAME.toUpperCase()");
	});

	it("forces --mode rpc as the last argument so it cannot be overridden", () => {
		// The main() call should append --mode rpc at the end so the last --mode wins.
		expect(RPC_ENTRY_SOURCE).toMatch(/main\(\[\.\.\.process\.argv\.slice\(2\),\s*"--mode",\s*"rpc"\]\)/);
	});
});
