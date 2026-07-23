import { describe, expect, it } from "vitest";
import {
	getSelfUpdateUnavailableInstructionForRuntime,
	getUpdateInstructionForRuntime,
	type SelfUpdateRuntime,
} from "../src/config-self-update.ts";

const binaryRuntime: SelfUpdateRuntime = {
	isBunBinary: true,
	isBunRuntime: true,
	moduleDir: "C:\\Program Files\\Atomic",
	getPackageDir: () => "C:\\Program Files\\Atomic",
};

const expected = "Download from: https://github.com/bastani-inc/atomic/releases/latest";

describe("standalone Atomic update guidance", () => {
	it("directs bun binaries to the Atomic release target", () => {
		expect(getSelfUpdateUnavailableInstructionForRuntime(binaryRuntime, "@bastani/atomic")).toBe(expected);
		expect(getUpdateInstructionForRuntime(binaryRuntime, "@bastani/atomic")).toBe(expected);
		expect(expected).not.toContain("pi-mono");
	});
});
