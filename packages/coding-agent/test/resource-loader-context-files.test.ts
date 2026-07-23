import { win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { getAncestorDirectories } from "../src/core/resource-loader-context-files.ts";

describe("project context ancestor traversal", () => {
	it("terminates at a Windows drive root using dirname fixed points", () => {
		expect(getAncestorDirectories("C:\\repo\\nested", win32.dirname)).toEqual([
			"C:\\repo\\nested",
			"C:\\repo",
			"C:\\",
		]);
	});
});
